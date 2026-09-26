/**
 * [INPUT]: 依赖轨道归一化、subtitleStore 与 translationScheduler、overlay、fullscreenMount 及 page bridge 播放器查询
 * [OUTPUT]: 提供互斥双原生/AI 翻译、独立 AI 源轨道、默认 10 组预取和可调上下文、首句等待、切集隔离及脱敏页面状态
 * [POS]: content 入口；只协调播放与视图，AI provider 配置和密钥由 background 从扩展存储读取
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const runtime = globalThis.browser ?? globalThis.chrome;
const modules = window.NetflixDualSubtitles;
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
const AI_SETTING_KEYS = new Set(["aiRole", "aiTargetLanguage", "aiProviderId", "aiStyleGuide", "aiContextCount", "aiSourceTrackKey", "aiSourceTrackPreference", "aiSourceLanguage"]);

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
  aiStyleGuide: DEFAULT_TRANSLATION_PROMPT,
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
const translator = modules.createTranslationScheduler({ translate: translateBatch, onUpdate: onTranslationUpdate });

boot();

async function boot() {
  state.watchId = readWatchId();
  state.settings = await readSettings();
  state.settingsWatchId = state.watchId;
  overlay.applySettings(state.settings);
  updateNativeSubtitleVisibility();
  await injectPageBridge();
  bindRuntimeMessages();
  bindPopupMessages();
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

    let shouldRefreshTracks = false;
    let shouldRefreshTranslation = Boolean(changes.providers);
    let shouldUpdatePrefetch = false;
    let settingsChanged = false;

    for (const [key, change] of Object.entries(changes)) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue;
      state.settings[key] = key === "aiPrefetchCount" && (!Number.isInteger(change.newValue) || change.newValue < 0 || change.newValue > 50)
        ? DEFAULT_SETTINGS.aiPrefetchCount
        : key === "aiContextCount" && (!Number.isInteger(change.newValue) || change.newValue < 0 || change.newValue > 4)
          ? DEFAULT_SETTINGS.aiContextCount
          : change.newValue === undefined ? DEFAULT_SETTINGS[key] : change.newValue;
      settingsChanged = true;
      shouldRefreshTracks ||= SUBTITLE_TRACK_SETTING_KEYS.has(key);
      shouldUpdatePrefetch ||= key === "aiPrefetchCount";
      shouldRefreshTranslation ||= AI_SETTING_KEYS.has(key) || key === "enabled";
    }

    if (!settingsChanged && !shouldRefreshTranslation) return;
    if (settingsChanged) overlay.applySettings(state.settings);
    if (shouldRefreshTranslation) {
      releaseInitialWait(true);
      translator.clear();
    }
    if (shouldRefreshTracks) refreshSelectedSubtitles();
    else if (shouldRefreshTranslation || shouldUpdatePrefetch) syncTranslator();
    updateNativeSubtitleVisibility();
    renderForCurrentTime();
  });
}

function bindPopupMessages() {
  runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "NETFLIX_DUAL_SUBTITLES_RELOAD") {
      if (!isWatchPage()) {
        sendResponse({ ok: false });
        return true;
      }

      clearSubtitleState();
      requestPlayerTracks();
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type !== "NETFLIX_DUAL_SUBTITLES_GET_STATE") return false;

    sendResponse({
      settings: normalizeSettings(state.settings),
      tracks: state.tracks,
      loadStatus: state.loadStatus,
      translationStatus: state.translationStatus,
      watchId: state.watchId,
      url: location.href
    });

    if (isWatchPage()) requestPlayerTracks();
    return true;
  });
}

function bindBridgeMessages() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "netflix-dual-subtitles-bridge") return;
    if (event.data?.type === "load-subtitle-result" || event.data?.type === "resolve-track-url-result") return;
    if (!isWatchPage()) return;
    syncWatchState();
    if (state.settingsWatchId !== state.watchId) return;

    const payload = event.data.payload;
    syncMovieState(payload);

    const tracks = modules.normalizeTracks(payload);
    if (tracks.length === 0) return;

    state.tracks = mergeTracks(state.tracks, tracks);
    void refreshSelectedSubtitles();
  });
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
  const host = document.getElementById("netflix-dual-subtitles-host");
  if (host) {
    host.__fullscreenInstalled = false;
    host.__netflixDualSubtitles_mountedKey = null;
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
    source: "netflix-dual-subtitles-bridge",
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
    const nativeFallback = state.selectedTrackKeys[role] !== state.selectedTrackKeys.aiSource;
    if (translated.length > 0) {
      if (role === "primary") overlay.render({ primaryCues: translated, secondaryCues });
      else overlay.render({ primaryCues, secondaryCues: translated });
      return;
    }
    if (!nativeFallback) {
      if (role === "primary") primaryCues.length = 0;
      else secondaryCues.length = 0;
    }
  }
  overlay.render({ primaryCues, secondaryCues });
}

function syncTranslator() {
  const role = state.settings.aiRole;
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

  const identity = JSON.stringify([
    state.watchId, state.subtitleEpoch, sourceTrack.key, role,
    state.settings.aiTargetLanguage, state.settings.aiProviderId, state.settings.aiStyleGuide, state.settings.aiContextCount
  ]);
  translator.setSource({
    identity,
    budgetKey: `${state.watchId}:${state.subtitleEpoch}`,
    cues,
    sourceLanguage: sourceTrack.language,
    targetLanguage: state.settings.aiTargetLanguage,
    prefetchCount: state.settings.aiPrefetchCount,
    contextCount: state.settings.aiContextCount
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
      runtime.runtime.sendMessage({ type: "NETFLIX_DUAL_SUBTITLES_TRANSLATE_BATCH", diagnostic: true, ...batch }, (response) => {
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
  if (state.initialWait && (status.phase === "error" || translator.readyAt(currentTimeMs()) || hasNativeFallback())) {
    releaseInitialWait(true);
  }
  renderForCurrentTime();
}

function currentTimeMs() {
  return (state.video?.currentTime ?? 0) * 1000 + state.settings.timingOffsetMs;
}

function onPlaybackTimeChange() {
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
  let style = document.querySelector("#netflix-dual-subtitles-native-hide-style");

  if (!shouldHide) {
    style?.remove();
    postNativeSubtitlePreference();
    return;
  }

  if (style) return;

  style = document.createElement("style");
  style.id = "netflix-dual-subtitles-native-hide-style";
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
    source: "netflix-dual-subtitles-bridge",
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
  if (typeof settings.aiStyleGuide !== "string" || !settings.aiStyleGuide.trim()) settings.aiStyleGuide = DEFAULT_TRANSLATION_PROMPT;
  if (stored.fontSize !== undefined && stored.secondaryFontSize === undefined) {
    settings.secondaryFontSize = stored.fontSize;
  }

  if (stored.verticalOffset !== undefined && stored.secondaryVerticalOffset === undefined) {
    settings.secondaryVerticalOffset = stored.verticalOffset;
  }

  return settings;
}
