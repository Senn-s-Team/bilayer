/**
 * [INPUT]: 依赖 browser/chrome storage、permissions API 与 host_permissions/optional_host_permissions 的跨域 fetch 能力
 * [OUTPUT]: 初始化默认值，提供字幕下载、多 provider 翻译、兼容服务对象序列规范化、诊断、连通性测试与旧键迁移
 * [POS]: background 生命周期入口；凭证仅存于 provider 条目且只在 worker 内读取，兼容服务必须通过端点校验与运行时域名授权
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const runtime = globalThis.browser ?? globalThis.chrome;
const TRANSLATE_MESSAGE = "NETFLIX_DUAL_SUBTITLES_TRANSLATE_BATCH";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_PROVIDER_ID = "openai";
const DEFAULT_TRANSLATION_PROMPT = "你是一位专业的影视字幕翻译员，也是目标语言的母语使用者。只翻译 items[].text；contextBefore 和 contextAfter 仅用于理解语境，不要翻译或输出。保持每个 id、数量和顺序完全一致，不合并、不拆分、不遗漏字幕。保留人名、专有名词和既有译名；结合上下文处理代词、时态、人物关系和语气。使用自然、简洁、适合屏幕阅读的字幕表达，不添加解释、注释、时间戳或额外字段。";
const LEGACY_TRANSLATION_PROMPT = "请将字幕准确翻译成目标语言。保持原意、人物语气和上下文，使用自然口语；保留人名、专有名词与格式；不要添加解释或额外内容。";
const MAX_BATCH_ITEMS = 20;
const MAX_CONTEXT_ITEMS = 8;
const MAX_TEXT_LENGTH = 2000;
const MAX_PAYLOAD_BYTES = 40000;
const MAX_RESPONSE_BYTES = 80000;
const LOCALE_PATTERN = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;
const MODEL_PATTERN = /^[^\s\x00-\x1f]{1,120}$/;
const PROVIDER_PATTERN = /^[\w-]{1,48}$/;
const DIAGNOSTICS_PAGE = "src/diagnostics/diagnostics.html";
const ONBOARDING_PAGE = "src/onboarding/onboarding.html";
const rawDiagnostics = [];
const MAX_RAW_DIAGNOSTICS = 20;
let rawDiagnosticsVersion = 0;
let rawCaptureEnabled = false;
let rawDiagnosticSequence = 0;


const DEFAULT_SETTINGS = {
  onboardingCompleted: false,
  enabled: true,
  hideNativeSubtitles: true,
  primaryTrackKey: "",
  primaryTrackPreference: "",
  primaryLanguage: "",
  secondaryLanguage: "en",
  secondaryTrackKey: "",
  secondaryTrackPreference: "",
  primaryFontSize: 26,
  secondaryFontSize: 28,
  primaryVerticalOffset: 26,
  secondaryVerticalOffset: 18,
  subtitleLayoutPreset: "balanced",
  primaryFontFamily: "system",
  secondaryFontFamily: "system",
  primaryFontWeight: 700,
  secondaryFontWeight: 700,
  primaryTextColor: "#FFFFFF",
  secondaryTextColor: "#FFFFFF",
  primaryTextOpacity: 100,
  secondaryTextOpacity: 100,
  primaryStrokeWidth: 1,
  secondaryStrokeWidth: 1,
  primaryStrokeColor: "#000000",
  secondaryStrokeColor: "#000000",
  primaryBackgroundColor: "#000000",
  secondaryBackgroundColor: "#000000",
  primaryBackgroundOpacity: 64,
  secondaryBackgroundOpacity: 64,
  primaryLineHeight: 1.28,
  secondaryLineHeight: 1.28,
  primaryMaxWidth: 86,
  secondaryMaxWidth: 86,
  timingOffsetMs: 0,
  aiRole: "off",
  aiSourceTrackKey: "",
  aiSourceTrackPreference: "",
  aiSourceLanguage: "",
  aiTargetLanguage: "zh-Hans",
  aiProviderId: DEFAULT_PROVIDER_ID,
  aiPrefetchCount: 10,
  aiContextCount: 2,
  aiStyleGuide: ""
};

const DEFAULT_PROVIDERS = {
  providers: [
    { id: DEFAULT_PROVIDER_ID, name: "OpenAI 官方", endpoint: "", model: "gpt-4o-mini", credential: "" }
  ]
};

// 一次性把单服务时代的 aiModel/aiEndpoint/aiCredential 迁移进默认 provider；
// 之后旧键不再参与请求，存储只保留一套 provider 事实。
runtime.runtime.onInstalled.addListener((details) => {
  runtime.storage.local.get({ ...DEFAULT_SETTINGS, ...DEFAULT_PROVIDERS }, (stored) => {
    const providers = Array.isArray(stored.providers) && stored.providers.length
      ? stored.providers
      : structuredClone(DEFAULT_PROVIDERS.providers);
    if (stored.aiModel !== undefined || stored.aiEndpoint !== undefined || stored.aiCredential !== undefined) {
      const legacy = providers.find((item) => item.id === DEFAULT_PROVIDER_ID);
      if (legacy) {
        if (typeof stored.aiModel === "string" && stored.aiModel) legacy.model = stored.aiModel;
        if (typeof stored.aiEndpoint === "string" && stored.aiEndpoint) legacy.endpoint = stored.aiEndpoint;
        if (typeof stored.aiCredential === "string" && stored.aiCredential) legacy.credential = stored.aiCredential;
      }
    }
    runtime.storage.local.set({
      ...DEFAULT_SETTINGS,
      ...stored,
      providers,
      aiModel: undefined,
      aiEndpoint: undefined,
      aiCredential: undefined
    });
    if (details?.reason === "install" && !stored.onboardingCompleted) {
      runtime.tabs?.create?.({ url: runtime.runtime.getURL(ONBOARDING_PAGE) });
    }
  });
});
runtime.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === TRANSLATE_MESSAGE) {
    void translateBatch(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, errorCode: "unavailable",
        ...(message.diagnostic === true ? { trace: [{ stage: "rejected", reason: "worker_exception" }] } : {}) }));
    return true;
  }
  if (message?.type === "NETFLIX_DUAL_SUBTITLES_TEST_PROVIDER") {
    void testProviderConnection(message.providerId, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, errorCode: "unavailable" }));
    return true;
  }
  if (message?.type === "NETFLIX_DUAL_SUBTITLES_LIST_MODELS") {
    void listProviderModels(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, errorCode: "unavailable" }));
    return true;
  }

  if (message?.type === "NETFLIX_DUAL_SUBTITLES_GET_RAW_DIAGNOSTICS") {
    if (!isDiagnosticsSender(sender)) {
      sendResponse({ ok: false, errorCode: "configuration" });
      return true;
    }
    sendResponse({ ok: true, enabled: rawCaptureEnabled, version: rawDiagnosticsVersion,
      ...(message.version === rawDiagnosticsVersion ? {} : { records: rawDiagnostics.map((record) => structuredClone(record)) }) });
    return true;
  }
  if (message?.type === "NETFLIX_DUAL_SUBTITLES_SET_RAW_DIAGNOSTICS") {
    if (!isDiagnosticsSender(sender) || typeof message.enabled !== "boolean") {
      sendResponse({ ok: false, errorCode: "configuration" });
      return true;
    }
    rawCaptureEnabled = message.enabled;
    sendResponse({ ok: true, enabled: rawCaptureEnabled });
    return true;
  }
  if (message?.type === "NETFLIX_DUAL_SUBTITLES_CLEAR_RAW_DIAGNOSTICS") {
    if (!isDiagnosticsSender(sender)) {
      sendResponse({ ok: false, errorCode: "configuration" });
      return true;
    }
    rawDiagnostics.length = 0;
    rawDiagnosticsVersion++;
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type !== "NETFLIX_DUAL_SUBTITLES_FETCH_SUBTITLE") return false;

  void fetchSubtitle(message.url)
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({
        ok: false,
        status: 0,
        error: error?.message ?? String(error)
      });
    });

  return true;
});

async function translateBatch(message, sender, testProviderId = "") {
  if ((!testProviderId && !isAllowedSender(sender)) || !isValidBatch(message)) {
    return { ok: false, errorCode: "configuration" };
  }
  const trace = message.diagnostic === true && !testProviderId ? [] : null;
  const record = (stage, details = {}) => { if (trace) trace.push({ stage, ...details }); };
  const result = (value) => trace ? { ...value, trace } : value;
  let rawRecord;
  const reject = (errorCode, stage, details) => {
    if (rawRecord) rawRecord.failure = { errorCode, reason: details?.reason ?? stage };
    record(stage, { errorCode, ...details });
    return result({ ok: false, errorCode });
  };

  let settings;
  try {
    settings = await new Promise((resolve, reject) => {
      runtime.storage.local.get({
        aiRole: "off",
        aiProviderId: DEFAULT_PROVIDER_ID,
        aiStyleGuide: DEFAULT_TRANSLATION_PROMPT,
        providers: []
      }, (stored) => {
        if (runtime.runtime.lastError) reject(new Error("storage unavailable"));
        else resolve(stored);
      });
    });
  } catch {
    return reject("configuration", "rejected", { reason: "storage_unavailable" });
  }

  if (!testProviderId && settings.aiRole !== "primary" && settings.aiRole !== "secondary") {
    return reject("configuration", "rejected", { reason: "ai_disabled" });
  }
  const provider = pickProvider(settings.providers, testProviderId || settings.aiProviderId);
  const styleGuide = typeof settings.aiStyleGuide === "string" && settings.aiStyleGuide.trim()
    ? settings.aiStyleGuide.trim()
    : DEFAULT_TRANSLATION_PROMPT;
  const customStyleGuide = styleGuide === DEFAULT_TRANSLATION_PROMPT || styleGuide === LEGACY_TRANSLATION_PROMPT ? "" : styleGuide;
  if (!provider) return reject("configuration", "rejected", { reason: "provider_missing" });
  if (typeof provider.credential !== "string" || !provider.credential.trim()) {
    return reject("configuration", "rejected", { reason: "credential_missing" });
  }
  if (typeof provider.model !== "string" || !MODEL_PATTERN.test(provider.model)) {
    return reject("configuration", "rejected", { reason: "model_invalid" });
  }
  if (typeof provider.endpoint !== "string" || (provider.endpoint && !isValidEndpoint(provider.endpoint))) {
    return reject("configuration", "rejected", { reason: "endpoint_invalid" });
  }
  if (typeof settings.aiStyleGuide !== "string" || new TextEncoder().encode(settings.aiStyleGuide).length > 2000) {
    return reject("configuration", "rejected", { reason: "style_invalid" });
  }

  const endpoint = provider.endpoint || OPENAI_ENDPOINT;
  record("configured", { providerId: provider.id, model: provider.model, endpointOrigin: new URL(endpoint).origin,
    itemCount: message.items.length, beforeCount: message.contextBefore.length, afterCount: message.contextAfter.length });
  if (provider.endpoint) {
    const url = new URL(endpoint);
    const origin = `${url.protocol}//${url.hostname}/*`;
    const granted = await new Promise((resolve) => {
      if (!runtime.permissions?.contains) { resolve(false); return; }
      runtime.permissions.contains({ origins: [origin] }, (allowed) => {
        resolve(!runtime.runtime.lastError && allowed === true);
      });
    });
    record("permission", { granted });
    if (!granted) return reject("permission_denied", "rejected", { reason: "host_permission_missing" });
  } else {
    record("permission", { granted: true, source: "manifest" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const startedAt = Date.now();
  record("request", { method: "POST", protocol: "chat_completions" });
  try {
    const requestOptions = {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${provider.credential}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.2,
        ...(endpoint === OPENAI_ENDPOINT ? { response_format: {
          type: "json_schema",
          json_schema: {
            name: "subtitle_translations",
            strict: true,
            schema: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" }, text: { type: "string" } },
                    required: ["id", "text"],
                    additionalProperties: false
                  }
                }
              },
              required: ["items"],
              additionalProperties: false
            }
          }
        } } : {}),
        messages: [
          {
            role: "system",
            content: "你是一位专业的影视字幕翻译员，也是目标语言的母语使用者。" +
              "只翻译 items[].text；contextBefore 和 contextAfter 仅用于理解语境，不要翻译或输出。" +
              "保持每个 id、数量和顺序完全一致，不合并、不拆分、不遗漏字幕。" +
              "只返回 JSON 对象 {\"items\":[{\"id\":\"原字幕 id\",\"text\":\"译文\"}]}，items 包含本次请求的全部字幕。" +
              "保留人名、专有名词和既有译名；结合上下文处理代词、时态、人物关系和语气。" +
              "使用自然、简洁、适合屏幕阅读的字幕表达，不添加解释、注释、时间戳或额外字段。" +
              `源语言：${message.sourceLanguage}；目标语言：${message.targetLanguage}。` +
              `上下文只用于消歧。${customStyleGuide ? `自定义风格要求：${customStyleGuide}` : ""}`
          },
          {
            role: "user",
            content: JSON.stringify({
              sourceLanguage: message.sourceLanguage,
              targetLanguage: message.targetLanguage,
              items: message.items,
              contextBefore: message.contextBefore,
              contextAfter: message.contextAfter
            })
          }
        ]
      })
    };
    if (rawCaptureEnabled) {
      rawRecord = {
        id: ++rawDiagnosticSequence,
        at: startedAt,
        request: { url: endpoint, method: requestOptions.method, headers: { "Content-Type": "application/json" }, body: requestOptions.body },
        response: null
      };
      rawDiagnostics.push(rawRecord);
      if (rawDiagnostics.length > MAX_RAW_DIAGNOSTICS) rawDiagnostics.shift();
      rawDiagnosticsVersion++;
    }
    const response = await fetch(endpoint, requestOptions);

    record("response", { status: response.status, durationMs: Date.now() - startedAt });
    const content = await response.text();
    if (rawRecord) rawRecord.response = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: content
    };
    if (!response.ok) return reject(classifyProviderError(response.status, content), "rejected", { reason: "http_error", status: response.status });
    const responseBytes = new TextEncoder().encode(content).length;
    if (responseBytes > MAX_RESPONSE_BYTES) {
      return reject("invalid_response", "rejected", { reason: "response_too_large", responseBytes });
    }

    let data;
    try {
      data = JSON.parse(content);
    } catch {
      return reject("invalid_response", "rejected", { reason: "envelope_not_json", responseBytes });
    }
    const choice = data?.choices?.[0];
    const messageContent = normalizeMessageContent(choice?.message?.content);
    record("parsed", { responseBytes, finishReason: ["stop", "length", "content_filter", "tool_calls"].includes(choice?.finish_reason)
      ? choice.finish_reason : "other",
      contentKind: typeof choice?.message?.content === "string" ? "text" : Array.isArray(choice?.message?.content) ? "parts" : "missing" });
    if (choice?.message?.refusal) return reject("invalid_response", "rejected", { reason: "refusal" });
    if (choice?.finish_reason !== "stop") return reject("invalid_response", "rejected", { reason: "finish_reason" });
    if (messageContent == null) return reject("invalid_response", "rejected", { reason: "content_missing" });
    try {
      data = parseTranslationJson(messageContent, Boolean(provider.endpoint));
    } catch {
      return reject("invalid_response", "rejected", { reason: "translation_not_json" });
    }
    if (provider.endpoint && message.items.length === 1 && data?.id === message.items[0].id) {
      data = { items: [data] };
    }
    if (!isValidTranslation(data, message.items)) {
      return reject("invalid_response", "rejected", { reason: "items_mismatch", expectedCount: message.items.length,
        receivedCount: Array.isArray(data?.items) ? data.items.length : null });
    }
    record("validated", { itemCount: data.items.length });
    if (rawRecord) rawRecord.validated = true;
    return result({ ok: true, items: data.items });
  } catch {
    if (rawRecord) rawRecord.error = controller.signal.aborted ? "timeout" : "network_error";
    return reject("unavailable", "rejected", { reason: controller.signal.aborted ? "timeout" : "network_error",
      durationMs: Date.now() - startedAt });
  } finally {
    clearTimeout(timeout);
    if (rawRecord) rawRecord.completedAt = Date.now();
    if (rawRecord) rawDiagnosticsVersion++;
  }
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
  return text || null;
}

function parseTranslationJson(content, compatible) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    if (!compatible || !candidate.startsWith("{")) throw error;
    return { items: JSON.parse(`[${candidate}]`) };
  }
}

async function testProviderConnection(providerId, sender) {
  if (!isAllowedTestSender(sender) || typeof providerId !== "string" || !PROVIDER_PATTERN.test(providerId)) {
    return { ok: false, errorCode: "configuration" };
  }
  const result = await translateBatch({
    sourceLanguage: "en",
    targetLanguage: "zh-Hans",
    items: [{ id: "connection", text: "Hello" }],
    contextBefore: [],
    contextAfter: []
  }, sender, providerId);
  return result.ok ? { ok: true } : result;
}

async function listProviderModels(message, sender) {
  if (!isAllowedTestSender(sender)) return { ok: false, errorCode: "configuration" };
  const providerId = typeof message === "string" ? message : message?.providerId;
  let credential = typeof message === "object" ? (message.credential ?? "") : "";
  let endpoint = typeof message === "object" ? (message.endpoint ?? "") : "";

  if ((!credential || !credential.trim()) && typeof providerId === "string" && PROVIDER_PATTERN.test(providerId)) {
    let stored;
    try {
      stored = await new Promise((resolve, reject) => runtime.storage.local.get({ providers: [] }, (value) => {
        if (runtime.runtime.lastError) reject(new Error("storage unavailable")); else resolve(value);
      }));
    } catch { return { ok: false, errorCode: "configuration" }; }
    const provider = pickProvider(stored.providers, providerId);
    if (!provider || typeof provider.credential !== "string" || !provider.credential.trim() ||
        typeof provider.endpoint !== "string" || (provider.endpoint && !isValidEndpoint(provider.endpoint))) {
      return { ok: false, errorCode: "configuration" };
    }
    credential = provider.credential;
    endpoint = provider.endpoint;
  }

  if (typeof credential !== "string") return { ok: false, errorCode: "configuration" };
  endpoint = endpoint || OPENAI_ENDPOINT;
  if (!isValidEndpoint(endpoint)) return { ok: false, errorCode: "configuration" };

  if (endpoint !== OPENAI_ENDPOINT) {
    const url = new URL(endpoint);
    const origin = `${url.protocol}//${url.hostname}/*`;
    const granted = await new Promise((resolve) => {
      if (!runtime.permissions?.contains) { resolve(false); return; }
      runtime.permissions.contains({ origins: [origin] }, (allowed) => resolve(!runtime.runtime.lastError && allowed === true));
    });
    if (!granted) return { ok: false, errorCode: "permission_denied" };
  }
  const modelsUrl = endpoint.slice(0, -"chat/completions".length) + "models";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(modelsUrl, { method: "GET", credentials: "omit", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${credential}` } });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      return { ok: false, errorCode: classifyProviderError(response.status, errorBody) };
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).length > MAX_RESPONSE_BYTES) return { ok: false, errorCode: "invalid_response" };
    const data = JSON.parse(body);
    if (!Array.isArray(data?.data)) return { ok: false, errorCode: "invalid_response" };
    const models = [...new Set(data.data.map((item) => item?.id).filter((id) => typeof id === "string" && MODEL_PATTERN.test(id)))].sort();
    return { ok: true, models: models.slice(0, 200) };
  } catch { return { ok: false, errorCode: "unavailable" }; }
  finally { clearTimeout(timeout); }
}

function isValidEndpoint(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.endsWith("/chat/completions") && url.href === raw;
  } catch {
    return false;
  }
}

function pickProvider(providers, providerId) {
  if (!Array.isArray(providers)) return null;
  return providers.find((item) => item && typeof item === "object" &&
    typeof item.id === "string" && PROVIDER_PATTERN.test(item.id) && item.id === providerId) ?? null;
}
function isAllowedTestSender(sender) {
  if (sender?.id !== runtime.runtime.id) return false;
  const popupUrl = runtime.runtime.getURL("src/popup/popup.html");
  const onboardingUrl = runtime.runtime.getURL(ONBOARDING_PAGE);
  if (sender.url === popupUrl && !sender.tab) return true;
  if (sender.url === onboardingUrl) return true;
  return false;
}

function isDiagnosticsSender(sender) {
  return sender?.id === runtime.runtime.id && sender.url === runtime.runtime.getURL(DIAGNOSTICS_PAGE);
}

function isAllowedSender(sender) {
  if (sender?.id != null && sender.id !== runtime.runtime.id) return false;
  if (typeof sender?.tab?.url !== "string") return false;
  try {
    const url = new URL(sender.tab.url);
    return url.protocol === "https:" &&
      (url.hostname === "netflix.com" || url.hostname === "www.netflix.com") &&
      /^\/watch\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function isValidBatch(message) {
  if (typeof message.sourceLanguage !== "string" ||
      typeof message.targetLanguage !== "string" ||
      !LOCALE_PATTERN.test(message.sourceLanguage) ||
      !LOCALE_PATTERN.test(message.targetLanguage) ||
      !Array.isArray(message.items) || message.items.length === 0 ||
      message.items.length > MAX_BATCH_ITEMS ||
      !Array.isArray(message.contextBefore) || !Array.isArray(message.contextAfter) ||
      message.contextBefore.length > MAX_CONTEXT_ITEMS ||
      message.contextAfter.length > MAX_CONTEXT_ITEMS) return false;

  const ids = new Set();
  for (const item of message.items) {
    if (!item || Object.keys(item).length !== 2 ||
        typeof item.id !== "string" || !item.id || item.id.length > 80 ||
        ids.has(item.id) || !isSubtitleText(item.text)) return false;
    ids.add(item.id);
  }
  if (![...message.contextBefore, ...message.contextAfter].every(isSubtitleText)) return false;
  return new TextEncoder().encode(JSON.stringify({
    sourceLanguage: message.sourceLanguage,
    targetLanguage: message.targetLanguage,
    items: message.items,
    contextBefore: message.contextBefore,
    contextAfter: message.contextAfter
  })).length <= MAX_PAYLOAD_BYTES;
}

function isSubtitleText(text) {
  return typeof text === "string" && text.trim().length > 0 && text.length <= MAX_TEXT_LENGTH;
}

function isValidTranslation(data, sourceItems) {
  if (!data || Object.keys(data).length !== 1 || !Array.isArray(data.items) ||
      data.items.length !== sourceItems.length) return false;
  const expected = new Set(sourceItems.map((item) => item.id));
  let bytes = 0;
  for (const item of data.items) {
    if (!item || Object.keys(item).length !== 2 || typeof item.id !== "string" ||
        !expected.delete(item.id) || !isSubtitleText(item.text)) return false;
    bytes += new TextEncoder().encode(item.text).length;
    if (bytes > MAX_PAYLOAD_BYTES) return false;
  }
  return expected.size === 0;
}

function classifyProviderError(status, content) {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) {
    try {
      const body = JSON.parse(content);
      if (body?.error?.code === "insufficient_quota" ||
          body?.error?.type === "insufficient_quota") return "quota";
    } catch { /* 限流服务可能返回非 JSON 错误正文。 */ }
    return "rate_limit";
  }
  if (status === 400 || status === 404 || status === 422) return "configuration";
  return "unavailable";
}

async function fetchSubtitle(url) {
  const response = await fetch(normalizeUrl(url), {
    credentials: "omit",
    cache: "force-cache",
    redirect: "follow"
  });
  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    contentType: response.headers.get("content-type") ?? "",
    text
  };
}

function normalizeUrl(url) {
  return String(url ?? "")
    .trim()
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}
