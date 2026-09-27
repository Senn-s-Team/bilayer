/**
 * [INPUT]: 依赖 Node.js test/vm 与真实 service_worker.js，模拟多 provider 扩展存储和 Chat Completions 响应
 * [OUTPUT]: 验证 provider 切换、日文源语言 ruby 振假名 Schema 与提示词生成、兼容服务单字幕和逗号分隔对象序列、多字幕及 ID 校验、权限/错误和原始报文秘密边界
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
    browser: runtime, fetch: fetcher, URL, TextEncoder, AbortController, structuredClone, setTimeout, clearTimeout
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

test("compatible providers may return fenced JSON or text content parts", async () => {
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: [{ type: "text", text: "```json\n{\"items\":[{\"id\":\"0\",\"text\":\"你好\"}]}\n```" }]
  } }] }));
  assert.deepEqual(JSON.parse(JSON.stringify(await worker())), { ok: true, items: [{ id: "0", text: "你好" }] });
});

test("compatible providers with key typos like id/ or leading markdown are normalized and validated", async () => {
  const rawContent = '*```json\n{"items":[{"id/":"1482","text":"工厂便化为了密室","ruby":"{工場|こうじょう}は{密室|みっしつ}となった"}]}\n```';
  const worker = createWorker(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: rawContent
  } }] }), {
    providers: [{ id: "custom", name: "Custom", endpoint: "https://provider.example/v1/chat/completions", model: "gemini-3.5-flash-lite", credential: "private-key" }],
    aiProviderId: "custom"
  });
  const batch = { ...message, items: [{ id: "1482", text: "工場は密室となった" }] };
  const result = await worker(batch);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{
    id: "1482", text: "工厂便化为了密室", ruby: "{工場|こうじょう}は{密室|みっしつ}となった"
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
  const result = await worker({ type: "NETFLIX_DUAL_SUBTITLES_TEST_PROVIDER", providerId: "custom" }, {
    id: "extension-id", url: "extension://src/popup/popup.html"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true });
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
  const get = () => worker({ type: "NETFLIX_DUAL_SUBTITLES_GET_RAW_DIAGNOSTICS" }, page);
  assert.equal((await get()).records.length, 0);
  assert.equal((await worker({ type: "NETFLIX_DUAL_SUBTITLES_SET_RAW_DIAGNOSTICS", enabled: true }, page)).ok, true);
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
  assert.equal((await worker({ type: "NETFLIX_DUAL_SUBTITLES_GET_RAW_DIAGNOSTICS" }, sender)).ok, false);
  assert.equal((await worker({ type: "NETFLIX_DUAL_SUBTITLES_GET_RAW_DIAGNOSTICS" },
    { id: "extension-id", url: "extension://src/popup/popup.html" })).ok, false);
  assert.equal((await worker({ type: "NETFLIX_DUAL_SUBTITLES_CLEAR_RAW_DIAGNOSTICS" }, sender)).ok, false);
  assert.equal((await worker({ type: "NETFLIX_DUAL_SUBTITLES_CLEAR_RAW_DIAGNOSTICS" }, page)).ok, true);
  assert.equal((await get()).records.length, 0);
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
  const result = await worker({ type: "NETFLIX_DUAL_SUBTITLES_TEST_PROVIDER", providerId: "openai" }, onboardingSender);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true });
  assert.equal(sent.options.headers.Authorization, "Bearer key1");

  const maliciousSender = {
    id: "extension-id",
    url: "https://evil.com",
    tab: { id: 11, url: "https://evil.com" }
  };
  const deniedResult = await worker({ type: "NETFLIX_DUAL_SUBTITLES_TEST_PROVIDER", providerId: "openai" }, maliciousSender);
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
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ id: "0", text: "你好", ruby: "{私|わたし}は" }]);

  const body = JSON.parse(sent.options.body);
  assert.match(body.messages[0].content, /振假名/);
  assert.match(body.messages[0].content, /ruby/);
  assert.deepEqual(body.response_format.json_schema.schema.properties.items.items.required, ["id", "text", "ruby"]);
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
  assert.doesNotMatch(body.messages[0].content, /振假名/);
  assert.deepEqual(body.response_format.json_schema.schema.properties.items.items.required, ["id", "text"]);
});

test("Japanese target language requests ruby for translation in schema and prompt", async () => {
  let sent;
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "0", text: "私は学生です", ruby: "{私|わたし}は{学生|がくせい}です" }] })
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
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ id: "0", text: "私は学生です", ruby: "{私|わたし}は{学生|がくせい}です" }]);

  const body = JSON.parse(sent.options.body);
  assert.match(body.messages[0].content, /目标语言为日语/);
  assert.match(body.messages[0].content, /振假名/);
  assert.deepEqual(body.response_format.json_schema.schema.properties.items.items.required, ["id", "text", "ruby"]);
});

test("Japanese source language includes Katakana translation guidelines in prompt", async () => {
  let sent;
  const worker = createWorker(async (url, options) => {
    sent = { url, options };
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ items: [{ id: "0", text: "超级" }] })
    } }] });
  });

  const jpMessage = {
    ...message,
    sourceLanguage: "ja",
    targetLanguage: "zh-Hans",
    items: [{ id: "0", text: "ウルトラ" }]
  };

  await worker(jpMessage);
  const body = JSON.parse(sent.options.body);
  assert.match(body.messages[0].content, /片假名与外来语翻译准则/);
  assert.match(body.messages[0].content, /ウルトラ/);
  assert.match(body.messages[0].content, /奥特/);
});
