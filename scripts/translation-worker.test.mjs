/**
 * [INPUT]: 依赖 Node.js test/vm 与真实 service_worker.js，模拟多 provider 扩展存储和 Chat Completions 响应
 * [OUTPUT]: 验证 provider 切换、兼容响应、权限/协议错误、HTTP/JSON/ID 校验阶段诊断与秘密脱敏
 * [POS]: scripts 的后台请求行为检查，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/background/service_worker.js", import.meta.url), "utf8");
const sender = { id: "extension-id", tab: { url: "https://www.netflix.com/watch/42" } };
const message = {
  type: "NETFLIX_DUAL_SUBTITLES_TRANSLATE_BATCH",
  sourceLanguage: "en", targetLanguage: "zh-Hans",
  items: [{ id: "0", text: "Hello" }],
  contextBefore: [], contextAfter: ["How are you?"]
};

function createWorker(fetcher, stored = {}, permissionGranted = true) {
  let listener;
  const runtime = {
    storage: { local: {
      get(defaults, callback) { callback({ ...defaults, aiRole: "secondary", providers: [{ id: "openai", name: "OpenAI 官方", endpoint: "", model: "gpt-4o-mini", credential: "private-key" }], aiProviderId: "openai", ...stored }); },
      set() {}
    } },
    permissions: { contains(_query, callback) { callback(permissionGranted); } },
    runtime: { id: "extension-id", getURL(path) { return `extension://${path}`; }, onInstalled: { addListener() {} }, onMessage: { addListener(callback) { listener = callback; } } }
  };
  runInNewContext(source, {
    browser: runtime, fetch: fetcher, URL, TextEncoder, AbortController, setTimeout, clearTimeout
  }, { filename: "service_worker.js" });
  return (request = message, from = sender) => new Promise((resolve) => listener(request, from, resolve));
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

test("compatible providers may return fenced JSON or text content parts", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: [{ type: "text", text: "```json\n{\"items\":[{\"id\":\"0\",\"text\":\"你好\"}]}\n```" }]
  } }] }));
  assert.deepEqual(JSON.parse(JSON.stringify(await worker())), { ok: true, items: [{ id: "0", text: "你好" }] });
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
  const result = await worker({ type: "NETFLIX_DUAL_SUBTITLES_TEST_PROVIDER", providerId: "custom" }, {
    id: "extension-id", url: "extension://src/popup/popup.html"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true });
  assert.equal(JSON.parse(sent.options.body).model, "c1");
  assert.equal(sent.options.headers.Authorization, "Bearer key2");
});
