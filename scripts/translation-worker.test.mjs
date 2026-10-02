/**
 * [INPUT]: 依赖 Node.js test/vm 与真实 service_worker.js、translationScheduler.js、overlay.js，模拟多 provider 扩展存储（可注入 get 行为以模拟抛错/挂起读取）和 Chat Completions 响应
 * [OUTPUT]: 验证 provider 切换、日文原文注音结构化请求经 worker/scheduler/overlay 渲染、混合汉字/假名的空数组约束、兼容服务回包及 ID 校验、权限/错误、原始报文秘密边界、AI 就绪度查询（已配置/无凭证远端/无密钥本地端点/无匹配条目、notice/tracksNotice/unreadNotice 三条文案各自独立解析、键缺失时分别回落 null 与空串、文案跟随 storage.local.uiLanguage 的包内解析与按语言缓存、auto/缺失/非法值一律走 getMessage 且不取包、包拒绝或不存在或非法 JSON 时逐级降级、存储读失败、对非观剧页与异物发送者的授权拒绝），以及采集开关跨 worker 重启的持久化与首请求门控、读取失败时的 fail-closed 与重试、用户切换与并发翻译交错时用户意图优先、清理缓冲绝不写入未知的开关键
 * [POS]: scripts 的后台请求行为检查，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/background/service_worker.js", import.meta.url), "utf8");
const schedulerSource = readFileSync(new URL("../extension/src/content/translationScheduler.js", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../extension/src/content/overlay.js", import.meta.url), "utf8");
const sender = { id: "extension-id", tab: { url: "https://www.netflix.com/watch/42" } };
// 后台本地化桩：真实环境的文案由 _locales/{en,zh_CN}/messages.json 提供（键名由 popup 侧维护），
// 这里只断言后台取了哪个键、返回值如何回填，不复制真实的提示句子。
const I18N_MESSAGES = {
  noticeProviderMissing: "[noticeProviderMissing]",
  noticeSubtitleTracksMissing: "[noticeSubtitleTracksMissing]",
  noticeSubtitleTracksUnread: "[noticeSubtitleTracksUnread]"
};
// 真实包内文案：具体语言路径按 runtime.getURL 生成的 URL 取回原文件（键名与句子都由 _locales 维护，测试不复制）。
const LOCALE_BUNDLES = new Map(["en", "zh_CN"].map((locale) => [
  `extension://_locales/${locale}/messages.json`,
  JSON.parse(readFileSync(new URL(`../extension/_locales/${locale}/messages.json`, import.meta.url), "utf8"))
]));
const noticeText = (locale, key) => LOCALE_BUNDLES.get(`extension://_locales/${locale}/messages.json`)[key].message;

// 包内文案 fetch 桩：记录每次请求的 URL；可按 URL 给出报文（对象＝原样序列化，字符串＝原样返回），
// texts 里没有的 URL 返回 404，reject 则模拟网络拒绝。
function localeFetcher({ reject = false, texts = LOCALE_BUNDLES } = {}) {
  const fetcher = async (url) => {
    fetcher.calls.push(url);
    if (reject) throw new Error("bundle fetch rejected");
    const body = texts.get(url);
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  };
  fetcher.calls = [];
  return fetcher;
}
const message = {
  type: "BILAYER_TRANSLATE_BATCH",
  sourceLanguage: "en", targetLanguage: "zh-Hans",
  items: [{ id: "0", text: "Hello" }],
  contextBefore: [], contextAfter: ["How are you?"]
};

function createWorker(fetcher, stored = {}, permissionGranted = true, store = { ...stored }, storageControl = {}) {
  let listener;
  const localizedKeys = [];
  const readStorage = (defaults, callback, overrides = {}) => callback({
    ...defaults, aiRole: "secondary", providers: [{ id: "openai", name: "OpenAI 官方", endpoint: "", model: "gpt-4o-mini", credential: "private-key" }], aiProviderId: "openai", ...store, ...overrides
  });
  const runtime = {
    storage: { local: {
      get(defaults, callback) {
        const fallback = (overrides) => readStorage(defaults, callback, overrides);
        if (storageControl.get) return storageControl.get(defaults, callback, store, fallback);
        fallback();
      },
      set(data, callback) { Object.assign(store, data); if (typeof callback === "function") callback(); }
    } },
    permissions: { contains(_query, callback) { callback(permissionGranted); } },
    i18n: { getMessage(key) { localizedKeys.push(key); return I18N_MESSAGES[key] ?? ""; } },
    runtime: { id: "extension-id", getURL(path) { return `extension://${path}`; }, onInstalled: { addListener() {} }, onMessage: { addListener(callback) { listener = callback; } } }
  };
  runInNewContext(source, {
    browser: runtime, fetch: fetcher, URL, TextEncoder, AbortController, structuredClone, setTimeout, clearTimeout
  }, { filename: "service_worker.js" });
  const run = (request = message, from = sender) => new Promise((resolve) => listener(request, from, resolve));
  // 断言“后台是否真的去解析了提示句”：未配置时才取 noticeProviderMissing。
  run.localizedKeys = localizedKeys;
  return run;
}

test("selected subtitle text is sent only to fixed OpenAI host and the key never returns", async () => {
  let request;
  const worker = createWorker(async (url, options) => {
    request = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
    } }] });
  });
  const result = await worker();
  assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer private-key");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "error");
  const body = JSON.parse(request.options.body);
  assert.equal(body.messages[1].content.includes("www.netflix.com/watch"), false);
  assert.match(body.messages[0].content, /影视字幕翻译员/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, items: [{ id: "0", text: "你好" }] });
  assert.equal(JSON.stringify(result).includes("private-key"), false);
});

test("non-Netflix senders and duplicate subtitle IDs cannot spend the key", async () => {
  let calls = 0;
  const worker = createWorker(async () => { calls++; throw new Error("should not reach network"); });
  assert.equal((await worker(message, { id: "extension-id", tab: { url: "https://evil.example/watch/42" } })).ok, false);
  assert.equal((await worker({ ...message, items: [message.items[0], message.items[0]] })).ok, false);
  assert.equal(calls, 0);
});

test("partial or mismatched model output is rejected without exposing provider body", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "other", text: "错位" }] })
  } }] }));
  assert.deepEqual(JSON.parse(JSON.stringify(await worker())), { ok: false, errorCode: "invalid_response" });
});

test("invalid provider translations expose sanitized request stages instead of only an error code", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "other", text: "private-output" }] })
  } }] }));
  const result = await worker({ ...message, diagnostic: true });
  assert.equal(result.errorCode, "invalid_response");
  assert.deepEqual(JSON.parse(JSON.stringify(result.trace.map(({ stage }) => stage))), [
    "configured", "permission", "request", "response", "parsed", "rejected"
  ]);
  assert.equal(result.trace.at(-1).reason, "items_mismatch");
  assert.equal(result.trace.find(({ stage }) => stage === "response").status, 200);
  assert.equal(JSON.stringify(result).includes("private-key"), false);
  assert.equal(JSON.stringify(result).includes("private-output"), false);
});

test("HTTP rejection reports status and provider stage without exposing upstream body", async () => {
  const worker = createWorker(async () => new Response("sensitive-provider-error", { status: 429 }));
  const result = await worker({ ...message, diagnostic: true });
  assert.equal(result.errorCode, "rate_limit");
  assert.equal(result.trace.find(({ stage }) => stage === "response").status, 429);
  assert.equal(result.trace.at(-1).reason, "http_error");
  assert.equal(JSON.stringify(result).includes("sensitive-provider-error"), false);
});

test("a consented compatible provider receives the standard chat request without OpenAI-only schema", async () => {
  let sent;
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
    } }] });
  }, { providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "org/model:latest", credential: "private-key" }], aiProviderId: "custom" });
  assert.equal((await worker()).ok, true);
  assert.equal(sent.url, "https://provider.example/v1/chat/completions");
  assert.equal(JSON.parse(sent.options.body).model, "org/model:latest");
  assert.equal(JSON.parse(sent.options.body).response_format, undefined);
  assert.equal(sent.options.headers.Authorization, "Bearer private-key");
});

test("a compatible provider's single translated subtitle is usable without an items wrapper", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ id: "584", text: "可以愉快地面对吧？" })
  } }] }), { providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "gemini-3.1-flash-lite", credential: "private-key" }], aiProviderId: "custom" });
  const one = { ...message, items: [{ id: "584", text: "楽しく向き合えるでしょ？" }] };
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(one))), { ok: true, items: [{ id: "584", text: "可以愉快地面对吧？" }] });
  const two = { ...one, items: [...one.items, { id: "585", text: "そうだよね。" }] };
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(two))), { ok: false, errorCode: "invalid_response" });
  const wrongId = { ...one, items: [{ id: "585", text: "そうだよね。" }] };
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(wrongId))), { ok: false, errorCode: "invalid_response" });
});

test("a compatible provider's comma-separated JSON objects translate the complete subtitle batch", async () => {
  const content = [
    { id: "585", text: "（男）是的。" },
    { id: "586", text: "在最近的分行，每人\n最多可兑换100万。" },
    { id: "587", text: "（濑田）最多100万？" }
  ].map(JSON.stringify).join(",");
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content } }] }), {
    providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "gemini-3.1-flash-lite", credential: "private-key" }],
    aiProviderId: "custom"
  });
  const batch = { ...message, items: ["585", "586", "587"].map((id) => ({ id, text: `原字幕 ${id}` })) };
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(batch))), {
    ok: true, items: JSON.parse(`[${content}]`)
  });
  const missing = { ...batch, items: [...batch.items, { id: "588", text: "漏译" }] };
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(missing))), { ok: false, errorCode: "invalid_response" });
  const wrongId = { ...batch, items: [...batch.items.slice(0, 2), { id: "588", text: "错配" }] };
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(wrongId))), { ok: false, errorCode: "invalid_response" });
});

test("a compatible provider's fenced top-level array preserves normalized readings for every subtitle", async () => {
  const content = "```json\n" + JSON.stringify([
    { id: "0", text: "青い箱", readings: [{ surface: "青", reading: "あお" }, { surface: "箱", reading: "はこ" }] },
    { id: "1", text: "ありがとう", readings: [] }
  ]) + "\n```";
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content } }] }), {
    providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "m", credential: "private-key" }],
    aiProviderId: "custom"
  });
  const batch = { ...message, targetLanguage: "ja", items: [{ id: "0", text: "A blue box" }, { id: "1", text: "Thank you" }] };
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(batch))), {
    ok: true, items: [
      { id: "0", text: "青い箱", readings: { "青": "あお", "箱": "はこ" } },
      { id: "1", text: "ありがとう", readings: {} }
    ]
  });
});

test("a compatible provider's plain one-item top-level array translates a subtitle", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: '[{"id":"0","text":"蓝色的盒子"}]'
  } }] }), {
    providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "m", credential: "private-key" }],
    aiProviderId: "custom"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await worker())), { ok: true, items: [{ id: "0", text: "蓝色的盒子" }] });
});

for (const [name, items] of [
  ["missing item", [{ id: "0", text: "蓝色的盒子" }]],
  ["duplicate ID", [{ id: "0", text: "蓝色的盒子" }, { id: "0", text: "谢谢" }]],
  ["wrong ID", [{ id: "0", text: "蓝色的盒子" }, { id: "other", text: "谢谢" }]],
  ["empty text", [{ id: "0", text: "" }, { id: "1", text: "谢谢" }]],
  ["extra field", [{ id: "0", text: "蓝色的盒子", extra: true }, { id: "1", text: "谢谢" }]],
  ["malformed readings", [{ id: "0", text: "青い箱", readings: [{ surface: "箱", reading: 42 }] }, { id: "1", text: "ありがとう", readings: [] }]]
]) {
  test(`a compatible provider's top-level array rejects ${name}`, async () => {
    const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify(items)
    } }] }), {
      providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "m", credential: "private-key" }],
      aiProviderId: "custom"
    });
    const batch = { ...message, items: [{ id: "0", text: "A blue box" }, { id: "1", text: "Thank you" }] };
    assert.deepEqual(JSON.parse(JSON.stringify(await worker(batch))), { ok: false, errorCode: "invalid_response" });
  });
}

test("compatible providers may return fenced JSON or text content parts", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: [{ type: "text", text: "```json\n{\"items\":[{\"id\":\"0\",\"text\":\"你好\"}]}\n```" }]
  } }] }));
  assert.deepEqual(JSON.parse(JSON.stringify(await worker())), { ok: true, items: [{ id: "0", text: "你好" }] });
});

test("compatible providers with key typos like id/ or leading markdown are normalized and validated", async () => {
  const rawContent = '*```json\n{"items":[{"id/":"1482","text":"店铺便迎来了清晨","ruby":"{店|みせ}は{朝|あさ}を{迎|むか}えた"}]}\n```';
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: rawContent
  } }] }), {
    providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "gemini-3.5-flash-lite", credential: "private-key" }],
    aiProviderId: "custom"
  });
  const batch = { ...message, items: [{ id: "1482", text: "店は朝を迎えた" }] };
  const result = await worker(batch);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{
    id: "1482", text: "店铺便迎来了清晨", ruby: "{店|みせ}は{朝|あさ}を{迎|むか}えた", readings: { "朝": "あさ", "店": "みせ", "迎": "むか" }
  }]);
});

test("a revoked provider permission or unsafe endpoint never receives a key", async () => {
  let requests = 0;
  const fetcher = async () => { requests++; throw new Error("must not send"); };
  const denied = createWorker(fetcher, { providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "m", credential: "private-key" }], aiProviderId: "custom" }, false);
  assert.equal((await denied()).errorCode, "permission_denied");
  const unsafe = createWorker(fetcher, { providers: [{ id: "custom", name: "Custom", endpoint: "http://provider.example/v1/chat/completions", model: "m", credential: "private-key" }], aiProviderId: "custom" });
  assert.equal((await unsafe()).errorCode, "configuration");
  const credentialInUrl = createWorker(fetcher, { providers: [{ id: "custom", name: "Custom", endpoint: "https://key@provider.example/v1/chat/completions", model: "m", credential: "private-key" }], aiProviderId: "custom" });
  assert.equal((await credentialInUrl()).errorCode, "configuration");
  assert.equal(requests, 0);
});

test("switching provider selects its endpoint, model and credential together", async () => {
  let sent;
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
    } }] });
  }, {
    aiProviderId: "custom",
    providers: [
      { id: "openai", name: "OpenAI", endpoint: "", model: "gpt-4o-mini", credential: "key1" },
      { id: "custom", name: "Custom", endpoint: "https://custom.example/v1/chat/completions", model: "c1", credential: "key2" }
    ]
  });
  assert.equal((await worker()).ok, true);
  assert.equal(sent.url, "https://custom.example/v1/chat/completions");
  assert.equal(JSON.parse(sent.options.body).model, "c1");
  assert.equal(sent.options.headers.Authorization, "Bearer key2");
});

test("successful diagnostics identify the provider without exposing endpoint paths or credentials", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
  } }] }), { aiProviderId: "custom", providers: [{ id: "custom", name: "Custom",
    endpoint: "https://custom.example/private-token/v1/chat/completions", model: "model-a", credential: "private-key" }] });
  const result = await worker({ ...message, diagnostic: true });
  assert.equal(result.ok, true);
  assert.equal(result.trace[0].endpointOrigin, "https://custom.example");
  assert.equal(result.trace.at(-1).stage, "validated");
  assert.equal(JSON.stringify(result.trace).includes("private-token"), false);
  assert.equal(JSON.stringify(result.trace).includes("private-key"), false);
});

test("missing selected provider never falls back to another provider credential", async () => {
  let requests = 0;
  const worker = createWorker(async () => { requests++; throw new Error("must not send"); }, { aiProviderId: "missing" });
  assert.equal((await worker()).errorCode, "configuration");
  assert.equal(requests, 0);
});

test("popup provider connectivity test uses the selected provider and returns only status", async () => {
  let sent;
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "connection", text: "OK" }] })
    } }] });
  }, {
    aiProviderId: "custom",
    providers: [{ id: "custom", name: "Custom", endpoint: "", model: "c1", credential: "key2" }]
  });
  const result = await worker({ type: "BILAYER_TEST_PROVIDER", providerId: "custom" }, {
    id: "extension-id", url: "extension://src/popup/popup.html"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, jsonMode: "json_schema" });
  assert.equal(JSON.parse(sent.options.body).model, "c1");
  assert.equal(sent.options.headers.Authorization, "Bearer key2");
});

test("raw diagnostic page sees exact request and malformed response without leaking to Netflix", async () => {
  let sent;
  const rawBody = '{"choices":[{"finish_reason":"stop","message":{"content":"{\\"wrong\\":true}"}}]}';
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return new Response(rawBody, { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };
  const get = () => worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal((await get()).records.length, 0);
  assert.equal((await worker({ type: "BILAYER_SET_RAW_DIAGNOSTICS", enabled: true }, page)).ok, true);
  const result = await worker({ ...message, diagnostic: true });
  assert.equal(result.errorCode, "invalid_response");
  assert.equal(JSON.stringify(result).includes("private-key"), false);
  assert.equal(JSON.stringify(result).includes("wrong"), false);
  const { records } = await get();
  assert.equal(records.length, 1);
  assert.equal(records[0].request.body, sent.options.body);
  assert.equal(records[0].request.headers.Authorization, undefined);
  assert.equal(records[0].response.body, rawBody);
  assert.equal(records[0].response.status, 200);
  assert.equal(records[0].failure.reason, "items_mismatch");
  assert.equal((await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, sender)).ok, false);
  assert.equal((await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" },
    { id: "extension-id", url: "extension://src/popup/popup.html" })).ok, false);
  assert.equal((await worker({ type: "BILAYER_CLEAR_RAW_DIAGNOSTICS" }, sender)).ok, false);
  assert.equal((await worker({ type: "BILAYER_CLEAR_RAW_DIAGNOSTICS" }, page)).ok, true);
  assert.equal((await get()).records.length, 0);
});

test("raw diagnostic failures preserve actual item counts without credentials or provider body", async () => {
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };
  const batch = { ...message, diagnostic: true, items: [{ id: "0", text: "A blue box" }, { id: "1", text: "Thank you" }] };
  for (const [content, failure] of [
    ['[{"id":"0","text":"synthetic-provider-output"}]',
      { errorCode: "invalid_response", reason: "items_mismatch", expectedCount: 2, receivedCount: 1 }],
    ['[{"id":"0","text":"synthetic-provider-output"},{"id":"other","text":"synthetic-provider-output"}]',
      { errorCode: "invalid_response", reason: "items_mismatch", expectedCount: 2, receivedCount: 2 }],
    ['{"wrong":"synthetic-provider-output"}',
      { errorCode: "invalid_response", reason: "items_mismatch", expectedCount: 2, receivedCount: null }],
    ["synthetic-provider-output",
      { errorCode: "invalid_response", reason: "translation_not_json" }]
  ]) {
    const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content } }] }), {
      providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "m", credential: "private-key" }],
      aiProviderId: "custom"
    });
    const result = await worker(batch);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_response");
    const diagnostics = await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
    assert.equal(diagnostics.ok, true);
    assert.equal(diagnostics.records.length, 1);
    assert.deepEqual(structuredClone(diagnostics.records[0].failure), failure);
    for (const value of [result, diagnostics.records[0].failure]) {
      const serialized = JSON.stringify(value);
      assert.equal(serialized.includes("private-key"), false);
      assert.equal(serialized.includes("synthetic-provider-output"), false);
      assert.equal(serialized.includes(content), false);
    }
  }
});

test("raw capture toggle persists across worker restart and gates the first translate request", async () => {
  const store = {};
  const okFetcher = async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
  } }] });
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };

  // (a) first worker loads with capture enabled, then the user turns it off
  let worker = createWorker(okFetcher, {}, true, store);
  assert.equal((await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page)).enabled, true);
  assert.equal((await worker({ type: "BILAYER_SET_RAW_DIAGNOSTICS", enabled: false }, page)).enabled, false);
  assert.equal(store.__raw_capture_enabled__, false);

  // (b) restart sharing the same storage: the first translate must not capture
  worker = createWorker(okFetcher, {}, true, store);
  const translated = await worker({ ...message, diagnostic: true });
  assert.equal(translated.ok, true);
  assert.equal((await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page)).enabled, false);
  assert.equal((await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page)).records.length, 0);

  // (c) stored false survives a third restart
  worker = createWorker(okFetcher, {}, true, store);
  assert.equal((await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page)).enabled, false);

  // (d) unset storage still defaults to enabled and captures
  const freshWorker = createWorker(okFetcher);
  assert.equal((await freshWorker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page)).enabled, true);
  assert.equal((await freshWorker({ ...message, diagnostic: true })).ok, true);
  assert.equal((await freshWorker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page)).records.length, 1);
});

test("a failed capture-preference read stays fail-closed and is retried by the next request", async () => {
  const store = {};
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };
  let failDiagnosticsReads = true;
  let diagnosticsReads = 0;
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
  } }] }), {}, true, store, {
    get(defaults, callback, backing, fallback) {
      if (Array.isArray(defaults)) {
        diagnosticsReads++;
        if (failDiagnosticsReads) throw new Error("storage unavailable");
      }
      fallback();
    }
  });

  // the read throws: the translation still succeeds, but nothing is captured and GET reports off
  assert.equal((await worker({ ...message, diagnostic: true })).ok, true);
  const failed = await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal(failed.enabled, false);
  assert.equal(failed.records.length, 0);
  assert.equal(diagnosticsReads, 2); // translate + GET each retried; the failure was not latched

  // the read recovers: the next translate retries and resumes capture with the stored value
  failDiagnosticsReads = false;
  store.__raw_capture_enabled__ = true;
  assert.equal((await worker({ ...message, diagnostic: true })).ok, true);
  const recovered = await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.records.length, 1);
  assert.equal(diagnosticsReads, 3); // the successful read was cached; GET did not read again
});

test("a user toggle that lands while the capture read is pending wins over the read's later value", async () => {
  const store = {};
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };
  const okFetcher = async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
  } }] });
  let releaseDiagnosticsRead;
  const worker = createWorker(okFetcher, {}, true, store, {
    get(defaults, callback, backing, fallback) {
      if (Array.isArray(defaults) && !releaseDiagnosticsRead) { releaseDiagnosticsRead = fallback; return; }
      fallback();
    }
  });

  const translating = worker({ ...message, diagnostic: true });
  for (let i = 0; i < 50 && !releaseDiagnosticsRead; i++) await new Promise(setImmediate);
  assert.equal(typeof releaseDiagnosticsRead, "function"); // the read is in flight, not settled

  const toggled = await worker({ type: "BILAYER_SET_RAW_DIAGNOSTICS", enabled: false }, page);
  assert.equal(toggled.enabled, false);
  assert.equal(store.__raw_capture_enabled__, false); // persisted without waiting for the read

  releaseDiagnosticsRead({ __raw_capture_enabled__: true }); // the late read carries the opposite value
  assert.equal((await translating).ok, true);
  assert.equal(store.__raw_capture_enabled__, false); // the read must not overwrite the user's choice
  const after = await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal(after.enabled, false);
  assert.equal(after.records.length, 0); // and no translate captured against it
});

test("a translate issued before the toggle does not revert the user's persisted value", async () => {
  const store = { __raw_capture_enabled__: false };
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };
  const okFetcher = async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
  } }] });
  let releaseDiagnosticsRead;
  const worker = createWorker(okFetcher, {}, true, store, {
    get(defaults, callback, backing, fallback) {
      if (Array.isArray(defaults) && !releaseDiagnosticsRead) { releaseDiagnosticsRead = fallback; return; }
      fallback();
    }
  });

  const translating = worker({ ...message, diagnostic: true });
  for (let i = 0; i < 50 && !releaseDiagnosticsRead; i++) await new Promise(setImmediate);

  const toggled = await worker({ type: "BILAYER_SET_RAW_DIAGNOSTICS", enabled: true }, page);
  assert.equal(toggled.enabled, true);
  assert.equal(store.__raw_capture_enabled__, true);

  releaseDiagnosticsRead({ __raw_capture_enabled__: false }); // the late read carries the stale off value
  assert.equal((await translating).ok, true);
  assert.equal(store.__raw_capture_enabled__, true); // the user's value survives the race
  const after = await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal(after.enabled, true);
  assert.equal(after.records.length, 1); // and the user's on value resumes capture
});

test("a translate that starts before the capture read settles still waits for the stored default", async () => {
  const store = {};
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };
  const okFetcher = async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
  } }] });
  let releaseDiagnosticsRead;
  const worker = createWorker(okFetcher, {}, true, store, {
    get(defaults, callback, backing, fallback) {
      if (Array.isArray(defaults) && !releaseDiagnosticsRead) { releaseDiagnosticsRead = fallback; return; }
      fallback();
    }
  });

  const translating = worker({ ...message, diagnostic: true });
  for (let i = 0; i < 50 && !releaseDiagnosticsRead; i++) await new Promise(setImmediate);
  releaseDiagnosticsRead(); // successful read with no stored key, so the documented default applies

  assert.equal((await translating).ok, true);
  const after = await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal(after.enabled, true);
  assert.equal(after.records.length, 1); // the request waited for the read instead of using the fail-closed default
});

test("a clear before any capture read never persists the fail-closed placeholder", async () => {
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };
  const okFetcher = async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
  } }] });

  // a stored true must survive a clear that is the very first message of a fresh worker
  const storedOn = { __raw_capture_enabled__: true };
  const onWorker = createWorker(okFetcher, {}, true, storedOn);
  assert.equal((await onWorker({ type: "BILAYER_CLEAR_RAW_DIAGNOSTICS" }, page)).ok, true);
  assert.equal(storedOn.__raw_capture_enabled__, true);
  const onAfter = await onWorker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal(onAfter.enabled, true);
  assert.equal(onAfter.records.length, 0);

  // an absent key must still default to on after the clear completes its read
  const absentStore = {};
  const absentWorker = createWorker(okFetcher, {}, true, absentStore);
  assert.equal((await absentWorker({ type: "BILAYER_CLEAR_RAW_DIAGNOSTICS" }, page)).ok, true);
  assert.notEqual(absentStore.__raw_capture_enabled__, false);
  assert.equal((await absentWorker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page)).enabled, true);
});

test("a clear that races an in-flight capture read stores the value that read returns", async () => {
  const store = {};
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };
  const okFetcher = async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
  } }] });
  let releaseDiagnosticsRead;
  const worker = createWorker(okFetcher, {}, true, store, {
    get(defaults, callback, backing, fallback) {
      if (Array.isArray(defaults) && !releaseDiagnosticsRead) { releaseDiagnosticsRead = fallback; return; }
      fallback();
    }
  });

  const clearing = worker({ type: "BILAYER_CLEAR_RAW_DIAGNOSTICS" }, page);
  for (let i = 0; i < 50 && !releaseDiagnosticsRead; i++) await new Promise(setImmediate);
  assert.equal(typeof releaseDiagnosticsRead, "function"); // the read is in flight, not settled
  assert.equal("__raw_capture_enabled__" in store, false); // nothing was written before the read landed

  releaseDiagnosticsRead({ __raw_capture_enabled__: true });
  assert.equal((await clearing).ok, true);
  assert.equal(store.__raw_capture_enabled__, true); // equals the value the read returned
  const after = await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal(after.enabled, true);
  assert.equal(after.records.length, 0);
});

test("a clear after a failed capture read writes no capture flag at all", async () => {
  const store = {};
  const page = { id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" } };
  let failDiagnosticsReads = true;
  const okFetcher = async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
  } }] });
  const worker = createWorker(okFetcher, {}, true, store, {
    get(defaults, callback, backing, fallback) {
      if (Array.isArray(defaults) && failDiagnosticsReads) throw new Error("storage unavailable");
      fallback();
    }
  });

  assert.equal((await worker({ type: "BILAYER_CLEAR_RAW_DIAGNOSTICS" }, page)).ok, true);
  assert.equal("__raw_capture_enabled__" in store, false); // the unknown value is never persisted
  assert.deepEqual(Object.keys(store).filter((key) => key.startsWith("__raw_")).sort(),
    ["__raw_diagnostic_seq__", "__raw_diagnostics__", "__raw_diagnostics_version__"]);
  assert.equal((await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page)).enabled, false);

  // the clear did not latch the failure: a recovering read still retries and resumes capture
  failDiagnosticsReads = false;
  store.__raw_capture_enabled__ = true;
  assert.equal((await worker({ ...message, diagnostic: true })).ok, true);
  const recovered = await worker({ type: "BILAYER_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.records.length, 1);
});

test("onboarding page is authorized to run provider connectivity test and rejects unauthorized senders", async () => {
  let sent;
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "connection", text: "OK" }] })
    } }] });
  }, {
    aiProviderId: "openai",
    providers: [{ id: "openai", name: "OpenAI 官方", endpoint: "", model: "gpt-4o-mini", credential: "key1" }]
  });

  const onboardingSender = {
    id: "extension-id",
    url: "extension://src/onboarding/onboarding.html",
    tab: { id: 10, url: "extension://src/onboarding/onboarding.html" }
  };
  const result = await worker({ type: "BILAYER_TEST_PROVIDER", providerId: "openai" }, onboardingSender);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, jsonMode: "json_schema" });
  assert.equal(sent.options.headers.Authorization, "Bearer key1");

  const maliciousSender = {
    id: "extension-id",
    url: "https://evil.com",
    tab: { id: 11, url: "https://evil.com" }
  };
  const deniedResult = await worker({ type: "BILAYER_TEST_PROVIDER", providerId: "openai" }, maliciousSender);
  assert.equal(deniedResult.ok, false);
});

test("Japanese source language requests ruby furigana in schema and validates ruby response", async () => {
  let sent;
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "0", text: "你好", ruby: "{私|わたし}は" }] })
    } }] });
  });

  const jpMessage = {
    ...message,
    sourceLanguage: "ja",
    targetLanguage: "zh-Hans",
    items: [{ id: "0", text: "私は" }]
  };

  const result = await worker(jpMessage);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ id: "0", text: "你好", ruby: "{私|わたし}は", readings: { "私": "わたし" } }]);

  const body = JSON.parse(sent.options.body);
  assert.deepEqual(body.response_format.json_schema.schema.properties.items.items.required, ["id", "text", "readings"]);
});

test("Japanese furigana string from a compatible provider survives translation for the native source row", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "我是田中", furigana: "{私|わたし}は{田中|たなか}です" }] })
  } }] }), {
    providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "model", credential: "private-key" }],
    aiProviderId: "custom",
    aiJapaneseRuby: true
  });
  const result = await worker({ ...message, sourceLanguage: "ja", targetLanguage: "zh-Hans", japaneseRuby: true,
    items: [{ id: "0", text: "私は田中です" }] });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].text, "我是田中");
  assert.equal(result.items[0].ruby, "{私|わたし}は{田中|たなか}です");
  assert.deepEqual(JSON.parse(JSON.stringify(result.items[0].readings)), { "私": "わたし", "田中": "たなか" });
  await assertJapaneseSourceRenders(worker);
});

async function assertJapaneseSourceRenders(worker) {
  const subtitle = { startMs: 1000, endMs: 2000, text: "私は田中です" };
  const window = {};
  runInNewContext(schedulerSource, { window }, { filename: "translationScheduler.js" });
  const scheduler = window.Bilayer.createTranslationScheduler({ translate: () => worker({
    ...message, sourceLanguage: "ja", targetLanguage: "zh-Hans", japaneseRuby: true,
    items: [{ id: "0", text: subtitle.text }]
  }) });
  scheduler.setSource({ identity: "watch:42:ja", cues: [subtitle], sourceLanguage: "ja", targetLanguage: "zh-Hans", japaneseRuby: true });
  scheduler.observe(1500);
  await new Promise((resolve) => setImmediate(resolve));

  const makeContainer = () => ({ children: [], hidden: true, replaceChildren(...nodes) { this.children = nodes; } });
  const primary = makeContainer();
  const secondary = makeContainer();
  const root = { set innerHTML(_value) {}, querySelector(selector) { return selector.includes("primary") ? primary : secondary; } };
  let host;
  const document = {
    createElement(tag) {
      if (!host) {
        host = { style: { setProperty() {} }, dataset: {}, isConnected: false, attachShadow() { return root; } };
        return host;
      }
      return { tagName: tag.toUpperCase(), textContent: "", children: [], append(...nodes) {
        for (const node of nodes) {
          if (typeof node === "string") this.textContent += node;
          else { this.children.push(node); this.textContent += node.textContent; }
        }
      } };
    },
    documentElement: { append(node) { node.isConnected = true; } }
  };
  runInNewContext(overlaySource, { window, document }, { filename: "overlay.js" });
  const overlay = window.Bilayer.createSubtitleOverlay();
  overlay.render({ primaryCues: scheduler.annotateSource([subtitle]), secondaryCues: scheduler.translatedFor([subtitle]) });
  assert.equal(primary.children[0].children[0].tagName, "RUBY");
  assert.equal(primary.children[0].children[0].children[0].tagName, "RT");
  assert.equal(primary.children[0].children[0].children[0].textContent, "わたし");
  assert.equal(primary.children[0].textContent.replace(/わたし|たなか/g, ""), subtitle.text);
  assert.equal(secondary.children[0].textContent, "我是田中");
}

test("Japanese source with kanji requests usable readings instead of accepting an empty Gemini object", async () => {
  let sent;
  const worker = createWorker(async (_url, options) => {
    sent = JSON.parse(options.body);
    const readingsSchema = sent.response_format?.json_schema?.schema?.properties?.items?.items?.properties?.readings;
    const readings = readingsSchema?.type === "array" && readingsSchema.items?.required?.includes("reading")
      ? [{ surface: "私", reading: "わたし" }, { surface: "田中", reading: "たなか" }]
      : {};
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: { items: [{ id: "0", text: "我是田中", readings }] }
    } }] });
  }, {
    providers: [{ id: "gemini", name: "Gemini", endpoint: "https://provider.example/v1/chat/completions", model: "gemini-3.1-flash-lite", jsonMode: "json_schema", credential: "private-key" }],
    aiProviderId: "gemini", aiJapaneseRuby: true
  });

  await assertJapaneseSourceRenders(worker);
  assert.equal(sent.response_format.json_schema.schema.properties.items.items.properties.readings.minItems, undefined);
  assert.equal(sent.response_format.json_schema.schema.properties.items.items.properties.readings.items.additionalProperties, false);
});

test("mixed kanji and kana-only cues keep empty readings only for the kana-only cue", async () => {
  let sent;
  const worker = createWorker(async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: { items: [
        { id: "0", text: "我来了", readings: [{ surface: "私", reading: "わたし" }] },
        { id: "1", text: "你好", readings: [] }
      ] }
    } }] });
  }, {
    providers: [{ id: "gemini", name: "Gemini", endpoint: "https://provider.example/v1/chat/completions", model: "gemini-3.1-flash-lite", jsonMode: "json_schema", credential: "private-key" }],
    aiProviderId: "gemini", aiJapaneseRuby: true
  });
  const result = await worker({ ...message, sourceLanguage: "ja", targetLanguage: "zh-Hans", japaneseRuby: true,
    items: [{ id: "0", text: "私は" }, { id: "1", text: "こんにちは" }] });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [
    { id: "0", text: "我来了", readings: { "私": "わたし" } },
    { id: "1", text: "你好", readings: {} }
  ]);
  const readingsSchema = sent.response_format.json_schema.schema.properties.items.items.properties.readings;
  assert.equal(readingsSchema.type, "array");
  assert.equal(readingsSchema.minItems, undefined);
});

test("Japanese source language omits ruby when aiJapaneseRuby is disabled", async () => {
  let sent;
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "0", text: "你好" }] })
    } }] });
  }, { aiJapaneseRuby: false });

  const jpMessage = {
    ...message,
    sourceLanguage: "ja",
    targetLanguage: "zh-Hans",
    items: [{ id: "0", text: "私は" }]
  };

  const result = await worker(jpMessage);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ id: "0", text: "你好" }]);

  const body = JSON.parse(sent.options.body);
  assert.deepEqual(body.response_format.json_schema.schema.properties.items.items.required, ["id", "text"]);
});

test("Japanese target language maps structured readings onto the translated row", async () => {
  let sent;
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "0", text: "私は学生です", readings: [{ surface: "私", reading: "わたし" }, { surface: "学生", reading: "がくせい" }] }] })
    } }] });
  });

  const enToJaMessage = {
    ...message,
    sourceLanguage: "en",
    targetLanguage: "ja",
    items: [{ id: "0", text: "I am a student." }]
  };

  const result = await worker(enToJaMessage);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ id: "0", text: "私は学生です", readings: { "私": "わたし", "学生": "がくせい" } }]);

  const body = JSON.parse(sent.options.body);
  assert.deepEqual(body.response_format.json_schema.schema.properties.items.items.required, ["id", "text", "readings"]);
  assert.equal(body.response_format.json_schema.schema.properties.items.items.properties.readings.items.additionalProperties, false);
});

test("model returning clean readings map without ruby string is validated and normalized", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ items: [{ id: "0", text: "你好", readings: { "私": "わたし" } }] })
  } }] }));
  const jpMessage = { ...message, sourceLanguage: "ja", targetLanguage: "zh-Hans", items: [{ id: "0", text: "私は" }] };
  const result = await worker(jpMessage);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ id: "0", text: "你好", readings: { "私": "わたし" } }]);
});

test("model returning malformed trailing characters like ]5} is healed and validated", async () => {
  const rawContent = '```json\n{"items":[{"id":"1547","text":"（店员）这是本店推荐的面包","readings":{"店員":"てんいん","推薦":"すいせん"}},{"id":"1548","text":"（店长）今天早晨刚烤好的","readings":{"店長":"てんちょう","今朝":"けさ"}},{"id":"1549","text":"我把它摆在了橱窗最里面","readings":{"棚":"たな","中":"なか"}}]5}\n```';
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: rawContent
  } }] }), {
    providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "gemini-3.5-flash-lite", credential: "private-key" }],
    aiProviderId: "custom"
  });
  const batch = {
    ...message,
    sourceLanguage: "ja",
    targetLanguage: "zh-Hans",
    items: [
      { id: "1547", text: "推薦" },
      { id: "1548", text: "今朝" },
      { id: "1549", text: "棚" }
    ]
  };
  const result = await worker(batch);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].id, "1547");
  assert.equal(result.items[0].text, "（店员）这是本店推荐的面包");
  assert.equal(result.items[0].readings["推薦"], "すいせん");
});

test("model returning message.content as an object is parsed and validated successfully", async () => {
  const objectContent = {
    items: [
      { id: "1585", text: "天还没亮", readings: {} },
      { id: "1586", text: "烤箱的灯却已经亮了", readings: { "灯": "ひ" } },
      { id: "1587", text: "明明昨天还没有人在", readings: { "昨日": "きのう" } },
      { id: "1588", text: "我本以为还需要再醒一会儿的面团却已经膨胀起来！", readings: { "生地": "きじ", "膨": "ふく" } },
      { id: "1589", text: "而且香味比平时还要浓郁", readings: { "香": "かお", "濃": "こ" } }
    ]
  };
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    role: "assistant",
    content: objectContent
  } }] }), {
    providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "gemini-3.1-flash-lite", credential: "private-key" }],
    aiProviderId: "custom"
  });
  const batch = {
    ...message,
    sourceLanguage: "ja",
    targetLanguage: "zh-Hans",
    items: [
      { id: "1585", text: "..." },
      { id: "1586", text: "..." },
      { id: "1587", text: "..." },
      { id: "1588", text: "..." },
      { id: "1589", text: "..." }
    ]
  };
  const result = await worker(batch);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 5);
  assert.equal(result.items[0].id, "1585");
  assert.equal(result.items[0].text, "天还没亮");
});

test("all collected real-world diagnostic cases in cases/ parse and validate successfully", async () => {
  const casesDir = new URL("../cases", import.meta.url);
  const files = readdirSync(casesDir).filter((file) => file.endsWith(".json"));
  assert.ok(files.length >= 3);

  for (const file of files) {
    const caseData = JSON.parse(readFileSync(new URL(`../cases/${file}`, import.meta.url), "utf8"));
    const worker = createWorker(async () => Response.json(caseData.response), {
      providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: caseData.response.model || "gemini", credential: "private-key" }],
      aiProviderId: "custom"
    });
    const batch = {
      ...message,
      sourceLanguage: "ja",
      targetLanguage: "zh-Hans",
      items: caseData.expectedItems.map((item) => ({ id: item.id, text: "源文本" }))
    };
    const result = await worker(batch);
    assert.equal(result.ok, true, `Case ${file} failed with: ${result.errorCode}`);
    assert.equal(result.items.length, caseData.expectedItems.length);
  }
});

test("connectivity probe falls back to json_object and none when json_schema is rejected with 400", async () => {
  const calls = [];
  const worker = createWorker(async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.response_format);
    // If json_schema, simulate 400 rejection from proxy
    if (body.response_format?.type === "json_schema") {
      return new Response(JSON.stringify({ error: { message: "unrecognized parameter: json_schema" } }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    // If json_object, simulate 200 success
    if (body.response_format?.type === "json_object") {
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{ id: "connection", text: "OK" }] }) } }] });
    }
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{ id: "connection", text: "OK" }] }) } }] });
  }, {
    aiProviderId: "deepseek",
    providers: [{ id: "deepseek", name: "DeepSeek", endpoint: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", credential: "key" }]
  });

  const result = await worker({ type: "BILAYER_TEST_PROVIDER", providerId: "deepseek" }, {
    id: "extension-id", url: "extension://src/popup/popup.html"
  });
  assert.equal(result.ok, true);
  assert.equal(result.jsonMode, "json_object");
  assert.equal(calls[0]?.type, "json_schema");
  assert.equal(calls[1]?.type, "json_object");
});

test("connectivity probe marks jsonMode as none and warns when both json_schema and json_object fail", async () => {
  const calls = [];
  const worker = createWorker(async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.response_format);
    // Reject both schema and object formats with 400
    if (body.response_format) {
      return new Response(JSON.stringify({ error: { message: "unsupported response_format" } }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{ id: "connection", text: "OK" }] }) } }] });
  }, {
    aiProviderId: "legacy",
    providers: [{ id: "legacy", name: "Legacy", endpoint: "https://legacy.example/v1/chat/completions", model: "legacy-v1", credential: "key" }]
  });

  const result = await worker({ type: "BILAYER_TEST_PROVIDER", providerId: "legacy" }, {
    id: "extension-id", url: "extension://src/popup/popup.html"
  });
  assert.equal(result.ok, true);
  assert.equal(result.jsonMode, "none");
  assert.equal(result.warning, "unsupported_json_mode");
  assert.equal(calls.length, 3);
  assert.equal(calls[2], undefined);
});

// ---------------------------------------------------------------------------
// AI 就绪度查询（BILAYER_AI_READINESS）：配置判定、本地化文案与授权边界
// ---------------------------------------------------------------------------

const readinessRequest = { type: "BILAYER_AI_READINESS" };
const popupSender = { id: "extension-id", url: "extension://src/popup/popup.html" };

test("AI readiness answers provider configuration and localized hints without any network call", async () => {
  let fetches = 0;
  const worker = createWorker(async () => { fetches++; throw new Error("must not reach the network"); }, {
    providers: [{ id: "openai", name: "OpenAI 官方", endpoint: "", model: "gpt-4o-mini", credential: "private-key" }],
    aiProviderId: "openai"
  });
  const result = await worker(readinessRequest, sender);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true, configured: true, notice: null,
    tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: "[noticeSubtitleTracksUnread]"
  });
  assert.equal(fetches, 0);
  // 已配置时连“未配置”那句文案都不去解析；两条轨道文案各自独立解析（none 与 unread 的证据不同）
  assert.deepEqual(worker.localizedKeys, ["noticeSubtitleTracksMissing", "noticeSubtitleTracksUnread"]);
});

test("a credential-less provider counts as ready only when it is the keyless local endpoint", async () => {
  const fetcher = async () => { throw new Error("must not reach the network"); };
  const local = createWorker(fetcher, {
    providers: [{ id: "ollama", name: "Ollama", endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:7b", credential: "" }],
    aiProviderId: "ollama"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await local(readinessRequest, sender))), {
    ok: true, configured: true, notice: null,
    tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: "[noticeSubtitleTracksUnread]"
  });
  assert.deepEqual(local.localizedKeys, ["noticeSubtitleTracksMissing", "noticeSubtitleTracksUnread"]);

  // 远端端点没有凭证（哪怕只是空白）＝不可用，与 popup 的“获取模型/测试连通性”门槛一致
  const remote = createWorker(fetcher, {
    providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "m", credential: "   " }],
    aiProviderId: "custom"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await remote(readinessRequest, sender))), {
    ok: true, configured: false, notice: "[noticeProviderMissing]",
    tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: "[noticeSubtitleTracksUnread]"
  });
  assert.deepEqual(remote.localizedKeys, ["noticeProviderMissing", "noticeSubtitleTracksMissing", "noticeSubtitleTracksUnread"]);

  // 没有与 aiProviderId 匹配的条目：与翻译侧 pickProvider() 的判定一致，按未配置处理
  const missing = createWorker(fetcher, { providers: [], aiProviderId: "openai" });
  assert.deepEqual(JSON.parse(JSON.stringify(await missing(readinessRequest, sender))), {
    ok: true, configured: false, notice: "[noticeProviderMissing]",
    tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: "[noticeSubtitleTracksUnread]"
  });
});

test("a missing localization key yields no hint instead of half a sentence", async () => {
  const saved = I18N_MESSAGES.noticeProviderMissing;
  const savedUnread = I18N_MESSAGES.noticeSubtitleTracksUnread;
  delete I18N_MESSAGES.noticeProviderMissing;
  delete I18N_MESSAGES.noticeSubtitleTracksUnread;
  try {
    const worker = createWorker(async () => { throw new Error("must not reach the network"); }, {
      providers: [{ id: "custom", name: "Custom", endpoint: "", model: "m", credential: "" }],
      aiProviderId: "custom"
    });
    // notice 键缺失 → null；unreadNotice 键缺失 → 空串（content 侧据此不渲染空提示条）
    assert.deepEqual(JSON.parse(JSON.stringify(await worker(readinessRequest, sender))), {
      ok: true, configured: false, notice: null,
      tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: ""
    });

    // 只有 unread 键缺失时，两条轨道文案分道扬镳：tracksNotice 仍在，unreadNotice 为空串
    I18N_MESSAGES.noticeProviderMissing = saved;
    const unreadless = createWorker(async () => { throw new Error("must not reach the network"); });
    assert.deepEqual(JSON.parse(JSON.stringify(await unreadless(readinessRequest, sender))), {
      ok: true, configured: true, notice: null,
      tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: ""
    });
  } finally {
    I18N_MESSAGES.noticeProviderMissing = saved;
    if (savedUnread === undefined) delete I18N_MESSAGES.noticeSubtitleTracksUnread;
    else I18N_MESSAGES.noticeSubtitleTracksUnread = savedUnread;
  }
});

test("a storage read failure reports unavailable instead of inventing a ready state", async () => {
  const worker = createWorker(async () => { throw new Error("must not reach the network"); }, {}, true, {}, {
    get() { throw new Error("storage unavailable"); }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(readinessRequest, sender))), { ok: false, errorCode: "unavailable" });
});

test("AI readiness is limited to watch-page content scripts and extension pages", async () => {
  const worker = createWorker(async () => { throw new Error("must not reach the network"); });

  const hostile = { id: "extension-id", url: "https://evil.example/watch/42", tab: { url: "https://evil.example/watch/42" } };
  const denied = await worker(readinessRequest, hostile);
  assert.deepEqual(JSON.parse(JSON.stringify(denied)), { ok: false, errorCode: "configuration" });
  assert.equal(JSON.stringify(denied).includes("notice"), false);
  // Netflix 的非观剧页（浏览页）同样不在授权范围
  assert.equal((await worker(readinessRequest, { id: "extension-id", tab: { url: "https://www.netflix.com/browse" } })).ok, false);
  // 其它扩展 id 即使挂在观剧页上也不行
  assert.equal((await worker(readinessRequest, { id: "other-extension", tab: { url: "https://www.netflix.com/watch/42" } })).ok, false);

  // 观剧页内容脚本与扩展自有页面（popup/onboarding/diagnostics）可以问
  assert.equal((await worker(readinessRequest, sender)).ok, true);
  assert.equal((await worker(readinessRequest, popupSender)).ok, true);
  assert.equal((await worker(readinessRequest, {
    id: "extension-id", url: "extension://src/onboarding/onboarding.html",
    tab: { id: 1, url: "extension://src/onboarding/onboarding.html" }
  })).ok, true);
  assert.equal((await worker(readinessRequest, {
    id: "extension-id", url: "extension://src/diagnostics/diagnostics.html",
    tab: { url: "extension://src/diagnostics/diagnostics.html" }
  })).ok, true);
});

// ---------------------------------------------------------------------------
// AI 就绪度文案跟随扩展界面语言（storage.local.uiLanguage）：包解析、缓存与降级链
// ---------------------------------------------------------------------------

const unconfiguredProvider = {
  providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "m", credential: "" }],
  aiProviderId: "custom"
};

test("readiness hints follow the stored uiLanguage bundle and fetch it only once", async () => {
  const fetcher = localeFetcher();
  const worker = createWorker(fetcher, { uiLanguage: "zh_CN", ...unconfiguredProvider });
  const expected = {
    ok: true, configured: false,
    notice: noticeText("zh_CN", "noticeProviderMissing"),
    tracksNotice: noticeText("zh_CN", "noticeSubtitleTracksMissing"),
    unreadNotice: noticeText("zh_CN", "noticeSubtitleTracksUnread")
  };
  assert.notEqual(expected.notice, I18N_MESSAGES.noticeProviderMissing);

  assert.deepEqual(JSON.parse(JSON.stringify(await worker(readinessRequest, sender))), expected);
  // 命中包内文案后不再回落浏览器语言
  assert.deepEqual(worker.localizedKeys, []);

  // 缓存：重复询问（含解析器状态在两次调用间变化）不再取包
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(readinessRequest, sender))), expected);
  assert.deepEqual(fetcher.calls, ["extension://_locales/zh_CN/messages.json"]);
  assert.deepEqual(worker.localizedKeys, []);
});

test("a concrete uiLanguage resolves its own bundle instead of the browser language", async () => {
  const fetcher = localeFetcher();
  const worker = createWorker(fetcher, { uiLanguage: "en", ...unconfiguredProvider });
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(readinessRequest, sender))), {
    ok: true, configured: false,
    notice: noticeText("en", "noticeProviderMissing"),
    tracksNotice: noticeText("en", "noticeSubtitleTracksMissing"),
    unreadNotice: noticeText("en", "noticeSubtitleTracksUnread")
  });
  assert.deepEqual(fetcher.calls, ["extension://_locales/en/messages.json"]);
  assert.deepEqual(worker.localizedKeys, []);
});

test("auto, missing and invalid uiLanguage keep the browser-language path and never fetch a bundle", async () => {
  // 未设置、显式 auto、非包内码（zh-CN/ja）、非字符串都按 auto 处理
  for (const stored of [{}, { uiLanguage: "auto" }, { uiLanguage: "zh-CN" }, { uiLanguage: "ja" }, { uiLanguage: 7 }]) {
    const fetcher = localeFetcher({ reject: true });
    const worker = createWorker(fetcher, stored);
    assert.deepEqual(JSON.parse(JSON.stringify(await worker(readinessRequest, sender))), {
      ok: true, configured: true, notice: null,
      tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: "[noticeSubtitleTracksUnread]"
    });
    assert.deepEqual(fetcher.calls, []);
    assert.deepEqual(worker.localizedKeys, ["noticeSubtitleTracksMissing", "noticeSubtitleTracksUnread"]);
  }

  // auto 且未配置时同样不取包，只解析浏览器语言
  const fetcher = localeFetcher({ reject: true });
  const worker = createWorker(fetcher, { uiLanguage: "auto", providers: [], aiProviderId: "openai" });
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(readinessRequest, sender))), {
    ok: true, configured: false, notice: "[noticeProviderMissing]",
    tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: "[noticeSubtitleTracksUnread]"
  });
  assert.deepEqual(fetcher.calls, []);
});

test("an unavailable bundle degrades to the browser language without failing the answer", async () => {
  const rejected = localeFetcher({ reject: true });
  const worker = createWorker(rejected, { uiLanguage: "zh_CN", ...unconfiguredProvider });
  assert.deepEqual(JSON.parse(JSON.stringify(await worker(readinessRequest, sender))), {
    ok: true, configured: false, notice: "[noticeProviderMissing]",
    tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: "[noticeSubtitleTracksUnread]"
  });
  // fetch 拒绝一次即被缓存，重复询问不重试、也绝不变成错误响应
  assert.deepEqual(rejected.calls, ["extension://_locales/zh_CN/messages.json"]);
  assert.equal((await worker(readinessRequest, sender)).ok, true);
  assert.deepEqual(rejected.calls, ["extension://_locales/zh_CN/messages.json"]);

  // 包内缺文件（404）与非法 JSON 同样逐级回落，不报错
  for (const texts of [new Map(), new Map([["extension://_locales/zh_CN/messages.json", "{ not json"]])]) {
    const fetcher = localeFetcher({ texts });
    const worker404 = createWorker(fetcher, { uiLanguage: "zh_CN" });
    assert.deepEqual(JSON.parse(JSON.stringify(await worker404(readinessRequest, sender))), {
      ok: true, configured: true, notice: null,
      tracksNotice: "[noticeSubtitleTracksMissing]", unreadNotice: "[noticeSubtitleTracksUnread]"
    });
  }
});

test("a key missing from the bundle falls back to the browser message, then to an empty hint", async () => {
  const url = "extension://_locales/zh_CN/messages.json";
  const savedUnread = I18N_MESSAGES.noticeSubtitleTracksUnread;
  const savedProvider = I18N_MESSAGES.noticeProviderMissing;
  try {
    // 包内只有两条：unread 缺失 → 回落 getMessage；notice/tracks 走包内
    const worker = createWorker(localeFetcher({ texts: new Map([[url, {
      noticeProviderMissing: { message: "ZH-PROVIDER" },
      noticeSubtitleTracksMissing: { message: "ZH-TRACKS" }
    }]]) }), { uiLanguage: "zh_CN", ...unconfiguredProvider });
    assert.deepEqual(JSON.parse(JSON.stringify(await worker(readinessRequest, sender))), {
      ok: true, configured: false, notice: "ZH-PROVIDER",
      tracksNotice: "ZH-TRACKS", unreadNotice: "[noticeSubtitleTracksUnread]"
    });
    assert.deepEqual(worker.localizedKeys, ["noticeSubtitleTracksUnread"]);

    // getMessage 也缺同一键时才是空串（两条轨道文案恒为字符串）
    delete I18N_MESSAGES.noticeSubtitleTracksUnread;
    const empty = await worker(readinessRequest, sender);
    assert.equal(empty.unreadNotice, "");
    assert.equal(empty.tracksNotice, "ZH-TRACKS");
    I18N_MESSAGES.noticeSubtitleTracksUnread = savedUnread;

    // 未配置：包内缺 noticeProviderMissing → getMessage 命中；两边都缺才是 null（不显示半句话）
    const worker2 = createWorker(localeFetcher({ texts: new Map([[url, {
      noticeSubtitleTracksMissing: { message: "ZH-TRACKS" }
    }]]) }), { uiLanguage: "zh_CN", ...unconfiguredProvider });
    assert.equal((await worker2(readinessRequest, sender)).notice, "[noticeProviderMissing]");
    delete I18N_MESSAGES.noticeProviderMissing;
    const missing = await worker2(readinessRequest, sender);
    assert.equal(missing.notice, null);
    assert.equal(missing.unreadNotice, "[noticeSubtitleTracksUnread]");
    assert.equal(typeof missing.tracksNotice, "string");
  } finally {
    if (savedProvider === undefined) delete I18N_MESSAGES.noticeProviderMissing;
    else I18N_MESSAGES.noticeProviderMissing = savedProvider;
    if (savedUnread === undefined) delete I18N_MESSAGES.noticeSubtitleTracksUnread;
    else I18N_MESSAGES.noticeSubtitleTracksUnread = savedUnread;
  }
});
