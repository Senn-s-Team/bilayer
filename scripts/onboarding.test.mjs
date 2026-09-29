/**
 * [INPUT]: 依赖 Node.js test/vm 与 onboarding 页面/脚本源码，用真实 markup 解析出迷你 DOM 并注入可控 Safari API 与定时器
 * [OUTPUT]: 验证向导最后一步在标签页 API 失效时仍写入配置并进入可交互完成态、外观控件与位置预设语义、预览渲染数学、模型发现协议、原生与 AI 模式 1→2→3 全路径无异常
 * [POS]: scripts 的新手向导行为回归检查，覆盖 popup 之外的第二套设置入口，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const scriptSource = readFileSync(new URL("../extension/src/onboarding/onboarding.js", import.meta.url), "utf8");
const markup = readFileSync(new URL("../extension/src/onboarding/onboarding.html", import.meta.url), "utf8");
const locale = JSON.parse(readFileSync(new URL("../extension/_locales/en/messages.json", import.meta.url), "utf8"));

const VISUAL_KEYS = [
  "subtitleLayoutPreset",
  "primaryFontSize", "secondaryFontSize",
  "primaryVerticalOffset", "secondaryVerticalOffset",
  "primaryFontFamily", "secondaryFontFamily",
  "primaryFontWeight", "secondaryFontWeight",
  "primaryTextColor", "secondaryTextColor",
  "primaryTextOpacity", "secondaryTextOpacity",
  "primaryStrokeWidth", "secondaryStrokeWidth",
  "primaryStrokeColor", "secondaryStrokeColor",
  "primaryBackgroundColor", "secondaryBackgroundColor",
  "primaryBackgroundOpacity", "secondaryBackgroundOpacity",
  "primaryLineHeight", "secondaryLineHeight",
  "primaryMaxWidth", "secondaryMaxWidth"
];

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr", "path", "rect", "circle", "ellipse", "line", "polygon", "stop", "use"
]);

/* ===== 迷你 DOM：解析 onboarding.html，保证测试与真实结构同构 ===== */

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
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.textContent = "";
    this.hidden = Object.hasOwn(attributes, "hidden");
    this.disabled = false;
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

  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focused = true; }

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

/* ===== 测试脚手架：加载 onboarding.js 到假 DOM + 假 Safari API ===== */

function translate(key, substitutions) {
  const message = locale[key]?.message ?? key;
  const args = substitutions == null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  if (!args.length) return message;
  return message.replace(/\$(\d)/g, (match, index) => (args[Number(index) - 1] === undefined ? match : String(args[Number(index) - 1])));
}

function createWizard({ stored = {}, tabs = {}, permissionsGranted = true, storageFails = false } = {}) {
  const { document, all } = createDocument();
  const byId = new Map(all.filter((element) => element.id).map((element) => [element.id, element]));
  const writes = [];
  const messages = [];
  const tabCalls = [];
  const permissionRequests = [];
  const windowsCreated = [];
  const timers = new Map();
  const storageState = structuredClone(stored);
  let nextTimerId = 1;

  const runtime = {
    storage: {
      local: {
        get(defaults, callback) {
          callback({ ...(defaults && typeof defaults === "object" ? defaults : {}), ...structuredClone(storageState) });
        },
        set(patch, callback) {
          if (storageFails) throw new Error("storage denied");
          writes.push(structuredClone(patch));
          Object.assign(storageState, structuredClone(patch));
          callback?.();
        }
      }
    },
    runtime: {
      getURL: (path) => `safari-web-extension://bilayer-app/${path}`,
      sendMessage(message, callback) { messages.push({ message: structuredClone(message), callback }); },
      lastError: undefined
    },
    permissions: {
      request(request, callback) { permissionRequests.push(structuredClone(request)); callback(permissionsGranted); }
    },
    tabs: {
      query(info, callback) {
        tabCalls.push({ type: "query", info: structuredClone(info) });
        if (tabs.queryThrows) throw new Error("tabs.query refused");
        callback(tabs.queryResult ?? []);
      },
      update(id, info, callback) {
        tabCalls.push({ type: "update", id, info: structuredClone(info) });
        if (tabs.updateThrows) throw new Error("tabs.update refused");
        if (!tabs.updateNeverCallsBack) callback?.();
      },
      remove(id, callback) {
        tabCalls.push({ type: "remove", id });
        if (tabs.removeThrows) throw new Error("tabs.remove refused");
        if (!tabs.removeNeverCallsBack) callback?.();
      },
      getCurrent(callback) {
        tabCalls.push({ type: "getCurrent" });
        if (tabs.getCurrentNeverCallsBack) return;
        callback(tabs.currentTab ?? null);
      },
      create(details, callback) {
        tabCalls.push({ type: "create", details: structuredClone(details) });
        windowsCreated.push(structuredClone(details));
        callback?.({ id: 99 });
      }
    }
  };

  const location = { href: "safari-web-extension://bilayer-app/src/onboarding/onboarding.html" };
  const windowListeners = new Map();
  const window = {
    closed: false,
    closeCount: 0,
    close() { this.closed = true; this.closeCount++; },
    open(url) { windowsCreated.push({ url }); return null; },
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
    location
  };

  const context = {
    browser: runtime,
    document,
    location,
    window,
    i18n: { t: translate, apply() {}, uiLanguage: () => "en" },
    URL,
    setTimeout(callback, delay = 0) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    queueMicrotask
  };
  context.globalThis = context;

  runInNewContext(scriptSource, context, { filename: "onboarding.js" });
  // 与真实页面一致：脚本执行完后 document 完成解析并触发 DOMContentLoaded（i18n.apply 也在此刻重写文案）
  document.readyState = "complete";
  document.dispatch("DOMContentLoaded", {});

  return {
    document,
    elements: byId,
    writes,
    messages,
    tabCalls,
    permissionRequests,
    windowsCreated,
    storageState,
    window,
    location,
    advance(ms) {
      for (let guard = 0; guard < 200; guard++) {
        const due = [...timers.entries()].filter(([, timer]) => timer.delay <= ms);
        if (!due.length) return;
        for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
      }
    },
    // async 处理函数在首个 await 后才会继续，需要让出事件循环让微任务落地
    async flush() {
      for (let index = 0; index < 4; index++) await new Promise((resolve) => setImmediate(resolve));
    },
    // 页面生命周期事件（pagehide 等）在 window 上触发
    fireWindow(type) {
      for (const handler of windowListeners.get(type) ?? []) handler({ type });
    },
    element(id) {
      const element = byId.get(id);
      assert.ok(element, `markup 缺少 #${id}`);
      return element;
    },
    query(selector) {
      return this.document.querySelector(selector);
    },
    click(id) { this.element(id).dispatch("click"); },
    clickSelector(selector) {
      const element = this.query(selector);
      assert.ok(element, `markup 缺少 ${selector}`);
      element.dispatch("click");
      return element;
    },
    input(id, value) {
      const element = this.element(id);
      element.value = value;
      element.dispatch("input");
    },
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
    lastMessage() { return messages.at(-1); },
    lastWrite() { return writes.at(-1); }
  };
}

function reachStep3(wizard) {
  wizard.click("btnForward");
  wizard.click("btnForward");
  assert.ok(wizard.element("pane3").classList.contains("is-active"), "第二步未推进到视效步骤");
}

function expectCompletion(wizard) {
  const deadEnd = `btnForward.disabled=${wizard.element("btnForward").disabled}, completionNote.hidden=${wizard.element("completionNote").hidden}, ` +
    `tabCalls=${JSON.stringify(wizard.tabCalls)}`;
  assert.equal(wizard.element("completionNote").hidden, false, `完成态未展示（死路）：${deadEnd}`);
  assert.equal(wizard.element("completionText").textContent, locale.onboardingSaved.message, deadEnd);
  assert.equal(wizard.element("btnCompletionNetflix").hidden, false);
  assert.equal(wizard.element("btnCompletionNetflix").disabled, false);
  assert.equal(wizard.element("btnBack").hidden, true);
  assert.equal(wizard.element("btnForward").hidden, true);
}

/* ===== 缺陷 4：最后一步必须确定性完成 ===== */

test("完成向导在 Safari 拒绝标签页操作时仍写入配置并进入可交互完成态", () => {
  const wizard = createWizard({
    stored: { providers: [{ id: "openai", name: "OpenAI", endpoint: "", model: "gpt-4o-mini", credential: "sk-stored" }] },
    // 复现用户报告的三个死路：update 回调永不触发、remove 失败、getCurrent 没有当前标签页
    tabs: {
      queryResult: [{ id: 7, url: "https://www.netflix.com/watch/123" }],
      updateNeverCallsBack: true,
      removeThrows: true,
      currentTab: null
    }
  });

  reachStep3(wizard);
  wizard.advance(5000);
  wizard.click("btnForward");
  wizard.advance(5000);

  const patch = wizard.lastWrite();
  assert.equal(patch.onboardingCompleted, true, "完成向导必须写入 onboardingCompleted");
  assert.equal(patch.enabled, true);
  assert.equal(patch.aiRole, "off");
  assert.equal(patch.aiTargetLanguage, "zh-Hans");
  assert.equal(patch.aiProviderId, "openai");
  for (const key of VISUAL_KEYS) assert.ok(key in patch, `持久化 patch 缺少外观键 ${key}`);

  expectCompletion(wizard);
  assert.ok(wizard.tabCalls.some((call) => call.type === "update" && call.id === 7), "仍应尽力激活 Netflix 标签页");
  assert.ok(wizard.tabCalls.some((call) => call.type === "getCurrent"), "仍应尽力关闭向导标签页");

  wizard.click("btnCompletionNetflix");
  assert.deepEqual(wizard.windowsCreated.at(-1), { url: "https://www.netflix.com" }, "页内出口应可打开 Netflix");
  assert.equal(wizard.element("btnCompletionNetflix").disabled, false, "页内出口永不禁用");
});

test("完成向导在标签页 API 抛错或缺失时仍保留完成态", () => {
  const wizard = createWizard({ tabs: { queryThrows: true, updateThrows: true, removeThrows: true, getCurrentNeverCallsBack: true } });
  reachStep3(wizard);
  assert.doesNotThrow(() => wizard.click("btnForward"));
  wizard.advance(5000);
  assert.equal(wizard.lastWrite().onboardingCompleted, true);
  expectCompletion(wizard);
});

test("跳过向导同样进入完成态而不是留下禁用按钮", () => {
  const wizard = createWizard({ tabs: { updateNeverCallsBack: true, removeThrows: true, currentTab: null } });
  wizard.click("btnSkip");
  wizard.advance(5000);
  assert.deepEqual(wizard.lastWrite(), { onboardingCompleted: true }, "未写临时 provider 时跳过不得凭空造出服务列表");
  expectCompletion(wizard);
});

test("未触碰 AI 服务时跳过向导不写入 providers", () => {
  const wizard = createWizard({});
  wizard.click("optAi");
  wizard.input("inputApiKey", "sk-test");
  wizard.click("btnSkip");
  wizard.advance(5000);
  assert.deepEqual(wizard.lastWrite(), { onboardingCompleted: true });
  assert.equal("providers" in wizard.storageState, false, "storage.providers 必须保持未创建状态");
  expectCompletion(wizard);
});

test("取模型后跳过向导：服务列表还原为进入向导时的内容，密钥不留存", async () => {
  const wizard = createWizard({ stored: { providers: [{ id: "openai", name: "OpenAI", endpoint: "", model: "gpt-4o-mini", credential: "sk-stored" }] } });
  wizard.click("optAi");
  wizard.input("inputApiKey", "sk-test");
  wizard.click("btnFetchModels");
  await wizard.flush();
  assert.ok(wizard.storageState.providers.some((provider) => provider.id === "onboarding-test"), "取模型前应写入临时 provider");

  wizard.click("btnSkip");
  const patch = wizard.lastWrite();
  assert.equal(patch.onboardingCompleted, true);
  assert.deepEqual(patch.providers, [{ id: "openai", name: "OpenAI", endpoint: "", model: "gpt-4o-mini", credential: "sk-stored" }]);
  assert.equal(wizard.storageState.providers.some((provider) => provider.id === "onboarding-test"), false);
  assert.equal(JSON.stringify(wizard.storageState.providers).includes("sk-test"), false, "临时密钥不得残留在服务列表");
});

test("取模型后中途关闭页面：pagehide 回滚临时 provider 且幂等", async () => {
  const wizard = createWizard({ stored: { providers: [{ id: "openai", name: "OpenAI", endpoint: "", model: "gpt-4o-mini", credential: "sk-stored" }] } });
  wizard.click("optAi");
  wizard.input("inputApiKey", "sk-test");
  wizard.click("btnFetchModels");
  await wizard.flush();
  assert.ok(wizard.storageState.providers.some((provider) => provider.id === "onboarding-test"));

  wizard.fireWindow("pagehide");
  assert.deepEqual(wizard.storageState.providers, [{ id: "openai", name: "OpenAI", endpoint: "", model: "gpt-4o-mini", credential: "sk-stored" }]);
  const writesAfterRollback = wizard.writes.length;
  wizard.fireWindow("pagehide");
  assert.equal(wizard.writes.length, writesAfterRollback, "回滚必须幂等，不得重复写入");
});

test("从未写入临时 provider 时 pagehide 不产生任何写入", () => {
  const wizard = createWizard({});
  wizard.click("optAi");
  assert.equal(wizard.writes.length, 0);
  wizard.fireWindow("pagehide");
  assert.equal(wizard.writes.length, 0);
});

test("完成向导后 pagehide 不得回写旧服务列表", async () => {
  const wizard = createWizard({});
  wizard.click("optAi");
  wizard.input("inputApiKey", "sk-test");
  wizard.click("btnFetchModels");
  await wizard.flush();
  wizard.reply(wizard.messages.length - 1, { ok: true, models: ["gpt-4o"] });
  wizard.click("btnForward");
  wizard.click("btnForward");
  wizard.click("btnForward");
  const finished = wizard.lastWrite();
  assert.equal(finished.providers.find((provider) => provider.id === "openai").credential, "sk-test");
  const writesAfterFinish = wizard.writes.length;
  wizard.fireWindow("pagehide");
  assert.equal(wizard.writes.length, writesAfterFinish, "完成态已剔除临时 provider，卸载兜底不得再写");
  assert.deepEqual(wizard.storageState.providers, finished.providers);
});

test("存储写入被拒绝时完成态仍可到达", () => {
  const wizard = createWizard({ storageFails: true, tabs: { updateNeverCallsBack: true, currentTab: null } });
  reachStep3(wizard);
  assert.doesNotThrow(() => wizard.click("btnForward"));
  wizard.advance(5000);
  assert.equal(wizard.writes.length, 0, "存储被拒绝时不应有写入");
  expectCompletion(wizard);
});

test("标签页操作成功时最佳努力关闭向导页且不重定向", () => {
  const wizard = createWizard({
    tabs: {
      queryResult: [{ id: 7, url: "https://www.netflix.com/watch/123" }],
      currentTab: { id: 9 }
    }
  });
  reachStep3(wizard);
  wizard.click("btnForward");
  wizard.advance(5000);
  expectCompletion(wizard);
  assert.ok(wizard.tabCalls.some((call) => call.type === "remove" && call.id === 9), "应关闭向导标签页");
  assert.equal(wizard.window.closeCount, 0, "标签页已关闭时不再调用 window.close");
  assert.equal(wizard.location.href, "safari-web-extension://bilayer-app/src/onboarding/onboarding.html");
});

/* ===== 缺陷 2/3：外观控件、预设语义与预览数学 ===== */

test("每个视效控件写入对应 visualSettings 键且完成 patch 携带该值", () => {
  const wizard = createWizard({});
  reachStep3(wizard);

  wizard.click("btnRolePrimary");
  wizard.input("sliderFontSize", 30);
  wizard.input("sliderLineHeight", 1.45);
  wizard.input("sliderMaxWidth", 92);
  wizard.input("inputTextColor", "#ff0000");
  wizard.input("sliderTextOpacity", 80);
  wizard.input("inputBgColor", "#112233");
  wizard.input("sliderBgOpacity", 40);
  wizard.input("inputStrokeColor", "#00ff00");
  wizard.input("sliderStrokeWidth", 2);
  wizard.change("selectFontFamily", "serif");
  wizard.change("selectFontWeight", "800");

  assert.equal(wizard.element("fontSizeDisplay").textContent, "30 px");
  assert.equal(wizard.element("lineHeightDisplay").textContent, "1.45");
  assert.equal(wizard.element("maxWidthDisplay").textContent, "92%");
  assert.equal(wizard.element("strokeWidthDisplay").textContent, "2 px");
  assert.equal(wizard.element("textColorDisplay").textContent, "#FF0000");

  wizard.click("btnRoleSecondary");
  wizard.input("sliderFontSize", 24);
  wizard.input("sliderLineHeight", 1.1);
  wizard.input("sliderMaxWidth", 60);

  wizard.click("btnRolePrimary");
  wizard.input("sliderOffset", 40);
  wizard.click("btnForward");

  const patch = wizard.lastWrite();
  assert.equal(patch.primaryFontSize, 30);
  assert.equal(patch.primaryLineHeight, 1.45);
  assert.equal(patch.primaryMaxWidth, 92);
  assert.equal(patch.primaryTextColor, "#ff0000");
  assert.equal(patch.primaryTextOpacity, 80);
  assert.equal(patch.primaryBackgroundColor, "#112233");
  assert.equal(patch.primaryBackgroundOpacity, 40);
  assert.equal(patch.primaryStrokeColor, "#00ff00");
  assert.equal(patch.primaryStrokeWidth, 2);
  assert.equal(patch.primaryFontFamily, "serif");
  assert.equal(patch.primaryFontWeight, 800);
  assert.equal(patch.primaryVerticalOffset, 40);
  assert.equal(patch.subtitleLayoutPreset, "balanced", "未点击预设时保持载入值");
  assert.equal(patch.secondaryFontSize, 24);
  assert.equal(patch.secondaryLineHeight, 1.1);
  assert.equal(patch.secondaryMaxWidth, 60);
  assert.equal(patch.secondaryVerticalOffset, 18, "未改动时保持默认值");
  for (const key of VISUAL_KEYS) assert.ok(key in patch, `持久化 patch 缺少外观键 ${key}`);
});

test("已持久化的外观设置会回填到控件", () => {
  const wizard = createWizard({
    stored: {
      subtitleLayoutPreset: "free",
      primaryFontSize: 34, secondaryFontSize: 20,
      primaryVerticalOffset: 30, secondaryVerticalOffset: 12,
      primaryLineHeight: 1.4, secondaryLineHeight: 1.2,
      primaryMaxWidth: 70, secondaryMaxWidth: 90,
      primaryFontFamily: "serif", primaryFontWeight: 600
    }
  });
  assert.equal(wizard.element("sliderFontSize").value, 34);
  assert.equal(wizard.element("sliderLineHeight").value, 1.4);
  assert.equal(wizard.element("maxWidthDisplay").textContent, "70%");
  assert.equal(wizard.element("selectFontFamily").value, "serif");
  assert.equal(wizard.element("sliderOffset").disabled, false, "free 预设下位置滑杆可用");
  wizard.click("btnRoleSecondary");
  assert.equal(wizard.element("sliderFontSize").value, 20);
  assert.equal(wizard.element("lineHeightDisplay").textContent, "1.2");
  assert.equal(wizard.element("maxWidthDisplay").textContent, "90%");
});

test("重置默认只恢复当前字幕角色的默认外观", () => {
  const wizard = createWizard({});
  reachStep3(wizard);
  wizard.input("sliderFontSize", 40);
  wizard.input("sliderLineHeight", 1.6);
  wizard.input("sliderMaxWidth", 60);
  wizard.click("btnResetStyles");
  assert.equal(wizard.element("sliderFontSize").value, 26);
  assert.equal(wizard.element("sliderLineHeight").value, 1.28);
  assert.equal(wizard.element("sliderMaxWidth").value, 86);
  assert.equal(wizard.element("lineHeightDisplay").textContent, "1.28");
  wizard.click("btnForward");
  const patch = wizard.lastWrite();
  assert.equal(patch.primaryFontSize, 26);
  assert.equal(patch.primaryLineHeight, 1.28);
  assert.equal(patch.primaryMaxWidth, 86);
});

test("位置预设只写 subtitleLayoutPreset、只闸门自由位置滑杆并驱动预览几何", () => {
  const wizard = createWizard({});
  reachStep3(wizard);

  assert.equal(wizard.element("sliderOffset").disabled, true, "默认标准预设下自由位置滑杆应禁用");

  wizard.clickSelector('[data-onboarding-layout="compact"]');
  assert.equal(wizard.element("previewStage").dataset.layout, "compact");
  assert.equal(wizard.element("previewStage").style["--preview-gap"], "4px");
  assert.equal(wizard.element("sliderOffset").disabled, true);
  assert.ok(wizard.query('[data-onboarding-layout="compact"]').classList.contains("is-active"));
  assert.equal(wizard.query('[data-onboarding-layout="balanced"]').classList.contains("is-active"), false);
  assert.equal(wizard.query('[data-preset="openai"]').classList.contains("is-active"), true, "排版预设不得污染服务预设状态");
  assert.equal(wizard.element("modelTrigger").textContent, "gpt-4o-mini");

  wizard.clickSelector('[data-onboarding-layout="spacious"]');
  assert.equal(wizard.element("previewStage").style["--preview-gap"], "16px");
  assert.equal(wizard.element("sliderOffset").disabled, true);

  wizard.clickSelector('[data-onboarding-layout="free"]');
  assert.equal(wizard.element("sliderOffset").disabled, false, "自由预设必须解锁位置滑杆");
  assert.equal(wizard.element("previewStage").style["--preview-primary-bottom"], `${12 + ((26 - 8) / 34) * 76}px`);
  assert.equal(wizard.element("previewStage").style["--preview-secondary-bottom"], `${12 + ((18 - 8) / 34) * 76}px`);

  wizard.input("sliderOffset", 40);
  assert.equal(wizard.element("previewStage").style["--preview-primary-bottom"], `${12 + ((40 - 8) / 34) * 76}px`);

  wizard.click("btnForward");
  const patch = wizard.lastWrite();
  assert.equal(patch.subtitleLayoutPreset, "free");
  assert.equal(patch.primaryVerticalOffset, 40);
  assert.equal(patch.secondaryVerticalOffset, 18, "位置预设不得覆盖逐行偏移量");
});

test("预览渲染与 popup 外观面板使用同一套数学", () => {
  const wizard = createWizard({});
  reachStep3(wizard);
  wizard.input("sliderFontSize", 30);
  wizard.input("sliderMaxWidth", 92);
  wizard.input("sliderLineHeight", 1.45);
  wizard.input("inputTextColor", "#ff0000");
  wizard.input("sliderTextOpacity", 80);
  wizard.input("inputBgColor", "#112233");
  wizard.input("sliderBgOpacity", 40);
  wizard.input("inputStrokeColor", "#00ff00");
  wizard.input("sliderStrokeWidth", 2);
  wizard.change("selectFontFamily", "serif");

  const primary = wizard.element("previewPrimary");
  assert.equal(primary.style.fontSize, `${10 + (30 - 18) * 0.18}px`);
  assert.equal(primary.style.maxWidth, `${Math.round(330 * 92 / 100)}px`);
  assert.equal(primary.style.lineHeight, 1.45);
  assert.equal(primary.style.color, "rgba(255, 0, 0, 0.8)");
  assert.equal(primary.style.background, "rgba(17, 34, 51, 0.4)");
  assert.equal(primary.style.webkitTextStroke, "2px #00ff00");
  assert.equal(primary.style.fontFamily, 'Georgia, "Times New Roman", serif');

  assert.ok(primary.classList.contains("is-editing"), "正在编辑的字幕行应有 is-editing 标记");
  wizard.click("btnRoleSecondary");
  assert.equal(primary.classList.contains("is-editing"), false);
  assert.ok(wizard.element("previewSecondary").classList.contains("is-editing"));
});

/* ===== 缺陷 1：模型发现 ===== */

test("模型发现复用 background 的 BILAYER_LIST_MODELS 协议并落地选择", async () => {
  const wizard = createWizard({});
  wizard.click("optAi");
  wizard.input("inputApiKey", "sk-test");
  wizard.click("btnFetchModels");
  await wizard.flush();

  const draftProviders = wizard.lastWrite().providers;
  assert.deepEqual(
    draftProviders.find((provider) => provider.id === "onboarding-test"),
    { id: "onboarding-test", name: locale.providerTestServiceName.message, endpoint: "", model: "gpt-4o-mini", credential: "sk-test" },
    "发送前必须先把密钥写入临时 provider 供 background 读取"
  );
  assert.deepEqual(wizard.lastMessage().message, { type: "BILAYER_LIST_MODELS", providerId: "onboarding-test" });

  wizard.reply(wizard.messages.length - 1, { ok: true, models: ["gpt-4o", "gpt-4.1-mini", "gpt-4o"] });
  assert.equal(wizard.element("testFeedback").textContent, translate("providerModelsFetched", [3]));
  assert.equal(wizard.element("btnFetchModels").disabled, false);

  const options = wizard.element("modelOptions").children;
  assert.deepEqual(options.map((option) => option.textContent), ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"]);
  assert.equal(options[0].getAttribute("role"), "option");
  assert.equal(wizard.element("modelMenu").hidden, true, "未点击触发器时菜单应关闭");

  wizard.click("modelTrigger");
  assert.equal(wizard.element("modelMenu").hidden, false);
  wizard.input("modelSearch", "4.1");
  assert.deepEqual(options.filter((option) => !option.hidden).map((option) => option.textContent), ["gpt-4.1-mini"]);

  options.find((option) => option.textContent === "gpt-4.1-mini").dispatch("click");
  assert.equal(wizard.element("inputModel").value, "gpt-4.1-mini");
  assert.equal(wizard.element("modelTrigger").textContent, "gpt-4.1-mini");
  assert.equal(wizard.element("modelMenu").hidden, true);

  wizard.click("btnForward");
  wizard.click("btnForward");
  wizard.click("btnForward");
  const patch = wizard.lastWrite();
  assert.equal(patch.aiRole, "secondary");
  assert.equal(patch.providers.find((provider) => provider.id === "openai").model, "gpt-4.1-mini");
  assert.equal(patch.providers.some((provider) => provider.id === "onboarding-test"), false, "临时测试 provider 不得进入最终配置");
});

test("模型发现缺少密钥时给出本地化提示且不发送请求", () => {
  const wizard = createWizard({ stored: { providers: [{ id: "openai", name: "OpenAI", endpoint: "", model: "gpt-4o-mini", credential: "" }] } });
  wizard.click("optAi");
  wizard.click("btnFetchModels");
  assert.equal(wizard.element("testFeedback").textContent, locale.providerModelsNeedKey.message);
  assert.equal(wizard.messages.length, 0);
  assert.equal(wizard.element("btnFetchModels").disabled, false);
});

test("模型发现失败路径回落到本地化反馈且按钮恢复", async () => {
  const wizard = createWizard({});
  wizard.click("optAi");
  wizard.input("inputApiKey", "sk-test");

  wizard.click("btnFetchModels");
  await wizard.flush();
  wizard.reply(wizard.messages.length - 1, { ok: false, errorCode: "auth" });
  assert.equal(wizard.element("testFeedback").textContent, translate("providerModelsFailed", [locale.providerErrorAuth.message]));
  assert.equal(wizard.element("btnFetchModels").disabled, false);

  wizard.click("btnFetchModels");
  await wizard.flush();
  wizard.advance(30000);
  assert.equal(wizard.element("btnFetchModels").disabled, false, "background 不回调时不得永久禁用按钮");
  assert.equal(wizard.element("testFeedback").textContent, translate("providerModelsFailed", [locale.providerModelsFailedShort.message]));
});

test("自定义端点获取模型前先申请域名权限", async () => {
  const denied = createWizard({ permissionsGranted: false });
  denied.click("optAi");
  denied.clickSelector('[data-preset="custom"]');
  denied.input("inputBaseUrl", "https://api.example.com/v1/chat/completions");
  denied.input("inputApiKey", "sk-test");
  denied.click("btnFetchModels");
  await denied.flush();
  assert.deepEqual(denied.permissionRequests, [{ origins: ["https://api.example.com/*"] }]);
  assert.equal(denied.element("testFeedback").textContent, locale.providerEndpointDeniedModels.message);
  assert.equal(denied.messages.length, 0);

  const granted = createWizard({});
  granted.click("optAi");
  granted.clickSelector('[data-preset="custom"]');
  granted.input("inputBaseUrl", "https://api.example.com/v1");
  granted.input("inputApiKey", "sk-test");
  granted.click("btnFetchModels");
  await granted.flush();
  assert.deepEqual(granted.permissionRequests, [{ origins: ["https://api.example.com/*"] }]);
  assert.deepEqual(granted.lastWrite().providers.find((provider) => provider.id === "onboarding-test").endpoint, "https://api.example.com/v1/chat/completions");
  assert.equal(granted.lastMessage().message.type, "BILAYER_LIST_MODELS");
});

/* ===== 全路径遍历与标记 ===== */

test("原生模式 1→2→3 全路径无异常并完成向导", () => {
  const wizard = createWizard({
    tabs: { queryResult: [{ id: 7, url: "https://www.netflix.com/watch/123" }], currentTab: { id: 9 } }
  });
  assert.equal(wizard.element("pane1").classList.contains("is-active"), true);
  wizard.click("btnForward");
  assert.ok(wizard.element("pane2").classList.contains("is-active"));
  assert.equal(wizard.element("btnForward").textContent, locale.onboardingNext.message);
  wizard.click("btnForward");
  assert.ok(wizard.element("pane3").classList.contains("is-active"));
  assert.equal(wizard.element("btnForward").textContent, locale.onboardingFinish.message);
  wizard.click("btnBack");
  assert.ok(wizard.element("pane2").classList.contains("is-active"));
  wizard.click("stepItem3");
  assert.ok(wizard.element("pane3").classList.contains("is-active"));
  wizard.click("btnForward");
  wizard.advance(5000);
  assert.equal(wizard.lastWrite().aiRole, "off");
  expectCompletion(wizard);
});

test("AI 模式 1→2→3（含连通性测试）全路径无异常", async () => {
  const wizard = createWizard({});
  wizard.click("optAi");
  assert.ok(wizard.element("aiDrawer").classList.contains("is-open"));
  wizard.input("inputApiKey", "sk-test");
  wizard.click("btnRunTest");
  await wizard.flush();
  assert.equal(wizard.lastMessage().message.type, "BILAYER_TEST_PROVIDER");
  assert.equal(wizard.element("btnRunTest").disabled, true);
  wizard.reply(wizard.messages.length - 1, { ok: true, jsonMode: "json_object" });
  assert.equal(wizard.element("testFeedback").textContent, locale.providerTestOkObject.message);
  assert.equal(wizard.element("btnRunTest").disabled, false);

  wizard.click("btnForward");
  wizard.click("btnForward");
  assert.ok(wizard.element("pane3").classList.contains("is-active"));
  assert.equal(wizard.element("previewBadge").style.display, "flex");
  wizard.click("btnForward");
  wizard.advance(5000);
  const patch = wizard.lastWrite();
  assert.equal(patch.aiRole, "secondary");
  assert.equal(patch.providers.find((provider) => provider.id === "openai").credential, "sk-test");
  expectCompletion(wizard);
});

test("连通性测试在 background 不回调时恢复按钮并给出反馈", async () => {
  const wizard = createWizard({});
  wizard.click("optAi");
  wizard.input("inputApiKey", "sk-test");
  wizard.click("btnRunTest");
  await wizard.flush();
  wizard.advance(30000);
  assert.equal(wizard.element("btnRunTest").disabled, false);
  assert.equal(wizard.element("testFeedback").textContent, translate("providerFailPrefix", [locale.providerConnectionFailed.message]));
  assert.equal(wizard.element("testDot").dataset.state, "error");
});

test("头部语言切换控件按 i18n.js 契约留空并挂在 header 内", () => {
  const wizard = createWizard({});
  const selects = wizard.document.querySelectorAll("[data-i18n-language]");
  assert.equal(selects.length, 1);
  assert.equal(selects[0].tagName, "SELECT");
  assert.equal(selects[0].children.length, 0, "选项由 i18n.js 注入，页面不得预写");
  assert.equal(selects[0].getAttribute("data-i18n-aria-label"), "uiLanguageAria");
  assert.ok(selects[0].closest(".header"), "语言切换控件必须位于头部");
});

test("三个颜色控件都是可点击的 type=color 输入", () => {
  const wizard = createWizard({});
  for (const id of ["inputTextColor", "inputBgColor", "inputStrokeColor"]) {
    const element = wizard.element(id);
    assert.equal(element.tagName, "INPUT");
    assert.equal(element.type, "color");
    assert.ok(element.closest(".color-picker-row"), `${id} 应包在可点击的颜色行内`);
  }
});
