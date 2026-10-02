/**
 * [INPUT]: 依赖轨道归一化、subtitleStore 与 translationScheduler（含 ruby 标注与等待占位角色查询）、overlay、fullscreenMount 及 page bridge 播放器查询，额度用量读写 runtime.storage.local
 * [OUTPUT]: 提供互斥双原生/AI 翻译、独立 AI 源轨道（支持日文源字幕 ruby 振假名回填展示）、默认 10 组预取和可调上下文、首句等待、切集隔离及脱敏页面状态；设置 aiRequestBudget/aiCharacterBudget（0 为不限，缺省/非法回落 80/40000）经 setBudget 注入调度器，aiBudgetWindow（session|hour|day，缺省/非法回落 session）决定计量窗口键，用量按 __ai_budget_usage__ 的多窗口台账持久化（每个窗口一项、上限 4 项，旧单记录形状读到时迁移）并在派发前与其它标签页对齐；BILAYER_GET_STATE 附带含 window/windowKey/resetAt 的实时 translationBudget、subtitleAvailability（unknown|unread|none|available，见文件内「字幕可用性与 AI 就绪度」状态机与 bridge 证据；unread 由 TRACK_REPORT_TIMEOUT_MS=20000 的兜底计时器在 watch 页且 video 已就绪时推进）以及 providerReadiness（{configured, notice}，来自 background 的 BILAYER_AI_READINESS，本页加载/AI provider 设置变更/settings 轮询时重取）；AI 字幕行等待译文时把 pending 角色交给 overlay，AI 模式下同时按与设置窗口同序的「轨道无可用 → provider 未配置 → 轨道读取超时 → 无提示」优先级把 notice 交给 overlay.render()，三条提示文案均由 background 本地化，content 不自带 UI 字符串
 * [POS]: content 入口；只协调播放与视图，AI provider 配置和密钥由 background 从扩展存储读取，就绪度判定与 UI 文案都留在 background，计量的持久化边界在本文件
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const runtime = globalThis.browser ?? globalThis.chrome;
const modules = window.Bilayer;
const DEFAULT_TRANSLATION_PROMPT = "你是一位专业的影视字幕翻译员，也是目标语言的母语使用者。只翻译 items[].text；contextBefore 和 contextAfter 仅用于理解语境，不要翻译或输出。保持每个 id、数量和顺序完全一致，不合并、不拆分、不遗漏字幕。保留人名、专有名词和既有译名；结合上下文处理代词、时态、人物关系和语气。使用自然、简洁、适合屏幕阅读的字幕表达，不添加解释、注释、时间戳或额外字段。";
const TARGET_LANGUAGES = new Set(["zh-Hans", "zh-Hant", "ja", "ko", "en", "es", "fr", "de", "it", "pt-BR", "ru", "ar", "hi"]);
const SUBTITLE_TRACK_SETTING_KEYS = new Set([
  "primaryTrackKey",
  "primaryTrackPreference",
  "primaryLanguage",
  "secondaryTrackKey",
  "secondaryTrackPreference",
  "secondaryLanguage",
  "aiSourceTrackKey",
  "aiSourceTrackPreference",
  "aiSourceLanguage"
]);
const AI_SETTING_KEYS = new Set(["aiRole", "aiTargetLanguage", "aiProviderId", "aiStyleGuide", "aiContextCount", "aiSourceTrackKey", "aiSourceTrackPreference", "aiSourceLanguage", "aiJapaneseRuby"]);
// 预算键不进入 AI_SETTING_KEYS：改预算只重新判定上限，不能清空已有译文与已用额度（同 aiPrefetchCount 的处理方式）。
const BUDGET_SETTING_KEYS = new Set(["aiRequestBudget", "aiCharacterBudget"]);
const BUDGET_SETTING_MAX = { aiRequestBudget: 1000, aiCharacterBudget: 1000000 };
// 计量窗口键是 runtime 状态而非设置：用量落在存储里，窗口定义只随 aiBudgetWindow 变化。
const BUDGET_USAGE_KEY = "__ai_budget_usage__";
const BUDGET_WINDOWS = new Set(["session", "hour", "day"]);
// 台账里同时保留的窗口项上限（当前窗口始终保留，其余按最近写入时间淘汰）。
const BUDGET_RECORD_LIMIT = 4;
// 轨道清单兜底等待：watch 页且 video 已就绪后，这么久仍没等到 bridge 的 player-api 载荷即为「读取不到」（unread）。
// 20 秒覆盖 Netflix 播放器从元素挂载到 getTimedTextTrackList() 可枚举的常见耗时（含首屏与广告位），留足余量
// 以免把「启动慢」误报成「读不到」；它只推进到 unread，绝不冒充 none（那需要真的收到过空清单载荷）。
const TRACK_REPORT_TIMEOUT_MS = 20000;
const DEFAULT_SETTINGS = {
  enabled: true,
  hideNativeSubtitles: true,
  primaryTrackKey: "",
  primaryTrackPreference: "",
  primaryLanguage: "",
  secondaryLanguage: "en",
  secondaryTrackKey: "",
  secondaryTrackPreference: "",
  aiRole: "off",
  aiSourceTrackKey: "",
  aiSourceTrackPreference: "",
  aiSourceLanguage: "",
  aiTargetLanguage: "zh-Hans",
  aiProviderId: "openai",
  aiPrefetchCount: 10,
  aiContextCount: 2,
  aiRequestBudget: 80,
  aiCharacterBudget: 40000,
  aiBudgetWindow: "session",
  aiStyleGuide: DEFAULT_TRANSLATION_PROMPT,
  aiJapaneseRuby: true,
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
  timingOffsetMs: 0
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  video: null,
  tracks: [],
  primaryCues: [],
  secondaryCues: [],
  aiSourceCues: [],
  selectedTrackKeys: { primary: "", secondary: "", aiSource: "" },
  loadStatus: {
    primary: { cueCount: 0, error: "" },
    secondary: { cueCount: 0, error: "" },
    aiSource: { cueCount: 0, error: "" }
  },
  translationStatus: { phase: "off", count: 0, error: "", logs: [] },
  // 本片字幕轨道的可用性四态；只在收到播放器轨道清单报告（none/available）或兜底计时器到期（unread）时推进，
  // available 单向锁定（换集/换片才重置）。unread 与 none 的证据强度不同，故不可互相替代。
  subtitleAvailability: "unknown",
  // 兜底计时器句柄（TRACK_REPORT_TIMEOUT_MS）：只在 unknown + watch 页 + video 已就绪时武装，见 armTrackReportTimer()。
  trackReportTimer: null,
  // background 的就绪度快照：configured 由 provider 凭证/本地无密钥端点判定，三条提示文案已在后台本地化。
  aiReadiness: { configured: false, notice: null, tracksNotice: "", unreadNotice: "" },
  // 当前计量的窗口键（session:<watchId> / hour:<YYYY-MM-DDTHH> / day:<YYYY-MM-DD>）与最近读写的用量台账。
  budgetWindowKey: "",
  budgetStore: { records: {}, updatedAt: 0, legacy: false },
  initialWait: null,
  waitedForWatch: "",
  tickId: 0,
  refreshToken: 0,
  subtitleEpoch: 0,
  playerQueryId: 0,
  locationId: 0,
  watchId: "",
  movieId: "",
  settingsWatchId: "",
  settingsToken: 0,
  unbindVideoFullscreen: null
};

const overlay = modules.createSubtitleOverlay();
const store = modules.createSubtitleStore();
const translator = modules.createTranslationScheduler({
  translate: translateBatch,
  onUpdate: onTranslationUpdate,
  syncUsage: syncBudgetUsage
});

boot();

async function boot() {
  state.watchId = readWatchId();
  state.budgetWindowKey = currentBudgetWindowKey();
  state.settings = await readSettings();
  state.settingsWatchId = state.watchId;
  overlay.applySettings(state.settings);
  void refreshBudgetWindow();
  void refreshProviderReadiness();
  updateNativeSubtitleVisibility();
  await injectPageBridge();
  bindRuntimeMessages();
  bindSettingsMessages();
  bindBridgeMessages();
  watchLocation();
  watchVideoElement();
  overlay.mount?.();
  startPlayerTrackQueries();
}

function injectPageBridge() {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = runtime.runtime.getURL("src/page/netflix-page-bridge.js");
    script.async = false;
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => resolve();
    (document.documentElement || document.head).append(script);
  });
}

function bindRuntimeMessages() {
  runtime.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    // 另一个标签页写下的台账：只取本页当前窗口那一项即刻取较大值合并，其它窗口项只并进内存镜像。
    const usageChange = changes[BUDGET_USAGE_KEY];
    if (usageChange) {
      const store = normalizeBudgetStore(usageChange.newValue);
      state.budgetStore = { ...state.budgetStore, records: mergeBudgetRecords(state.budgetStore.records, store.records) };
      const record = budgetStoreRecord(store, state.budgetWindowKey);
      if (record) {
        translator.setUsage(state.budgetWindowKey, record);
      } else if (Object.keys(store.records).length > 0) {
        // 台账里没有本页的窗口（本页跨过整点/午夜，或另一标签页在看别的剧集）：核对是否该换锚。
        budgetWindowMayRoll();
      }
    }

    let shouldRefreshTracks = false;
    let shouldRefreshTranslation = Boolean(changes.providers);
    let shouldUpdatePrefetch = false;
    let shouldUpdateBudget = false;
    let settingsChanged = false;
    // 就绪度只依赖 provider 条目与当前选中项：凭证/端点一改就重问后台（文案与判定都在后台）。
    let shouldRefreshReadiness = Boolean(changes.providers);

    for (const [key, change] of Object.entries(changes)) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue;
      state.settings[key] = key === "aiPrefetchCount" && (!Number.isInteger(change.newValue) || change.newValue < 0 || change.newValue > 50)
        ? DEFAULT_SETTINGS.aiPrefetchCount
        : key === "aiContextCount" && (!Number.isInteger(change.newValue) || change.newValue < 0 || change.newValue > 4)
          ? DEFAULT_SETTINGS.aiContextCount
          : key === "aiBudgetWindow" ? normalizeBudgetWindowSetting(change.newValue)
            : BUDGET_SETTING_KEYS.has(key) ? normalizeBudgetSetting(key, change.newValue)
              : change.newValue === undefined ? DEFAULT_SETTINGS[key] : change.newValue;
      settingsChanged = true;
      shouldRefreshTracks ||= SUBTITLE_TRACK_SETTING_KEYS.has(key);
      shouldUpdatePrefetch ||= key === "aiPrefetchCount";
      // 换计量窗口只换计数锚点，不属于 AI 设置变更：不许清空已有译文与已用额度。
      shouldUpdateBudget ||= BUDGET_SETTING_KEYS.has(key) || key === "aiBudgetWindow";
      shouldRefreshTranslation ||= AI_SETTING_KEYS.has(key) || key === "enabled";
      shouldRefreshReadiness ||= key === "aiProviderId";
    }

    if (shouldRefreshReadiness) void refreshProviderReadiness();

    if (!settingsChanged && !shouldRefreshTranslation) return;
    if (settingsChanged) overlay.applySettings(state.settings);
    if (shouldRefreshTranslation) {
      releaseInitialWait(true);
      translator.clear();
    }
    if (shouldRefreshTracks) refreshSelectedSubtitles();
    else if (shouldRefreshTranslation || shouldUpdatePrefetch || shouldUpdateBudget) syncTranslator();
    budgetWindowMayRoll();
    updateNativeSubtitleVisibility();
    renderForCurrentTime();
  });
}

function bindSettingsMessages() {
  runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "BILAYER_RELOAD") {
      if (!isWatchPage()) {
        sendResponse({ ok: false });
        return true;
      }

      clearSubtitleState();
      requestPlayerTracks();
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type !== "BILAYER_GET_STATE") return false;

    // 时间窗口可能在本页空闲时已翻页（轮询才唤醒我们）：先异步重锚，本次响应最多滞后一轮。
    budgetWindowMayRoll();
    // 同一轮询顺带重问就绪度：本次响应携带上一轮的值，回调落地后会自行重渲染提示行。
    void refreshProviderReadiness();
    sendResponse({
      settings: normalizeSettings(state.settings),
      tracks: state.tracks,
      loadStatus: state.loadStatus,
      translationStatus: state.translationStatus,
      translationBudget: translationBudgetState(),
      subtitleAvailability: state.subtitleAvailability,
      // 只投射页面需要的两项：轨道提示（tracksNotice）属于 overlay 位置，不进 page state。
      providerReadiness: { configured: state.aiReadiness.configured, notice: state.aiReadiness.notice },
      watchId: state.watchId,
      url: location.href
    });

    if (isWatchPage()) requestPlayerTracks();
    return true;
  });
}

// 上限永远来自当前设置（含未开始翻译时的初始值），用量与 exhausted 来自调度器最近一次 status。
// window 由当前锚定的 windowKey 反推，保证标签与它计量的那份用量始终同窗口；windowKey 是具体锚点字符串。
function translationBudgetState() {
  const limits = budgetLimits(state.settings);
  const usage = state.translationStatus?.budget ?? {};
  const anchor = budgetStoreRecord(state.budgetStore, state.budgetWindowKey);

  return {
    requestsUsed: usage.requestsUsed ?? 0,
    charactersUsed: usage.charactersUsed ?? 0,
    requestLimit: limits.requestLimit,
    characterLimit: limits.characterLimit,
    exhausted: usage.exhausted ?? null,
    window: budgetWindowId(state.budgetWindowKey, state.settings),
    windowKey: state.budgetWindowKey,
    resetAt: budgetWindowStart(state.budgetWindowKey) ?? anchor?.startedAt ?? null
  };
}

function bindBridgeMessages() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "bilayer-bridge") return;
    if (event.data?.type === "load-subtitle-result" || event.data?.type === "resolve-track-url-result") return;
    if (!isWatchPage()) return;
    syncWatchState();
    if (state.settingsWatchId !== state.watchId) return;

    const payload = event.data.payload;
    syncMovieState(payload);

    const tracks = modules.normalizeTracks(payload);
    observeTrackReport(payload, tracks);
    if (tracks.length === 0) return;

    state.tracks = mergeTracks(state.tracks, tracks);
    void refreshSelectedSubtitles();
  });
}

// ---- 字幕可用性与 AI 就绪度 ----
// 可用性四态锚定在本页当前播放的影片上，判据只有两条：bridge 发布的 player-api 轨道清单载荷，以及读不到该载荷时的兜底计时器。
// 证据（extension/src/page/netflix-page-bridge.js，queryPlayerApi）：
//     const tracks = readTimedTextTrackList(activePlayer).map((track) => serializeTrack(...)).filter(Boolean);
//     if (tracks.length === 0) return;                       // 原始列表为空 → 静默，不发布任何载荷
//     publish(`player-api:${movieId}:${reason}`, { source: "player-api", playerApi: true, movieId, activeTrack, tracks });
// 即：该载荷只会在“播放器实例存在且枚举出 ≥1 条原始轨道”时出现（boot、content 的 query-player-tracks 请求、2.5s 轮询），
// 携带 movieId 且只在 /watch/ 页面发布。因此：
//   unknown   —— 尚未收到带 movieId 的 player-api 载荷，且兜底计时器尚未到期（播放器未就绪，或原始列表为空而 bridge 静默）；
//   unread    —— 在 /watch/ 页面且 video 元素已就绪（播放上下文成立）后，TRACK_REPORT_TIMEOUT_MS 内仍没有任何 player-api 载荷：
//                取证失败，不代表本片没有轨道，故与 none 严格分开；
//   none      —— 真的收到该载荷，但 normalizeTracks() 归一化后没有可用轨道（原始列表可能只剩 off/none 轨道，
//                被 netflixAdapter.js 的 isPlayableTrack/isOffTrack 过滤）＝ 播放器已就绪而本片没有可用字幕轨道；
//   available —— 同一影片的载荷里有 ≥1 条可用轨道；此后不再因空载荷回退（回退只发生在换集/换片的 clearSubtitleState）。
// 迁移规则：unknown → unread（计时器到期）；unknown|unread → none|available（载荷到达，计时器同时取消）；
//   unread 可以在从未是 none 的情况下直接变成 available/none；available 不再降级。
// 归一化后的列表是判据本身：轨道 URL 尚未落地不算空——netflixAdapter.js 的 readDownloadables() 会为带 trackId 的
// player-api 轨道生成 netflix-track: 惰性 URL。
// 计时器生命周期：只在 unknown + /watch/ 页 + video 已就绪时武装（armTrackReportTimer），在载荷到达（observeTrackReport）、
//   任何复位（clearSubtitleState：换 watchId、换 movieId、BILAYER_RELOAD、离开 watch 页的清理路径）时先取消；
//   回调自身再复核状态与页面条件，因此不会在导航之后越权推进，也不会留下悬挂定时器。
function observeTrackReport(payload, tracks) {
  if (payload?.playerApi !== true || !payload.movieId) return;
  // 载荷已到：无论是否推进状态，兜底计时器都失去意义。
  clearTrackReportTimer();
  if (state.subtitleAvailability === "available") return;

  state.subtitleAvailability = tracks.length > 0 ? "available" : "none";
  renderForCurrentTime();
}

// 取消兜底计时器：复位、载荷到达、离开 watch 页时调用，保证任何时刻至多一个悬挂计时器。
function clearTrackReportTimer() {
  if (state.trackReportTimer) {
    clearTimeout(state.trackReportTimer);
    state.trackReportTimer = null;
  }
}

// 武装兜底计时器（等价于“重启计时”）：先清旧再按当前页面条件决定是否重新武装——
// 非 watch 页、还没有 video 元素、或可用性已不是 unknown 时一律不武装（不进则退，绝不让计时器空转）。
function armTrackReportTimer() {
  clearTrackReportTimer();
  if (state.subtitleAvailability !== "unknown" || !state.video || !isWatchPage()) return;

  state.trackReportTimer = setTimeout(() => {
    state.trackReportTimer = null;
    // 20 秒里可能已经收到载荷，或页面已导航/播放器已拆除：回调只做复核，不越权推进。
    if (state.subtitleAvailability !== "unknown" || !state.video || !isWatchPage()) return;

    state.subtitleAvailability = "unread";
    renderForCurrentTime();
  }, TRACK_REPORT_TIMEOUT_MS);
}

let readinessRequest = 0;

// 就绪度与三条提示文案的唯一真相在 background：content 只转述，从不自己携带 UI 字符串。
// 每次调用都重新问（不缓存，设置窗口轮询会反复问）；失败保留上一次已知值，绝不凭空造出提示。
function refreshProviderReadiness() {
  const token = ++readinessRequest;
  try {
    runtime.runtime.sendMessage({ type: "BILAYER_AI_READINESS" }, (response) => {
      if (runtime.runtime.lastError || token !== readinessRequest) return;
      if (!response || response.ok !== true) return;

      state.aiReadiness = {
        configured: response.configured === true,
        notice: typeof response.notice === "string" && response.notice ? response.notice : null,
        tracksNotice: typeof response.tracksNotice === "string" ? response.tracksNotice : "",
        unreadNotice: typeof response.unreadNotice === "string" ? response.unreadNotice : ""
      };
      renderForCurrentTime();
    });
  } catch {
    // 后台暂不可达：保留上一次已知快照，下一次触发会重新取。
  }
}

// 字幕位置的提示行：与 settings 的 writeAvailabilityNotice() 同一顺序——硬性不可用 > 可操作提示 > 软提示：
//   none（Netflix 没给任何轨道，双原生与 AI 都无从显示，硬性阻断）> provider 未配置（与轨道无关，随时可修复、带配置入口）
//   > unread（只是等不到载荷的观察态：配置好服务后它自己会回来）> 无提示。
// 文案为空（本地化键缺失或后台未给）时宁可不显示，也不显示半句无意义的提示，因此绝不产出空文本提示条。
function readinessNotice() {
  if (state.subtitleAvailability === "none" && state.aiReadiness.tracksNotice) {
    return { text: state.aiReadiness.tracksNotice, kind: "warning" };
  }
  if (!state.aiReadiness.configured && state.aiReadiness.notice) {
    return { text: state.aiReadiness.notice, kind: "warning" };
  }
  if (state.subtitleAvailability === "unread" && state.aiReadiness.unreadNotice) {
    return { text: state.aiReadiness.unreadNotice, kind: "warning" };
  }
  return null;
}

function syncMovieState(payload) {
  if (!payload?.playerApi || !payload.movieId) return;

  const nextMovieId = String(payload.movieId);
  if (nextMovieId === state.movieId) return;

  const hadMovie = Boolean(state.movieId);
  state.movieId = nextMovieId;
  if (hadMovie) clearSubtitleState();
}

function watchVideoElement() {
  const observer = new MutationObserver(() => bindVideo(document.querySelector("video")));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  bindVideo(document.querySelector("video"));
}

function watchLocation() {
  syncWatchState();
  state.locationId = setInterval(syncWatchState, 500);
}

function syncWatchState() {
  const nextWatchId = readWatchId();
  if (nextWatchId === state.watchId) return;

  state.watchId = nextWatchId;
  state.settingsWatchId = "";
  clearSubtitleState();
  updateNativeSubtitleVisibility();
  postNativeSubtitlePreference();
  // Remount overlay against the new player DOM after a watchId change so
  // the host reattaches to the new fullscreen root instead of staying
  // detached on a stale ancestor.
  overlay.mount?.();
  void loadSettingsForWatch(nextWatchId);
}

async function loadSettingsForWatch(watchId) {
  const token = ++state.settingsToken;
  const settings = await readSettings();
  if (token !== state.settingsToken || watchId !== state.watchId) return;

  state.settings = settings;
  state.settingsWatchId = watchId;
  // session 窗口锚在 watchId 上：换剧集即换窗口，先同步换键再异步读回持久化用量。
  state.budgetWindowKey = currentBudgetWindowKey();
  void refreshBudgetWindow();
  translator.setBudget(budgetLimits(state.settings));
  overlay.applySettings(state.settings);
  updateNativeSubtitleVisibility();
  renderForCurrentTime();

  if (watchId) requestPlayerTracks();
  else postNativeSubtitlePreference();
}

function clearSubtitleState() {
  state.refreshToken += 1;
  state.subtitleEpoch += 1;
  releaseInitialWait(false);
  state.waitedForWatch = "";
  state.tracks = [];
  // 换集/换片/重载即是可用性边界：新影片的轨道证据尚未到达，回到 unknown（available 只在这条边界上解除锁定），
  // 兜底计时器随之重启；离开 watch 页的清理路径不会武装（armTrackReportTimer 自查页面与 video）。
  clearTrackReportTimer();
  state.subtitleAvailability = "unknown";
  armTrackReportTimer();
  state.selectedTrackKeys = { primary: "", secondary: "", aiSource: "" };
  state.primaryCues = [];
  state.secondaryCues = [];
  state.aiSourceCues = [];
  state.loadStatus = {
    primary: { cueCount: 0, error: "" },
    secondary: { cueCount: 0, error: "" },
    aiSource: { cueCount: 0, error: "" }
  };
  translator.clear();
  store.clear();
  // SPA route changes may detach the subtitle host element; clear the
  // fullscreen-management flags so overlay.mount() reattaches listeners
  // and reparent logic runs on the next mount against the new player.
  const host = document.getElementById("bilayer-host");
  if (host) {
    host.__fullscreenInstalled = false;
    host.__bilayer_mountedKey = null;
  }
  overlay.render();
}

function startPlayerTrackQueries() {
  requestPlayerTracks();
  if (state.playerQueryId) clearInterval(state.playerQueryId);
  state.playerQueryId = setInterval(requestPlayerTracks, 2500);
}

function requestPlayerTracks() {
  if (!isWatchPage()) {
    clearSubtitleState();
    postNativeSubtitlePreference();
    return;
  }

  if (state.settingsWatchId !== state.watchId) return;

  window.postMessage({
    source: "bilayer-bridge",
    type: "query-player-tracks"
  }, window.location.origin);

  postNativeSubtitlePreference();
}

function bindVideo(video) {
  if (!video || video === state.video) return;

  if (state.video) {
    state.video.removeEventListener("timeupdate", onPlaybackTimeChange);
    state.video.removeEventListener("seeked", onPlaybackSeek);
    state.video.removeEventListener("ratechange", onPlaybackTimeChange);
    state.video.removeEventListener("play", onVideoPlay);
    state.video.removeEventListener("pause", onVideoPause);
    if (typeof state.unbindVideoFullscreen === "function") {
      state.unbindVideoFullscreen();
      state.unbindVideoFullscreen = null;
    }
  }

  state.video = video;
  video.addEventListener("timeupdate", onPlaybackTimeChange);
  video.addEventListener("seeked", onPlaybackSeek);
  video.addEventListener("ratechange", onPlaybackTimeChange);
  video.addEventListener("play", onVideoPlay);
  video.addEventListener("pause", onVideoPause);
  const bindFs = modules.bindVideoFullscreen;
  if (typeof bindFs === "function") {
    state.unbindVideoFullscreen = bindFs(video, () => overlay.mount?.());
  }
  overlay.mount?.();
  onPlaybackTimeChange();
  startFrameLoop();
  // 播放上下文此刻才成立（video 元素存在）：这是 unread 计时器最早可能的起点（首次挂载与 SPA 换源后重新绑定）。
  armTrackReportTimer();
}

function refreshSelectedSubtitles() {
  if (!isWatchPage()) {
    clearSubtitleState();
    return;
  }

  const token = ++state.refreshToken;
  const selected = [
    ["primary", pickTrack(state.tracks, state.settings.primaryTrackKey, state.settings.primaryTrackPreference, state.settings.primaryLanguage)],
    ["secondary", pickTrack(state.tracks, state.settings.secondaryTrackKey, state.settings.secondaryTrackPreference, state.settings.secondaryLanguage)],
    ["aiSource", pickTrack(state.tracks, state.settings.aiSourceTrackKey, state.settings.aiSourceTrackPreference, state.settings.aiSourceLanguage)]
  ];

  for (const [role, track] of selected) {
    const key = track?.key ?? "";
    if (state.selectedTrackKeys[role] !== key) {
      state.selectedTrackKeys[role] = key;
      state[`${role}Cues`] = [];
      state.loadStatus[role] = { cueCount: 0, error: "" };
    }
    if (track) void loadTrackCues(role, track, token);
  }
  syncTranslator();
  renderForCurrentTime();
}

async function loadTrackCues(role, track, token) {
  let cues = [];
  let error = "";
  try {
    cues = await store.load(track);
  } catch (cause) {
    error = cause?.message ?? String(cause);
  }

  if (token !== state.refreshToken) return;
  state[`${role}Cues`] = cues;
  state.loadStatus[role] = { cueCount: cues.length, error };
  updateNativeSubtitleVisibility();
  if (state.initialWait && hasNativeFallback()) releaseInitialWait(true);
  syncTranslator();
  renderForCurrentTime();
}

function renderForCurrentTime() {
  if (!state.video || !state.settings.enabled || !isWatchPage()) {
    overlay.render();
    return;
  }

  const timeMs = state.video.currentTime * 1000 + state.settings.timingOffsetMs;
  const primaryCues = dedupeActiveCues(activeAtTime(state.primaryCues, timeMs));
  const secondaryCues = dedupeActiveCues(activeAtTime(state.secondaryCues, timeMs));
  const role = state.settings.aiRole;
  if (role === "primary" || role === "secondary") {
    const source = dedupeActiveCues(activeAtTime(state.aiSourceCues, timeMs));
    const translated = translator.translatedFor(source);
    // 当前 AI 行仍在等译文时把角色交给 overlay：它只在该行确实没有文本时显示等待占位。
    const pending = translator.pendingRoles(source);
    // 只在 AI 模式挂提示行：原生模式没有任何 AI 前置条件，字幕位置保持干净。
    const notice = readinessNotice();
    const nativeFallback = state.selectedTrackKeys[role] !== state.selectedTrackKeys.aiSource;
    if (translated.length === 0 && !nativeFallback) {
      if (role === "primary") primaryCues.length = 0;
      else secondaryCues.length = 0;
    }
    if (translated.length > 0) {
      if (role === "primary") overlay.render({ primaryCues: translated, secondaryCues: translator.annotateSource(secondaryCues), pending, notice });
      else overlay.render({ primaryCues: translator.annotateSource(primaryCues), secondaryCues: translated, pending, notice });
      return;
    }
    overlay.render({
      primaryCues: translator.annotateSource(primaryCues),
      secondaryCues: translator.annotateSource(secondaryCues),
      pending,
      notice
    });
    return;
  }
  overlay.render({
    primaryCues: translator.annotateSource(primaryCues),
    secondaryCues: translator.annotateSource(secondaryCues),
    notice: null
  });
}

function syncTranslator() {
  const role = state.settings.aiRole;
  budgetWindowMayRoll();
  translator.setBudget(budgetLimits(state.settings));
  if (!state.settings.enabled || (role !== "primary" && role !== "secondary") || !isWatchPage()) {
    if (state.translationStatus.phase !== "off") translator.clear();
    return;
  }

  const sourceTrack = state.tracks.find((track) => track.key === state.selectedTrackKeys.aiSource);
  const cues = state.aiSourceCues;
  if (!sourceTrack || cues.length === 0) {
    if (state.translationStatus.phase !== "off") translator.clear();
    state.translationStatus = {
      phase: state.tracks.length && !sourceTrack ? "error" : "waiting",
      count: 0,
      error: state.tracks.length && !sourceTrack ? "source_unavailable" : ""
    };
    return;
  }

  const isSourceJp = isJapanese(sourceTrack.language);
  const isTargetJp = isJapanese(state.settings.aiTargetLanguage);
  const hasJp = isSourceJp || isTargetJp;
  const rubyEnabled = hasJp && (state.settings.aiJapaneseRuby !== false);

  const identity = JSON.stringify([
    state.watchId, state.subtitleEpoch, sourceTrack.key, role,
    state.settings.aiTargetLanguage, state.settings.aiProviderId, state.settings.aiStyleGuide,
    state.settings.aiContextCount, rubyEnabled
  ]);
  translator.setSource({
    identity,
    budgetKey: state.budgetWindowKey,
    role,
    cues,
    sourceLanguage: sourceTrack.language,
    targetLanguage: state.settings.aiTargetLanguage,
    prefetchCount: state.settings.aiPrefetchCount,
    contextCount: state.settings.aiContextCount,
    japaneseRuby: rubyEnabled
  });
  if (state.video) {
    translator.observe(currentTimeMs(), state.video.playbackRate || 1);
    maybeWaitForFirstTranslation();
  }
}

function translateBatch(batch) {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(() => finish({ ok: false, errorCode: "unavailable", trace: [
      { stage: "rejected", reason: "message_timeout" }
    ] }), 22000);
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    }
    try {
      runtime.runtime.sendMessage({ type: "BILAYER_TRANSLATE_BATCH", diagnostic: true, ...batch }, (response) => {
        finish(runtime.runtime.lastError
          ? { ok: false, errorCode: "unavailable", trace: [{ stage: "rejected", reason: "runtime_error" }] }
          : response ?? { ok: false, errorCode: "unavailable", trace: [{ stage: "rejected", reason: "empty_reply" }] });
      });
    } catch {
      finish({ ok: false, errorCode: "unavailable", trace: [{ stage: "rejected", reason: "send_failed" }] });
    }
  });
}

function onTranslationUpdate(status) {
  state.translationStatus = status;
  // 只在调度器计量的窗口与本页当前窗口一致时回写：跨窗口的瞬间（还差一次存储读回）宁可少写一次，
  // 也不能把上一个窗口的用量记到新窗口上；下一次派发前的 syncBudgetUsage 会补齐。
  if (!budgetRefresh && status.budgetKey && status.budgetKey === state.budgetWindowKey) {
    persistBudgetUsage(status.budgetKey, status.budget);
  }
  if (state.initialWait && (status.phase === "error" || translator.readyAt(currentTimeMs()) || hasNativeFallback())) {
    releaseInitialWait(true);
  }
  renderForCurrentTime();
}

function currentTimeMs() {
  return (state.video?.currentTime ?? 0) * 1000 + state.settings.timingOffsetMs;
}

function onPlaybackTimeChange() {
  budgetWindowMayRoll();
  if (state.video && state.settings.enabled) translator.observe(currentTimeMs(), state.video.playbackRate || 1);
  renderForCurrentTime();
}

function onPlaybackSeek() {
  if (state.video && state.settings.enabled) translator.observe(currentTimeMs(), state.video.playbackRate || 1, true);
  renderForCurrentTime();
}

function onVideoPlay() {
  startFrameLoop();
  if (state.initialWait) {
    releaseInitialWait(false);
    return;
  }
  onPlaybackTimeChange();
  maybeWaitForFirstTranslation();
}

function onVideoPause() {
  stopFrameLoop();
  if (state.initialWait && !state.initialWait.internalPause) state.initialWait.userPaused = true;
}

function hasNativeFallback() {
  const role = state.settings.aiRole;
  return state[`${role}Cues`]?.length > 0 && state.selectedTrackKeys[role] !== state.selectedTrackKeys.aiSource;
}

function maybeWaitForFirstTranslation() {
  const video = state.video;
  const role = state.settings.aiRole;
  if (!video || video.paused || typeof video.pause !== "function" || !state.settings.enabled ||
      (role !== "primary" && role !== "secondary") || !isWatchPage() || hasNativeFallback()) return;
  if (!state.settings.aiSourceTrackKey && !state.settings.aiSourceLanguage) return;
  const watch = `${state.watchId}:${role}`;
  if (state.initialWait || state.waitedForWatch === watch ||
      (state.translationStatus.count > 0 && translator.readyAt(currentTimeMs()))) return;

  state.waitedForWatch = watch;
  const wait = { video, watchId: state.watchId, internalPause: true, userPaused: false, timer: 0 };
  state.initialWait = wait;
  wait.timer = setTimeout(() => {
    if (state.initialWait !== wait) return;
    state.translationStatus = { ...state.translationStatus, phase: "error", error: "initial_timeout" };
    releaseInitialWait(true);
  }, 3000);
  video.pause();
  queueMicrotask(() => { wait.internalPause = false; });
}

function releaseInitialWait(resume) {
  const wait = state.initialWait;
  if (!wait) return;
  clearTimeout(wait.timer);
  state.initialWait = null;
  if (resume && !wait.userPaused && wait.video === state.video && wait.watchId === state.watchId && wait.video.paused) {
    void Promise.resolve(wait.video.play()).catch(() => {});
  }
}

function updateNativeSubtitleVisibility() {
  const shouldHide = shouldHideNativeSubtitles();
  let style = document.querySelector("#bilayer-native-hide-style");

  if (!shouldHide) {
    style?.remove();
    postNativeSubtitlePreference();
    return;
  }

  if (style) return;

  style = document.createElement("style");
  style.id = "bilayer-native-hide-style";
  style.textContent = `
    .player-timedtext,
    .player-timedtext-text-container,
    .image-based-subtitles,
    .image-based-subtitles svg,
    .image-based-subtitles img,
    [data-uia="player-timedtext"],
    [data-uia="player-subtitle"],
    [data-uia*="timedtext"],
    [data-uia*="subtitle"],
    [class*="player-timedtext"],
    [class*="timedtext"],
    [class*="TimedText"],
    [class*="subtitle"],
    [class*="Subtitle"] {
      opacity: 0 !important;
      visibility: hidden !important;
      display: none !important;
    }
  `;
  document.documentElement.append(style);
  postNativeSubtitlePreference();
}

function postNativeSubtitlePreference() {
  window.postMessage({
    source: "bilayer-bridge",
    type: "set-native-subtitles-hidden",
    hidden: shouldHideNativeSubtitles()
  }, window.location.origin);
}

function shouldHideNativeSubtitles() {
  return isWatchPage() && state.settings.enabled && state.settings.hideNativeSubtitles
    && (state.settings.aiRole === "off" || state.primaryCues.length > 0 || state.secondaryCues.length > 0);
}

function startFrameLoop() {
  stopFrameLoop();

  const frame = () => {
    renderForCurrentTime();
    state.tickId = requestAnimationFrame(frame);
  };

  state.tickId = requestAnimationFrame(frame);
}

function stopFrameLoop() {
  if (!state.tickId) return;
  cancelAnimationFrame(state.tickId);
  state.tickId = 0;
}

function mergeTracks(existing, incoming) {
  const byKey = new Map(existing.map((track) => [track.key, track]));

  for (const track of incoming) {
    byKey.set(track.key, { ...byKey.get(track.key), ...track });
  }

  return [...byKey.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function activeAtTime(cues, timeMs) {
  return cues.filter((cue) => cue.startMs <= timeMs && timeMs <= cue.endMs);
}

function dedupeActiveCues(cues) {
  const seen = new Set();
  const result = [];

  for (const cue of cues) {
    const key = normalizeCueText(cue.text);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cue);
  }

  return result;
}

function normalizeCueText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isWatchPage() {
  return Boolean(readWatchId());
}

function readWatchId() {
  return location.pathname.match(/^\/watch\/([^/?#]+)/)?.[1] ?? "";
}

function trackPreference(track) {
  return JSON.stringify([track.language, track.label, track.type].map((part) => String(part ?? "").trim().toLowerCase()));
}

function pickTrack(tracks, trackKey, preference, language) {
  if (trackKey) {
    const selected = tracks.find((track) => track.key === trackKey);
    if (selected) return selected;
  }

  if (preference) {
    const selected = tracks.find((track) => trackPreference(track) === preference);
    if (selected) return selected;
  }

  const needle = String(language ?? "").toLowerCase();
  if (!needle) return null;

  return tracks.find((track) => track.language.toLowerCase() === needle)
    ?? tracks.find((track) => track.language.toLowerCase().startsWith(needle))
    ?? null;
}

function readSettings() {
  return new Promise((resolve) => {
    runtime.storage.local.get(DEFAULT_SETTINGS, (stored) => resolve(normalizeSettings(stored)));
  });
}

function normalizeSettings(stored) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (stored[key] !== undefined) settings[key] = stored[key];
  }
  if (!TARGET_LANGUAGES.has(settings.aiTargetLanguage)) settings.aiTargetLanguage = DEFAULT_SETTINGS.aiTargetLanguage;
  if (!Number.isInteger(settings.aiPrefetchCount) || settings.aiPrefetchCount < 0 || settings.aiPrefetchCount > 50) {
    settings.aiPrefetchCount = DEFAULT_SETTINGS.aiPrefetchCount;
  }
  if (!Number.isInteger(settings.aiContextCount) || settings.aiContextCount < 0 || settings.aiContextCount > 4) {
    settings.aiContextCount = DEFAULT_SETTINGS.aiContextCount;
  }
  for (const key of BUDGET_SETTING_KEYS) {
    settings[key] = normalizeBudgetSetting(key, settings[key]);
  }
  settings.aiBudgetWindow = normalizeBudgetWindowSetting(settings.aiBudgetWindow);
  if (typeof settings.aiStyleGuide !== "string" || !settings.aiStyleGuide.trim()) settings.aiStyleGuide = DEFAULT_TRANSLATION_PROMPT;
  if (stored.fontSize !== undefined && stored.secondaryFontSize === undefined) {
    settings.secondaryFontSize = stored.fontSize;
  }

  if (stored.verticalOffset !== undefined && stored.secondaryVerticalOffset === undefined) {
    settings.secondaryVerticalOffset = stored.verticalOffset;
  }

  return settings;
}

function isJapanese(lang) {
  return /^(ja|jp)($|[-_])/i.test(String(lang ?? "").trim());
}

// 预算设置只接受 0..上限 的整数：0 表示不限，缺省、非整数、越界一律回落默认值。
function normalizeBudgetSetting(key, value) {
  if (!Number.isInteger(value) || value < 0 || value > BUDGET_SETTING_MAX[key]) return DEFAULT_SETTINGS[key];
  return value;
}

// 计量窗口只接受三个固定取值，缺省或非法一律回落 session（与预算数值同一套降级风格）。
function normalizeBudgetWindowSetting(value) {
  return BUDGET_WINDOWS.has(value) ? value : DEFAULT_SETTINGS.aiBudgetWindow;
}

function budgetLimits(settings) {
  return {
    requestLimit: settings.aiRequestBudget === 0 ? null : settings.aiRequestBudget,
    characterLimit: settings.aiCharacterBudget === 0 ? null : settings.aiCharacterBudget
  };
}

// ---- 额度计量窗口：窗口定义、持久化台账与多上下文合并 ----
// 窗口键是唯一的计量边界，也是持久化台账里每条用量记录的归属标识：
// session:<watchId> 让同一集页面刷新后继续累计（换剧集/换标题即换键，重新起算）；
// hour/day 按本机时间分桶，跨过整点/午夜后自然换键。0 表示不限的语义在预算上限一侧，与本键无关。

// 当前时刻应使用的窗口键（纯计算，不做 IO，便于时间推进时随时比对）。
function currentBudgetWindowKey(settings = state.settings, date = new Date()) {
  const window = normalizeBudgetWindowSetting(settings.aiBudgetWindow);
  if (window === "session") return `session:${state.watchId}`;
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return window === "hour" ? `hour:${day}T${pad(date.getHours())}` : `day:${day}`;
}

// 页面状态里报告的窗口 id：由锚定的键反推，永远与那份用量同窗口。
function budgetWindowId(windowKey, settings) {
  const id = String(windowKey ?? "").split(":")[0];
  return BUDGET_WINDOWS.has(id) ? id : normalizeBudgetWindowSetting(settings?.aiBudgetWindow);
}

// 时间桶的起点（epoch ms），供 UI 标注“本轮从何时开始”；session 窗口没有可推导的起点，返回 null。
function budgetWindowStart(windowKey, date = new Date()) {
  const id = String(windowKey ?? "").split(":")[0];
  if (id === "hour") {
    const start = new Date(date.getTime());
    start.setMinutes(0, 0, 0);
    return start.getTime();
  }
  if (id === "day") {
    const start = new Date(date.getTime());
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  return null;
}

function normalizeCounter(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function earliestStart(left, right) {
  const first = normalizeCounter(left);
  const second = normalizeCounter(right);
  if (!first) return second;
  if (!second) return first;
  return Math.min(first, second);
}

function normalizeBudgetRecord(entry) {
  return {
    requests: normalizeCounter(entry?.requests),
    characters: normalizeCounter(entry?.characters),
    startedAt: normalizeCounter(entry?.startedAt),
    updatedAt: normalizeCounter(entry?.updatedAt ?? entry?.startedAt)
  };
}

// 同一窗口的两份视图取并集：计数逐项取较大值（两个标签页各记自己的消耗），窗口起点取较早的一个。
function mergeBudgetRecord(left, right) {
  return {
    requests: Math.max(normalizeCounter(left?.requests), normalizeCounter(right?.requests)),
    characters: Math.max(normalizeCounter(left?.characters), normalizeCounter(right?.characters)),
    startedAt: earliestStart(left?.startedAt, right?.startedAt),
    updatedAt: Math.max(normalizeCounter(left?.updatedAt), normalizeCounter(right?.updatedAt))
  };
}

// 台账形状：{ records: { "<windowKey>": { requests, characters, startedAt, updatedAt } }, updatedAt }。
// 每条窗口各占一项，因此两个标签页看不同剧集（session:<watchId> 不同）时互不覆盖；
// 旧版单记录形状（顶层 windowKey/requests/characters）读到时迁移成映射并保留其中的计数。
function normalizeBudgetStore(raw) {
  if (!raw || typeof raw !== "object") return { records: {}, updatedAt: 0, legacy: false };
  const legacyKey = typeof raw.windowKey === "string" ? raw.windowKey : "";
  if (raw.records && typeof raw.records === "object") {
    const records = {};
    for (const [key, entry] of Object.entries(raw.records)) {
      if (typeof key !== "string" || !key) continue;
      records[key] = normalizeBudgetRecord(entry);
    }
    // 罕见的混合形状：顶层旧字段与映射同时存在时按同窗口取并集，不丢计数。
    if (legacyKey) {
      const legacy = normalizeBudgetRecord(raw);
      records[legacyKey] = records[legacyKey] ? mergeBudgetRecord(records[legacyKey], legacy) : legacy;
    }
    return { records, updatedAt: normalizeCounter(raw.updatedAt), legacy: false };
  }
  if (!legacyKey) return { records: {}, updatedAt: 0, legacy: false };
  return { records: { [legacyKey]: normalizeBudgetRecord(raw) }, updatedAt: normalizeCounter(raw.startedAt), legacy: true };
}

// 台账上限：当前窗口始终保留，其余按最近写入时间从新到旧保留，够覆盖“本集 + 本小时 + 本日 + 上一个窗口”。
function pruneBudgetRecords(records, keepKey) {
  const keys = Object.keys(records);
  if (keys.length <= BUDGET_RECORD_LIMIT) return records;
  const ordered = keys.sort((left, right) => {
    const leftAt = records[left].updatedAt || records[left].startedAt || 0;
    const rightAt = records[right].updatedAt || records[right].startedAt || 0;
    return rightAt - leftAt;
  });
  const kept = {};
  if (records[keepKey]) kept[keepKey] = records[keepKey];
  for (const key of ordered) {
    if (Object.keys(kept).length >= BUDGET_RECORD_LIMIT) break;
    kept[key] = records[key];
  }
  return kept;
}

function mergeBudgetRecords(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, record] of Object.entries(right)) {
    merged[key] = merged[key] ? mergeBudgetRecord(merged[key], record) : record;
  }
  return merged;
}

function budgetStoreRecord(store, windowKey) {
  return store?.records?.[windowKey] ?? null;
}

// 只有能派发翻译的观剧页面才写台账：浏览页、首页、设置窗口永远不会派发请求，
// 只在自身内存里归零，免得占掉别人的窗口项或触发无谓的写入。
function budgetWindowAnchorable(windowKey) {
  return Boolean(state.watchId) && Boolean(windowKey);
}

// 读回整本台账；读失败返回 null（未知即不采用：既不换锚也不回写，避免把 0 写进存储）。
function readBudgetUsage() {
  return new Promise((resolve) => {
    try {
      runtime.storage.local.get({ [BUDGET_USAGE_KEY]: null }, (stored) => {
        if (runtime.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(normalizeBudgetStore(stored?.[BUDGET_USAGE_KEY]));
      });
    } catch {
      resolve(null);
    }
  });
}

let budgetStoreWrite = null;
let budgetStoreWritePending = false;

// 写台账：先并入存储里当前的其它窗口项再落盘，因此本页只会更新自己窗口那一项，
// 不会把另一标签页刚写下的记录抹掉。写入失败不致命：本页继续按内存镜像计量。
async function flushBudgetStore() {
  const stored = await readBudgetUsage();
  if (!stored) return;
  const records = pruneBudgetRecords(mergeBudgetRecords(stored.records, state.budgetStore.records), state.budgetWindowKey);
  const next = { records, updatedAt: Date.now(), legacy: false };
  state.budgetStore = next;
  try {
    runtime.storage.local.set({ [BUDGET_USAGE_KEY]: { records: next.records, updatedAt: next.updatedAt } }, () => {});
  } catch {
    // 见上：存储不可用时只保留内存镜像。
  }
}

function scheduleBudgetStoreWrite() {
  if (budgetStoreWrite) {
    budgetStoreWritePending = true;
    return;
  }
  budgetStoreWrite = flushBudgetStore().catch(() => null).finally(() => {
    budgetStoreWrite = null;
    if (budgetStoreWritePending) {
      budgetStoreWritePending = false;
      scheduleBudgetStoreWrite();
    }
  });
}

// 记账：值没变就不落盘（每次 notify 都会回写），旧版单记录形状例外——即使值没变也写一次，
// 把存储升级成多窗口映射。内存镜像立即生效，落盘异步合并。
function persistBudgetUsage(windowKey, usage) {
  if (!budgetWindowAnchorable(windowKey) || !usage) return;
  const previous = budgetStoreRecord(state.budgetStore, windowKey);
  const requests = normalizeCounter(usage.requests ?? usage.requestsUsed);
  const characters = normalizeCounter(usage.characters ?? usage.charactersUsed);
  if (previous && previous.requests === requests && previous.characters === characters && !state.budgetStore.legacy) return;
  const record = {
    requests,
    characters,
    startedAt: previous?.startedAt || Date.now(),
    updatedAt: Date.now()
  };
  state.budgetStore = {
    records: pruneBudgetRecords({ ...state.budgetStore.records, [windowKey]: record }, windowKey),
    updatedAt: record.updatedAt,
    legacy: state.budgetStore.legacy
  };
  scheduleBudgetStoreWrite();
}

let budgetRefresh = null;

// 读回当前窗口的持久化用量并锚定调度器：窗口不同则按读到的视图重新起算，
// 窗口相同则取较大值合并。单飞，读期间跨过窗口边界就重算一次。
function refreshBudgetWindow() {
  budgetRefresh ??= doRefreshBudgetWindow().catch(() => null).finally(() => {
    budgetRefresh = null;
  });
  return budgetRefresh;
}

async function doRefreshBudgetWindow() {
  for (let attempt = 0; attempt < 2; attempt++) {
    const windowKey = currentBudgetWindowKey();
    const store = await readBudgetUsage();
    if (!store) return null;
    // 读期间跨过整点/午夜：按新的窗口键重来，避免把旧窗口的用量锚到新窗口上。
    if (windowKey !== currentBudgetWindowKey()) continue;
    const record = budgetStoreRecord(store, windowKey);
    const view = record
      ? { windowKey, requests: record.requests, characters: record.characters }
      : { windowKey, requests: 0, characters: 0 };
    state.budgetWindowKey = windowKey;
    state.budgetStore = store;
    translator.setUsage(windowKey, view);
    persistBudgetUsage(windowKey, view);
    return view;
  }
  return null;
}

function budgetWindowMayRoll() {
  if (state.budgetWindowKey === currentBudgetWindowKey()) return;
  void refreshBudgetWindow();
}

// 派发前闸门：调度器在扣费前回调，先与台账对齐（另一标签页可能已经花掉同一窗口的额度，或本页刚换了窗口），
// 再把合并后的用量交还调度器，因此上限不会被第二个标签页翻倍。只读自己窗口那一项。
async function syncBudgetUsage({ windowKey, requests, characters }) {
  if (state.budgetWindowKey !== currentBudgetWindowKey()) await refreshBudgetWindow();
  const currentKey = state.budgetWindowKey;
  const store = await readBudgetUsage();
  if (store) state.budgetStore = store;
  const stored = budgetStoreRecord(store, currentKey);
  // 调度器报的用量只在同一窗口下才计入；刚换窗口时它手里还是上一个窗口的计数，必须丢弃。
  const sameWindow = windowKey === currentKey;
  const merged = {
    windowKey: currentKey,
    requests: Math.max(sameWindow ? normalizeCounter(requests) : 0, stored?.requests ?? 0),
    characters: Math.max(sameWindow ? normalizeCounter(characters) : 0, stored?.characters ?? 0)
  };
  translator.setUsage(currentKey, merged);
  // 台账读不到时只更新内存镜像、不回写：宁可少一次跨标签页可见，也不拿 0 覆盖别人的记录。
  if (store) persistBudgetUsage(currentKey, merged);
  return merged;
}
