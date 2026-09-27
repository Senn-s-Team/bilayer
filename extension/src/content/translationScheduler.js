/**
 * [INPUT]: 依赖已解析的 Netflix cue 时间轴与注入的批量翻译请求
 * [OUTPUT]: 对 window.Bilayer 提供 createTranslationScheduler，支持当前句优先、预取双上限、可调邻句、预算与逐请求耗时日志，并输出日文源字幕 ruby 注音回填能力 annotateSource
 * [POS]: content 的纯调度层，不接触密钥、提供商协议或字幕原文日志
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
window.Bilayer ??= {};
window.Bilayer.createTranslationScheduler = function createTranslationScheduler({ translate, onUpdate }) {
  const MAX_REQUESTS = 80;
  const MAX_CHARACTERS = 40000;
  const MAX_BATCH_ITEMS = 12;
  const MAX_BATCH_CHARACTERS = 600;
  let cues = [];
  let groups = [];
  let identity = "";
  let budgetKey = "";
  let sourceLanguage = "";
  let targetLanguage = "";
  let generation = 0;
  let requests = 0;
  let sentCharacters = 0;
  let inFlight = 0;
  let positionMs = 0;
  let leadMs = 60000;
  let prefetchCount = 10;
  let contextCount = 2;
  let japaneseRuby = true;
  let urgentSeek = false;
  let failure = "";
  let translations = new Map();
  let readingsMap = new Map();
  let rubies = new Map();
  let cueIds = new WeakMap();
  let pending = new Set();
  let failed = new Set();
  let logs = [];

  function addLog(event, message, details = {}) {
    logs.push({ at: Date.now(), event, message, ...details });
  }

  const notify = () => onUpdate?.(status());

  function status() {
    return {
      phase: !identity ? "off" : failure ? "error" : inFlight ? "translating" : translations.size ? "ready" : "waiting",
      count: translations.size,
      error: failure,
      requests,
      sentCharacters,
      logs: logs.map((entry) => ({ ...entry }))
    };
  }

  function setSource(source) {
    prefetchCount = Number.isInteger(source.prefetchCount) && source.prefetchCount >= 0 && source.prefetchCount <= 50
      ? source.prefetchCount : 10;
    contextCount = Number.isInteger(source.contextCount) && source.contextCount >= 0 && source.contextCount <= 4
      ? source.contextCount : 2;
    japaneseRuby = source.japaneseRuby !== false;
    if (source.identity === identity && source.cues === cues) return;
    const cancelledRequests = inFlight;
    generation++;
    if (source.budgetKey !== budgetKey) {
      logs = [];
      budgetKey = source.budgetKey;
      requests = 0;
      sentCharacters = 0;
    }
    identity = source.identity;
    cues = source.cues;
    sourceLanguage = source.sourceLanguage;
    targetLanguage = source.targetLanguage;
    cueIds = new WeakMap(cues.map((cue, index) => [cue, String(index)]));
    groups = buildGroups(cues);
    translations = new Map();
    readingsMap = new Map();
    rubies = new Map();
    failed = new Set();
    inFlight = 0;
    failure = "";
    urgentSeek = false;
    addLog("source_changed", "翻译来源已切换", { cancelledRequests });
    addLog("source_ready", "字幕翻译源已准备", { cueCount: cues.length, sourceLanguage, targetLanguage });
    notify();
  }

  function clear() {
    generation++;
    identity = "";
    cues = [];
    groups = [];
    japaneseRuby = true;
    cueIds = new WeakMap();
    translations.clear();
    readingsMap.clear();
    rubies.clear();
    failed.clear();
    inFlight = 0;
    failure = "";
    logs = [];
    notify();
  }

  function observe(timeMs, rate = 1, seek = false) {
    if (!identity || groups.length === 0) return;
    positionMs = Math.max(0, timeMs);
    leadMs = Math.min(120000, 60000 * Math.max(1, rate));
    urgentSeek ||= seek;
    pump();
  }

  function pump() {
    if (!identity) return;
    const start = groups.findIndex((group) => group.endMs >= positionMs);
    if (start < 0) return;
    const last = Math.min(groups.length - 1, start + prefetchCount);
    const maxConcurrent = urgentSeek ? 2 : 1;
    while (inFlight < maxConcurrent) {
      let first = -1;
      for (let index = start; index <= last && groups[index].startMs <= positionMs + leadMs; index++) {
        if (!isDone(groups[index])) { first = index; break; }
      }
      if (first < 0) break;
      const items = [];
      const selected = [];
      let characters = 0;
      for (let index = first; index <= last && groups[index].startMs <= positionMs + leadMs; index++) {
        const group = groups[index];
        if (isDone(group)) continue;
        if (selected.length && (items.length + group.ids.length > MAX_BATCH_ITEMS || characters + group.characters > MAX_BATCH_CHARACTERS)) break;
        selected.push(group);
        for (const id of group.ids) {
          const text = cues[Number(id)].text;
          items.push({ id, text });
          characters += text.length;
        }
        // 首句单独发出，避免播放开始时等待整个预取窗口。
        if (first === start) break;
      }
      const before = contextCount === 0 ? [] : groups.slice(Math.max(0, first - contextCount), first)
        .flatMap((group) => group.ids).slice(-contextCount).map((id) => cues[Number(id)].text);
      const lastGroup = groups.indexOf(selected.at(-1));
      const after = contextCount === 0 ? [] : groups.slice(lastGroup + 1, lastGroup + 1 + contextCount)
        .flatMap((group) => group.ids).slice(0, contextCount).map((id) => cues[Number(id)].text);
      const totalCharacters = characters + before.join("").length + after.join("").length;
      if (requests >= MAX_REQUESTS || sentCharacters + totalCharacters > MAX_CHARACTERS) {
        failure = "budget_exceeded";
        addLog("budget_exceeded", "本集翻译预算已用尽", { requests, sentCharacters });
        notify();
        break;
      }
      const requestNumber = ++requests;
      sentCharacters += totalCharacters;
      inFlight++;
      for (const group of selected) pending.add(group);
      const requestGeneration = generation;
      const batch = { sourceLanguage, targetLanguage, items, contextBefore: before, contextAfter: after, japaneseRuby };
      const requestStartedAt = Date.now();
      addLog("request_sent", "正在请求字幕翻译", { request: requestNumber, cueIds: items.map(({ id }) => id), characters: totalCharacters });
      notify();
      void Promise.resolve().then(() => translate(batch)).then((response) => {
        if (requestGeneration !== generation) return;
        if (Array.isArray(response?.trace)) {
          for (const step of response.trace) addLog("provider_stage", "LLM 请求链路", { ...step, request: requestNumber });
        }
        const received = response?.ok ? response.items : null;
        const byId = new Map(Array.isArray(received) ? received.map((entry) => [entry.id, entry.text]) : []);
        const byReadings = new Map(Array.isArray(received)
          ? received.filter((entry) => entry.readings && typeof entry.readings === "object").map((entry) => [entry.id, entry.readings])
          : []);
        const byRuby = new Map(Array.isArray(received)
          ? received.filter((entry) => typeof entry.ruby === "string").map((entry) => [entry.id, entry.ruby])
          : []);
        const valid = Array.isArray(received) && received.length === items.length
          && byId.size === items.length && items.every(({ id }) => typeof byId.get(id) === "string" && byId.get(id).trim());
        if (valid) {
          for (const { id } of items) {
            translations.set(id, collapseLines(byId.get(id)));
            if (byReadings.has(id)) readingsMap.set(id, byReadings.get(id));
            if (byRuby.has(id)) rubies.set(id, collapseLines(byRuby.get(id)));
          }
          addLog("request_succeeded", "字幕翻译完成", { request: requestNumber, cueIds: items.map(({ id }) => id), durationMs: Date.now() - requestStartedAt });
        } else {
          for (const group of selected) failed.add(group);
          failure = response?.errorCode ?? "invalid_response";
          addLog("request_failed", "字幕翻译失败", { request: requestNumber, cueIds: items.map(({ id }) => id), error: failure, durationMs: Date.now() - requestStartedAt });
        }
      }).catch(() => {
        if (requestGeneration !== generation) return;
        for (const group of selected) failed.add(group);
        failure = "unavailable";
        addLog("request_failed", "字幕翻译请求异常", { request: requestNumber, cueIds: items.map(({ id }) => id), error: failure, durationMs: Date.now() - requestStartedAt });
      }).finally(() => {
        if (requestGeneration !== generation) return;
        inFlight--;
        for (const group of selected) pending.delete(group);
        urgentSeek = false;
        notify();
        pump();
      });
      if (first === start) break;
    }
  }

  function isDone(group) {
    return pending.has(group) || failed.has(group) || group.ids.every((id) => translations.has(id));
  }

  function readyAt(timeMs) {
    const group = groups.find((entry) => entry.endMs >= timeMs);
    return !group || group.ids.every((id) => translations.has(id));
  }

  const isJp = (lang) => /^(ja|jp)($|[-_])/i.test(String(lang ?? "").trim());

  function translatedFor(activeCues) {
    const result = [];
    const targetIsJp = isJp(targetLanguage);
    for (const cue of activeCues) {
      const id = cueIds.get(cue);
      const text = id !== undefined ? translations.get(id) : undefined;
      const readings = (japaneseRuby && targetIsJp && id !== undefined) ? readingsMap.get(id) : undefined;
      const ruby = (japaneseRuby && targetIsJp && id !== undefined) ? rubies.get(id) : undefined;
      if (text !== undefined) {
        result.push({
          startMs: cue.startMs,
          endMs: cue.endMs,
          text,
          ...(readings ? { readings } : {}),
          ...(ruby ? { ruby } : {})
        });
      }
    }
    return result;
  }

  function annotateSource(activeCues) {
    const sourceIsJp = isJp(sourceLanguage);
    if (!japaneseRuby || !sourceIsJp || (readingsMap.size === 0 && rubies.size === 0) || !Array.isArray(activeCues)) {
      return activeCues;
    }
    return activeCues.map((cue) => {
      let id = cueIds.get(cue);
      if (id === undefined) {
        const found = cues.findIndex((candidate) => Math.abs(candidate.startMs - cue.startMs) < 200 && candidate.text === cue.text);
        if (found >= 0) id = String(found);
      }
      const readings = id !== undefined ? readingsMap.get(id) : undefined;
      const ruby = id !== undefined ? rubies.get(id) : undefined;
      if (readings || ruby) {
        return {
          ...cue,
          ...(readings ? { readings } : {}),
          ...(ruby ? { ruby } : {})
        };
      }
      return cue;
    });
  }

  return { setSource, clear, observe, readyAt, translatedFor, annotateSource, status };
};

function collapseLines(text) {
  const helper = window.Bilayer?.collapseSubtitleLines;
  if (typeof helper === "function") return helper(text);
  return collapseSubtitleLinesLocal(text);
}

function collapseSubtitleLinesLocal(text) {
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

function buildGroups(cues) {
  const groups = [];
  const ordered = cues.map((cue, index) => ({ cue, index }))
    .sort((left, right) => left.cue.startMs - right.cue.startMs || left.index - right.index);
  for (let position = 0; position < ordered.length; position++) {
    const { cue, index } = ordered[position];
    const previous = ordered[position - 1]?.cue;
    const group = groups.at(-1);
    const continues = group && previous && cue.startMs >= previous.endMs
      && cue.startMs - previous.endMs < 1000 && group.ids.length < 3
      && group.characters + cue.text.length < 240 && !/[.!?。？！]$/.test(previous.text.trim());
    if (continues) {
      group.ids.push(String(index));
      group.endMs = cue.endMs;
      group.characters += cue.text.length;
    } else {
      groups.push({ ids: [String(index)], startMs: cue.startMs, endMs: cue.endMs, characters: cue.text.length });
    }
  }
  return groups;
}
