/**
 * [INPUT]: 依赖浏览器 DOMParser 与字幕文本载荷
 * [OUTPUT]: 对 window.NetflixDualSubtitles 提供 parseSubtitle 函数（输出统一 {startMs,endMs,text} cue）与 collapseSubtitleLines
 * [POS]: content 的格式解析层，被 subtitleStore 调用并规范化单句换行
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

window.NetflixDualSubtitles ??= {};
window.NetflixDualSubtitles.collapseSubtitleLines = collapseSubtitleLines;
window.NetflixDualSubtitles.parseSubtitle = function parseSubtitle(text, contentType = "") {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return dedupeCues(parseJsonSubtitle(trimmed));
  }

  if (trimmed.startsWith("WEBVTT")) {
    return dedupeCues(parseWebVtt(trimmed));
  }

  if (trimmed.startsWith("<")) {
    return dedupeCues(parseTimedTextXml(trimmed));
  }

  return [];
};

function parseTimedTextXml(text) {
  const document = new DOMParser().parseFromString(text, "text/xml");
  const timing = readXmlTiming(document);

  return [...document.querySelectorAll("p")]
    .map((node) => {
      const startMs = parseTime(node.getAttribute("begin"), timing);
      const durationMs = parseTime(node.getAttribute("dur"), timing);
      const endMs = parseTime(node.getAttribute("end"), timing)
        ?? (Number.isFinite(startMs) && Number.isFinite(durationMs) ? startMs + durationMs : null);
      const cueText = cleanCueText(readCueText(node));
      return { startMs, endMs, text: cueText };
    })
    .filter(isValidCue);
}

function parseWebVtt(text) {
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timingLine = lines.find((line) => line.includes("-->"));
    if (!timingLine) continue;

    const index = lines.indexOf(timingLine);
    const [start, end] = timingLine.split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const cueText = cleanCueText(lines.slice(index + 1).join("\n").trim());
    cues.push({ startMs: parseTime(start), endMs: parseTime(end), text: cueText });
  }

  return cues.filter(isValidCue);
}

function parseJsonSubtitle(text) {
  const payload = JSON.parse(text);
  const nodes = collectObjects(payload);
  return nodes
    .map((node) => {
      const startMs = numberOrTime(node.startMs ?? node.startTime ?? node.start ?? node.begin);
      const durationMs = numberOrTime(node.durationMs ?? node.duration ?? node.dur);
      const endMs = numberOrTime(node.endMs ?? node.endTime ?? node.end)
        ?? (Number.isFinite(startMs) && Number.isFinite(durationMs) ? startMs + durationMs : null);
      const cueText = cleanCueText(readJsonCueText(node));
      return { startMs, endMs, text: cueText };
    })
    .filter(isValidCue);
}

function collectObjects(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (!Array.isArray(value)) result.push(value);
  for (const child of Object.values(value)) collectObjects(child, result);
  return result;
}

function readXmlTiming(document) {
  const root = document.documentElement;
  const tickRate = Number(root.getAttribute("ttp:tickRate") ?? root.getAttribute("tickRate") ?? 10000000);
  const frameRate = Number(root.getAttribute("ttp:frameRate") ?? root.getAttribute("frameRate") ?? 30);
  return { tickRate, frameRate };
}

function readCueText(node) {
  const lines = [];

  for (const child of node.childNodes) {
    if (child.nodeName.toLowerCase() === "br") {
      lines.push("\n");
      continue;
    }

    lines.push(child.textContent ?? "");
  }

  return lines.join("").replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function readJsonCueText(node) {
  if (Array.isArray(node.text)) return node.text.map(String).join("\n").trim();
  if (Array.isArray(node.content)) return node.content.map(String).join("\n").trim();
  return String(node.text ?? node.content ?? node.body ?? node.value ?? "").trim();
}

function parseTime(value, timing = {}) {
  if (!value) return null;
  const input = String(value).trim();
  const tickRate = Number.isFinite(timing.tickRate) ? timing.tickRate : 10000000;
  const frameRate = Number.isFinite(timing.frameRate) ? timing.frameRate : 30;

  if (/^\d+(\.\d+)?s$/.test(input)) return Math.round(Number(input.slice(0, -1)) * 1000);
  if (/^\d+(\.\d+)?ms$/.test(input)) return Math.round(Number(input.slice(0, -2)));
  if (/^\d+(\.\d+)?t$/.test(input)) return Math.round(Number(input.slice(0, -1)) * 1000 / tickRate);
  if (/^\d+(\.\d+)?f$/.test(input)) return Math.round(Number(input.slice(0, -1)) * 1000 / frameRate);
  if (/^\d+(\.\d+)?$/.test(input)) return Number(input);

  const match = input.match(/^(?:(\d+):)?(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;

  const [, hours = "0", minutes, seconds, millis = "0"] = match;
  return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000
    + Number(millis.padEnd(3, "0"));
}

function numberOrTime(value) {
  if (value == null) return null;
  return typeof value === "number" ? value : parseTime(value);
}

function isValidCue(cue) {
  return Number.isFinite(cue.startMs)
    && Number.isFinite(cue.endMs)
    && cue.endMs > cue.startMs
    && cue.text.length > 0;
}

function dedupeCues(cues) {
  const seen = new Set();
  const result = [];

  for (const cue of cues) {
    const key = `${Math.round(cue.startMs)}:${Math.round(cue.endMs)}:${normalizeCueText(cue.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cue);
  }

  return result;
}

function normalizeCueText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function cleanCueText(text) {
  const cleaned = decodeEntities(stripCueMarkup(String(text ?? "")))
    .replace(/[ \t\f\v]+/g, " ")
    .trim();
  return collapseSubtitleLines(cleaned);
}

function collapseSubtitleLines(text) {
  if (!text || typeof text !== "string") return "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "";

  const result = [lines[0]];
  const dialogueDashPattern = /^[-–—―・]\s*/;
  const cjkCharPattern = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

  for (let index = 1; index < lines.length; index++) {
    const prevLine = result[result.length - 1];
    const currLine = lines[index];

    if (dialogueDashPattern.test(currLine)) {
      result.push(currLine);
      continue;
    }

    const prevPlain = prevLine.replace(/\{[^|{}]+\|[^|{}]+\}/g, (match) => match.slice(1, match.indexOf("|")));
    const currPlain = currLine.replace(/\{[^|{}]+\|[^|{}]+\}/g, (match) => match.slice(1, match.indexOf("|")));
    const prevLastChar = prevPlain.slice(-1);
    const currFirstChar = currPlain.slice(0, 1);

    if (cjkCharPattern.test(prevLastChar) && cjkCharPattern.test(currFirstChar)) {
      result[result.length - 1] = prevLine + currLine;
    } else {
      result[result.length - 1] = prevLine + " " + currLine;
    }
  }

  return result.join("\n");
}

function stripCueMarkup(text) {
  return text
    .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, "")
    .replace(/<\/?[^>\n]+>/g, "");
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
