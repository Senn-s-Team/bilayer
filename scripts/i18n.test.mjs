/**
 * [INPUT]: 依赖 Node.js test/vm 与 extension/src/i18n.js 源码及真实 _locales/{en,zh_CN}/messages.json
 * [OUTPUT]: 验证 uiLanguage 偏好解析（auto 走 runtime.i18n.getMessage 且 substitutions 一并下传、具体语言同步解析包内文案并本地替换）、同步 XHR 被拒时的异步补取与一次性重载闸门、浏览器语言归一与 BCP-47 lang 标签、$1 替换两态一致（未提供的参数保留占位符）、未知键回落、getMessage 抛错/缺失时的降级链、语言切换器的填充/选中/持久化；getMessage 桩按浏览器语义把未传参数的 $n 抹成空串
 * [POS]: scripts 的扩展页国际化行为回归检查，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/i18n.js", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../extension/_locales/en/messages.json", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../extension/_locales/zh_CN/messages.json", import.meta.url), "utf8");
const enMessages = JSON.parse(enSource);
const zhMessages = JSON.parse(zhSource);

// 忠实复刻浏览器的 runtime.i18n.getMessage(key, substitutions)：传了 substitutions 就按 $n 替换，
// 没传（或该位没有对应参数）就把 $n 抹成空串——这正是 auto 路径原先丢掉占位符的成因，
// 桩必须照抄它，否则回归用例永远绿。
function chromeGetMessage(message, substitutions) {
  const args = substitutions == null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  return message.replace(/\$(\d)/g, (match, index) => {
    const value = args[Number(index) - 1];
    return value === undefined ? "" : String(value);
  });
}

// i18n.js 的同步偏好缓存键（storage.local 是权威事实，这份镜像只服务解析期的同步读取）
const CACHE_KEY = "bilayer.uiLanguage";
const DEFAULT_FILES = {
  "_locales/en/messages.json": enSource,
  "_locales/zh_CN/messages.json": zhSource
};

function createElement(tagName) {
  const listeners = {};
  const element = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    attributes: {},
    value: "",
    text: "",
    appendChild(child) { element.children.push(child); },
    getAttribute(name) { return element.attributes[name] ?? null; },
    setAttribute(name, value) { element.attributes[name] = String(value); },
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    dispatch(type) { for (const handler of listeners[type] ?? []) handler({ type }); }
  };

  Object.defineProperty(element, "textContent", {
    get() { return element.text; },
    set(value) { element.text = String(value); element.children.length = 0; }
  });

  return element;
}

function createPage({
  stored = {},
  browserLanguage = "en-US",
  browserMessagePrefix = "",
  domReady = true,
  cache = null,
  asyncStorage = false,
  sessionReloaded = false,
  files = {},
  fetchFiles = null,
  fetchFails = false,
  noSessionStorage = false,
  sessionWritesDropped = false,
  getMessageThrows = false,
  noGetMessage = false
} = {}) {
  const writes = [];
  const reloads = [];
  const getMessageCalls = [];
  const xhrUrls = [];
  const fetchUrls = [];
  const documentListeners = [];
  const cacheStore = new Map();
  const sessionStore = new Map();
  if (cache !== null) cacheStore.set(CACHE_KEY, cache);
  if (sessionReloaded) sessionStore.set("bilayer.uiLanguage.reloaded", "1");

  const languageSelect = createElement("select");
  const translatedHeading = createElement("h2");
  translatedHeading.setAttribute("data-i18n", "tabStyles");
  const elements = {
    "[data-i18n-language]": [languageSelect],
    "[data-i18n]": [translatedHeading]
  };

  const document = {
    readyState: domReady ? "complete" : "loading",
    documentElement: { lang: "" },
    createElement: (tag) => createElement(tag),
    querySelectorAll: (selector) => elements[selector] ?? [],
    addEventListener(type, handler) { documentListeners.push({ type, handler }); },
    fireDomReady() {
      for (const listener of documentListeners) if (listener.type === "DOMContentLoaded") listener.handler();
    }
  };

  const runtime = {
    i18n: {
      getUILanguage: () => browserLanguage,
      getMessage: noGetMessage ? undefined : (key, substitutions) => {
        getMessageCalls.push(key);
        if (getMessageThrows) throw new Error("i18n unavailable");
        const message = enMessages[key]?.message;
        return message ? browserMessagePrefix + chromeGetMessage(message, substitutions) : "";
      }
    },
    runtime: { getURL: (path) => `extension://bilayer/${path}` },
    storage: {
      local: {
        get(defaults, callback) {
          const value = { ...defaults, ...stored };
          if (asyncStorage) return Promise.resolve(value); // 真实浏览器：回调是异步任务，无同步真值
          callback(value);
          return undefined;
        },
        set(update, callback) {
          writes.push(update);
          callback?.();
          return undefined;
        }
      }
    }
  };

  class FakeXMLHttpRequest {
    open(method, url, async) {
      this.method = method;
      this.url = url;
      this.async = async;
      xhrUrls.push(url);
    }
    send() {
      const path = String(this.url).replace("extension://bilayer/", "");
      const body = Object.hasOwn(files, path) ? files[path] : DEFAULT_FILES[path];
      if (body === undefined) { this.status = 404; this.responseText = ""; return; }
      this.status = 200;
      this.responseText = body;
    }
  }

  const context = {
    browser: runtime,
    document,
    location: { reload() { reloads.push("reload"); } },
    XMLHttpRequest: FakeXMLHttpRequest,
    fetch(url) {
      fetchUrls.push(String(url));
      const body = fetchFiles ? fetchFiles[String(url)] : DEFAULT_FILES[String(url).replace("extension://bilayer/", "")];
      if (fetchFails || body === undefined) return Promise.reject(new Error("fetch failed"));
      return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
    },
    localStorage: {
      getItem: (key) => (cacheStore.has(key) ? cacheStore.get(key) : null),
      setItem: (key, value) => { cacheStore.set(key, String(value)); }
    },
    sessionStorage: noSessionStorage ? undefined : {
      getItem: (key) => (sessionStore.has(key) ? sessionStore.get(key) : null),
      setItem: (key, value) => { if (!sessionWritesDropped) sessionStore.set(key, String(value)); }
    }
  };

  runInNewContext(source, context, { filename: "i18n.js" });

  return {
    i18n: context.i18n,
    document,
    select: languageSelect,
    heading: translatedHeading,
    writes,
    reloads,
    getMessageCalls,
    xhrUrls,
    fetchUrls,
    cacheStore,
    sessionStore,
    fireDomReady: document.fireDomReady
  };
}

test("auto preference keeps resolving through runtime.i18n.getMessage", () => {
  const page = createPage({ stored: { uiLanguage: "auto" }, browserLanguage: "en-US" });

  assert.equal(page.i18n.t("tabStyles"), enMessages.tabStyles.message);
  assert.equal(page.getMessageCalls.includes("tabStyles"), true);
  assert.deepEqual(page.xhrUrls, []);
  assert.equal(page.i18n.availableLanguages.join(","), "auto,en,zh_CN");
});

test("an invalid stored value falls back to auto", () => {
  const page = createPage({ stored: { uiLanguage: "zh" }, browserLanguage: "en-US" });

  assert.equal(page.i18n.uiLanguage(), "en");
  assert.equal(page.i18n.t("tabStyles"), enMessages.tabStyles.message);
  assert.deepEqual(page.xhrUrls, []);
});

test("stored en resolves the English bundle from disk without calling getMessage", () => {
  const page = createPage({ stored: { uiLanguage: "en" }, browserMessagePrefix: "BROWSER:" });

  assert.notEqual(enMessages.tabStyles.message, zhMessages.tabStyles.message);
  assert.equal(page.i18n.t("tabStyles"), enMessages.tabStyles.message);
  assert.deepEqual(page.xhrUrls, ["extension://bilayer/_locales/en/messages.json"]);
  assert.equal(page.getMessageCalls.includes("tabStyles"), false);
});

test("stored zh_CN resolves the Chinese bundle from disk", () => {
  const page = createPage({ stored: { uiLanguage: "zh_CN" }, browserMessagePrefix: "BROWSER:" });

  assert.equal(page.i18n.t("tabStyles"), zhMessages.tabStyles.message);
  assert.equal(page.i18n.t("tabStyles"), "外观");
  assert.deepEqual(page.xhrUrls, ["extension://bilayer/_locales/zh_CN/messages.json"]);
  assert.equal(page.getMessageCalls.includes("tabStyles"), false);
});

test("unknown keys return the key itself on both paths", () => {
  const auto = createPage({ stored: { uiLanguage: "auto" } });
  const chinese = createPage({ stored: { uiLanguage: "zh_CN" } });

  assert.equal(auto.i18n.t("noSuchKey"), "noSuchKey");
  assert.equal(chinese.i18n.t("noSuchKey"), "noSuchKey");
  assert.equal(auto.i18n.t("noSuchKey", ["a", "b"]), "noSuchKey");
  assert.equal(chinese.i18n.t("noSuchKey", ["a", "b"]), "noSuchKey");
});

test("$1 substitutions keep working on both paths", () => {
  const auto = createPage({ stored: { uiLanguage: "auto" } });
  const chinese = createPage({ stored: { uiLanguage: "zh_CN" } });

  assert.equal(auto.i18n.t("statusLoadedCount", 5), "Loaded 5");
  assert.equal(chinese.i18n.t("statusLoadedCount", 5), "已加载 5 条");
  assert.equal(chinese.i18n.t("providerEndpointGranted", ["a.example", "/v1"]), "已授权 a.example；已使用 /v1");
});

test("auto hands substitutions to getMessage so real keys keep every placeholder value", () => {
  const auto = createPage({ stored: { uiLanguage: "auto" }, browserLanguage: "en-US" });
  const args = ["This watch session", "0", "80", "0", "40000"];

  const usage = auto.i18n.t("aiBudgetUsage", args);
  assert.equal(usage, "This watch session: 0 / 80 requests · 0 / 40000 characters");
  assert.equal(/\$\d/.test(usage), false, "no placeholder survives on the auto path");

  assert.equal(auto.i18n.t("diagTreeItems", [7]), "7 items");
  assert.equal(auto.i18n.t("providerEndpointGranted", ["a.example", "/v1"]), "Authorized a.example; using /v1");
  // auto 的语义不变：带 substitutions 也绝不因此去加载包内文件
  assert.deepEqual(auto.xhrUrls, []);
  assert.deepEqual(auto.fetchUrls, []);
});

test("auto keeps the placeholders whose argument was not supplied, exactly like the bundled path", () => {
  const auto = createPage({ stored: { uiLanguage: "auto" }, browserLanguage: "en-US" });
  const chinese = createPage({ stored: { uiLanguage: "zh_CN" } });

  // 只给 $1：$2…$5 必须原样保留，不能被静默抹掉；两条路径的替换语义必须逐字一致
  assert.equal(
    auto.i18n.t("aiBudgetUsage", ["This watch session"]),
    "This watch session: $2 / $3 requests · $4 / $5 characters"
  );
  assert.equal(
    chinese.i18n.t("aiBudgetUsage", ["本次观看"]),
    "本次观看：请求 $2 / $3 · 字符 $4 / $5"
  );

  const sparse = createPage({ stored: { uiLanguage: "auto" }, browserLanguage: "en-US" });
  assert.equal(
    sparse.i18n.t("providerEndpointGranted", [undefined, "/v1"]),
    "Authorized $1; using /v1",
    "undefined holes stay literal on both paths"
  );
});

test("explicit locales still resolve from the bundle and substitute locally", () => {
  const args = ["This watch session", "0", "80", "0", "40000"];
  const zhArgs = ["本次观看", "0", "80", "0", "40000"];
  const english = createPage({ stored: { uiLanguage: "en" }, browserMessagePrefix: "BROWSER:" });
  const chinese = createPage({ stored: { uiLanguage: "zh_CN" }, browserMessagePrefix: "BROWSER:" });

  assert.equal(english.i18n.t("aiBudgetUsage", args), "This watch session: 0 / 80 requests · 0 / 40000 characters");
  assert.equal(chinese.i18n.t("aiBudgetUsage", zhArgs), "本次观看：请求 0 / 80 · 字符 0 / 40000");
  assert.deepEqual(english.getMessageCalls, [], "the bundle path never consults the browser");
  assert.deepEqual(chinese.getMessageCalls, []);
  assert.deepEqual(english.xhrUrls, ["extension://bilayer/_locales/en/messages.json"]);
});

test("a throwing or absent getMessage keeps the documented degradation chain", () => {
  const throwing = createPage({ stored: { uiLanguage: "auto" }, getMessageThrows: true });
  assert.equal(throwing.i18n.t("tabStyles"), "tabStyles");
  assert.equal(throwing.i18n.t("aiBudgetUsage", ["a", "b", "c", "d", "e"]), "aiBudgetUsage");

  const absent = createPage({ stored: { uiLanguage: "auto" }, noGetMessage: true });
  assert.equal(absent.i18n.t("tabStyles"), "tabStyles");
  assert.equal(absent.i18n.t("noSuchKey", ["x"]), "noSuchKey");

  // 包内报文损坏 → getMessage 也不可用 → 回落 key，任一环节都不抛错、不返回半句话
  const brokenBundle = createPage({
    stored: { uiLanguage: "en" },
    files: { "_locales/en/messages.json": "{ not json" },
    getMessageThrows: true
  });
  assert.equal(brokenBundle.i18n.t("statusLoadedCount", 5), "statusLoadedCount");
});

test("a missing or unparsable bundle degrades to getMessage and then to the key", () => {
  const missing = createPage({
    stored: { uiLanguage: "zh_CN" },
    browserMessagePrefix: "BROWSER:",
    files: { "_locales/zh_CN/messages.json": undefined }
  });
  assert.equal(missing.i18n.t("tabStyles"), `BROWSER:${enMessages.tabStyles.message}`);

  const broken = createPage({
    stored: { uiLanguage: "en" },
    browserMessagePrefix: "BROWSER:",
    files: { "_locales/en/messages.json": "{ not json" }
  });
  assert.equal(broken.i18n.t("tabStyles"), `BROWSER:${enMessages.tabStyles.message}`);
  assert.equal(broken.i18n.t("noSuchKey"), "noSuchKey");
});

test("browser language codes normalize to a bundled locale", () => {
  const cases = [
    ["zh-Hans-CN", "zh_CN"],
    ["zh-CN", "zh_CN"],
    ["zh_TW", "zh_CN"],
    ["en-US", "en"],
    ["de-DE", "en"]
  ];

  for (const [browserLanguage, expected] of cases) {
    const page = createPage({ stored: { uiLanguage: "auto" }, browserLanguage });
    assert.equal(page.i18n.uiLanguage(), expected, browserLanguage);
  }
});

test("documentElement.lang carries a BCP-47 tag while uiLanguage() returns the bundle code", () => {
  const auto = createPage({ stored: { uiLanguage: "auto" }, browserLanguage: "zh-Hans-CN" });
  assert.equal(auto.i18n.uiLanguage(), "zh_CN");
  assert.equal(auto.document.documentElement.lang, "zh-CN");

  const chinese = createPage({ stored: { uiLanguage: "zh_CN" }, browserLanguage: "en-US" });
  assert.equal(chinese.i18n.uiLanguage(), "zh_CN");
  assert.equal(chinese.document.documentElement.lang, "zh-CN");
  assert.equal(chinese.heading.textContent, zhMessages.tabStyles.message);

  const english = createPage({ stored: { uiLanguage: "en" }, browserLanguage: "de-DE" });
  assert.equal(english.i18n.uiLanguage(), "en");
  assert.equal(english.document.documentElement.lang, "en");
});

test("the switcher is filled, selected and persisted without page-side JS", () => {
  const page = createPage({ stored: { uiLanguage: "zh_CN" }, domReady: true });

  assert.deepEqual(page.select.children.map((option) => option.value), ["auto", "en", "zh_CN"]);
  assert.deepEqual(page.select.children.map((option) => option.textContent), ["跟随系统", "English", "简体中文"]);
  assert.equal(page.select.value, "zh_CN");

  page.i18n.mountLanguageSwitcher();
  assert.equal(page.select.children.length, 3);

  page.select.value = "en";
  page.select.dispatch("change");
  assert.deepEqual(page.writes.map((write) => write.uiLanguage), ["en"]);
  assert.deepEqual(page.reloads, ["reload"]);
  assert.equal(page.cacheStore.get(CACHE_KEY), "en");

  page.select.value = "not-a-locale";
  page.select.dispatch("change");
  assert.equal(page.writes.length, 1);
});

test("the switcher mounts on DOMContentLoaded when parsing is still in progress", () => {
  const page = createPage({ stored: { uiLanguage: "auto" }, domReady: false });

  assert.equal(page.select.children.length, 0);
  page.fireDomReady();
  assert.equal(page.select.children.length, 3);
  assert.deepEqual(page.select.children.map((option) => option.textContent), ["Follow system", "English", "简体中文"]);
  assert.equal(page.select.value, "auto");
});

test("a synchronously cached preference renders before the asynchronous storage truth arrives", async () => {
  const page = createPage({ stored: { uiLanguage: "zh_CN" }, cache: "en", asyncStorage: true, domReady: true });

  assert.equal(page.i18n.uiLanguage(), "en");
  assert.equal(page.i18n.t("tabStyles"), enMessages.tabStyles.message);
  assert.equal(page.select.value, "en");
  assert.deepEqual(page.reloads, []);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.i18n.uiLanguage(), "zh_CN");
  assert.equal(page.document.documentElement.lang, "zh-CN");
  assert.equal(page.i18n.t("tabStyles"), zhMessages.tabStyles.message);
  assert.equal(page.select.value, "zh_CN");
  assert.equal(page.cacheStore.get(CACHE_KEY), "zh_CN");
  // 权威值与解析期缓存不一致时重载一次，让页面脚本内建的字符串整体按真值重建
  assert.deepEqual(page.reloads, ["reload"]);
});

test("the correction reloads at most once per session and still applies the stored value", async () => {
  const page = createPage({
    stored: { uiLanguage: "zh_CN" },
    cache: "en",
    asyncStorage: true,
    sessionReloaded: true,
    domReady: true
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.i18n.uiLanguage(), "zh_CN");
  assert.equal(page.i18n.t("tabStyles"), zhMessages.tabStyles.message);
  assert.deepEqual(page.reloads, [], "already corrected in this session");
});

test("a late storage answer never overrides the language the user just picked", async () => {
  const page = createPage({ stored: { uiLanguage: "en" }, cache: "en", asyncStorage: true, domReady: true });

  assert.equal(page.i18n.setLanguage("zh_CN"), true);
  assert.equal(page.i18n.setLanguage("xx"), false);
  assert.deepEqual(page.reloads, ["reload"]);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.i18n.uiLanguage(), "zh_CN");
  assert.equal(page.i18n.t("tabStyles"), zhMessages.tabStyles.message);
  assert.deepEqual(page.reloads, ["reload"]);
});

test("a refused synchronous bundle request self-heals through the async fallback", async () => {
  const page = createPage({
    stored: { uiLanguage: "zh_CN" },
    browserMessagePrefix: "BROWSER:",
    files: { "_locales/zh_CN/messages.json": undefined },
    fetchFiles: { "extension://bilayer/_locales/zh_CN/messages.json": zhSource }
  });

  assert.equal(page.i18n.t("tabStyles"), `BROWSER:${enMessages.tabStyles.message}`);
  assert.equal(page.heading.textContent, `BROWSER:${enMessages.tabStyles.message}`);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.i18n.t("tabStyles"), zhMessages.tabStyles.message);
  assert.equal(page.heading.textContent, zhMessages.tabStyles.message);
  assert.equal(page.document.documentElement.lang, "zh-CN");
  assert.deepEqual(page.fetchUrls, ["extension://bilayer/_locales/zh_CN/messages.json"]);
  assert.deepEqual(page.reloads, ["reload"]);

  page.i18n.t("tabStyles");
  assert.equal(page.fetchUrls.length, 1, "the healed bundle is cached for later calls");
});

test("a failed async fallback keeps the getMessage degradation without reloading", async () => {
  const page = createPage({
    stored: { uiLanguage: "zh_CN" },
    browserMessagePrefix: "BROWSER:",
    files: { "_locales/zh_CN/messages.json": undefined },
    fetchFails: true
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.i18n.t("tabStyles"), `BROWSER:${enMessages.tabStyles.message}`);
  assert.equal(page.heading.textContent, `BROWSER:${enMessages.tabStyles.message}`);
  assert.deepEqual(page.reloads, []);
  assert.equal(page.writes.length, 0);
  assert.equal(page.sessionStore.has("bilayer.uiLanguage.reloaded"), false);
});

test("the shared reload guard allows only one compensation per session", async () => {
  const page = createPage({
    stored: { uiLanguage: "zh_CN" },
    files: { "_locales/zh_CN/messages.json": undefined },
    fetchFiles: { "extension://bilayer/_locales/zh_CN/messages.json": zhSource },
    sessionReloaded: true
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.i18n.t("tabStyles"), zhMessages.tabStyles.message);
  assert.equal(page.heading.textContent, zhMessages.tabStyles.message);
  assert.deepEqual(page.reloads, []);
});

test("auto never requests a bundle, synchronously or asynchronously", async () => {
  const page = createPage({ stored: { uiLanguage: "auto" }, browserLanguage: "zh-Hans-CN" });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.i18n.uiLanguage(), "zh_CN");
  assert.deepEqual(page.xhrUrls, []);
  assert.deepEqual(page.fetchUrls, []);
});

test("a missing or silently unwritable session store never reloads, so compensation cannot loop", async () => {
  const cases = [
    { name: "absent sessionStorage", options: { noSessionStorage: true } },
    { name: "writes silently dropped", options: { sessionWritesDropped: true } }
  ];

  for (const { name, options } of cases) {
    const page = createPage({
      stored: { uiLanguage: "zh_CN" },
      files: { "_locales/zh_CN/messages.json": undefined },
      fetchFiles: { "extension://bilayer/_locales/zh_CN/messages.json": zhSource },
      ...options
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(page.i18n.t("tabStyles"), zhMessages.tabStyles.message, name);
    assert.equal(page.heading.textContent, zhMessages.tabStyles.message, name);
    assert.deepEqual(page.reloads, [], name);
  }
});

test("the mirror correction is bounded by the same session guard", async () => {
  const page = createPage({ stored: { uiLanguage: "zh_CN" }, cache: "en", asyncStorage: true, sessionWritesDropped: true });

  assert.equal(page.i18n.uiLanguage(), "en");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.i18n.uiLanguage(), "zh_CN");
  assert.equal(page.heading.textContent, zhMessages.tabStyles.message);
  assert.deepEqual(page.reloads, []);
});
