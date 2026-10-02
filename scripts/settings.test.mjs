/**
 * [INPUT]: 依赖 Node.js test/vm 与 settings 页面/脚本源码，用真实 settings.html 解析出迷你 DOM 并注入可控 Safari API、可控存储与假定时器
 * [OUTPUT]: 验证常驻窗口的轮询可见性门控（隐藏期间不读取标签页、重新可见立即补一轮且链不停摆）与 providers 整数组写入的读-改-写合并（单点修改/新增/删除都保留其它表面在此期间写入的服务）
 * [POS]: scripts 的 settings 行为回归检查，覆盖从工具栏弹窗迁移为常驻窗口后的轮询与设置写入语义，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const scriptSource = readFileSync(new URL("../extension/src/settings/settings.js", import.meta.url), "utf8");
const markup = readFileSync(new URL("../extension/src/settings/settings.html", import.meta.url), "utf8");
const locale = JSON.parse(readFileSync(new URL("../extension/_locales/en/messages.json", import.meta.url), "utf8"));

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr", "path", "rect", "circle", "ellipse", "line", "polygon", "stop", "use"
]);

/* ===== 迷你 DOM：解析 settings.html，保证测试与真实结构同构 ===== */

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

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.id = attributes.id ?? "";
    this.type = attributes.type ?? "";
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
    this.hidden = Object.hasOwn(attributes, "hidden");
    this.disabled = false;
    this.title = attributes.title ?? "";
    this._value = "";
    this._valueSet = false;
    if (attributes.value !== undefined || this.localName !== "select") this.value = attributes.value ?? "";
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;

    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      if (name === "class") for (const token of value.split(/\s+/).filter(Boolean)) this.classList.add(token);
    }
  }

  get className() { return [...this.classList.names].join(" "); }
  set className(value) { this.classList.names = new Set(String(value).split(/\s+/).filter(Boolean)); }

  get value() {
    if (this._valueSet) return this._value;
    if (this.localName === "select") return this.children.find((child) => child.localName === "option")?.getAttribute("value") ?? "";
    return this.attributes.get("value") ?? "";
  }

  set value(value) {
    this._value = value;
    this._valueSet = true;
  }

  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    return node;
  }

  // <select> 的 add(new Option(...)) 语义：与 appendChild 等价
  add(node) { return this.appendChild(node); }

  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) this.appendChild(node);
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
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
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

  dispatch(type, event = {}) {
    const detail = { type, target: this, preventDefault() {}, stopPropagation() {}, key: undefined, ...event };
    // 真实 DOM 的 click 会冒泡：事件委托（如模型列表点击）依赖这一行为
    for (let node = this; node; node = node.parent) {
      detail.currentTarget = node;
      for (const handler of node.handlers.get(type) ?? []) handler(detail);
      node[`on${type}`]?.(detail);
      if (node.document) node.document.dispatch(type, detail);
    }
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
  const listeners = new Map();
  const document = {
    readyState: "loading",
    hidden: false,
    documentElement: new FakeElement("html"),
    body: all.find((element) => element.localName === "body") ?? new FakeElement("body"),
    createElement: (tagName) => new FakeElement(tagName),
    querySelector: (selector) => all.find((element) => element.matches(selector)) ?? null,
    querySelectorAll: (selector) => all.filter((element) => element.matches(selector)),
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event) { for (const handler of listeners.get(type) ?? []) handler({ type, ...event }); }
  };
  // 让冒泡链在根节点处继续落到 document 监听器上
  const root = all[0]?.parent;
  if (root) root.document = document;
  return { document, all };
}

/* ===== 测试脚手架：加载 settings.js 到假 DOM + 假 Safari API + 共享存储 ===== */

function translate(key, substitutions) {
  const message = locale[key]?.message ?? key;
  const args = substitutions == null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  if (!args.length) return message;
  return message.replace(/\$(\d)/g, (match, index) => (args[Number(index) - 1] === undefined ? match : String(args[Number(index) - 1])));
}

const PROVIDER_A = { id: "openai", name: "OpenAI", endpoint: "", model: "gpt-4o-mini", credential: "sk-stored" };
const PROVIDER_B = { id: "deepseek", name: "DeepSeek", endpoint: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", credential: "sk-other" };

const WATCH_STATE = {
  url: "https://www.netflix.com/watch/80000001",
  watchId: "80000001",
  tracks: [
    { key: "track-en", label: "English", language: "en", type: "subtitles" },
    { key: "track-ja", label: "日本語", language: "ja", type: "subtitles" }
  ],
  loadStatus: { primary: { cueCount: 12 }, secondary: { cueCount: 12 } },
  subtitleAvailability: "available",
  providerReadiness: { configured: true, notice: "" }
};

function createPopup({ stored = {}, queryResult = [{ id: 7, url: "https://www.netflix.com/watch/80000001" }], pageState = WATCH_STATE, grantPermissions = true } = {}) {
  const { document, all } = createDocument();
  const byId = new Map(all.filter((element) => element.id).map((element) => [element.id, element]));
  const writes = [];
  const tabCalls = [];
  const stateReads = [];
  const messages = [];
  const permissionRequests = [];
  const timers = new Map();
  const storageState = structuredClone({ providers: [PROVIDER_A], aiRole: "off", ...stored });
  let nextTimerId = 1;
  let nextUuid = 1;

  const storage = {
    get(defaults, callback) {
      callback({ ...(defaults && typeof defaults === "object" ? structuredClone(defaults) : {}), ...structuredClone(storageState) });
    },
    set(patch, callback) {
      writes.push(structuredClone(patch));
      Object.assign(storageState, structuredClone(patch));
      callback?.();
    }
  };

  const runtime = {
    storage: { local: storage },
    runtime: {
      getURL: (path) => `safari-web-extension://bilayer-app/${path}`,
      sendMessage(message, callback) { messages.push({ message: structuredClone(message), callback }); },
      lastError: undefined
    },
    permissions: { request(request, callback) { permissionRequests.push(structuredClone(request)); callback(grantPermissions); } },
    tabs: {
      query(info, callback) {
        tabCalls.push({ type: "query", info: structuredClone(info) });
        callback(structuredClone(queryResult));
      },
      sendMessage(tabId, message, callback) {
        stateReads.push({ tabId, type: message?.type });
        callback(typeof pageState === "function" ? pageState(message) : structuredClone(pageState));
      },
      create(details, callback) { tabCalls.push({ type: "create", details: structuredClone(details) }); callback?.({ id: 99 }); }
    }
  };

  const location = { href: "safari-web-extension://bilayer-app/src/settings/settings.html" };
  const window = {
    closed: false,
    open() { return null; },
    addEventListener() {}
  };

  const alerts = [];
  const context = {
    browser: runtime,
    document,
    location,
    window,
    i18n: { t: translate, apply() {}, uiLanguage: () => "en" },
    URL,
    crypto: { randomUUID: () => `draft-${nextUuid++}` },
    alert: (message) => alerts.push(String(message)),
    setTimeout(callback, delay = 0) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    queueMicrotask
  };
  context.globalThis = context;

  runInNewContext(scriptSource, context, { filename: "settings.js" });

  return {
    document,
    elements: byId,
    writes,
    tabCalls,
    stateReads,
    messages,
    permissionRequests,
    storageState,
    alerts,
    element(id) {
      const element = byId.get(id);
      assert.ok(element, `markup 缺少 #${id}`);
      return element;
    },
    queries() { return tabCalls.filter((call) => call.type === "query"); },
    // 模拟另一个表面（新手向导等）在 popup 打开期间直接写入存储
    external(patch) { Object.assign(storageState, structuredClone(patch)); },
    advance(ms) {
      for (let guard = 0; guard < 200; guard++) {
        const due = [...timers.entries()].filter(([, timer]) => timer.delay <= ms);
        if (!due.length) return;
        for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
      }
    },
    // async 处理函数在首个 await 后才会继续，需要让出事件循环让微任务落地
    async flush() {
      for (let index = 0; index < 6; index++) await new Promise((resolve) => setImmediate(resolve));
    },
    fireDocument(type) { document.dispatch(type, {}); },
    click(id) { this.element(id).dispatch("click"); },
    change(id, value) {
      const element = this.element(id);
      element.value = value;
      element.dispatch("change");
    },
    reply(index, result) {
      const message = messages[index];
      assert.ok(message, `未发出第 ${index} 条扩展消息`);
      message.callback?.(result);
      return message;
    },
    storedProviders() { return storageState.providers; }
  };
}

async function createReadyPopup(options) {
  const popup = createPopup(options);
  await popup.flush();
  return popup;
}

function modelOption(popup, model) {
  const option = popup.element("providerModelList").children.find((child) => child.textContent === model);
  assert.ok(option, `模型列表缺少 ${model}`);
  return option;
}

/* ===== providers 整数组写入必须读-改-写 ===== */

test("其它表面新增服务后，设置页改当前服务的模型不得抹掉新服务", async () => {
  const popup = await createReadyPopup({ stored: { providers: [PROVIDER_A], aiRole: "off" } });
  assert.equal(popup.element("providerName").value, PROVIDER_A.name, "初始化应看到已保存的唯一服务");

  // 初始化之后，另一个表面（新手向导同样整数组写 providers）新增了服务
  popup.external({ providers: [PROVIDER_A, PROVIDER_B] });

  // 用户打开模型菜单（options）并选一个模型
  popup.click("providerModel");
  await popup.flush();
  const fetchRequest = popup.messages.findIndex((entry) => entry.message.type === "BILAYER_LIST_MODELS");
  assert.ok(fetchRequest >= 0, "打开模型菜单应请求模型目录");
  popup.reply(fetchRequest, { ok: true, models: ["gpt-4o", "gpt-4o-mini"] });
  await popup.flush();

  modelOption(popup, "gpt-4o").dispatch("click");
  await popup.flush();

  const providers = popup.storedProviders();
  const written = popup.writes.at(-1);
  assert.deepEqual(written.providers.map((provider) => provider.id), ["openai", "deepseek"],
    `写回的服务列表丢失了其它表面新增的服务：${JSON.stringify(providers)}`);
  const updated = providers.find((provider) => provider.id === "openai");
  assert.equal(updated.model, "gpt-4o", "选中的模型必须落到存储里");
  assert.equal(updated.name, PROVIDER_A.name);
  assert.equal(updated.credential, PROVIDER_A.credential, "不得改动同一服务的其它字段");
  assert.deepEqual(providers.find((provider) => provider.id === "deepseek"), PROVIDER_B, "新增服务必须原样保留");
});

test("新增与删除服务同样基于存储最新列表合并", async () => {
  const popup = await createReadyPopup({ stored: { providers: [PROVIDER_A, PROVIDER_B], aiProviderId: "openai" } });

  // 初始化之后，另一个表面改写了服务列表（新增 C）
  const providerC = { id: "groq", name: "Groq", endpoint: "", model: "llama-3.3-70b-versatile", credential: "sk-c" };
  popup.external({ providers: [PROVIDER_A, PROVIDER_B, providerC] });

  // 新增草案服务
  popup.click("addProvider");
  popup.change("newDraftName", "My Endpoint");
  popup.change("newDraftKey", "sk-draft");
  popup.click("saveNewDraftBtn");
  await popup.flush();

  const afterSave = popup.storedProviders();
  assert.deepEqual(afterSave.map((provider) => provider.id), ["openai", "deepseek", "groq", "draft-1"],
    `新增服务时丢失了其它表面写入的服务：${JSON.stringify(afterSave)}`);

  // 删除当前服务（刚新增的草案），回退到列表首个服务，且不得丢掉 C
  popup.click("deleteProvider");
  await popup.flush();

  const afterDelete = popup.storedProviders();
  assert.deepEqual(afterDelete.map((provider) => provider.id), ["openai", "deepseek", "groq"],
    `删除服务时丢失了其它表面写入的服务：${JSON.stringify(afterDelete)}`);
  assert.equal(popup.writes.at(-1).aiProviderId, "openai", "删除当前服务后 aiProviderId 仍回退到首个服务");
});

/* ===== 常驻窗口的轮询可见性门控 ===== */

test("窗口隐藏时不发起标签页读取，重新可见立即补一轮且轮询链继续", async () => {
  const popup = await createReadyPopup({ stored: { providers: [PROVIDER_A], aiRole: "secondary", aiProviderId: "openai" } });
  const readsAfterInit = popup.stateReads.length;
  const queriesPerRead = popup.queries().length / readsAfterInit;

  // 首轮（350ms）完成一次状态读取，AI 模式在播放页上应继续轮询
  popup.advance(400);
  await popup.flush();
  assert.equal(popup.stateReads.length, readsAfterInit + 1, "首轮应完成一次状态读取");
  assert.equal(popup.queries().length, (readsAfterInit + 1) * queriesPerRead, "每轮状态读取都要走完全部回退查询");

  // 隐藏：定时器仍会到期，但不得再读取任何标签页
  popup.document.hidden = true;
  const queriesWhileHidden = popup.queries().length;
  const readsWhileHidden = popup.stateReads.length;
  popup.advance(10000);
  await popup.flush();
  assert.equal(popup.queries().length, queriesWhileHidden, "隐藏期间不得调用 tabs.query");
  assert.equal(popup.stateReads.length, readsWhileHidden, "隐藏期间不得向标签页发消息");

  // 重新可见：visibilitychange 立即补一轮
  popup.document.hidden = false;
  popup.fireDocument("visibilitychange");
  popup.advance(400);
  await popup.flush();
  assert.ok(popup.queries().length > queriesWhileHidden, "重新可见后应立刻读取标签页");
  assert.equal(popup.stateReads.length, readsWhileHidden + 1, "重新可见后应产生一轮状态读取");

  // 并且链没有因此永久停摆：下一轮按既有节奏继续
  popup.advance(1000);
  await popup.flush();
  assert.equal(popup.stateReads.length, readsWhileHidden + 2, "恢复后的轮询链应继续按既有节奏运行");
});

/* ===== 新增服务草案的失败提示必须就地可见，且不得再调用 window.alert ===== */

function draftStatus(popup) {
  const status = popup.element("newDraftStatus");
  return { text: status.textContent, state: status.dataset.state ?? "", hidden: Boolean(status.hidden) };
}

function listModelRequests(popup) {
  return popup.messages.filter((entry) => entry.message.type === "BILAYER_LIST_MODELS");
}

test("草案端点非法：保存与获取模型都就地报错，不写存储也不弹窗", async () => {
  const popup = await createReadyPopup({});
  popup.click("addProvider");
  assert.deepEqual(draftStatus(popup), { text: "", state: "", hidden: true }, "打开草案应回到无提示状态");

  // 保存分支：normalizeProviderEndpoint 抛错
  popup.change("newDraftEndpoint", "not a url");
  popup.change("newDraftKey", "sk-draft");
  popup.click("saveNewDraftBtn");
  await popup.flush();
  assert.equal(popup.alerts.length, 0, `保存分支不得再弹阻塞式对话框：${JSON.stringify(popup.alerts)}`);
  assert.deepEqual(draftStatus(popup), { text: translate("providerValidEndpoint"), state: "error", hidden: false });
  assert.equal(popup.storedProviders().length, 1, "端点非法时不得写入新服务");
  assert.equal(popup.element("providerNewDraftView").hidden, false, "校验失败后仍停在草案视图");

  // 获取模型分支：同一条校验错误就地覆盖显示
  popup.change("newDraftEndpoint", "https://api.example.com/v1?token=1");
  popup.click("fetchNewDraftModels");
  await popup.flush();
  assert.equal(popup.alerts.length, 0, `获取模型分支不得再弹阻塞式对话框：${JSON.stringify(popup.alerts)}`);
  assert.deepEqual(draftStatus(popup), { text: translate("providerValidEndpoint"), state: "error", hidden: false });
  assert.equal(listModelRequests(popup).length, 0, "端点非法时不得请求模型目录");

  assert.equal(popup.alerts.length, 0, `不得再弹阻塞式对话框：${JSON.stringify(popup.alerts)}`);
});

test("草案缺少密钥：就地提示并把焦点交给密钥输入，不弹窗", async () => {
  const popup = await createReadyPopup({});
  popup.click("addProvider");
  popup.click("fetchNewDraftModels");
  await popup.flush();

  assert.equal(popup.alerts.length, 0, `缺密钥分支不得再弹阻塞式对话框：${JSON.stringify(popup.alerts)}`);
  assert.deepEqual(draftStatus(popup), { text: translate("providerNeedKeyToList"), state: "error", hidden: false });
  assert.equal(popup.element("newDraftKey").focused, true, "焦点行为保持不变");
  assert.equal(listModelRequests(popup).length, 0, "缺密钥时不得请求模型目录");
});

test("草案端点域名未授权：就地提示，不弹窗也不发消息", async () => {
  const popup = await createReadyPopup({ grantPermissions: false });
  popup.click("addProvider");
  popup.change("newDraftEndpoint", "https://api.example.com/v1");
  popup.change("newDraftKey", "sk-draft");
  popup.click("fetchNewDraftModels");
  await popup.flush();

  assert.equal(popup.alerts.length, 0, `未授权分支不得再弹阻塞式对话框：${JSON.stringify(popup.alerts)}`);
  assert.deepEqual(popup.permissionRequests, [{ origins: ["https://api.example.com/*"] }], "授权请求本身不变");
  assert.deepEqual(draftStatus(popup), { text: translate("providerEndpointDeniedModels"), state: "error", hidden: false });
  assert.equal(listModelRequests(popup).length, 0, "未授权时不得请求模型目录");
  assert.equal(popup.element("fetchNewDraftModels").disabled, false, "被拒后按钮不得停在禁用态");
});

test("模型目录拉取失败就地提示，重试成功后状态清空且目录落入菜单", async () => {
  const popup = await createReadyPopup({});
  popup.click("addProvider");
  popup.change("newDraftKey", "sk-draft");
  popup.click("fetchNewDraftModels");
  await popup.flush();
  assert.deepEqual(draftStatus(popup), { text: "", state: "", hidden: true }, "进入拉取态先清掉旧提示");
  assert.equal(popup.element("fetchNewDraftModels").disabled, true, "拉取期间按钮保持禁用");

  popup.reply(0, { ok: false, errorCode: "auth" });
  assert.equal(popup.alerts.length, 0, `拉取失败分支不得再弹阻塞式对话框：${JSON.stringify(popup.alerts)}`);
  assert.deepEqual(draftStatus(popup), { text: translate("providerKeyInvalidModels"), state: "error", hidden: false });
  assert.equal(popup.element("fetchNewDraftModels").disabled, false, "失败后按钮恢复可用");

  popup.click("fetchNewDraftModels");
  await popup.flush();
  assert.deepEqual(draftStatus(popup), { text: "", state: "", hidden: true }, "重试时先清空上一次的失败提示");
  popup.reply(1, { ok: false, errorCode: "network" });
  assert.deepEqual(draftStatus(popup), { text: translate("providerModelsListFailed"), state: "error", hidden: false });

  popup.click("fetchNewDraftModels");
  await popup.flush();
  popup.reply(2, { ok: true, models: ["gpt-4o-mini", "gpt-4o"] });
  assert.deepEqual(draftStatus(popup), { text: "", state: "", hidden: true }, "成功后不得留下错误提示");
  assert.deepEqual(popup.element("newDraftModelList").children.map((child) => child.textContent), ["gpt-4o-mini", "gpt-4o"]);
  assert.equal(popup.alerts.length, 0, `不得再弹阻塞式对话框：${JSON.stringify(popup.alerts)}`);
});

test("草案保存成功：状态无提示、视图收起且服务写入存储，全程零弹窗", async () => {
  const popup = await createReadyPopup({});
  popup.click("addProvider");
  popup.change("newDraftEndpoint", "https://api.example.com/v1");
  popup.change("newDraftKey", "sk-draft");
  popup.click("saveNewDraftBtn");
  await popup.flush();

  const added = popup.storedProviders().at(-1);
  assert.equal(added.name, translate("presetOpenAI"), "预设名照旧作为默认服务名");
  assert.equal(added.endpoint, "https://api.example.com/v1/chat/completions", "端点规范化行为不变");
  assert.equal(added.credential, "sk-draft");
  assert.equal(popup.element("providerNewDraftView").hidden, true, "保存后面板收起");
  assert.deepEqual(draftStatus(popup), { text: "", state: "", hidden: true });
  assert.equal(popup.alerts.length, 0);
});
