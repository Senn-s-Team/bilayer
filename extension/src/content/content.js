/**
 * [INPUT]: 依赖 window.NetflixDualSubtitles 的轨道归一化、字幕加载、overlay 渲染、fullscreenMount 全屏挂载管理与 page bridge 播放器查询
 * [OUTPUT]: 对外提供 Netflix 页面双字幕同步、全局字幕偏好恢复、轨道查询与手动重载，并在视频/文档全屏时挂载 host
 * [POS]: content 模块入口，连接 Safari 隔离世界与 Netflix 页面主世界；协调 overlay.mount 与 bindVideoFullscreen
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const runtime = globalThis.browser ?? globalThis.chrome;
const modules = window.NetflixDualSubtitles;
const SUBTITLE_TRACK_SETTING_KEYS = new Set([
  "primaryTrackKey",
  "primaryTrackPreference",
  "primaryLanguage",
  "secondaryTrackKey",
  "secondaryTrackPreference",
  "secondaryLanguage"
]);

const DEFAULT_SETTINGS = {
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
  timingOffsetMs: 0
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  video: null,
  tracks: [],
  primaryCues: [],
  secondaryCues: [],
  loadStatus: {
    primary: { cueCount: 0, error: "" },
    secondary: { cueCount: 0, error: "" }
  },
  tickId: 0,
  refreshToken: 0,
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

    for (const [key, change] of Object.entries(changes)) {
      if (key === "episodeSettingsById") continue;
      state.settings[key] = change.newValue;
      shouldRefreshTracks ||= SUBTITLE_TRACK_SETTING_KEYS.has(key);
    }

    overlay.applySettings(state.settings);
    updateNativeSubtitleVisibility();
    if (shouldRefreshTracks) void refreshSelectedSubtitles();
    else renderForCurrentTime();
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
      settings: state.settings,
      tracks: state.tracks,
      loadStatus: state.loadStatus,
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
  state.tracks = [];
  state.primaryCues = [];
  state.secondaryCues = [];
  state.loadStatus = {
    primary: { cueCount: 0, error: "" },
    secondary: { cueCount: 0, error: "" }
  };
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
    state.video.removeEventListener("timeupdate", renderForCurrentTime);
    state.video.removeEventListener("seeked", renderForCurrentTime);
    state.video.removeEventListener("ratechange", renderForCurrentTime);
    state.video.removeEventListener("play", startFrameLoop);
    state.video.removeEventListener("pause", stopFrameLoop);
    if (typeof state.unbindVideoFullscreen === "function") {
      state.unbindVideoFullscreen();
      state.unbindVideoFullscreen = null;
    }
  }

  state.video = video;
  video.addEventListener("timeupdate", renderForCurrentTime);
  video.addEventListener("seeked", renderForCurrentTime);
  video.addEventListener("ratechange", renderForCurrentTime);
  video.addEventListener("play", startFrameLoop);
  video.addEventListener("pause", stopFrameLoop);
  const bindFs = modules.bindVideoFullscreen;
  if (typeof bindFs === "function") {
    state.unbindVideoFullscreen = bindFs(video, () => overlay.mount?.());
  }
  overlay.mount?.();
  startFrameLoop();
}

async function refreshSelectedSubtitles() {
  if (!isWatchPage()) {
    clearSubtitleState();
    return;
  }

  const token = ++state.refreshToken;
  const [primaryTrack, secondaryTrack] = [
    pickTrack(state.tracks, state.settings.primaryTrackKey, state.settings.primaryTrackPreference, state.settings.primaryLanguage),
    pickTrack(state.tracks, state.settings.secondaryTrackKey, state.settings.secondaryTrackPreference, state.settings.secondaryLanguage)
  ];

  const [primaryCues, secondaryCues] = await Promise.all([
    loadTrackCues("primary", primaryTrack),
    loadTrackCues("secondary", secondaryTrack)
  ]);

  if (token !== state.refreshToken) return;

  state.primaryCues = primaryCues;
  state.secondaryCues = secondaryCues;
  renderForCurrentTime();
}

async function loadTrackCues(role, track) {
  if (!track) {
    state.loadStatus[role] = { cueCount: 0, error: "" };
    return [];
  }

  try {
    const cues = await store.load(track);
    state.loadStatus[role] = { cueCount: cues.length, error: "" };
    return cues;
  } catch (error) {
    state.loadStatus[role] = { cueCount: 0, error: error?.message ?? String(error) };
    return [];
  }
}

function renderForCurrentTime() {
  if (!state.video || !state.settings.enabled || !isWatchPage()) {
    overlay.render();
    return;
  }

  const timeMs = state.video.currentTime * 1000 + state.settings.timingOffsetMs;
  overlay.render({
    primaryCues: dedupeActiveCues(activeAtTime(state.primaryCues, timeMs)),
    secondaryCues: dedupeActiveCues(activeAtTime(state.secondaryCues, timeMs))
  });
}

function updateNativeSubtitleVisibility() {
  const shouldHide = isWatchPage() && state.settings.enabled && state.settings.hideNativeSubtitles;
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
    hidden: isWatchPage() && state.settings.enabled && state.settings.hideNativeSubtitles
  }, window.location.origin);
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
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  if (stored.fontSize !== undefined && stored.secondaryFontSize === undefined) {
    settings.secondaryFontSize = stored.fontSize;
  }

  if (stored.verticalOffset !== undefined && stored.secondaryVerticalOffset === undefined) {
    settings.secondaryVerticalOffset = stored.verticalOffset;
  }

  return settings;
}
