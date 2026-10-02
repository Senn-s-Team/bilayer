/**
 * [INPUT]: 依赖 Node.js test/vm、真实 diagnostics 页面/完整脚本与 en/zh_CN 文案，注入迷你 DOM、后台记录、剪贴板、可失败的 downloads 与同源导出框架边界
 * [OUTPUT]: 验证双语条数状态与精确字幕复制、导出失败就地可见及成功收起、完整报文下载与 ruby 注音重复渲染
 * [POS]: scripts 的诊断页行为回归检查，共用真实 markup 的动态 DOM，通过页面初始化、点击、剪贴板和下载观察结果，不访问私有函数
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const scriptSource = readFileSync(new URL("../extension/src/diagnostics/diagnostics.js", import.meta.url), "utf8");
const markup = readFileSync(new URL("../extension/src/diagnostics/diagnostics.html", import.meta.url), "utf8");
const locales = Object.fromEntries(["en", "zh_CN"].map((language) => [language,
  JSON.parse(readFileSync(new URL(`../extension/_locales/${language}/messages.json`, import.meta.url), "utf8"))
]));
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/* ===== 迷你 DOM：真实 markup 与动态 innerHTML 共用解析器 ===== */

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name]);
}

function escapeMarkup(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function serializeNode(node) {
  if (!node.localName) return escapeMarkup(node.textContent);
  const attributes = [...node.attributes].map(([name, value]) => ` ${name}="${escapeMarkup(value)}"`).join("");
  const opening = `<${node.localName}${attributes}>`;
  return VOID_TAGS.has(node.localName) ? opening : `${opening}${node.innerHTML}</${node.localName}>`;
}

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.localName = tagName.toLowerCase();
    this.attributes = new Map(Object.entries(attributes));
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.handlers = new Map();
    this.hidden = Object.hasOwn(attributes, "hidden");
    this.value = attributes.value ?? "";
    this.scrollTop = 0;
    this.contentWindow = undefined;
    this.style = {};
    this.classes = new Set((attributes.class ?? "").split(/\s+/).filter(Boolean));
    this.classList = {
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const active = force === undefined ? !this.classes.has(name) : Boolean(force);
        if (active) this.classes.add(name); else this.classes.delete(name);
        return active;
      }
    };
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      if (name === "style") for (const declaration of value.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon >= 0) this.style[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
    }
  }

  get className() { return [...this.classes].join(" "); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get textContent() { return this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren({ textContent: String(value) }); }
  get innerHTML() { return this.children.map(serializeNode).join(""); }
  set innerHTML(value) { this.replaceChildren(...parseMarkup(value).children); }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    for (const node of this.children) node.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  matches(selector) {
    if (selector.startsWith("#")) return this.getAttribute("id") === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      const value = this.getAttribute(attribute[1]);
      return value !== null && (attribute[2] === undefined || value === attribute[2]);
    }
    return this.localName === selector;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if (child.matches?.(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  async click() {
    const event = { type: "click", target: this, preventDefault() {} };
    for (let node = this; node; node = node.parentElement) {
      event.currentTarget = node;
      for (const handler of node.handlers.get("click") ?? []) await handler(event);
    }
  }
}

function parseMarkup(source) {
  const root = new FakeElement("#document");
  const stack = [root];
  const html = source.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  const pattern = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(html))) {
    const text = html.slice(cursor, match.index);
    if (text) stack.at(-1).append({ textContent: decodeEntities(text) });
    cursor = pattern.lastIndex;
    const [, closing, rawName, attributeText, selfClosing] = match;
    const name = rawName.toLowerCase();
    if (closing) {
      if (stack.at(-1).localName === name) stack.pop();
      continue;
    }
    const attributes = {};
    for (const entry of attributeText.matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attributes[entry[1].toLowerCase()] = decodeEntities(entry[2] ?? entry[3] ?? entry[4] ?? "");
    }
    const element = new FakeElement(name, attributes);
    stack.at(-1).append(element);
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(element);
  }
  if (cursor < html.length) stack.at(-1).append({ textContent: decodeEntities(html.slice(cursor)) });
  return root;
}

/* ===== 页面边界：完整初始化、真实文案与可控后台/下载 ===== */

function substitute(message, args = []) {
  return message.replace(/\$(\d)/g, (match, index) => args[Number(index) - 1] === undefined ? match : String(args[Number(index) - 1]));
}

async function createDiagnostics(language, records, { withDownloads = true, frameReady = false } = {}) {
  const document = parseMarkup(markup);
  document.body = document.querySelector("body");
  document.createElement = (name) => new FakeElement(name);
  document.createTextNode = (text) => ({ textContent: String(text) });
  const clipboard = [];
  const alerts = [];
  const downloads = [];
  const frameCalls = [];
  const failDownloads = { value: false };
  const timers = [];
  const bundle = locales[language];
  const t = (key, args) => {
    assert.ok(bundle[key]?.message, `${language} 文案缺少 ${key}`);
    return substitute(bundle[key].message, args);
  };
  const runtime = {
    runtime: {
      getURL: (path) => `safari-web-extension://bilayer-app/${path}`,
      sendMessage(message, callback) {
        if (message.type === "BILAYER_SET_RAW_DIAGNOSTICS") callback({ ok: true });
        else if (message.type === "BILAYER_GET_RAW_DIAGNOSTICS") callback({ ok: true, enabled: true, version: 1, records: structuredClone(records) });
        else assert.fail(`未支持的诊断消息 ${message.type}`);
      },
      lastError: undefined
    },
    downloads: withDownloads ? {
      download(options, callback) {
        downloads.push(structuredClone(options));
        if (failDownloads.value) runtime.runtime.lastError = { message: "download interrupted" };
        try {
          callback?.();
        } finally {
          runtime.runtime.lastError = undefined;
        }
      }
    } : undefined
  };
  const alert = (message) => alerts.push(String(message));
  runInNewContext(scriptSource, {
    document,
    browser: runtime,
    i18n: { t },
    navigator: { clipboard: { async writeText(text) { clipboard.push(text); } } },
    TextEncoder,
    URL,
    alert,
    window: { alert, setInterval(callback, delay) { timers.push({ callback, delay }); return timers.length; } },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }
  }, { filename: "diagnostics.js" });
  const exportFrame = document.body.querySelector("iframe");
  assert.ok(exportFrame, "完整脚本必须创建导出框架");
  if (frameReady) exportFrame.contentWindow = { downloadCases: (filename, text) => frameCalls.push({ filename, text }) };
  // init() 的消息回调与 await 全部通过事件循环落地，不调用脚本内部函数。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector("#recordCount").textContent, String(records.length));
  return { document, clipboard, alerts, downloads, frameCalls, failDownloads, exportFrame, t };
}

function recordFor(items, failure) {
  return {
    id: 17,
    at: 1700000000000,
    completedAt: 1700000000123,
    validated: !failure,
    ...(failure ? { failure: { errorCode: "invalid_response", reason: "items_mismatch", ...failure } } : {}),
    request: {
      method: "POST", url: "https://example.invalid/v1/chat/completions", headers: {},
      body: JSON.stringify({ model: "synthetic-model", messages: [{ role: "user", content: JSON.stringify({
        sourceLanguage: "en", targetLanguage: "zh-Hans",
        items: [{ id: "cue-41", text: "The synthetic lamp is blue." }, { id: "cue-42", text: "The synthetic door is open." }]
      }) }] })
    },
    response: {
      status: 200, statusText: "OK", headers: {},
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(items) } }] })
    }
  };
}

async function expectDisplayedStatus(page, expected) {
  const row = page.document.querySelector("#recordList").querySelector(".record-item");
  assert.ok(row, "后台记录必须显示为可选请求行");
  assert.equal(row.querySelector(".record-state").querySelector("em").textContent, expected, "请求列表状态");
  await row.click();
  assert.equal(page.document.querySelector("#detailContent").hidden, false);
  assert.equal(page.document.querySelector("#detailResult").textContent, expected, "选中请求的详情状态");
}

/* ===== 双语状态语义：只有已知且不相等的非负整数才表示条数不符 ===== */

for (const language of ["en", "zh_CN"]) {
  for (const [expectedCount, receivedCount] of [[2, 1], [2, 0], [0, 1]]) {
    test(`${language}: 列表与详情保留已知不等条数 ${expectedCount}/${receivedCount}`, async () => {
      const page = await createDiagnostics(language, [recordFor([], { expectedCount, receivedCount })]);
      await expectDisplayedStatus(page, page.t("diagStatusCountMismatch", ["invalid_response", expectedCount, receivedCount]));
    });
  }

  const validationCases = [
    ["同条数但错误 ID", { expectedCount: 2, receivedCount: 2 }],
    ["条数都缺失", {}],
    ["条数都是 null", { expectedCount: null, receivedCount: null }],
    ["只知道期望条数", { expectedCount: 2 }],
    ["实际条数为 null", { expectedCount: 2, receivedCount: null }],
    ["只知道实际条数", { receivedCount: 1 }],
    ["期望条数为 null", { expectedCount: null, receivedCount: 1 }],
    ["条数是字符串", { expectedCount: "2", receivedCount: 1 }],
    ["条数为负数", { expectedCount: 2, receivedCount: -1 }],
    ["条数不是整数", { expectedCount: 2, receivedCount: 0.5 }]
  ];
  for (const [description, counts] of validationCases) {
    test(`${language}: ${description}显示通用校验失败，不推测条数`, async () => {
      const record = recordFor([{ id: "wrong-41", text: "合成译文甲" }, { id: "wrong-42", text: "合成译文乙" }], counts);
      const page = await createDiagnostics(language, [record]);
      await expectDisplayedStatus(page, page.t("diagStatusValidationFailed", ["invalid_response"]));
    });
  }

  test(`${language}: UI 页签复制顶层数组中的精确字幕 ID 和译文`, async () => {
    const id = "cue-41";
    const translation = "合成台灯是蓝色的。";
    const page = await createDiagnostics(language, [recordFor([{ id, text: translation }])]);
    await page.document.querySelector('[data-payload="ui"]').click();
    assert.equal(page.document.querySelector("#payloadView").querySelector(".ui-card-id").textContent, `#${id}`);
    assert.equal(page.document.querySelector("#payloadView").querySelector(".ui-trans-row").textContent, translation);
    await page.document.querySelector("#copyPayload").click();
    assert.deepEqual(page.clipboard, [
      `[#${id}]\n${page.t("diagCopySourceLabel", [translation])}\n${page.t("diagCopyTargetLabel", [translation])}`
    ]);
    assert.equal(page.document.querySelector("#copyPayload").textContent, page.t("diagCopied"));
  });
}

/* ===== 导出结果：失败就地可见，成功清空并收起，不弹阻塞式窗口 ===== */

function expectExportStatus(page, key) {
  const status = page.document.querySelector("#exportStatus");
  assert.equal(status.textContent, key ? page.t(key) : "");
  assert.equal(status.dataset.state ?? "", key ? "error" : "");
  assert.equal(status.hidden, false);
  if (key) assert.notEqual(status.style.display, "none", "失败说明必须可见");
  else assert.equal(status.style.display, "none", "成功后状态行必须收起");
  assert.deepEqual(page.alerts, [], "导出不得触发阻塞式弹窗");
}

const EXPORT_RECORD = recordFor([{ id: "cue-41", text: "合成台灯是蓝色的。" }]);

test("没有报文记录时导出：状态行就地说明原因，不弹窗", async () => {
  const page = await createDiagnostics("en", []);
  await page.document.querySelector("#exportCases").click();
  expectExportStatus(page, "diagExportEmpty");
  assert.deepEqual(page.downloads, [], "无记录时不得触发下载");
  assert.deepEqual(page.frameCalls, [], "无记录时不得交给框架下载");
});

test("下载失败：状态行就地报错，重试成功后收起，不弹窗", async () => {
  const page = await createDiagnostics("en", [EXPORT_RECORD]);
  page.failDownloads.value = true;
  await page.document.querySelector("#exportCases").click();
  expectExportStatus(page, "diagExportFailed");
  assert.equal(page.downloads.length, 1, "失败仍须保留发出的下载请求");
  assert.equal(page.downloads[0].saveAs, true);
  assert.match(page.downloads[0].filename, /^netflix-subtitles-cases-.*\.json$/);
  const prefix = "data:application/json;charset=utf-8,";
  assert.ok(page.downloads[0].url.startsWith(prefix));
  assert.deepEqual(JSON.parse(decodeURIComponent(page.downloads[0].url.slice(prefix.length))), [EXPORT_RECORD], "下载应包含完整记录");

  page.failDownloads.value = false;
  await page.document.querySelector("#exportCases").click();
  assert.equal(page.downloads.length, 2, "重试必须再次发出下载请求");
  expectExportStatus(page);
});

test("下载 API 缺失且导出框架未就绪：状态行就地报错，不弹窗", async () => {
  const page = await createDiagnostics("en", [EXPORT_RECORD], { withDownloads: false });
  await page.document.querySelector("#exportCases").click();
  expectExportStatus(page, "diagExportNotReady");
  assert.deepEqual(page.frameCalls, [], "框架未就绪时不得调用 downloadCases");
  assert.deepEqual(page.downloads, []);
});

test("框架就绪时导出交给框架且清除失败提示，不弹窗", async () => {
  const page = await createDiagnostics("en", [EXPORT_RECORD], { withDownloads: false, frameReady: true });
  const readyWindow = page.exportFrame.contentWindow;
  page.exportFrame.contentWindow = undefined;
  await page.document.querySelector("#exportCases").click();
  expectExportStatus(page, "diagExportNotReady");

  page.exportFrame.contentWindow = readyWindow;
  await page.document.querySelector("#exportCases").click();
  assert.equal(page.frameCalls.length, 1, "框架就绪时应由同源框架触发下载");
  assert.match(page.frameCalls[0].filename, /^netflix-subtitles-cases-.*\.json$/);
  assert.deepEqual(JSON.parse(page.frameCalls[0].text), [EXPORT_RECORD], "框架应收到完整记录");
  assert.deepEqual(page.downloads, []);
  expectExportStatus(page);
});

/* ===== ruby：兼容无 readings 的响应，切换页签后仍逐字一致 ===== */

const RUBY_RECORD = {
  id: 9,
  at: Date.parse("2026-09-29T00:05:00Z"),
  completedAt: Date.parse("2026-09-29T00:05:00Z") + 640,
  validated: true,
  request: {
    url: "https://example.invalid/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "synthetic-model",
      messages: [{
        role: "user",
        content: JSON.stringify({
          sourceLanguage: "ja", targetLanguage: "zh-Hans",
          items: [{ id: "42", text: "そろそろ行こう。" }]
        })
      }]
    })
  },
  response: {
    status: 200, statusText: "OK", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choices: [{ message: {
      role: "assistant",
      content: JSON.stringify({ items: [{ id: "42", text: "该走了。", ruby: "{そろそろ|そろそろ}{行こう|いこう}" }] })
    } }] })
  }
};

test("响应 items 带 ruby 且无 readings 时，UI 注音与译文重复渲染逐字一致", async () => {
  const page = await createDiagnostics("en", [RUBY_RECORD]);
  const uiTab = page.document.querySelector('[data-payload="ui"]');
  const responseTab = page.document.querySelector('[data-payload="response"]');
  await uiTab.click();
  const view = page.document.querySelector("#payloadView");
  assert.equal(view.querySelectorAll("ruby").length, 2);
  assert.deepEqual(view.querySelectorAll("rt").map((rt) => rt.textContent), ["そろそろ", "いこう"]);
  assert.equal(view.querySelector(".ui-ruby-row").textContent, "そろそろそろそろ行こういこう");
  assert.equal(view.querySelector(".ui-trans-row").textContent, "该走了。");
  const first = view.textContent;

  await responseTab.click();
  await uiTab.click();
  assert.equal(view.textContent, first, "切换回 UI 后必须逐字一致");
  assert.equal(view.querySelectorAll("ruby").length, 2);
  assert.deepEqual(view.querySelectorAll("rt").map((rt) => rt.textContent), ["そろそろ", "いこう"]);
});
