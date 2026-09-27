/**
 * [INPUT]: 依赖 Netflix 页面桥接层传入的 player API、manifest 与 timed text 响应片段
 * [OUTPUT]: 对 window.Bilayer 提供 normalizeTracks 函数，将私有结构转换成稳定 Track
 * [POS]: content 的 Netflix 边界适配器，隔离页面私有字段变化
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const FORMAT_PRIORITY = [
  /webvtt/i,
  /dfxp/i,
  /ttml/i,
  /xml/i,
  /simplesdh/i
];

const OFF_PATTERN = /^(off|none|关闭|關閉|关闭字幕|關閉字幕|字幕关闭|字幕關閉)$/i;
const NON_SUBTITLE_FORMAT_PATTERN = /image|jpeg|jpg|png|svg|stpp|itt/i;
const FORCED_PATTERN = /forced|narrative/i;

window.Bilayer ??= {};
window.Bilayer.normalizeTracks = function normalizeTracks(payload) {
  const candidates = collectObjects(payload);
  const tracks = candidates.flatMap(toTracks).filter(isPlayableTrack);
  const byKey = new Map();

  for (const track of tracks) {
    const existing = byKey.get(track.key);
    if (!existing || track.priority < existing.priority) {
      byKey.set(track.key, track);
    }
  }

  return [...byKey.values()]
    .map(({ priority, ...track }) => track)
    .sort((left, right) => left.label.localeCompare(right.label));
};

function collectObjects(value, result = []) {
  if (!value || typeof value !== "object") return result;

  if (!Array.isArray(value)) {
    result.push(value);
  }

  for (const child of Object.values(value)) {
    collectObjects(child, result);
  }

  return result;
}

function toTracks(object) {
  const url = readPrimaryUrl(object);
  const language = readLanguage(object) || readLanguageFromUrl(url);
  const label = decorateLabel(readLabel(object, language), object);
  const type = readType(object);
  const trackId = readTrackId(object);
  if (!language || !label || isOffTrack({ ...object, label, language, type })) return [];

  return readDownloadables(object).map((downloadable) => {
    const normalizedLabel = normalizeLabel(label);
    return {
      key: `${language}:${normalizedLabel}:${type}:${trackId || downloadable.url}`,
      label,
      language,
      type,
      url: downloadable.url,
      format: downloadable.format,
      trackId,
      needsResolution: downloadable.needsResolution,
      source: object.source ?? payloadSource(object),
      priority: downloadable.priority
    };
  });
}

function readLanguage(object) {
  const raw = object.bcp47
    ?? object.language
    ?? object.languageCode
    ?? object.locale
    ?? object.ttDownloadables?.bcp47
    ?? "";

  return String(raw).trim();
}

function readLabel(object, fallback) {
  return String(
    object.languageDescription
      ?? object.displayName
      ?? object.label
      ?? object.name
      ?? object.language
      ?? object.bcp47
      ?? fallback
      ?? ""
  ).trim();
}

function decorateLabel(label, object) {
  const parts = [String(label ?? "").trim()];
  const rawTrackType = String(object.rawTrackType ?? object.trackType ?? object.type ?? "").toLowerCase();
  const variant = String(object.trackVariant ?? "").trim();

  if (/closedcaptions|closecaptions|cc/.test(rawTrackType) && !/\bcc\b/i.test(parts[0])) {
    parts.push("[CC]");
  } else if (/subtitle/.test(rawTrackType) && !/\bsub\b/i.test(parts[0])) {
    parts.push("[SUB]");
  }

  if (variant && !parts.join(" ").toLowerCase().includes(variant.toLowerCase())) {
    parts.push(`[${variant}]`);
  }

  return parts.filter(Boolean).join(" ");
}

function readType(object) {
  return String(object.rawTrackType ?? object.trackType ?? object.type ?? "subtitle").trim();
}

function readTrackId(object) {
  return String(object.trackId ?? object.id ?? object.new_track_id ?? object.downloadableId ?? "").trim();
}

function readDownloadables(object) {
  const result = [];

  for (const direct of [object.url, object.downloadUrl]) {
    if (direct) result.push(toDownloadable("direct", direct));
  }

  if (object.downloadUrls && typeof object.downloadUrls === "object") {
    for (const value of Object.values(object.downloadUrls)) {
      if (value) result.push(toDownloadable("downloadUrls", value));
    }
  }

  const downloadables = object.downloadables ?? object.ttDownloadables;
  if (downloadables && typeof downloadables === "object") {
    for (const [format, value] of Object.entries(downloadables)) {
      if (value?.downloadUrls && typeof value.downloadUrls === "object") {
        for (const url of Object.values(value.downloadUrls)) {
          if (url) result.push(toDownloadable(format, url));
        }
      }

      if (Array.isArray(value?.urls)) {
        for (const item of value.urls) {
          if (item?.url) result.push(toDownloadable(format, item.url));
        }
      }
    }
  }

  if (result.length === 0 && object.source === "player-api" && readTrackId(object)) {
    result.push({
      format: "player-api-lazy",
      url: `netflix-track:${encodeURIComponent(readTrackId(object))}`,
      needsResolution: true,
      priority: FORMAT_PRIORITY.length + 1
    });
  }

  return result
    .filter((item) => item.url && isSubtitleFormat(item.format, item.url))
    .sort((left, right) => left.priority - right.priority);
}

function readPrimaryUrl(object) {
  return String(object.url ?? object.downloadUrl ?? "").trim();
}

function toDownloadable(format, url) {
  return {
    format: String(format),
    url: String(url),
    priority: formatPriority(format, url)
  };
}

function isPlayableTrack(track) {
  return Boolean(track.url && track.language && !isOffTrack(track));
}

function isOffTrack(track) {
  if (track.isNoneTrack) return true;
  if (track.isImageBased) return true;
  if (track.rank !== undefined && Number(track.rank) < 0) return true;
  if (track.isForcedNarrative || track.isForced) return true;

  const trackId = readTrackId(track);
  if (trackId) {
    const parts = trackId.split(";");
    if (parts[4] === "1") return true;
  }

  return [track.label, track.language, track.type, track.displayName, track.languageDescription]
    .some((value) => OFF_PATTERN.test(String(value ?? "").trim()) || FORCED_PATTERN.test(String(value ?? "")));
}

function isSubtitleFormat(format, url) {
  const value = `${format} ${url}`;
  if (NON_SUBTITLE_FORMAT_PATTERN.test(value)) return false;
  return true;
}

function formatPriority(format, url) {
  const value = `${format} ${url}`;
  const index = FORMAT_PRIORITY.findIndex((pattern) => pattern.test(value));
  return index === -1 ? FORMAT_PRIORITY.length : index;
}

function normalizeLabel(label) {
  return String(label).trim().toLowerCase().replace(/\s+/g, " ");
}

function readLanguageFromUrl(url) {
  if (!url) return "";

  try {
    const parsed = new URL(url, location.href);

    for (const key of ["bcp47", "lang", "language", "locale", "tlang", "trackLang"]) {
      const value = parsed.searchParams.get(key);
      if (value && !OFF_PATTERN.test(value)) return value;
    }

    const pathMatch = parsed.pathname.match(/(?:^|[/_-])([a-z]{2,3}(?:-[A-Za-z0-9]+){0,2})(?:[._/-]|$)/);
    return pathMatch?.[1] ?? "";
  } catch {
    return "";
  }
}

function payloadSource(object) {
  if (object.playerApi) return "player-api";
  if (object.movieId && (object.timedtexttracks || object.textTracks)) return "manifest";
  return "network";
}
