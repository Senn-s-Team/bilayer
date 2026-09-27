/**
 * [INPUT]: 依赖 Node.js test/vm 与真实 overlay.js，模拟 Shadow DOM 中的字幕节点
 * [OUTPUT]: 验证相同字幕（含 ruby 注音）不重复替换节点、ruby/rt 元素生成、文字变化与字幕消失仍正确更新画面
 * [POS]: scripts 的字幕呈现回归测试，覆盖播放帧与真实 DOM 更新边界
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/content/overlay.js", import.meta.url), "utf8");

function createOverlay() {
  const container = () => ({
    children: [], hidden: true, replacements: 0,
    replaceChildren(...nodes) {
      this.children = nodes;
      this.replacements++;
    }
  });
  const primary = container();
  const secondary = container();
  const root = {
    set innerHTML(_html) {},
    querySelector(selector) { return selector.includes("primary") ? primary : secondary; }
  };
  let host;
  const document = {
    createElement(tag) {
      if (host) {
        const el = {
          tagName: String(tag).toUpperCase(),
          className: "",
          textContent: "",
          children: [],
          append(...nodes) {
            for (const node of nodes) {
              if (typeof node === "string") {
                this.textContent += node;
              } else {
                this.children.push(node);
                this.textContent += (node.textContent ?? "");
              }
            }
          }
        };
        return el;
      }
      host = { id: "", style: { setProperty() {} }, dataset: {}, isConnected: false,
        attachShadow() { return root; } };
      return host;
    },
    documentElement: { append(node) { node.isConnected = true; } }
  };
  const window = {};
  runInNewContext(source, { window, document }, { filename: "overlay.js" });
  return { overlay: window.NetflixDualSubtitles.createSubtitleOverlay(), primary, secondary };
}

test("unchanged subtitles retain their DOM nodes across playback frames", () => {
  const { overlay, primary, secondary } = createOverlay();
  overlay.render({ primaryCues: [{ text: "私はいつも案内の人と" }], secondaryCues: [{ text: "我总是跟着讲解员" }] });
  const original = [primary.children[0], secondary.children[0]];
  overlay.render({ primaryCues: [{ text: "私はいつも案内の人と" }], secondaryCues: [{ text: "我总是跟着讲解员" }] });
  assert.equal(primary.children[0], original[0]);
  assert.equal(secondary.children[0], original[1]);
  assert.equal(primary.replacements, 1);
  assert.equal(secondary.replacements, 1);
});

test("subtitle text changes and disappearance still update each row independently", () => {
  const { overlay, primary, secondary } = createOverlay();
  overlay.render({ primaryCues: [{ text: "原文" }], secondaryCues: [{ text: "旧译文" }] });
  const original = primary.children[0];
  overlay.render({ primaryCues: [{ text: "原文" }], secondaryCues: [{ text: "新译文" }] });
  assert.equal(primary.children[0], original);
  assert.equal(secondary.children[0].textContent, "新译文");
  overlay.render({ primaryCues: [], secondaryCues: [{ text: "新译文" }] });
  assert.equal(primary.hidden, true);
  assert.equal(primary.children.length, 0);
  assert.equal(secondary.hidden, false);
  assert.equal(secondary.replacements, 2);
});

test("cues with ruby generate ruby and rt elements and retain nodes across frames", () => {
  const { overlay, primary } = createOverlay();
  const cueWithRuby = { text: "私の名前は田中です", ruby: "{私|わたし}の{名前|なまえ}は{田中|たなか}です" };
  overlay.render({ primaryCues: [cueWithRuby], secondaryCues: [] });
  const line = primary.children[0];
  assert.ok(line);
  assert.equal(line.children.length, 3);
  assert.equal(line.children[0].tagName, "RUBY");
  assert.equal(line.children[0].children[0].tagName, "RT");
  assert.equal(line.children[0].children[0].textContent, "わたし");
  assert.equal(primary.replacements, 1);

  overlay.render({ primaryCues: [cueWithRuby], secondaryCues: [] });
  assert.equal(primary.children[0], line);
  assert.equal(primary.replacements, 1);
});

test("cues with orphan braces without vertical bar are stripped safely", () => {
  const { overlay, primary } = createOverlay();
  const badCue = { text: 'この "すべからく" だけど 私', ruby: '{この} "{すべからく}" だけど {私|わたし}' };
  overlay.render({ primaryCues: [badCue], secondaryCues: [] });
  const line = primary.children[0];
  assert.ok(line);
  assert.equal(line.textContent, 'この "すべからく" だけど 私わたし');
  assert.equal(line.children.length, 1);
  assert.equal(line.children[0].tagName, "RUBY");
  assert.equal(line.children[0].children[0].tagName, "RT");
  assert.equal(line.children[0].children[0].textContent, "わたし");
});

test("cues with invalid kanji in furigana position like {1|人} are healed to plain text", () => {
  const { overlay, primary } = createOverlay();
  const badCue = {
    text: "そしてもう1人 前歴のない指紋が付着していました",
    ruby: "そしてもう{1|人} {前歴|ぜんれき}のない{指紋|しもん}が{付着|ふちゃく}していました"
  };
  overlay.render({ primaryCues: [badCue], secondaryCues: [] });
  const line = primary.children[0];
  assert.ok(line);
  assert.equal(line.textContent.includes("1人"), true);
  assert.equal(line.textContent.includes("1人 前歴ぜんれきのない指紋しもんが付着ふちゃくしていました"), true);
  assert.equal(line.children.length, 3);
  assert.equal(line.children[0].textContent, "前歴ぜんれき");
  assert.equal(line.children[1].textContent, "指紋しもん");
  assert.equal(line.children[2].textContent, "付着ふちゃく");
});
