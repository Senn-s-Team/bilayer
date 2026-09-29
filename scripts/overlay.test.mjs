/**
 * [INPUT]: 依赖 Node.js test/vm 与真实 overlay.js，模拟 Shadow DOM 中的字幕节点
 * [OUTPUT]: 验证相同字幕（含 ruby/readings 注音）不重复替换节点、ruby/rt 元素生成、文字/读音变化与字幕消失更新、最长前缀匹配与外观布局参数生效，以及提示条 notice 的缺省/null/空文本、文案与 kind 分支、单节点跨显隐复用无 churn、与真实字幕行及 pending 占位共存、外观/自由布局参数不受影响
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
  const noticeWrites = { text: 0, hidden: 0, kind: 0 };
  const noticeDataset = {};
  let noticeHidden = true;
  let noticeText = "";
  Object.defineProperty(noticeDataset, "kind", {
    enumerable: true,
    get() { return noticeDataset._kind; },
    set(value) {
      noticeDataset._kind = value;
      noticeWrites.kind += 1;
    }
  });
  const notice = {
    className: "subtitle-notice",
    dataset: noticeDataset,
    children: [],
    get hidden() { return noticeHidden; },
    set hidden(value) {
      noticeHidden = value;
      noticeWrites.hidden += 1;
    },
    get textContent() { return noticeText; },
    set textContent(value) {
      noticeText = value;
      noticeWrites.text += 1;
    }
  };
  const root = {
    set innerHTML(html) { this.html = html; },
    querySelector(selector) {
      if (selector.includes("notice")) return notice;
      return selector.includes("primary") ? primary : secondary;
    }
  };
  let host;
  let now = 0;
  let timerId = 0;
  const timers = [];
  const clock = {
    advance(ms) {
      now += ms;
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at);
      for (const timer of due) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
        timer.fn();
      }
    }
  };
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
  const window = {
    setTimeout(fn, delay) {
      timerId += 1;
      timers.push({ id: timerId, fn, at: now + delay });
      return timerId;
    },
    clearTimeout(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    }
  };
  runInNewContext(source, { window, document }, { filename: "overlay.js" });
  return { overlay: window.Bilayer.createSubtitleOverlay(), primary, secondary, notice, noticeWrites, host, root, clock };
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

const PLACEHOLDER_CLASS = "subtitle-placeholder";

function isPlaceholder(node) {
  return typeof node?.className === "string" && node.className.includes(PLACEHOLDER_CLASS);
}

test("pending role renders a non-text placeholder only after the anti-flicker delay", () => {
  const { overlay, primary, clock } = createOverlay();
  overlay.render({ primaryCues: [], secondaryCues: [], pending: { primary: true } });
  assert.equal(primary.children.length, 0);
  assert.equal(primary.hidden, true);

  clock.advance(199);
  assert.equal(primary.children.length, 0);
  assert.equal(primary.hidden, true);

  clock.advance(1);
  assert.equal(primary.children.length, 1);
  assert.equal(primary.hidden, false);
  const placeholder = primary.children[0];
  assert.equal(placeholder.tagName, "DIV");
  assert.equal(placeholder.className.includes(PLACEHOLDER_CLASS), true);
  assert.equal(placeholder.textContent, "");
  assert.equal(placeholder.children.length, 3);
  assert.equal(placeholder.children.every((dot) => dot.className.includes("subtitle-placeholder-dot")), true);
});

test("placeholder never replaces real text and clears immediately when cues arrive", () => {
  const { overlay, primary, clock } = createOverlay();
  overlay.render({ primaryCues: [], pending: { primary: true } });
  clock.advance(200);
  assert.equal(isPlaceholder(primary.children[0]), true);

  overlay.render({ primaryCues: [{ text: "原文" }], pending: { primary: true } });
  assert.equal(primary.children.length, 1);
  assert.equal(isPlaceholder(primary.children[0]), false);
  assert.equal(primary.children[0].textContent, "原文");
  assert.equal(primary.hidden, false);

  clock.advance(500);
  assert.equal(primary.children.length, 1);
  assert.equal(isPlaceholder(primary.children[0]), false);
});

test("stopping pending removes the placeholder immediately without waiting", () => {
  const { overlay, primary, clock } = createOverlay();
  overlay.render({ primaryCues: [], pending: { primary: true } });
  clock.advance(200);
  assert.equal(isPlaceholder(primary.children[0]), true);

  overlay.render({ primaryCues: [], pending: {} });
  assert.equal(primary.children.length, 0);
  assert.equal(primary.hidden, true);

  clock.advance(500);
  assert.equal(primary.children.length, 0);
});

test("a role that resolves before the delay never flashes the placeholder", () => {
  const { overlay, primary, clock } = createOverlay();
  overlay.render({ primaryCues: [], pending: { primary: true } });
  clock.advance(100);
  overlay.render({ primaryCues: [{ text: "快" }], pending: { primary: true } });
  assert.equal(primary.children[0].textContent, "快");

  clock.advance(1000);
  assert.equal(primary.children.length, 1);
  assert.equal(isPlaceholder(primary.children[0]), false);
});

test("placeholder reuses the role line style contract and appearance variables", () => {
  const { overlay, primary, host, root, clock } = createOverlay();
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

  overlay.render({ primaryCues: [], pending: { primary: true } });
  clock.advance(200);
  const placeholder = primary.children[0];
  assert.equal(placeholder.className.includes("line"), true);
  assert.equal(host.style["--primary-subtitle-size"], "32px");
  assert.equal(host.style["--primary-subtitle-color"], "rgba(255, 0, 0, 0.8)");
  assert.equal(host.style["--primary-subtitle-background"], "rgba(255, 255, 255, 0.5)");
  assert.equal(host.dataset.layout, "free");

  assert.match(root.html, /\.subtitle\[data-role="primary"\] \.line/);
  assert.match(root.html, /\.line\.subtitle-placeholder/);
  assert.match(root.html, /background: currentColor/);
  assert.match(root.html, /width: 0\.3em/);
  assert.match(root.html, /animation: bilayer-placeholder-pulse/);

  overlay.render({ primaryCues: [], pending: { primary: true } });
  assert.equal(primary.children[0], placeholder);
});

test("repeated identical pending frames do not churn placeholder nodes", () => {
  const { overlay, primary, clock } = createOverlay();
  overlay.render({ primaryCues: [], pending: { primary: true } });
  clock.advance(200);
  const placeholder = primary.children[0];
  const replacements = primary.replacements;

  overlay.render({ primaryCues: [], pending: { primary: true } });
  overlay.render({ primaryCues: [], pending: { primary: true } });
  assert.equal(primary.replacements, replacements);
  assert.equal(primary.children[0], placeholder);
});

test("placeholder node is reused across repeated appear/disappear cycles without leaking", () => {
  const { overlay, primary, clock } = createOverlay();
  let firstPlaceholder;
  for (let cycle = 0; cycle < 4; cycle++) {
    overlay.render({ primaryCues: [], pending: { primary: true } });
    clock.advance(200);
    assert.equal(primary.children.length, 1);
    assert.equal(isPlaceholder(primary.children[0]), true);
    firstPlaceholder ??= primary.children[0];
    assert.equal(primary.children[0], firstPlaceholder);

    overlay.render({ primaryCues: [], pending: {} });
    assert.equal(primary.children.length, 0);
    assert.equal(primary.hidden, true);
  }

  overlay.render({ primaryCues: [{ text: "回到文本" }], pending: { primary: true } });
  clock.advance(500);
  assert.equal(primary.children.length, 1);
  assert.equal(primary.children[0].textContent, "回到文本");
});

test("primary and secondary placeholders are independent roles", () => {
  const { overlay, primary, secondary, clock } = createOverlay();
  overlay.render({
    primaryCues: [{ text: "原文" }],
    secondaryCues: [],
    pending: { primary: true, secondary: true }
  });

  assert.equal(primary.children[0].textContent, "原文");
  assert.equal(secondary.children.length, 0);

  clock.advance(200);
  assert.equal(primary.children.length, 1);
  assert.equal(isPlaceholder(primary.children[0]), false);
  assert.equal(secondary.children.length, 1);
  assert.equal(isPlaceholder(secondary.children[0]), true);
});

test("omitting pending renders exactly as before", () => {
  const { overlay, primary, secondary, clock } = createOverlay();
  overlay.render({ primaryCues: [{ text: "A" }], secondaryCues: [{ text: "B" }] });
  assert.equal(primary.children.length, 1);
  assert.equal(primary.hidden, false);
  assert.equal(primary.replacements, 1);

  const firstPrimary = primary.children[0];
  overlay.render({ primaryCues: [{ text: "A" }], secondaryCues: [{ text: "B" }] });
  assert.equal(primary.children[0], firstPrimary);
  assert.equal(primary.replacements, 1);

  overlay.render({});
  assert.equal(primary.children.length, 0);
  assert.equal(primary.hidden, true);
  assert.equal(secondary.children.length, 0);
  assert.equal(secondary.hidden, true);

  clock.advance(1000);
  assert.equal(primary.children.length, 0);
  assert.equal(secondary.children.length, 0);
});

test("notice is absent by default and for null/empty payloads", () => {
  const { overlay, notice, noticeWrites, root } = createOverlay();
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, "");

  overlay.render({ primaryCues: [{ text: "原文" }] });
  overlay.render({ primaryCues: [{ text: "原文" }], notice: null });
  overlay.render({ primaryCues: [{ text: "原文" }], notice: {} });
  overlay.render({ primaryCues: [{ text: "原文" }], notice: { text: "" } });
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, "");
  assert.equal(noticeWrites.text, 0);
  assert.equal(noticeWrites.hidden, 0);
  assert.equal(noticeWrites.kind, 0);

  assert.equal((root.html.match(/data-notice/g) ?? []).length, 1);
  assert.equal(root.html.includes('data-notice aria-live="off" aria-hidden="true" hidden'), true);
});

test("notice renders given text, defaults to info, and hides when cleared", () => {
  const { overlay, notice, noticeWrites } = createOverlay();
  overlay.render({ primaryCues: [{ text: "原文" }], notice: { text: "未配置 AI 服务" } });
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, "未配置 AI 服务");
  assert.equal(notice.dataset.kind, "info");
  assert.equal(noticeWrites.text, 1);
  assert.equal(noticeWrites.hidden, 1);
  assert.equal(noticeWrites.kind, 1);

  overlay.render({ primaryCues: [{ text: "原文" }], notice: { text: "未配置 AI 服务" } });
  assert.equal(noticeWrites.text, 1);
  assert.equal(noticeWrites.hidden, 1);
  assert.equal(noticeWrites.kind, 1);

  overlay.render({ primaryCues: [{ text: "原文" }], notice: { text: "未配置 AI 服务", kind: "warning" } });
  assert.equal(notice.dataset.kind, "warning");
  assert.equal(noticeWrites.kind, 2);
  assert.equal(noticeWrites.text, 1);

  overlay.render({ primaryCues: [{ text: "原文" }], notice: null });
  assert.equal(notice.hidden, true);

  overlay.render({ primaryCues: [{ text: "原文" }], notice: { text: "换个提示" } });
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, "换个提示");
  assert.equal(noticeWrites.text, 2);
});

test("notice reuses one node across appear/disappear cycles without churn or leaks", () => {
  const { overlay, notice, noticeWrites, primary, root } = createOverlay();
  const noticeNode = notice;
  for (let cycle = 0; cycle < 4; cycle++) {
    overlay.render({ primaryCues: [{ text: "原文" }], notice: { text: "AI 不可用", kind: "warning" } });
    assert.equal(notice, noticeNode);
    assert.equal(notice.hidden, false);
    assert.equal(notice.textContent, "AI 不可用");
    assert.equal(notice.dataset.kind, "warning");

    overlay.render({ primaryCues: [{ text: "原文" }], notice: null });
    assert.equal(notice, noticeNode);
    assert.equal(notice.hidden, true);
  }
  assert.equal(noticeWrites.text, 1);
  assert.equal(noticeWrites.kind, 1);
  assert.equal((root.html.match(/class="subtitle-notice"/g) ?? []).length, 1);
  assert.equal(primary.children.length, 1);
  assert.equal(primary.children[0].textContent, "原文");
});

test("notice coexists with real lines and the pending placeholder", () => {
  const { overlay, primary, secondary, notice, noticeWrites, clock } = createOverlay();
  overlay.render({
    primaryCues: [{ text: "原文" }],
    secondaryCues: [],
    pending: { secondary: true },
    notice: { text: "AI 服务未配置", kind: "warning" }
  });
  assert.equal(primary.children[0].textContent, "原文");
  assert.equal(secondary.children.length, 0);
  assert.equal(notice.hidden, false);

  clock.advance(200);
  assert.equal(isPlaceholder(secondary.children[0]), true);
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, "AI 服务未配置");

  overlay.render({
    primaryCues: [{ text: "原文" }],
    secondaryCues: [{ text: "译文" }],
    pending: {},
    notice: { text: "AI 服务未配置", kind: "warning" }
  });
  assert.equal(isPlaceholder(secondary.children[0]), false);
  assert.equal(secondary.children[0].textContent, "译文");
  assert.equal(notice.hidden, false);
  assert.equal(noticeWrites.text, 1);

  clock.advance(500);
  assert.equal(secondary.children.length, 1);
  assert.equal(isPlaceholder(secondary.children[0]), false);
  assert.equal(notice.hidden, false);
});

test("notice styling follows the layout preset and free positioning without disturbing them", () => {
  const { overlay, host, root } = createOverlay();
  overlay.applySettings({
    subtitleLayoutPreset: "free",
    primaryVerticalOffset: 30,
    secondaryVerticalOffset: 15,
    primaryFontSize: 32,
    secondaryFontSize: 24,
    primaryMaxWidth: 80,
    secondaryMaxWidth: 70
  });
  assert.equal(host.dataset.layout, "free");
  assert.equal(host.style["--primary-subtitle-offset"], "30vh");
  assert.equal(host.style["--secondary-subtitle-offset"], "15vh");
  assert.equal(host.style["--notice-subtitle-size"], "14px");
  assert.equal(Number.parseInt(host.style["--notice-subtitle-size"], 10) < 24, true);
  assert.equal(host.style["--notice-subtitle-max-width"], "80vw");
  assert.equal(host.style["--notice-subtitle-offset"], "9vh");

  const stacked = createOverlay();
  stacked.overlay.applySettings({
    subtitleLayoutPreset: "compact",
    primaryVerticalOffset: 26,
    secondaryVerticalOffset: 18,
    primaryFontSize: 26,
    secondaryFontSize: 28
  });
  assert.equal(stacked.host.dataset.layout, "stacked");
  assert.equal(stacked.host.style["--subtitle-stack-bottom"], "14vh");
  assert.equal(stacked.host.style["--subtitle-stack-gap"], "4px");
  assert.equal(stacked.host.style["--notice-subtitle-size"], "16px");
  assert.equal(stacked.host.style["--notice-subtitle-offset"], "12vh");
  assert.equal(Number.parseInt(stacked.host.style["--notice-subtitle-size"], 10) < 26, true);

  assert.match(root.html, /\.subtitle-notice \{/);
  assert.match(root.html, /-webkit-line-clamp: 2[\s\S]*?pointer-events: none/);
  assert.match(root.html, /-webkit-line-clamp: 2[\s\S]*?user-select: none/);
  assert.match(root.html, /font-size: var\(--notice-subtitle-size, 16px\)/);
  assert.match(root.html, /max-width: min\(var\(--notice-subtitle-max-width, 86vw\), 1280px\)/);
  assert.match(root.html, /\.subtitle-notice\[hidden\] \{\s*display: none;\s*\}/);
  assert.match(root.html, /\.subtitle-notice\[data-kind="warning"\]/);
  assert.match(root.html, /:host\(\[data-layout="free"\]\) \.subtitle-notice/);
  assert.match(root.html, /bottom: var\(--notice-subtitle-offset, 12vh\)/);

  const html = root.html;
  assert.ok(html.indexOf('data-role="secondary"') < html.indexOf("data-notice"));
});
