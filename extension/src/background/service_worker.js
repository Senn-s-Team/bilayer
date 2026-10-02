/**
 * [INPUT]: 依赖 browser/chrome storage、permissions API 与 host_permissions/optional_host_permissions 的跨域 fetch 能力
 * [OUTPUT]: 初始化默认值，提供字幕下载、多 provider 翻译（日文源/目标注音请求使用定长字段的 readings 条目数组，兼容旧字典/字符串回包供 ruby 渲染）、兼容服务对象序列与顶层条目数组规范化（逐条规范化 readings 后仍严格校验数量、字段与 ID）、AI 就绪度查询（BILAYER_AI_READINESS：只读 provider 条目、aiProviderId 与界面语言偏好 uiLanguage（同一次 storage.local.get），不触网不缓存，返回 {configured, notice, tracksNotice, unreadNotice}，提示句跟随 storage.local.uiLanguage：auto 走 runtime.i18n.getMessage、具体语言异步解析包内 _locales/<code>/messages.json 并缓存，缺失逐级回落 getMessage→空串，语义对齐 src/i18n.js）、诊断（失败摘要仅保留错误码、原因及显式提供的 expectedCount/receivedCount，不复制正文或凭证；采集开关未知即关闭：读取成功才采用持久化值、读取失败不缓存并在下次调用重试、用户显式切换立即落盘且优先于尚未落地的读取；开关值未知时缓冲落盘一律省略 `__raw_capture_enabled__`，GET/CLEAR 均先 await 单飞读取，采集判断前同样必须 await）、连通性测试与旧键迁移，以及设置窗口的唯一打开路径（openSettingsWindow：工具栏 action.onClicked 与 BILAYER_OPEN_SETTINGS 共用，已存在的设置页窗口只聚焦、引擎隐藏扩展页 tab.url 时按记住的开窗 id 复核复用（id 记在 storage.session，不支持时退回 storage.local 并在 onStartup 作废）、都未命中才 windows.create 弹独立窗口、windows.create 缺失或失败时回落 tabs.create；设置页/向导页的授权要求扩展身份与页面 URL 白名单，不以 sender.tab 排除独立窗口）
 * [POS]: background 生命周期入口；凭证仅存于 provider 条目且只在 worker 内读取，兼容服务必须通过端点校验与运行时域名授权
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

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
const DIAGNOSTICS_PAGE = "src/diagnostics/diagnostics.html";
const ONBOARDING_PAGE = "src/onboarding/onboarding.html";
const SETTINGS_PAGE = "src/settings/settings.html";
const rawDiagnostics = [];
const MAX_RAW_DIAGNOSTICS = 20;
let rawDiagnosticsVersion = 0;
let rawDiagnosticSequence = 0;
// 采集开关以“未知即关闭”为初值：读取成功或用户显式切换之前，任何请求都不得采集。
let rawCaptureEnabled = false;
// 单飞读取：仅成功时缓存；失败清空缓存，下一次调用必须重试，绝不把失败钉成“已加载”。
let rawDiagnosticsLoad = null;
// 本 worker 生命周期内用户显式切换过开关；用户意图优先于之后才落地的读取结果。
let capturePreferenceSetByUser = false;
// 采集开关值是否已知（读取成功，或用户在本 worker 内切换过）。未知时绝不把
// fail-closed 占位值写进存储，否则清理缓冲会把用户从未读到的偏好静默翻转。
let rawCapturePreferenceKnown = false;

function loadRawDiagnosticsIfNeeded() {
  if (rawDiagnosticsLoad) return rawDiagnosticsLoad;
  const attempt = new Promise((resolve) => {
    try {
      runtime.storage.local.get(["__raw_diagnostics__", "__raw_diagnostics_version__", "__raw_diagnostic_seq__", "__raw_capture_enabled__"], (stored) => {
        if (runtime.runtime?.lastError) { resolve(false); return; }
        if (!capturePreferenceSetByUser) rawCaptureEnabled = stored?.__raw_capture_enabled__ !== false;
        rawCapturePreferenceKnown = true;
        if (Array.isArray(stored?.__raw_diagnostics__) && stored.__raw_diagnostics__.length) {
          rawDiagnostics.splice(0, rawDiagnostics.length, ...stored.__raw_diagnostics__.slice(-MAX_RAW_DIAGNOSTICS));
          rawDiagnosticsVersion = stored.__raw_diagnostics_version__ ?? rawDiagnostics.length;
          rawDiagnosticSequence = stored.__raw_diagnostic_seq__ ?? rawDiagnostics.length;
        }
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
  rawDiagnosticsLoad = attempt.then((loaded) => { if (!loaded) rawDiagnosticsLoad = null; });
  return rawDiagnosticsLoad;
}

// 切换开关只写开关键，避免在缓冲尚未读回时用空缓冲覆盖 `__raw_diagnostics__`。
function persistRawCapturePreference() {
  try {
    runtime.storage.local.set({ __raw_capture_enabled__: rawCaptureEnabled });
  } catch {}
}

function persistRawDiagnostics() {
  try {
    runtime.storage.local.set({
      __raw_diagnostics__: rawDiagnostics.slice(-MAX_RAW_DIAGNOSTICS),
      __raw_diagnostics_version__: rawDiagnosticsVersion,
      __raw_diagnostic_seq__: rawDiagnosticSequence,
      // 只在开关值已知时一并写入；未知时省略该键，避免用 fail-closed 占位值覆盖用户偏好。
      ...(rawCapturePreferenceKnown ? { __raw_capture_enabled__: rawCaptureEnabled } : {})
    });
  } catch {}
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

  if (message?.type === "BILAYER_GET_RAW_DIAGNOSTICS") {
    if (!isDiagnosticsSender(sender)) {
      sendResponse({ ok: false, errorCode: "configuration" });
      return true;
    }
    void loadRawDiagnosticsIfNeeded().then(() => {
      sendResponse({
        ok: true,
        enabled: rawCaptureEnabled,
        version: rawDiagnosticsVersion,
        ...(message.version === rawDiagnosticsVersion ? {} : { records: rawDiagnostics.map((record) => structuredClone(record)) })
      });
    });
    return true;
  }
  if (message?.type === "BILAYER_SET_RAW_DIAGNOSTICS") {
    if (!isDiagnosticsSender(sender) || typeof message.enabled !== "boolean") {
      sendResponse({ ok: false, errorCode: "configuration" });
      return true;
    }
    // 用户意图立即生效并立即落盘，不等待仍未完成的读取；该读取落地时不得覆盖此值。
    capturePreferenceSetByUser = true;
    rawCapturePreferenceKnown = true;
    rawCaptureEnabled = message.enabled;
    persistRawCapturePreference();
    sendResponse({ ok: true, enabled: rawCaptureEnabled });
    return true;
  }
  if (message?.type === "BILAYER_CLEAR_RAW_DIAGNOSTICS") {
    if (!isDiagnosticsSender(sender)) {
      sendResponse({ ok: false, errorCode: "configuration" });
      return true;
    }
    // 与 GET 一致先读回开关，避免清理缓冲时把未知的 fail-closed 值当成用户偏好落盘。
    void loadRawDiagnosticsIfNeeded().then(() => {
      rawDiagnostics.length = 0;
      rawDiagnosticsVersion++;
      persistRawDiagnostics();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message?.type !== "BILAYER_FETCH_SUBTITLE") return false;

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
              buildRubyPromptSection(message, settings) +
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
    await loadRawDiagnosticsIfNeeded();
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
      persistRawDiagnostics();
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
    return result({ ok: true, items: data.items });
  } catch {
    if (rawRecord) rawRecord.error = controller.signal.aborted ? "timeout" : "network_error";
    return reject("unavailable", "rejected", { reason: controller.signal.aborted ? "timeout" : "network_error",
      durationMs: Date.now() - startedAt });
  } finally {
    clearTimeout(timeout);
    if (rawRecord) {
      rawRecord.completedAt = Date.now();
      rawDiagnosticsVersion++;
      persistRawDiagnostics();
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

// 就绪度查询的授权边界：观剧页内容脚本（isAllowedSender）与扩展自有页面（settings/onboarding/diagnostics）。
function isReadinessSender(sender) {
  return isAllowedSender(sender) || isAllowedTestSender(sender) || isDiagnosticsSender(sender);
}
// 设置页搬进独立窗口后，其文档与标签页文档一样带 sender.tab，故授权只按 URL 判定，
// 但身份仍是必过项：只放行扩展自己的设置页与向导页，绝不放宽到任意扩展页面或网页。
function isAllowedTestSender(sender) {
  if (sender?.id !== runtime.runtime.id) return false;
  const settingsUrl = runtime.runtime.getURL(SETTINGS_PAGE);
  const onboardingUrl = runtime.runtime.getURL(ONBOARDING_PAGE);
  return sender.url === settingsUrl || sender.url === onboardingUrl;
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
