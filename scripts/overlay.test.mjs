/**
 * [INPUT]: 依赖 Node.js test/vm 与真实 overlay.js，模拟 Shadow DOM 中的字幕节点
 * [OUTPUT]: 验证相同字幕（含 ruby/readings 注音）不重复替换节点、ruby/rt 元素生成、文字/读音变化与字幕消失更新、最长前缀匹配与外观布局参数生效
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
      host = {
        id: "",
        style: {
          setProperty(key, value) { this[key] = value; }
        },
        dataset: {},
        isConnected: false,
        attachShadow() { return root; }
      };
      return host;
    },
    documentElement: { append(node) { node.isConnected = true; } }
  };
  const window = {};
  runInNewContext(source, { window, document }, { filename: "overlay.js" });
  return { overlay: window.Bilayer.createSubtitleOverlay(), primary, secondary, host };
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

test("cues with readings map preserve all punctuation and annotate kanji words", () => {
  const { overlay, primary } = createOverlay();
  const cue = {
    text: "（コナン：小五郎の声）そしてもう1人、前歴のない指紋が付着していました",
    readings: { "声": "こえ", "1人": "ひとり", "前歴": "ぜんれき", "指紋": "しもん", "付着": "ふちゃく" }
  };
  overlay.render({ primaryCues: [cue], secondaryCues: [] });
  const line = primary.children[0];
  assert.ok(line);
  assert.equal(line.textContent.startsWith("（コナン：小五郎の声こえ）そしてもう1人ひとり、前歴ぜんれき"), true);
  assert.equal(line.children.length, 5);
  assert.equal(line.children[0].tagName, "RUBY");
  assert.equal(line.children[0].children[0].tagName, "RT");
  assert.equal(line.children[0].children[0].textContent, "こえ");
  assert.equal(line.children[1].children[0].textContent, "ひとり");
  assert.equal(line.children[2].children[0].textContent, "ぜんれき");
});

test("readings map matches longest kanji word first and ignores unused keys", () => {
  const { overlay, primary } = createOverlay();
  const cue = {
    text: "長野県警と東京都",
    readings: { "県警": "けんけい", "長野県警": "ながのけんけい", "東京": "とうきょう", "未使用": "みしよう" }
  };
  overlay.render({ primaryCues: [cue] });
  const line = primary.children[0];
  assert.equal(line.children.length, 2);
  assert.equal(line.children[0].textContent, "長野県警ながのけんけい");
  assert.equal(line.children[1].textContent, "東京とうきょう");
  assert.equal(line.textContent, "長野県警ながのけんけいと東京とうきょう都");
});

test("cues with readings retain DOM nodes across frames and update when readings change", () => {
  const { overlay, primary } = createOverlay();
  const cue1 = { text: "警察", readings: { "警察": "けいさつ" } };
  overlay.render({ primaryCues: [cue1] });
  const original = primary.children[0];

  overlay.render({ primaryCues: [{ text: "警察", readings: { "警察": "けいさつ" } }] });
  assert.equal(primary.children[0], original);
  assert.equal(primary.replacements, 1);

  overlay.render({ primaryCues: [{ text: "警察", readings: { "警察": "ポリ" } }] });
  assert.notEqual(primary.children[0], original);
  assert.equal(primary.children[0].children[0].children[0].textContent, "ポリ");
  assert.equal(primary.replacements, 2);
});

test("multiple concurrent cues render as multiple line elements and manage visibility", () => {
  const { overlay, primary } = createOverlay();
  overlay.render({ primaryCues: [{ text: "Line 1" }, { text: "Line 2" }] });
  assert.equal(primary.children.length, 2);
  assert.equal(primary.children[0].textContent, "Line 1");
  assert.equal(primary.children[1].textContent, "Line 2");
  assert.equal(primary.hidden, false);

  overlay.render({ primaryCues: [] });
  assert.equal(primary.children.length, 0);
  assert.equal(primary.hidden, true);
});

test("applySettings configures host layout, vertical offsets and role styles with opacity", () => {
  const { overlay, host } = createOverlay();
  overlay.applySettings({
    subtitleLayoutPreset: "free",
    primaryVerticalOffset: 30,
    secondaryVerticalOffset: 15,
    primaryFontSize: 32,
    primaryTextColor: "#ff0000",
    primaryTextOpacity: 80,
    primaryBackgroundColor: "#fff",
    primaryBackgroundOpacity: 50,
    primaryFontFamily: "rounded",
    primaryFontWeight: 800,
    primaryLineHeight: 1.4,
    primaryStrokeWidth: 2,
    primaryStrokeColor: "#000000",
    primaryMaxWidth: 80,
    secondaryFontSize: 24,
    secondaryTextColor: "#ffffff",
    secondaryTextOpacity: 100,
    secondaryBackgroundColor: "#000000",
    secondaryBackgroundOpacity: 64,
    secondaryFontFamily: "system",
    secondaryFontWeight: 700,
    secondaryLineHeight: 1.28,
    secondaryStrokeWidth: 1,
    secondaryStrokeColor: "#000000",
    secondaryMaxWidth: 86
  });

  assert.equal(host.dataset.layout, "free");
  assert.equal(host.style["--primary-subtitle-offset"], "30vh");
  assert.equal(host.style["--secondary-subtitle-offset"], "15vh");
  assert.equal(host.style["--primary-subtitle-size"], "32px");
  assert.equal(host.style["--primary-subtitle-color"], "rgba(255, 0, 0, 0.8)");
  assert.equal(host.style["--primary-subtitle-background"], "rgba(255, 255, 255, 0.5)");
  assert.match(host.style["--primary-subtitle-font-family"], /SF Pro Rounded/);
  assert.equal(host.style["--primary-subtitle-stroke-width"], "2px");
});

test("handles full-width parentheses furigana and regex special characters in readings safely", () => {
  const { overlay, primary } = createOverlay();
  overlay.render({ primaryCues: [{ text: "明日", ruby: "{明日（あした）}" }] });
  assert.equal(primary.children[0].children[0].tagName, "RUBY");
  assert.equal(primary.children[0].children[0].children[0].textContent, "あした");

  overlay.render({ primaryCues: [{ text: "C++とC#", readings: { "C++": "シープラ", "C#": "シーシャープ" } }] });
  assert.equal(primary.children[0].children.length, 2);
  assert.equal(primary.children[0].children[0].textContent, "C++シープラ");
  assert.equal(primary.children[0].children[1].textContent, "C#シーシャープ");
});
