/**
 * [INPUT]: 依赖 browser/chrome storage、IndexedDB diagnostics_store.js 与 translation_cache_store.js、permissions API
 * [OUTPUT]: 初始化默认设置并迁移历史键；提供诊断 QUERY/GET/EXPORT/SET/CLEAR 与翻译缓存 REGISTER/READ/STATS/CLEAR 消息、多 provider 翻译（成功返回实际 cacheMetadata，IDB 写失败不改写译文）、字幕下载、设置窗口与连通性服务
 * [POS]: classic background service worker；入口同步加载两个持久层，凭证仅在 worker 内读取；诊断历史和缓存管理仅接受自有 settings.html URL；缓存提交使用请求配置快照，存储错误不伪装为空数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
if (typeof importScripts === "function") importScripts("diagnostics_store.js", "translation_cache_store.js");

const runtime = globalThis.browser ?? globalThis.chrome;
const TRANSLATE_MESSAGE = "BILAYER_TRANSLATE_BATCH";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
// 无需凭证的本地端点（settings/onboarding 的 Ollama 预设）：就绪度判定与 settings 的「获取模型/测试连通性」门槛同一规则。
const KEYLESS_ENDPOINTS = new Set(["http://localhost:11434/v1/chat/completions"]);
const DEFAULT_PROVIDER_ID = "openai";
// 后台 UI 文案的语言来源 = 扩展自身的界面语言偏好 runtime.storage.local.uiLanguage，与 extension/src/i18n.js 同一语义。
// auto：跟随浏览器语言（runtime.i18n.getMessage）；en/zh_CN：取包内 _locales/<code>/messages.json。
// 与 i18n.js 相比这里是刻意的重复实现：service worker 没有 DOM 与 localStorage，无法加载 i18n.js（其解析期
// 依赖同步 XHR），平台也拒绝 worker 里的同步请求，故只能异步 fetch 包内文件并各自维护缓存。
const UI_LANGUAGE_AUTO = "auto";
const BUNDLED_UI_LOCALES = Object.freeze(["en", "zh_CN"]);
// locale → Promise<bundle|null>：同一语言只取一次，成功与不可用都缓存，worker 生命周期内复用。
const localeBundles = new Map();
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
const ONBOARDING_PAGE = "src/onboarding/onboarding.html";
const SETTINGS_PAGE = "src/settings/settings.html";
let rawDiagnosticsLoad = null;
let capturePreferenceSetByUser = false;
let rawCapturePreferenceKnown = false;
let diagnosticsPreferenceWrite = Promise.resolve();


function loadRawDiagnosticsIfNeeded() {
  if (rawDiagnosticsLoad) return rawDiagnosticsLoad;
  rawDiagnosticsLoad = (async () => {
    try {
      const stored = await new Promise((resolve, reject) => runtime.storage.local.get(["__raw_capture_enabled__"], (value) => {
        if (runtime.runtime?.lastError) reject(new Error("storage_unavailable")); else resolve(value);
      }));
      if (!capturePreferenceSetByUser) rawCaptureEnabled = stored?.__raw_capture_enabled__ !== false;
      rawCapturePreferenceKnown = true;
      await BilayerDiagnosticsStore.initialize(
        () => new Promise((resolve, reject) => runtime.storage.local.get(["__raw_diagnostics__", "__raw_diagnostics_version__", "__raw_diagnostic_seq__"], (value) => runtime.runtime?.lastError ? reject(new Error("storage_unavailable")) : resolve(value))),
        () => new Promise((resolve, reject) => runtime.storage.local.remove(["__raw_diagnostics__", "__raw_diagnostics_version__", "__raw_diagnostic_seq__"], () => runtime.runtime?.lastError ? reject(new Error("storage_unavailable")) : resolve()))
      );
      diagnosticsStorageError = null;
      return true;
    } catch (error) { diagnosticsStorageError = error?.message ?? "storage_unavailable"; rawDiagnosticsLoad = null; return false; }
  })();
  return rawDiagnosticsLoad;
}

function persistRawCapturePreference(enabled) {
  const write = diagnosticsPreferenceWrite.catch(() => {}).then(() => new Promise((resolve, reject) => runtime.storage.local.set({ __raw_capture_enabled__: enabled }, () => runtime.runtime?.lastError ? reject(new Error("storage_unavailable")) : resolve())));
  diagnosticsPreferenceWrite = write;
  return write;
}



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
  // 0 表示不限（content 侧 budgetLimits() 把它转成 null 上限交给调度器）
  aiRequestBudget: 80,
  aiCharacterBudget: 40000,
  aiStyleGuide: "",
  aiJapaneseRuby: true
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

// 只有在 manifest 里去掉 action.default_popup，浏览器才会把工具栏点击交给我们：点击即打开/聚焦设置窗口。
runtime.action?.onClicked?.addListener(() => openSettingsWindow());
// 浏览器启动：窗口 id 会被新会话复用，上个会话记住的记录必须作废。
runtime.runtime.onStartup?.addListener(() => forgetSettingsWindow());

runtime.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === TRANSLATE_MESSAGE) {
    void translateBatch(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, errorCode: "unavailable",
        ...(message.diagnostic === true ? { trace: [{ stage: "rejected", reason: "worker_exception" }] } : {}) }));
    return true;
  }
  if (message?.type === "BILAYER_TEST_PROVIDER") {
    void testProviderConnection(message.providerId, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, errorCode: "unavailable" }));
    return true;
  }
  if (message?.type === "BILAYER_LIST_MODELS") {
    void listProviderModels(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, errorCode: "unavailable" }));
    return true;
  }

  if (message?.type === "BILAYER_OPEN_SETTINGS") {
    if (!isAllowedTestSender(sender)) {
      sendResponse({ ok: false, errorCode: "configuration" });
      return true;
    }
    void openSettingsWindow().then(sendResponse);
    return true;
  }

  if (message?.type === "BILAYER_AI_READINESS") {
    if (!isReadinessSender(sender)) {
      sendResponse({ ok: false, errorCode: "configuration" });
      return true;
    }
    void aiReadinessSnapshot()
      .then((snapshot) => sendResponse({ ok: true, ...snapshot }))
      .catch(() => sendResponse({ ok: false, errorCode: "unavailable" }));
    return true;
  }

  if (message?.type === "BILAYER_QUERY_RAW_DIAGNOSTICS" || message?.type === "BILAYER_GET_RAW_DIAGNOSTIC" || message?.type === "BILAYER_EXPORT_RAW_DIAGNOSTICS" || message?.type === "BILAYER_SET_RAW_DIAGNOSTICS" || message?.type === "BILAYER_CLEAR_RAW_DIAGNOSTICS") {
    if (!isSettingsSender(sender)) { sendResponse({ ok: false, errorCode: "configuration" }); return true; }
    void handleDiagnosticsMessage(message).then(sendResponse).catch((error) => sendResponse({ ok: false, errorCode: error?.message?.startsWith("storage_") ? error.message : "storage_unavailable" }));
    return true;
  }
  if (["BILAYER_REGISTER_TRANSLATION_CACHE_SOURCE", "BILAYER_READ_TRANSLATION_CACHE", "BILAYER_GET_TRANSLATION_CACHE_STATS", "BILAYER_CLEAR_TRANSLATION_CACHE"].includes(message?.type)) {
    if (!isAllowedSender(sender) && !isSettingsSender(sender)) { sendResponse({ ok: false, errorCode: "configuration" }); return true; }
    void handleTranslationCacheMessage(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, errorCode: error?.message?.startsWith("storage_") ? error.message : "storage_unavailable" }));
    return true;
  }
  if (message?.type === "BILAYER_FETCH_SUBTITLE") {
    void fetchSubtitle(message.url).then(sendResponse).catch((error) => sendResponse({ ok: false, status: 0, error: error?.message ?? String(error) }));
    return true;
  }

  return false;
});

async function handleDiagnosticsMessage(message) {
  if (message.type === "BILAYER_SET_RAW_DIAGNOSTICS") {
    if (typeof message.enabled !== "boolean") return { ok: false, errorCode: "configuration" };
    capturePreferenceSetByUser = true;
    rawCapturePreferenceKnown = true;
    rawCaptureEnabled = message.enabled;
    void loadRawDiagnosticsIfNeeded();
    try { await persistRawCapturePreference(message.enabled); return { ok: true, enabled: message.enabled, persisted: true }; }
    catch { return { ok: false, enabled: message.enabled, persisted: false, errorCode: "storage_unavailable" }; }
  }
  const loaded = await loadRawDiagnosticsIfNeeded();
  if (!loaded) return { ok: false, errorCode: "storage_unavailable", enabled: rawCaptureEnabled,
    preferenceKnown: rawCapturePreferenceKnown, storageError: { reason: diagnosticsStorageError ?? "storage_unavailable" } };
  if (message.type === "BILAYER_CLEAR_RAW_DIAGNOSTICS") return await BilayerDiagnosticsStore.clear();
  if (message.type === "BILAYER_GET_RAW_DIAGNOSTIC") return BilayerDiagnosticsStore.detail(message.id, message.generation);
  if (message.type === "BILAYER_EXPORT_RAW_DIAGNOSTICS") return BilayerDiagnosticsStore.exportPage(message);
  const page = await BilayerDiagnosticsStore.query({ ...message, enabled: rawCaptureEnabled, preferenceKnown: rawCapturePreferenceKnown });
  return { ...page, storageError: diagnosticsStorageError ? { reason: diagnosticsStorageError } : null };
}

async function handleTranslationCacheMessage(message, sender) {
  await loadRawDiagnosticsIfNeeded();
  const preferences = await new Promise((resolve, reject) => runtime.storage.local.get({ aiCacheMode: "session", aiCacheRetentionDays: 30, aiCacheMaxMiB: 256 }, (stored) => {
    if (runtime.runtime.lastError) reject(new Error("storage_unavailable")); else resolve(stored);
  }));
  const cacheMode = preferences.aiCacheMode === "local" ? "local" : "session";
  const retentionDays = Number.isInteger(preferences.aiCacheRetentionDays) && preferences.aiCacheRetentionDays >= 0 && preferences.aiCacheRetentionDays <= 3650 ? preferences.aiCacheRetentionDays : 30;
  const maxBytes = Number.isInteger(preferences.aiCacheMaxMiB) && preferences.aiCacheMaxMiB >= 0 && preferences.aiCacheMaxMiB <= 65536 ? preferences.aiCacheMaxMiB * 1048576 : 256 * 1048576;
  if (message.type === "BILAYER_REGISTER_TRANSLATION_CACHE_SOURCE") {
    if (!isAllowedSender(sender) || message.episodeId !== watchIdFromSender(sender)) return { ok: false, errorCode: "configuration" };
    const result = await BilayerTranslationCacheStore.registerSource(message, cacheMode, { maxBytes });
    return result;
  }
  if (message.type === "BILAYER_READ_TRANSLATION_CACHE") {
    if (!isAllowedSender(sender) || message.episodeId !== watchIdFromSender(sender)) return { ok: false, errorCode: "configuration" };
    if (cacheMode !== "local") return { ok: true, snapshots: [] };
    return BilayerTranslationCacheStore.read(message, { retentionDays, maxBytes });
  }
  if (message.type === "BILAYER_GET_TRANSLATION_CACHE_STATS") {
    if (!isSettingsSender(sender)) return { ok: false, errorCode: "configuration" };
    return BilayerTranslationCacheStore.stats(message.episodeId, { retentionDays, maxBytes });
  }
  if (message.type === "BILAYER_CLEAR_TRANSLATION_CACHE") {
    if (!isSettingsSender(sender)) return { ok: false, errorCode: "configuration" };
    const result = await BilayerTranslationCacheStore.clear(message.episodeId);
    return result;
  }
  return { ok: false, errorCode: "configuration" };
}

function watchIdFromSender(sender) {
  try { return new URL(sender.tab.url).pathname.split("/")[2] ?? ""; } catch { return ""; }
}
function isSettingsSender(sender) {
  return sender?.id === runtime.runtime.id && sender.url === runtime.runtime.getURL(SETTINGS_PAGE);
}

async function persistAcceptedTranslation(message, sender, settings, provider, endpoint, items, dispatchedGeneration) {
  const capture = message.cacheCapture;
  const episodeId = watchIdFromSender(sender);
  const prompt = String(settings.aiStyleGuide ?? "").trim();
  const semanticIntent = !prompt || prompt === DEFAULT_TRANSLATION_PROMPT || prompt === LEGACY_TRANSLATION_PROMPT ? "default-v1" : prompt;
  const createdAt = Date.now();
  const provenance = { providerId: provider.id, providerName: provider.name, model: provider.model,
    endpoint: (() => { try { const url = new URL(endpoint); return `${url.origin}${url.pathname}`; } catch { return ""; } })() };
  const metadata = { semanticIntent, translationSemantics: "cue-v1", annotationSemantics: null, provenance, createdAt };
  const sourceById = new Map(message.items.map((item) => [item.id, item.text]));
  const annotationSide = isJapanese(message.targetLanguage) ? "target" : isJapanese(message.sourceLanguage) ? "source" : null;
  const hasValidReadings = annotationSide && items.every((item) => {
    const anchor = annotationSide === "target" ? item.text : sourceById.get(item.id);
    return typeof anchor === "string" && item.readings &&
      Object.entries(item.readings).every(([surface]) => anchor.includes(surface)) &&
      (isKanaOnly(anchor) || Object.keys(item.readings).length > 0);
  });
  if (hasValidReadings) { metadata.annotationSemantics = "reading-v1"; metadata.annotationSide = annotationSide; }
  if (settings.aiCacheMode === "local" && capture && typeof capture.sourceId === "string" && episodeId) {
    let source = null;
    try { source = await BilayerTranslationCacheStore.source(capture.sourceId); }
    catch { metadata.storageError = "storage_unavailable"; }
    if (source && source.episodeId === episodeId && source.sourceLanguage === message.sourceLanguage &&
        Array.isArray(capture.itemIndices) && Array.isArray(capture.beforeIndices) && Array.isArray(capture.afterIndices)) {
      const requestItemsById = new Map(message.items.map((item, index) => [item.id, { item, index }]));
      const sourceTexts = items.map((item) => source.texts[capture.itemIndices[requestItemsById.get(item.id)?.index]]);
      const beforeTexts = capture.beforeIndices.map((index) => source.texts[index]);
      const afterTexts = capture.afterIndices.map((index) => source.texts[index]);
      const exact = (indices, texts) => indices.length === texts.length && indices.every((index, offset) =>
        Number.isInteger(index) && index >= 0 && index < source.texts.length && source.texts[index] === texts[offset]);
      const responseIdsMatch = items.every((item) => requestItemsById.has(item.id));
      if (responseIdsMatch && sourceTexts.length === items.length && sourceTexts.every((text, index) => text === requestItemsById.get(items[index].id).item.text) &&
          beforeTexts.length === message.contextBefore.length && beforeTexts.every((text, index) => text === message.contextBefore[index]) &&
          afterTexts.length === message.contextAfter.length && afterTexts.every((text, index) => text === message.contextAfter[index]) &&
          exact(capture.itemIndices, capture.itemIndices.map((index) => source.texts[index])) && exact(capture.beforeIndices, beforeTexts) && exact(capture.afterIndices, afterTexts)) {
        if (settings.aiCacheMode === "local") {
          try {
            if (!dispatchedGeneration) throw new Error("storage_unavailable");
            const generation = dispatchedGeneration;
            const committed = await BilayerTranslationCacheStore.commitBatch({ sourceId: capture.sourceId, episodeId,
              sourceLanguage: message.sourceLanguage, trackKind: source.trackKind, targetLanguage: message.targetLanguage,
              semanticIntent, itemIndices: items.map((item) => capture.itemIndices[requestItemsById.get(item.id).index]),
              beforeIndices: capture.beforeIndices, afterIndices: capture.afterIndices,
              sourceTexts, beforeTexts, afterTexts,
              items: items.map((item, index) => ({ ...item, sourceText: sourceTexts[index], translatedText: item.text })),
              provenance, generation, annotationSemantics: metadata.annotationSemantics, annotationSide: metadata.annotationSide, createdAt },
            { maxBytes: settings.aiCacheMaxMiB * 1048576 });
            if (!committed.ok) metadata.storageError = committed.errorCode;
            else metadata.id = committed.id;
          } catch { metadata.storageError = "storage_unavailable"; }
        }
      }
    }
  }
  return metadata;
}

async function translateBatch(message, sender, testProviderId = "") {
  if ((!testProviderId && !isAllowedSender(sender)) || !isValidBatch(message)) {
    return { ok: false, errorCode: "configuration" };
  }
  const annotationCapture = message.annotationOnly === true ? message.annotationCapture : null;
  const annotationSide = isJapanese(message.targetLanguage) ? "target" : isJapanese(message.sourceLanguage) ? "source" : null;
  if (message.annotationOnly === true && (!annotationSide || !annotationCapture ||
      annotationCapture.episodeId !== watchIdFromSender(sender) || annotationCapture.sourceLanguage !== message.sourceLanguage ||
      annotationCapture.targetLanguage !== message.targetLanguage || annotationCapture.translationSemantics !== "cue-v1" ||
      typeof annotationCapture.sourceId !== "string" || typeof annotationCapture.trackKind !== "string" ||
      !Array.isArray(annotationCapture.items) || annotationCapture.items.length !== message.items.length ||
      annotationCapture.items.some((item, index) => item?.id !== message.items[index].id || !Number.isInteger(item.sourceIndex) ||
        item.sourceIndex < 0 || !isSubtitleText(item.acceptedText) || item.annotationText !== message.items[index].text ||
        item.annotationSide !== annotationSide || (annotationSide === "target" && item.annotationText !== item.acceptedText)))) {
    return { ok: false, errorCode: "configuration" };
  }
  const trace = message.diagnostic === true && !testProviderId ? [] : null;
  const record = (stage, details = {}) => { if (trace) trace.push({ stage, ...details }); };
  const result = (value) => trace ? { ...value, trace } : value;
  let rawRecord;
  const reject = (errorCode, stage, details) => {
    if (rawRecord) {
      rawRecord.failure = { errorCode, reason: details?.reason ?? stage };
      if (details?.expectedCount !== undefined) rawRecord.failure.expectedCount = details.expectedCount;
      if (details?.receivedCount !== undefined) rawRecord.failure.receivedCount = details.receivedCount;
    }
    record(stage, { errorCode, ...details });
    return result({ ok: false, errorCode });
  };

  let settings;
  try {
    settings = await new Promise((resolve, reject) => {
      runtime.storage.local.get({
        aiRole: "off", aiProviderId: DEFAULT_PROVIDER_ID, aiStyleGuide: DEFAULT_TRANSLATION_PROMPT,
        providers: [], aiCacheMode: "session", aiCachePolicy: "prefer", aiCacheRetentionDays: 30, aiCacheMaxMiB: 256
      }, (stored) => {
        if (runtime.runtime.lastError) reject(new Error("storage unavailable"));
        else resolve(stored);
      });
    });
  } catch {
    return reject("configuration", "rejected", { reason: "storage_unavailable" });
  }
  settings.aiCacheMode = settings.aiCacheMode === "local" ? "local" : "session";
  settings.aiCachePolicy = settings.aiCachePolicy === "only" ? "only" : "prefer";
  settings.aiCacheRetentionDays = Number.isInteger(settings.aiCacheRetentionDays) && settings.aiCacheRetentionDays >= 0 && settings.aiCacheRetentionDays <= 3650 ? settings.aiCacheRetentionDays : 30;
  settings.aiCacheMaxMiB = Number.isInteger(settings.aiCacheMaxMiB) && settings.aiCacheMaxMiB >= 0 && settings.aiCacheMaxMiB <= 65536 ? settings.aiCacheMaxMiB : 256;
  if (!testProviderId && settings.aiCachePolicy === "only") return reject("cache_miss", "rejected", { reason: "cache_miss" });

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
        ...(() => {
          const activeJsonMode = provider.jsonMode ?? (endpoint === OPENAI_ENDPOINT ? "json_schema" : "none");
          if (activeJsonMode === "json_schema") {
            return {
              response_format: {
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
                          properties: ((isJapanese(message.sourceLanguage) || isJapanese(message.targetLanguage)) && (message.japaneseRuby !== undefined ? Boolean(message.japaneseRuby) : (settings.aiJapaneseRuby !== false))) ? {
                            id: { type: "string" },
                            text: { type: "string" },
                            readings: {
                              type: "array",
                              items: {
                                type: "object",
                                properties: { surface: { type: "string" }, reading: { type: "string" } },
                                required: ["surface", "reading"],
                                additionalProperties: false
                              }
                            }
                          } : {
                            id: { type: "string" },
                            text: { type: "string" }
                          },
                          required: ((isJapanese(message.sourceLanguage) || isJapanese(message.targetLanguage)) && (message.japaneseRuby !== undefined ? Boolean(message.japaneseRuby) : (settings.aiJapaneseRuby !== false))) ? ["id", "text", "readings"] : ["id", "text"],
                          additionalProperties: false
                        }
                      }
                    },
                    required: ["items"],
                    additionalProperties: false
                  }
                }
              }
            };
          }
          if (activeJsonMode === "json_object") {
            return { response_format: { type: "json_object" } };
          }
          return {};
        })(),
        messages: [
          {
            role: "system",
            content: "你是一位专业的影视字幕翻译员，也是目标语言的母语使用者。" +
              "text 字段只放译文；若要求日语注音，readings 是独立于译文的必填结果，不得省略。contextBefore 和 contextAfter 仅用于理解语境，不要翻译或输出。" +
              "保持每个 id、数量和顺序完全一致，不合并、不拆分、不遗漏字幕。" +
              (annotationCapture ? "【补注音契约】items[].text 是已接受的日文注音锚点。逐字回显 text，只生成该 text 的 readings，不翻译、不改写正文。readings 使用 [{\"surface\":\"汉字词\",\"reading\":\"平假名\"}] 数组；纯假名允许空数组。" : buildRubyPromptSection(message, settings)) +
              "保留人名、专有名词和既有译名；结合上下文处理代词、时态、人物关系和语气。" +
              (isJapanese(message.sourceLanguage) ? buildKatakanaGuide() : "") +
              "使用自然、简洁、适合屏幕阅读的字幕表达，不添加解释、时间戳或契约之外的字段。" +
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
    const diagnosticsLoaded = await loadRawDiagnosticsIfNeeded();
    if (diagnosticsLoaded && rawCaptureEnabled && !testProviderId) {
      const capture = { at: startedAt, model: provider.model,
        request: { url: endpoint, method: requestOptions.method, headers: { "Content-Type": "application/json" }, body: requestOptions.body }, response: null };
      try { rawRecord = await BilayerDiagnosticsStore.captureStart(capture, true); }
      catch (error) { diagnosticsStorageError = error?.message ?? "storage_unavailable"; }
    }
    let dispatchedCacheGeneration = null;
    if (!testProviderId) {
      try { dispatchedCacheGeneration = await BilayerTranslationCacheStore.generation(watchIdFromSender(sender)); }
      catch { diagnosticsStorageError = "storage_unavailable"; }
    }
    if (!testProviderId && settings.aiCacheMode === "local" && message.cacheCapture?.sourceId) {
      try { await BilayerTranslationCacheStore.touchSource(message.cacheCapture.sourceId); }
      catch { diagnosticsStorageError = "storage_unavailable"; }
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
      contentKind: typeof choice?.message?.content === "string" ? "text" : Array.isArray(choice?.message?.content) ? "parts" : typeof choice?.message?.content === "object" ? "object" : "missing" });
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
    let acceptedItems = data.items;
    if (annotationCapture) {
      const requested = new Map(annotationCapture.items.map((item) => [item.id, item]));
      acceptedItems = data.items.map((item) => {
        const anchor = requested.get(item.id);
        const valid = (annotationSide !== "target" || item.text === anchor.acceptedText) && item.readings &&
          Object.entries(item.readings).every(([surface, reading]) => surface && typeof reading === "string" && reading.length > 0 && anchor.annotationText.includes(surface)) &&
          (isKanaOnly(anchor.annotationText) || Object.keys(item.readings).length > 0);
        return { id: item.id, text: anchor.acceptedText, ...(valid ? { readings: item.readings } : {}) };
      });
      if (acceptedItems.some((item) => item.readings === undefined)) return reject("invalid_response", "rejected", { reason: "annotation_anchor_mismatch" });
    }
    const translated = { ok: true, items: acceptedItems };
    if (!testProviderId) {
      const cacheMetadata = await persistAcceptedTranslation(annotationCapture ? { ...message, cacheCapture: undefined } : message,
        sender, { ...settings, aiStyleGuide: styleGuide }, provider, endpoint, acceptedItems, dispatchedCacheGeneration);
      if (annotationCapture && settings.aiCacheMode === "local") {
        const accepted = new Map(acceptedItems.map((item) => [item.id, item]));
        const annotations = annotationCapture.items.filter((item) => accepted.get(item.id).readings !== undefined)
          .map((item) => ({ ...item, readings: accepted.get(item.id).readings }));
        if (annotations.length) {
          try {
            const committed = await BilayerTranslationCacheStore.commitAnnotations({ ...annotationCapture, annotationSide,
              semanticIntent: cacheMetadata.semanticIntent, generation: dispatchedCacheGeneration, items: annotations }, { maxBytes: settings.aiCacheMaxMiB * 1048576 });
            if (!committed.ok) cacheMetadata.storageError = committed.errorCode;
          } catch { cacheMetadata.storageError = "storage_unavailable"; }
        }
      }
      translated.cacheMetadata = cacheMetadata;
    }
    return result(translated);
  } catch {
    if (rawRecord) rawRecord.error = controller.signal.aborted ? "timeout" : "network_error";
    return reject("unavailable", "rejected", { reason: controller.signal.aborted ? "timeout" : "network_error",
      durationMs: Date.now() - startedAt });
  } finally {
    clearTimeout(timeout);
    if (rawRecord) {
      rawRecord.completedAt = Date.now();
      try { await BilayerDiagnosticsStore.captureFinish(rawRecord); diagnosticsStorageError = null; }
      catch (error) { diagnosticsStorageError = error?.message ?? "storage_unavailable"; }
    }
  }
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    return JSON.stringify(content);
  }
  if (!Array.isArray(content)) return null;
  const text = content.filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
  return text || null;
}

function parseTranslationJson(content, compatible) {
  if (typeof content === "object" && content !== null) {
    return normalizeTranslationPayload(content);
  }
  if (typeof content !== "string") throw new Error("content_not_string");
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let candidate = fenced ? fenced[1].trim() : trimmed;

  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidate = candidate.slice(firstBrace, lastBrace + 1).trim();
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    try {
      const healed = candidate.replace(/\]\s*[^\s,}\]]+\s*\}/g, "]}").replace(/,\s*([}\]])/g, "$1");
      parsed = JSON.parse(healed);
    } catch {
      const itemsMatch = candidate.match(/"items"\s*:\s*(\[\s*\{[\s\S]*\}\s*\])/);
      if (itemsMatch) {
        try {
          const itemsCleaned = itemsMatch[1].replace(/,\s*([}\]])/g, "$1");
          parsed = { items: JSON.parse(itemsCleaned) };
        } catch {}
      }
      if (!parsed && compatible) {
        try {
          parsed = { items: JSON.parse(`[${candidate}]`) };
        } catch {
          throw error;
        }
      } else if (!parsed) {
        throw error;
      }
    }
  }
  return normalizeTranslationPayload(parsed);
}

function normalizeTranslationPayload(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return { items: data.map(normalizeTranslationItem) };
  if (Array.isArray(data.items)) {
    data.items = data.items.map(normalizeTranslationItem);
  } else if (data.id !== undefined || data["id/"] !== undefined) {
    return normalizeTranslationItem(data);
  }
  return data;
}

function normalizeTranslationItem(item) {
  if (!item || typeof item !== "object") return item;
  const normalized = {};
  for (const [key, value] of Object.entries(item)) {
    const clean = key.replace(/[\W_]+/g, "").toLowerCase();
    if (clean === "id") {
      normalized.id = typeof value === "number" ? String(value) : String(value ?? "").trim();
    } else if (clean === "text" || clean === "translation" || clean === "content") {
      normalized.text = typeof value === "string" ? value : String(value ?? "");
    } else if (clean === "readings" || clean === "reading" || clean === "furigana") {
      if (Array.isArray(value)) {
        normalized.readings = value.every((entry) => entry && typeof entry.surface === "string" && typeof entry.reading === "string")
          ? Object.fromEntries(value.map(({ surface, reading }) => [surface, reading])) : value;
      } else if (typeof value === "object" && value !== null) {
        normalized.readings = value;
      } else if (clean === "furigana" && typeof value === "string") {
        normalized.ruby = value;
      }
    } else if (clean === "ruby") {
      normalized.ruby = typeof value === "string" ? value : String(value ?? "");
    } else {
      normalized[key] = value;
    }
  }

  if (!normalized.readings && typeof normalized.ruby === "string") {
    const extracted = {};
    for (const match of normalized.ruby.matchAll(/\{([^|{}]+)\|([ぁ-んァ-ヴー]+)\}/g)) {
      extracted[match[1]] = match[2];
    }
    if (Object.keys(extracted).length > 0) {
      normalized.readings = extracted;
    }
  }

  return normalized;
}

async function testProviderConnection(providerId, sender) {
  if (!isAllowedTestSender(sender) || typeof providerId !== "string" || !PROVIDER_PATTERN.test(providerId)) {
    return { ok: false, errorCode: "configuration" };
  }

  let stored;
  try {
    stored = await new Promise((resolve, reject) => {
      runtime.storage.local.get({ providers: [] }, (val) => {
        if (runtime.runtime.lastError) reject(new Error("storage unavailable"));
        else resolve(val);
      });
    });
  } catch {
    return { ok: false, errorCode: "configuration" };
  }

  const provider = pickProvider(stored.providers, providerId);
  if (!provider) return { ok: false, errorCode: "configuration" };

  const testBatch = {
    sourceLanguage: "en",
    targetLanguage: "zh-Hans",
    items: [{ id: "connection", text: "Hello" }],
    contextBefore: [],
    contextAfter: []
  };

  if (!provider.endpoint || provider.endpoint === OPENAI_ENDPOINT) {
    const res = await translateBatch(testBatch, sender, providerId);
    if (!res.ok) return res;
    await saveProviderJsonMode(stored.providers, providerId, "json_schema");
    return { ok: true, jsonMode: "json_schema" };
  }

  // Probe 1: json_schema
  provider.jsonMode = "json_schema";
  let probe = await translateBatch(testBatch, sender, providerId);
  if (probe.ok) {
    await saveProviderJsonMode(stored.providers, providerId, "json_schema");
    return { ok: true, jsonMode: "json_schema" };
  }

  if (probe.errorCode === "auth" || probe.errorCode === "quota" || probe.errorCode === "permission_denied" || probe.errorCode === "unavailable") {
    return probe;
  }

  // Probe 2: json_object
  provider.jsonMode = "json_object";
  probe = await translateBatch(testBatch, sender, providerId);
  if (probe.ok) {
    await saveProviderJsonMode(stored.providers, providerId, "json_object");
    return { ok: true, jsonMode: "json_object" };
  }

  if (probe.errorCode === "auth" || probe.errorCode === "quota" || probe.errorCode === "permission_denied" || probe.errorCode === "unavailable") {
    return probe;
  }

  // Probe 3: standard prompt (none)
  provider.jsonMode = "none";
  probe = await translateBatch(testBatch, sender, providerId);
  if (probe.ok) {
    await saveProviderJsonMode(stored.providers, providerId, "none");
    return { ok: true, jsonMode: "none", warning: "unsupported_json_mode" };
  }

  return probe;
}

function saveProviderJsonMode(providers, providerId, jsonMode) {
  if (!Array.isArray(providers)) return Promise.resolve();
  const updated = providers.map((item) => item.id === providerId ? { ...item, jsonMode } : item);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      runtime.storage.local.set({ providers: updated }, finish);
    } catch {
      finish();
    }
    setTimeout(finish, 0);
  });
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

// 缺失/非法偏好一律按 auto 处理（与 i18n.js 的 normalizePreference 同一规则）。
function normalizeUiLanguage(value) {
  const code = typeof value === "string" ? value.trim() : "";
  return BUNDLED_UI_LOCALES.includes(code) ? code : UI_LANGUAGE_AUTO;
}

// 包内报文的取值形状与 i18n.js 的 fromBundle 一致：字符串，或 { message } 对象。
function bundleMessage(bundle, key) {
  const entry = bundle?.[key];
  const value = typeof entry === "string" ? entry : entry?.message;
  return typeof value === "string" ? value : "";
}

// 单飞加载包内报文：成功缓存解析结果，不可用（缺文件、非 2xx、非法 JSON、抛错）也缓存 null，
// 避免 settings 的轮询把不可用变成反复失败的网络请求；worker 回收重启后缓存清空，自然重试。
// 绝不让失败变成异常：调用方拿到的永远是 bundle 或 null。
function loadLocaleBundle(locale) {
  if (localeBundles.has(locale)) return localeBundles.get(locale);
  const attempt = (async () => {
    try {
      if (typeof fetch !== "function") return null;
      const url = runtime.runtime?.getURL?.(`_locales/${locale}/messages.json`) ?? "";
      if (!url) return null;
      const response = await fetch(url);
      if (!response?.ok) return null;
      const parsed = JSON.parse(await response.text());
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  })();
  localeBundles.set(locale, attempt);
  return attempt;
}

// UI 文案的唯一来源，语义对齐 extension/src/i18n.js：auto 只走 runtime.i18n.getMessage（绝不加载包），
// 具体语言先取包内报文，缺失时逐级回落 getMessage → ""。任一环节不可用都只降级，绝不抛错、绝不返回半句话。
async function localizedMessage(key, uiLanguage) {
  if (BUNDLED_UI_LOCALES.includes(uiLanguage)) {
    const message = bundleMessage(await loadLocaleBundle(uiLanguage), key);
    if (message) return message;
  }
  try {
    return runtime.i18n?.getMessage?.(key) ?? "";
  } catch {
    return "";
  }
}

// provider 是否“真的能用”：有凭证，或落在无需凭证的本地端点上（与 settings 的选取门槛同一规则，不另立判据）。
function providerIsConfigured(provider) {
  if (!provider || typeof provider !== "object") return false;
  if (typeof provider.credential === "string" && provider.credential.trim()) return true;
  return typeof provider.endpoint === "string" && KEYLESS_ENDPOINTS.has(provider.endpoint);
}

// 就绪度快照：只读设置、不触网（仅按需取一次包内文案）、不缓存（调用方会反复问，任何缓存都可能过期）。
// 文案缺失（本地化键未落地）时按“无提示”处理，绝不返回半句话。
async function aiReadinessSnapshot() {
  const stored = await new Promise((resolve, reject) => {
    // uiLanguage 与 providers/aiProviderId 同一次读取，不额外增加一次存储往返。
    runtime.storage.local.get({ providers: [], aiProviderId: DEFAULT_PROVIDER_ID, uiLanguage: UI_LANGUAGE_AUTO }, (value) => {
      if (runtime.runtime.lastError) reject(new Error("storage unavailable"));
      else resolve(value);
    });
  });
  const configured = providerIsConfigured(pickProvider(stored.providers, stored.aiProviderId));
  const uiLanguage = normalizeUiLanguage(stored.uiLanguage);
  const missingProvider = configured ? "" : await localizedMessage("noticeProviderMissing", uiLanguage);
  const tracksNotice = await localizedMessage("noticeSubtitleTracksMissing", uiLanguage);
  // “读不到轨道清单”（content 侧的 unread：超时未收到 player-api 载荷）与“本片没有轨道”（none）证据不同，
  // 文案也分开；恒为字符串，content 侧只在 subtitleAvailability === "unread" 时使用。
  const unreadNotice = await localizedMessage("noticeSubtitleTracksUnread", uiLanguage);
  return {
    configured,
    // 文案缺失（本地化键未落地）时按“无提示”处理，绝不返回半句话。
    notice: missingProvider || null,
    tracksNotice,
    unreadNotice
  };
}

// 设置窗口的唯一实现：同一设置页已开着就只聚焦（重复点击不叠窗），否则开一个独立窗口。
// 引擎可能不把扩展页 url 交给扩展：Chrome 未授予 tabs 权限时窗口里每个 tab.url 都是 null（本机 Chrome for
// Testing 实测，连扩展自己的页面也一样），此时 url 匹配必然落空，故再用上次记录的开窗 id 兜底，避免每次
// 点击都叠出一个新窗口；id 校验用 windows.get，窗口已被关掉就照常新建。
// windows.create 在 iOS Safari 等引擎上可能不存在或拒绝，回落 tabs.create 这条跨引擎可用路径；
// 两者都不可用时才如实报告失败，不静默吞掉点击。
const SETTINGS_WINDOW_KEY = "__settings_window_id__";

// 记录位置优先 session 存储（会话结束即清空，窗口 id 不会被下一次会话复用）；不支持时退回 local，
// 并在浏览器启动（onStartup）时清掉旧记录，避免拿上一次会话的窗口 id 去聚焦无关窗口。
function settingsWindowArea() {
  return runtime.storage?.session ?? runtime.storage?.local ?? null;
}

function rememberSettingsWindow(windowId) {
  if (typeof windowId !== "number") return;
  try {
    settingsWindowArea()?.set({ [SETTINGS_WINDOW_KEY]: windowId });
  } catch {}
}

function forgetSettingsWindow() {
  try {
    settingsWindowArea()?.set({ [SETTINGS_WINDOW_KEY]: null });
  } catch {}
}

function storedSettingsWindowId() {
  const area = settingsWindowArea();
  if (typeof area?.get !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      area.get([SETTINGS_WINDOW_KEY], (stored) => {
        if (runtime.runtime.lastError) { resolve(null); return; }
        const id = stored?.[SETTINGS_WINDOW_KEY];
        resolve(typeof id === "number" ? id : null);
      });
    } catch { resolve(null); }
  });
}

async function openSettingsWindow() {
  const url = runtime.runtime.getURL(SETTINGS_PAGE);
  const windows = runtime.windows;
  const focus = async (windowId) => {
    if (typeof windows?.update !== "function") return false;
    try {
      await windows.update(windowId, { focused: true });
      rememberSettingsWindow(windowId);
      return true;
    } catch {
      return false;
    }
  };
  if (typeof windows?.getAll === "function") {
    try {
      const open = await windows.getAll({ populate: true });
      const existing = (Array.isArray(open) ? open : [])
        .find((win) => Array.isArray(win?.tabs) && win.tabs.some((tab) => tab?.url === url));
      if (existing && await focus(existing.id)) return { ok: true, reused: true };
    } catch {}
  }
  const remembered = await storedSettingsWindowId();
  if (remembered !== null && typeof windows?.get === "function") {
    try {
      await windows.get(remembered);
      if (await focus(remembered)) return { ok: true, reused: true };
    } catch {}
  }
  if (typeof windows?.create === "function") {
    try {
      // 940 是窗口外高口径（含标题栏/窗口框），实测内高约 852。窗口同时加宽到 1240：侧栏改用 clamp(180px, 17.5%, 224px)
      // 后 1240 宽下侧栏占约 217px（比原 168px 宽约 49px），若窗口仍留在 1180，内容列会从约 1004px 掉到约 952px，
      // 逼近最高 AI 页（约 731）在 780 可用高下的滚动阈值；把窗口一起放宽，内容列宽度基本不变，四个页签仍不出现面板内滚动。
      const created = await windows.create({ type: "popup", width: 1240, height: 940, url });
      rememberSettingsWindow(created?.id);
      return { ok: true, reused: false };
    } catch {}
  }
  try {
    await runtime.tabs.create({ url });
    return { ok: true, reused: false };
  } catch {
    return { ok: false, errorCode: "unavailable" };
  }
}

// AI 就绪度只对 Netflix 内容脚本、设置页与新手引导开放；诊断历史只对设置页开放。
function isReadinessSender(sender) {
  return isAllowedSender(sender) || isAllowedTestSender(sender);
}
function isAllowedTestSender(sender) {
  if (sender?.id !== runtime.runtime.id) return false;
  return sender.url === runtime.runtime.getURL(SETTINGS_PAGE) || sender.url === runtime.runtime.getURL(ONBOARDING_PAGE);
}


function isAllowedSender(sender) {
  if (sender?.id !== runtime.runtime.id) return false;
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
    if (!item || typeof item.id !== "string" || !expected.delete(item.id) ||
        !isSubtitleText(item.text)) return false;
    for (const key of Object.keys(item)) {
      if (key !== "id" && key !== "text" && key !== "readings" && key !== "ruby") return false;
    }
    if (item.readings !== undefined) {
      if (!item.readings || typeof item.readings !== "object" || Array.isArray(item.readings)) return false;
      for (const [k, v] of Object.entries(item.readings)) {
        if (typeof k !== "string" || typeof v !== "string") return false;
        bytes += new TextEncoder().encode(k + v).length;
      }
    }
    if (item.ruby !== undefined) {
      if (typeof item.ruby !== "string") return false;
      bytes += new TextEncoder().encode(item.ruby).length;
    }
    bytes += new TextEncoder().encode(item.text).length;
    if (bytes > MAX_PAYLOAD_BYTES) return false;
  }
  return expected.size === 0;
}

function isJapanese(lang) {
  return /^(ja|jp)($|[-_])/i.test(String(lang ?? "").trim());
}

function isKanaOnly(text) {
  return /^[\u3040-\u309f\u30a0-\u30ff\u30fc\s。、，．！？・「」『』（）()［］【】]+$/.test(text);
}

function buildRubyPromptSection(message, settings) {
  const isSourceJp = isJapanese(message.sourceLanguage);
  const isTargetJp = isJapanese(message.targetLanguage);
  const hasJp = isSourceJp || isTargetJp;
  const rubyEnabled = hasJp && (message.japaneseRuby !== undefined
    ? Boolean(message.japaneseRuby)
    : (settings.aiJapaneseRuby !== false));

  if (!rubyEnabled) {
    return "只返回 JSON 对象 {\"items\":[{\"id\":\"原字幕 id\",\"text\":\"译文\"}]}，items 包含本次请求的全部字幕。";
  }

  if (isTargetJp) {
    return "【注音契约】" +
      "目标语言为日语：text 是不带注音标记的日文译文；readings 必须基于译文 text 中出现的日文汉字，而不是英文原文。" +
      "readings 是 [{\"surface\":\"汉字词\",\"reading\":\"平假名\"}] 数组，surface 必须在译文中完整出现，reading 必须是纯平假名；例如 text=\"私は学生です\" 时 readings=[{\"surface\":\"私\",\"reading\":\"わたし\"},{\"surface\":\"学生\",\"reading\":\"がくせい\"}]。" +
      "译文含日文汉字（包括数字量词）时不得返回空数组；只有译文完全没有日文汉字时才返回 []。每条 item 均输出 id、text、readings。";
  }

  return "【注音契约】" +
    "源语言为日语：text 只放目标语言译文；readings 必须读取请求里同一 id 的原文 items[].text 中的日文汉字，绝不能依据译文 text（例如中文译文）来判断是否需要注音。" +
    "readings 是 [{\"surface\":\"原文汉字词\",\"reading\":\"平假名\"}] 数组，surface 必须在该条日文原文中完整出现，reading 必须是纯平假名；例如原文\"私は田中です\"译为\"我是田中\"时 readings=[{\"surface\":\"私\",\"reading\":\"わたし\"},{\"surface\":\"田中\",\"reading\":\"たなか\"}]。" +
    "原文含日文汉字（包括数字量词）时不得返回空数组；只有原文完全没有日文汉字时才返回 []。每条 item 均输出 id、text、readings。";
}

function buildKatakanaGuide() {
  return "【外来语本地化准则】" +
    "1. 语境意译优先：日常外来借词（片假名词汇）必须结合台词前后文语义及词性意译为自然地道的中文表达，严禁脱离语境盲目按特定影视 IP 专称进行机械音译。" +
    "2. 专有名词严谨：人名、地名、知名 IP 采用公认行业规范译名；剧情独创虚构设定或代号结合剧情意译，无公认译名时保留原词或英文，不生造怪异中文假字。" +
    "3. 对话语气还原：以片假名书写的日语口语语气词（如マジ、ダメ、ウソ等）按实际人物性格与情境口吻意译。";
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
