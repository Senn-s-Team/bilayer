/**
 * [INPUT]: 依赖 Node.js test/vm 与真实 service_worker.js、translationScheduler.js、overlay.js，模拟多 provider 扩展存储和 Chat Completions 响应
 * [OUTPUT]: 验证 provider 切换、日文原文注音结构化请求经 worker/scheduler/overlay 渲染、混合汉字/假名的空数组约束、兼容服务回包及 ID 校验、权限/错误和原始报文秘密边界
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
const message = {
  type: "BILAYER_TRANSLATE_BATCH",
  sourceLanguage: "en", targetLanguage: "zh-Hans",
  items: [{ id: "0", text: "Hello" }],
  contextBefore: [], contextAfter: ["How are you?"]
};

function createWorker(fetcher, stored = {}, permissionGranted = true) {
  let listener;
  const runtime = {
    storage: { local: {
      get(defaults, callback) { callback({ ...defaults, aiRole: "secondary", providers: [{ id: "openai", name: "OpenAI 官方", endpoint: "", model: "gpt-4o-mini", credential: "private-key" }], aiProviderId: "openai", ...stored }); },
      set(_data, callback) { if (typeof callback === "function") callback(); }
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
