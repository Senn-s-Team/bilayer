/**
 * [INPUT]: 依赖 Netflix 页面主世界的 player API、JSON manifest、fetch/XMLHttpRequest 与 PerformanceResourceTiming
 * [OUTPUT]: 对外通过 window.postMessage 发布播放器字幕轨道、manifest 与 timed text 响应片段
 * [POS]: page 模块桥接器，被 content.js 注入到 Netflix 页面上下文
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

(() => {
  const SOURCE = "bilayer-bridge";
  const PROFILE_HINTS = ["webvtt-lssdh-ios8", "webvtt-lssdh", "dfxp-ls-sdh", "dfxp-ls-sdh-ios8", "simplesdh"];
  const seen = new Set();
  const originalJsonParse = JSON.parse;
  const originalJsonStringify = JSON.stringify;
  let desiredNativeHidden = false;
  let isResolvingTrackUrl = false;

  if (window.__BilayerBridgeInstalled) return;
  window.__BilayerBridgeInstalled = true;

  hookJson();
  hookFetch();
  hookXhr();
  bindContentRequests();
  scanPerformance();
  queryPlayerApi("boot");
  setInterval(() => queryPlayerApi("poll"), 2500);
  setInterval(scanPerformance, 3000);

  function hookJson() {
    JSON.parse = function parse(text, ...rest) {
      const parsed = originalJsonParse.call(this, text, ...rest);
      if (isManifestPayload(parsed)) {
        publish("json-parse:manifest", {
          source: "manifest-json-parse",
          result: parsed.result ?? parsed
        });
      }
      return parsed;
    };

    JSON.stringify = function stringify(value, ...rest) {
      if (isManifestRequest(value)) {
        addSubtitleProfileHints(value);
      }
      return originalJsonStringify.call(this, value, ...rest);
    };
  }

  function hookFetch() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") return;

    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const url = String(args[0]?.url ?? args[0] ?? response.url ?? "");
      void publishResponse(url, response.clone());
      return response;
    };
  }

  function hookXhr() {
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
      this.__dualSubtitlesUrl = String(url);
      return nativeOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function send(...args) {
      this.addEventListener("load", () => {
        const url = this.__dualSubtitlesUrl ?? "";
        const responseText = readXhrText(this);
        if (!looksRelevant(url) && !looksRelevant(responseText)) return;
        publish(url, parsePayload(responseText));
      });

      return nativeSend.call(this, ...args);
    };
  }

  async function publishResponse(url, response) {
    if (!looksRelevant(url)) return;
    if (seen.has(url)) return;
    seen.add(url);

    const text = await response.text().catch(() => "");
    if (!looksRelevant(text)) return;
    publish(url, parsePayload(text));
  }

  function scanPerformance() {
    for (const entry of performance.getEntriesByType("resource")) {
      const url = entry.name;
      if (!looksRelevant(url) || seen.has(url)) continue;
      seen.add(url);
      publish(url, { url });
    }
  }

  function publish(url, payload) {
    window.postMessage({ source: SOURCE, url, payload }, window.location.origin);
  }

  function bindContentRequests() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.data?.source !== SOURCE) return;

      if (event.data?.type === "load-subtitle") {
        void loadSubtitle(event.data.requestId, event.data.url);
        return;
      }

      if (event.data?.type === "query-player-tracks") {
        queryPlayerApi("request");
        applyNativeSubtitleVisibility();
        return;
      }

      if (event.data?.type === "resolve-track-url") {
        void resolveTrackUrl(event.data);
        return;
      }

      if (event.data?.type === "set-native-subtitles-hidden") {
        desiredNativeHidden = Boolean(event.data.hidden);
        applyNativeSubtitleVisibility();
      }
    });
  }

  async function loadSubtitle(requestId, url) {
    try {
      const response = await fetch(url, { credentials: "include" });
      const text = await response.text();

      window.postMessage({
        source: SOURCE,
        type: "load-subtitle-result",
        requestId,
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        text
      }, window.location.origin);
    } catch (error) {
      window.postMessage({
        source: SOURCE,
        type: "load-subtitle-result",
        requestId,
        ok: false,
        status: 0,
        error: error?.message ?? String(error)
      }, window.location.origin);
    }
  }

  function parsePayload(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return {};

    try {
      return JSON.parse(trimmed);
    } catch {
      return { text: trimmed.slice(0, 200000) };
    }
  }

  function queryPlayerApi(reason) {
    if (!isWatchPage()) return;

    const activePlayer = getActivePlayer();
    if (!activePlayer) return;

    const urlMap = timedTextUrlsByTrackId();
    const tracks = readTimedTextTrackList(activePlayer)
      .map((track) => serializeTrack(track, urlMap))
      .filter(Boolean);

    if (tracks.length === 0) return;

    publish(`player-api:${readMovieId(activePlayer) || "unknown"}:${reason}`, {
      source: "player-api",
      playerApi: true,
      movieId: readMovieId(activePlayer),
      activeTrack: serializeTrack(safeCall(() => activePlayer.getTimedTextTrack()), urlMap),
      tracks
    });
  }

  async function resolveTrackUrl(message) {
    const activePlayer = getActivePlayer();
    const fail = (error) => {
      post({
        type: "resolve-track-url-result",
        requestId: message.requestId,
        ok: false,
        error: error?.message ?? String(error ?? "Could not resolve subtitle URL")
      });
    };

    if (!activePlayer) {
      fail("Netflix player is not available");
      return;
    }

    const tracks = readTimedTextTrackList(activePlayer);
    const track = findTrack(tracks, message);
    if (!track) {
      fail("Subtitle track is not available in Netflix player");
      return;
    }

    const trackId = readTrackId(track);
    const existingUrl = timedTextUrlsByTrackId().get(trackId);
    if (existingUrl) {
      post({ type: "resolve-track-url-result", requestId: message.requestId, ok: true, url: existingUrl });
      return;
    }

    const previousTrack = safeCall(() => activePlayer.getTimedTextTrack());
    let shouldRevert = false;

    try {
      isResolvingTrackUrl = true;
      await Promise.resolve(activePlayer.setTimedTextTrack(track));
      shouldRevert = true;

      const url = await waitForTrackUrl(trackId, 7000);
      if (!url) {
        fail("Netflix did not expose a URL for this subtitle track");
        return;
      }

      post({ type: "resolve-track-url-result", requestId: message.requestId, ok: true, url });
      queryPlayerApi("resolved-track");
    } catch (error) {
      fail(error);
    } finally {
      isResolvingTrackUrl = false;

      if (desiredNativeHidden) {
        applyNativeSubtitleVisibility();
      } else if (shouldRevert && previousTrack) {
        try {
          await Promise.resolve(activePlayer.setTimedTextTrack(previousTrack));
        } catch {
          // Restoring the native track is best-effort.
        }
      }
    }
  }

  function applyNativeSubtitleVisibility() {
    if (!isWatchPage() || !desiredNativeHidden || isResolvingTrackUrl) return;

    const activePlayer = getActivePlayer();
    if (!activePlayer) return;

    const tracks = readTimedTextTrackList(activePlayer);
    const offTrack = tracks.find(isNoneTrack);
    const currentTrack = safeCall(() => activePlayer.getTimedTextTrack());

    if (offTrack && !isSameTrack(currentTrack, offTrack)) {
      void Promise.resolve(activePlayer.setTimedTextTrack(offTrack)).catch(() => {});
      return;
    }

    if (!offTrack && currentTrack) {
      void Promise.resolve(activePlayer.setTimedTextTrack(null)).catch(() => {});
    }
  }

  function getApi() {
    return window.netflix?.appContext?.state?.playerApp?.getAPI?.();
  }

  function getVideoPlayerApi() {
    return getApi()?.videoPlayer;
  }

  function getActivePlayer() {
    const videoPlayer = getVideoPlayerApi();
    const sessionIds = videoPlayer?.getAllPlayerSessionIds?.() ?? [];
    const sessionId = sessionIds[sessionIds.length - 1];
    if (!sessionId) return null;
    return videoPlayer.getVideoPlayerBySessionId?.(sessionId) ?? null;
  }

  function readTimedTextTrackList(activePlayer) {
    const tracks = safeCall(() => activePlayer.getTimedTextTrackList()) ?? [];
    return Array.isArray(tracks) ? tracks : [];
  }

  function readMovieId(activePlayer) {
    return safeCall(() => activePlayer.getMovieId()) ?? "";
  }

  function timedTextUrlsByTrackId() {
    const result = new Map();
    const videoPlayer = getVideoPlayerApi();
    const sessionIds = videoPlayer?.getAllPlayerSessionIds?.() ?? [];
    const sessionId = sessionIds[sessionIds.length - 1];
    const root = window.netflix?.appContext?.state?.playerApp?.getState?.()
      ?.videoPlayer?.cadmiumPlayerRepository?.playersById?.[sessionId];

    if (!root) return result;

    const seenObjects = new WeakSet();
    const stack = [{ node: root, depth: 0 }];

    while (stack.length > 0) {
      const { node, depth } = stack.pop();
      if (!node || typeof node !== "object" || depth > 22 || seenObjects.has(node)) continue;
      seenObjects.add(node);
      if (node instanceof ArrayBuffer || ArrayBuffer.isView(node)) continue;

      try {
        if (node.type === "timedtext" && typeof node.trackId === "string" && Array.isArray(node.urls)) {
          const url = node.urls.find((item) => typeof item?.url === "string")?.url;
          if (url && !result.has(node.trackId)) result.set(node.trackId, url);
        }
      } catch {
        // Some Netflix state nodes use accessors that can throw.
      }

      for (const key of Object.keys(node)) {
        const value = safeCall(() => node[key]);
        if (value && typeof value === "object") stack.push({ node: value, depth: depth + 1 });
      }
    }

    return result;
  }

  function serializeTrack(track, urlMap) {
    if (!track || typeof track !== "object") return null;

    const output = {};
    for (const key of [
      "trackId", "id", "new_track_id", "bcp47", "language", "displayName", "languageDescription",
      "rawTrackType", "trackType", "type", "isNoneTrack", "isForcedNarrative", "isForced",
      "isImageBased", "rank", "trackVariant", "downloadables", "ttDownloadables"
    ]) {
      const value = safeCall(() => track[key]);
      if (value !== undefined) output[key] = value;
    }

    const trackId = readTrackId(output);
    const url = trackId ? urlMap.get(trackId) : "";
    if (url) output.url = url;
    output.source = "player-api";
    return output;
  }

  function findTrack(tracks, message) {
    const requestedTrackId = String(message.trackId ?? "");
    const requestedLanguage = String(message.language ?? "").toLowerCase();

    return tracks.find((track) => readTrackId(track) === requestedTrackId)
      ?? tracks.find((track) => String(track.bcp47 ?? track.language ?? "").toLowerCase() === requestedLanguage)
      ?? null;
  }

  function isNoneTrack(track) {
    if (!track || typeof track !== "object") return false;
    if (track.isNoneTrack) return true;
    if (track.rank !== undefined && Number(track.rank) < 0) return true;

    const trackId = readTrackId(track);
    if (trackId.split(";")[4] === "1") return true;

    return /^(off|none|关闭|關閉|关闭字幕|關閉字幕)$/i.test(String(
      track.displayName ?? track.languageDescription ?? track.language ?? track.bcp47 ?? track.type ?? ""
    ).trim());
  }

  function isSameTrack(left, right) {
    const leftId = readTrackId(left);
    const rightId = readTrackId(right);
    if (leftId && rightId) return leftId === rightId;
    return left === right;
  }

  function readTrackId(track) {
    return String(track?.trackId ?? track?.id ?? track?.new_track_id ?? "");
  }

  function waitForTrackUrl(trackId, timeoutMs) {
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const poll = () => {
        const url = timedTextUrlsByTrackId().get(trackId);
        if (url) {
          resolve(url);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          resolve("");
          return;
        }

        setTimeout(poll, 150);
      };

      poll();
    });
  }

  function isManifestPayload(value) {
    const result = value?.result ?? value;
    return Boolean(result?.movieId && (Array.isArray(result.timedtexttracks) || Array.isArray(result.textTracks)));
  }

  function isManifestRequest(value) {
    if (!value || typeof value !== "object") return false;
    return collectObjects(value).some((object) => /manifest|licensedManifest/i.test(String(object.url ?? "")));
  }

  function addSubtitleProfileHints(value) {
    for (const object of collectObjects(value)) {
      if (Array.isArray(object.profiles)) {
        for (const profile of PROFILE_HINTS) {
          if (!object.profiles.includes(profile)) object.profiles.unshift(profile);
        }
      }

      if (object.showAllSubDubTracks != null) object.showAllSubDubTracks = true;
    }
  }

  function collectObjects(value, result = [], seenObjects = new WeakSet()) {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return result;
    seenObjects.add(value);
    if (!Array.isArray(value)) result.push(value);

    for (const child of safeObjectValues(value)) {
      collectObjects(child, result, seenObjects);
    }

    return result;
  }

  function safeObjectValues(value) {
    const values = [];

    for (const key of Object.keys(value)) {
      const child = safeCall(() => value[key]);
      if (child !== undefined) values.push(child);
    }

    return values;
  }

  function safeCall(callback) {
    try {
      return callback();
    } catch {
      return undefined;
    }
  }

  function post(message) {
    window.postMessage({ source: SOURCE, ...message }, window.location.origin);
  }

  function readXhrText(xhr) {
    try {
      if (xhr.responseType === "json") return JSON.stringify(xhr.response);
      if (xhr.responseType && xhr.responseType !== "text") return "";
      return xhr.responseText ?? "";
    } catch {
      return "";
    }
  }

  function looksRelevant(value) {
    return /timedtext|timed-text|subtitle|subtitles|closedcaptions|dfxp|webvtt|ttml|nflxvideo.*(?:text|vtt|dfxp)|[?&](?:bcp47|lang|language|locale|tlang|trackLang)=/i.test(String(value ?? ""));
  }

  function isWatchPage() {
    return /^\/watch\/[^/?#]+/.test(location.pathname);
  }
})();
