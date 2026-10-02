/**
 * [INPUT]: 依赖 Node.js test/vm 与 diagnostics 页面/脚本源码，用真实 diagnostics.html 解析出迷你 DOM 并注入可控浏览器 API（含可失败的 downloads 与可注入的导出框架）
 * [OUTPUT]: 验证报文导出结果只就地写进 #exportStatus（无记录/下载失败/框架未就绪三态均为 data-state=error，成功后清空并收起），全程不调用 window.alert
 * [POS]: scripts 的 diagnostics 行为回归检查，覆盖「导出失败不得用阻塞式弹窗打断检查器」这一可观察契约，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const scriptSource = readFileSync(new URL("../extension/src/diagnostics/diagnostics.js", import.meta.url), "utf8");
const markup = readFileSync(new URL("../extension/src/diagnostics/diagnostics.html", import.meta.url), "utf8");
const locale = JSON.parse(readFileSync(new URL("../extension/_locales/en/messages.json", import.meta.url), "utf8"));

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr", "path", "rect", "circle", "ellipse", "line", "polygon", "stop", "use"
]);

/* ===== 迷你 DOM：解析 diagnostics.html，保证测试与真实结构同构 ===== */

class FakeClassList {
  constructor() {
    this.names = new Set();
  }

  add(...names) { for (const name of names) if (name) this.names.add(name); }
  remove(...names) { for (const name of names) this.names.delete(name); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    const active = force === undefined ? !this.names.has(name) : Boolean(force);
    if (active) this.names.add(name); else this.names.delete(name);
    return active;
  }
}

class FakeTextNode {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.children = [];
    this.parent = null;
  }
}

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.id = attributes.id ?? "";
    this.type = attributes.type ?? "";
    this.nodeType = 1;
    this.children = [];
    this.parent = null;
    this.handlers = new Map();
    this.attributes = new Map(Object.entries(attributes));
    this.dataset = {};
    this.classList = new FakeClassList();
    this.style = {
      setProperty: (name, value) => { this.style[name] = value; },
      removeProperty: (name) => { delete this.style[name]; }
    };
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = Object.hasOwn(attributes, "hidden");
    this.disabled = false;
    this.scrollTop = 0;
    this.contentWindow = undefined;
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      if (name === "class") for (const token of value.split(/\s+/).filter(Boolean)) this.classList.add(token);
      // 内联 style 必须与真实 DOM 一样先落到 style 上（真实页面已不再给 #exportStatus 写内联 display）
      if (name === "style") for (const declaration of value.split(";")) {
        const [property, declarationValue] = declaration.split(":");
        if (property?.trim()) this.style[property.trim()] = (declarationValue ?? "").trim();
      }
    }
  }

  get className() { return [...this.classList.names].join(" "); }
  set className(value) { this.classList.names = new Set(String(value).split(/\s+/).filter(Boolean)); }

  append(...nodes) {
    for (const node of nodes) {
      if (node == null) continue;
      node.parent = this;
      this.children.push(node);
    }
  }

  appendChild(node) { return this.append(node), node; }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.focused = true; }

  get previousElementSibling() {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return index > 0 ? this.parent.children[index - 1] : null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }

  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches?.(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  matches(selector) {
    if (!selector) return false;
    let rest = selector.trim();
    const tag = /^[a-zA-Z][\w-]*/.exec(rest)?.[0];
    if (tag) {
      if (this.localName !== tag.toLowerCase()) return false;
      rest = rest.slice(tag.length);
    }

    let index = 0;
    while (index < rest.length) {
      if (rest[index] === "#") {
        const id = /^[\w-]+/.exec(rest.slice(index + 1))?.[0];
        if (!id || this.id !== id) return false;
        index += id.length + 1;
      } else if (rest[index] === ".") {
        const name = /^[\w-]+/.exec(rest.slice(index + 1))?.[0];
        if (!name || !this.classList.contains(name)) return false;
        index += name.length + 1;
      } else if (rest[index] === "[") {
        const close = rest.indexOf("]", index);
        if (close < 0) return false;
        const [rawName, rawValue] = rest.slice(index + 1, close).split("=");
        const name = rawName.trim();
        const expected = rawValue === undefined ? undefined : rawValue.trim().replace(/^["']|["']$/g, "");
        if (name.startsWith("data-")) {
          const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          if (!(key in this.dataset)) return false;
          if (expected !== undefined && this.dataset[key] !== expected) return false;
        } else {
          if (!this.attributes.has(name)) return false;
          if (expected !== undefined && this.attributes.get(name) !== expected) return false;
        }
        index = close + 1;
      } else {
        return false;
      }
    }
    return true;
  }

  dispatch(type) {
    const detail = { type, target: this, preventDefault() {}, stopPropagation() {} };
    for (const handler of this.handlers.get(type) ?? []) handler(detail);
    return detail;
  }
}

function parseAttributes(text) {
  const attributes = {};
  const pattern = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = pattern.exec(text))) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function parseMarkup(source) {
  const root = new FakeElement("#document");
  const stack = [root];
  const html = source.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  const tagPattern = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let cursor = 0;
  let match;

  while ((match = tagPattern.exec(html))) {
    const text = html.slice(cursor, match.index).trim();
    if (text) {
      const current = stack[stack.length - 1];
      current.textContent = current.textContent ? `${current.textContent} ${text}` : text;
    }
    cursor = tagPattern.lastIndex;

    const [, closing, rawName, attributeText, selfClosing] = match;
    const name = rawName.toLowerCase();
    if (closing) {
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].localName === name) { stack.length = index; break; }
      }
      continue;
    }

    const element = new FakeElement(name, parseAttributes(attributeText));
    stack[stack.length - 1].appendChild(element);
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(element);
  }

  const all = [];
  const collect = (node) => { for (const child of node.children) { all.push(child); collect(child); } };
  collect(root);
  return all;
}

function createDocument() {
  const all = parseMarkup(markup);
  const document = {
    readyState: "loading",
    documentElement: new FakeElement("html"),
    body: all.find((element) => element.localName === "body") ?? new FakeElement("body"),
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => new FakeTextNode(text),
    querySelector: (selector) => all.find((element) => element.matches(selector)) ?? null,
    querySelectorAll: (selector) => all.filter((element) => element.matches(selector)),
    addEventListener() {}
  };
  return { document, all };
}

/* ===== 测试脚手架：加载 diagnostics.js 到假 DOM + 假浏览器 API ===== */

function translate(key, substitutions) {
  const message = locale[key]?.message ?? key;
  const args = substitutions == null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  if (!args.length) return message;
  return message.replace(/\$(\d)/g, (match, index) => (args[Number(index) - 1] === undefined ? match : String(args[Number(index) - 1])));
}

const RECORD = {
  id: 7,
  at: Date.parse("2026-09-29T00:00:00Z"),
  completedAt: Date.parse("2026-09-29T00:00:00Z") + 512,
  validated: true,
  request: {
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [] })
  },
  response: { status: 200, statusText: "OK", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choices: [] }) }
};

function createHarness({ records = [], withDownloads = true, frameReady = false } = {}) {
  const { document, all } = createDocument();
  const byId = new Map(all.filter((element) => element.id).map((element) => [element.id, element]));
  const alerts = [];
  const downloads = [];
  const frameCalls = [];
  const timers = new Map();
  let nextTimerId = 1;

  const runtime = {
    runtime: {
      getURL: (path) => `safari-web-extension://bilayer-app/${path}`,
      sendMessage(message, callback) {
        if (message?.type === "BILAYER_GET_RAW_DIAGNOSTICS") callback({ ok: true, enabled: true, version: 3, records: structuredClone(records) });
        else callback({ ok: true });
      },
      lastError: undefined
    },
    downloads: withDownloads
      ? {
        download(options, callback) {
          downloads.push(structuredClone(options));
          if (failDownloads.value) runtime.runtime.lastError = { message: "download interrupted" };
          callback?.();
          runtime.runtime.lastError = undefined;
        }
      }
      : undefined
  };
  const failDownloads = { value: false };

  const context = {
    browser: runtime,
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    i18n: { t: translate, apply() {}, uiLanguage: () => "en" },
    TextEncoder,
    URL,
    alert: (message) => alerts.push(String(message)),
    setTimeout(callback) { const id = nextTimerId++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  context.window = {
    setInterval(callback) { const id = nextTimerId++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); }
  };
  context.globalThis = context;

  runInNewContext(scriptSource, context, { filename: "diagnostics.js" });

  const exportFrame = document.body.children.find((child) => child.localName === "iframe");
  assert.ok(exportFrame, "diagnostics.js 应把导出框架挂到 body 上");
  if (frameReady) exportFrame.contentWindow = { downloadCases: (filename, text) => frameCalls.push({ filename, text }) };

  return {
    document,
    alerts,
    downloads,
    frameCalls,
    failDownloads,
    element(id) {
      const element = byId.get(id);
      assert.ok(element, `markup 缺少 #${id}`);
      return element;
    },
    status() {
      const node = this.element("exportStatus");
      return { text: node.textContent, state: node.dataset.state ?? "", display: node.style.display ?? "" };
    },
    // 计算样式：行内 display 优先；否则由 diagnostics.css 的两条规则决定
    // （`.live-status { display: inline-flex }` 与 `.live-status:empty { display: none }`）
    statusComputedDisplay() {
      const node = this.element("exportStatus");
      const inline = node.style.display ?? "";
      if (inline) return inline;
      return node.textContent === "" ? "none" : "inline-flex";
    },
    click(id) { this.element(id).dispatch("click"); },
    async flush() {
      for (let index = 0; index < 6; index++) await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

async function createReadyHarness(options) {
  const harness = createHarness(options);
  await harness.flush();
  return harness;
}

const RUBY_RECORD = {
  id: 9,
  at: Date.parse("2026-09-29T00:05:00Z"),
  completedAt: Date.parse("2026-09-29T00:05:00Z") + 640,
  validated: true,
  request: {
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: JSON.stringify({
          sourceLanguage: "ja",
          targetLanguage: "zh-Hans",
          items: [{ id: "42", text: "そろそろ行こう。" }]
        })
      }]
    })
  },
  // 后台允许条目带 ruby（service_worker 对 item.ruby 有兼容分支），诊断页存的是未归一化的原始响应文本
  response: {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({ items: [{ id: "42", text: "该走了。", ruby: "{そろそろ|そろそろ}{行こう|いこう}" }] })
        }
      }]
    })
  }
};

function textOf(node) {
  if (!node) return "";
  if (node.nodeType === 3) return node.textContent;
  const own = node.children.length ? "" : (node.textContent ?? "");
  return own + node.children.map(textOf).join("");
}

/* ===== 导出结果必须就地可见，且不得再调用 window.alert ===== */

test("没有报文记录时导出：状态行就地说明原因，不弹窗", async () => {
  const harness = await createReadyHarness({ records: [] });
  const initial = harness.status();
  assert.deepEqual({ text: initial.text, state: initial.state, display: initial.display }, { text: "", state: "", display: "" }, "初始状态行不得有文案，也不得依赖内联 display");
  assert.equal(harness.statusComputedDisplay(), "none", "初始状态行必须不可见（由 .live-status:empty 收起）");

  harness.click("exportCases");
  assert.equal(harness.alerts.length, 0, `不得再弹阻塞式对话框：${JSON.stringify(harness.alerts)}`);
  assert.deepEqual(harness.status(), { text: translate("diagExportEmpty"), state: "error", display: "" });
  assert.equal(harness.downloads.length, 0, "无记录时不得触发下载");
});

test("下载失败：状态行就地报错并保留已发出的下载请求，不弹窗", async () => {
  const harness = await createReadyHarness({ records: [RECORD] });
  harness.failDownloads.value = true;

  harness.click("exportCases");
  assert.equal(harness.alerts.length, 0, `下载失败分支不得再弹阻塞式对话框：${JSON.stringify(harness.alerts)}`);
  assert.equal(harness.downloads.length, 1, "下载请求照发（saveAs 语义不变）");
  assert.equal(harness.downloads[0].saveAs, true);
  assert.match(harness.downloads[0].filename, /^netflix-subtitles-cases-.*\.json$/);
  assert.deepEqual(harness.status(), { text: translate("diagExportFailed"), state: "error", display: "" });

  // 下一次成功导出必须清掉上一次的失败说明并收回状态行
  harness.failDownloads.value = false;
  harness.click("exportCases");
  assert.deepEqual(harness.status(), { text: "", state: "", display: "none" });
  assert.equal(harness.alerts.length, 0, `不得再弹阻塞式对话框：${JSON.stringify(harness.alerts)}`);
});

test("下载 API 缺失且导出框架未就绪：状态行就地报错，不弹窗", async () => {
  const harness = await createReadyHarness({ records: [RECORD], withDownloads: false, frameReady: false });

  harness.click("exportCases");
  assert.equal(harness.alerts.length, 0, `框架未就绪分支不得再弹阻塞式对话框：${JSON.stringify(harness.alerts)}`);
  assert.equal(harness.frameCalls.length, 0, "框架未就绪时不得调用 downloadCases");
  assert.deepEqual(harness.status(), { text: translate("diagExportNotReady"), state: "error", display: "" });
  assert.equal(harness.alerts.length, 0, `不得再弹阻塞式对话框：${JSON.stringify(harness.alerts)}`);
});

test("框架就绪时导出交给框架且不留提示，不弹窗", async () => {
  const harness = await createReadyHarness({ records: [RECORD], withDownloads: false, frameReady: true });

  harness.click("exportCases");
  assert.equal(harness.frameCalls.length, 1, "框架就绪时应由同源框架触发下载");
  assert.match(harness.frameCalls[0].filename, /^netflix-subtitles-cases-.*\.json$/);
  assert.match(harness.frameCalls[0].text, /"id": 7/, "导出的是当前记录的全量报文");
  assert.deepEqual(harness.status(), { text: "", state: "", display: "none" });
  assert.equal(harness.alerts.length, 0);
});

test("响应 items 带 ruby 且无 readings 时，「渲染为 UI」逐字渲染注音且不抛异常", async () => {
  const harness = await createReadyHarness({ records: [RUBY_RECORD] });
  const uiTab = harness.document.querySelector('[data-payload="ui"]');
  const responseTab = harness.document.querySelector('[data-payload="response"]');
  assert.ok(uiTab && responseTab, "payload 页签应存在于 markup 中");

  // 修复前这里直接抛 ReferenceError: rubyPattern is not defined，整块报文区空白
  uiTab.dispatch("click");
  const view = harness.element("payloadView");
  assert.equal(view.querySelectorAll("ruby").length, 2, "两个 {kanji|kana} 片段都应渲染成 <ruby>");
  assert.deepEqual(view.querySelectorAll("rt").map((rt) => rt.textContent), ["そろそろ", "いこう"]);
  assert.match(textOf(view), /该走了。/, "译文行照旧渲染");
  const first = textOf(view);

  // 幂等：切回原文再切回 UI，逐字一致（共享带 g 的正则会在第二次调用时残留 lastIndex 而截断）
  responseTab.dispatch("click");
  uiTab.dispatch("click");
  assert.equal(textOf(view), first, "第二次渲染必须与第一次逐字一致");
  assert.equal(view.querySelectorAll("ruby").length, 2);
});
