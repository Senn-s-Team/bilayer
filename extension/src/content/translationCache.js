/**
 * [INPUT]: cue 原文、完整字幕时间线与 background 翻译缓存协议
 * [OUTPUT]: 精确 occurrence 匹配、session 接受结果读写与清理
 * [POS]: 缓存语义层；所有最优对齐都强制的配对才可复用，不接触凭证
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
window.Bilayer ??= {};
window.Bilayer.createTranslationCache = function createTranslationCache({ maxWork = 2_000_000, maxDistance = 512 } = {}) {
  const sessions = new Map();
  let generation = 0;
  const isJapanese = (language) => /^(ja|jp)(?:$|[-_])/i.test(String(language ?? ""));

  function occurrenceMap(oldTexts, nextTexts) {
    const n = oldTexts.length, m = nextTexts.length;
    if (n === m && oldTexts.every((text, index) => text === nextTexts[index])) return new Map(oldTexts.map((_, index) => [index, index]));
    const inf = 0x3fffffff;
    let distance = inf;
    let v = new Map([[1, 0]]);
    for (let d = 0; d <= Math.min(maxDistance, n + m); d++) {
      if ((n + m + 1) * (2 * d + 1) > maxWork) return null;
      const next = new Map(v);
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
          ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
        let y = x - k;
        while (x < n && y < m && oldTexts[x] === nextTexts[y]) { x++; y++; }
        next.set(k, x);
        if (x >= n && y >= m) { distance = d; break; }
      }
      v = next;
      if (distance !== inf) break;
    }
    if (distance === inf) return null;
    const radius = distance, width = 2 * radius + 1, cells = (n + 1) * width;
    if (cells * 2 > maxWork) return null;
    const at = (i, j) => i * width + j - i + radius;
    const forward = new Int32Array(cells).fill(inf), backward = new Int32Array(cells).fill(inf);
    forward[at(0, 0)] = 0;
    for (let i = 0; i <= n; i++) for (let j = Math.max(0, i - radius); j <= Math.min(m, i + radius); j++) {
      const cost = forward[at(i, j)];
      if (i < n && Math.abs(i + 1 - j) <= radius) forward[at(i + 1, j)] = Math.min(forward[at(i + 1, j)], cost + 1);
      if (j < m && Math.abs(i - j - 1) <= radius) forward[at(i, j + 1)] = Math.min(forward[at(i, j + 1)], cost + 1);
      if (i < n && j < m && oldTexts[i] === nextTexts[j]) forward[at(i + 1, j + 1)] = Math.min(forward[at(i + 1, j + 1)], cost);
    }
    backward[at(n, m)] = 0;
    for (let i = n; i >= 0; i--) for (let j = Math.min(m, i + radius); j >= Math.max(0, i - radius); j--) {
      const cost = backward[at(i, j)];
      if (i > 0 && Math.abs(i - 1 - j) <= radius) backward[at(i - 1, j)] = Math.min(backward[at(i - 1, j)], cost + 1);
      if (j > 0 && Math.abs(i - j + 1) <= radius) backward[at(i, j - 1)] = Math.min(backward[at(i, j - 1)], cost + 1);
      if (i > 0 && j > 0 && oldTexts[i - 1] === nextTexts[j - 1]) backward[at(i - 1, j - 1)] = Math.min(backward[at(i - 1, j - 1)], cost);
    }
    const lcsLength = (n + m - distance) / 2;
    const viable = Array.from({ length: lcsLength }, () => []);
    for (let i = 0; i < n; i++) for (let j = Math.max(0, i - radius); j < Math.min(m, i + radius + 1); j++) {
      if (oldTexts[i] !== nextTexts[j]) continue;
      const before = forward[at(i, j)], after = backward[at(i + 1, j + 1)];
      if (before + after !== distance) continue;
      const rank = (i + j - before) / 2;
      if (Number.isInteger(rank) && viable[rank]) viable[rank].push([i, j]);
    }
    const forced = new Map();
    for (const rank of viable) if (rank.length === 1) forced.set(rank[0][0], rank[0][1]);
    return forced;
  }

  function dependenciesPreserved(forced, oldTexts, newTexts, indices) {
    const n = oldTexts.length, m = newTexts.length, required = new Set(indices);
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= n) return false;
      for (let local = Math.max(0, index - 2); local <= Math.min(n - 1, index + 2); local++) required.add(local);
      if (index <= 2) required.add(-1);
      if (n - 1 - index <= 2) required.add(n);
    }
    const mapped = [];
    for (const index of [...required].filter((value) => value >= 0 && value < n).sort((a, b) => a - b)) {
      if (!forced.has(index)) return false;
      mapped.push(forced.get(index));
    }
    if (mapped.some((value, index) => index > 0 && value !== mapped[index - 1] + 1)) return false;
    if (required.has(-1) && forced.get(0) !== 0) return false;
    if (required.has(n) && forced.get(n - 1) !== m - 1) return false;
    return true;
  }

  const keyOf = (scope) => JSON.stringify([scope.episodeId, scope.sourceLanguage, scope.trackKind, scope.targetLanguage,
    scope.semanticIntent ?? "default-v1", scope.translationSemantics ?? "cue-v1"]);
  function sourceId(source) { return JSON.stringify([source.episodeId, source.sourceLanguage, source.trackKind, source.cues.map((cue) => cue.text)]); }
  function remember(scope, source) {
    const key = JSON.stringify([scope.episodeId, scope.sourceLanguage, scope.trackKind]);
    const list = sessions.get(key) ?? [];
    let snapshot = list.find((entry) => entry.sourceId === source.sourceId);
    if (!snapshot) { snapshot = { sourceId: source.sourceId, texts: source.texts.slice(), batches: [], episodeId: scope.episodeId,
      sourceLanguage: scope.sourceLanguage, trackKind: scope.trackKind, targets: {} }; list.push(snapshot); sessions.set(key, list); }
    const targetBatches = snapshot.targets[keyOf(scope)] ??= [];
    for (const batch of source.batches ?? []) {
      const prior = targetBatches.findIndex((entry) => entry.itemIndices?.join(",") === batch.itemIndices?.join(",")
        && entry.beforeIndices?.join(",") === batch.beforeIndices?.join(",") && entry.afterIndices?.join(",") === batch.afterIndices?.join(","));
      if (prior >= 0) targetBatches.splice(prior, 1);
      targetBatches.unshift({ ...batch, items: batch.items.map((item) => ({ ...item })) });
    }
    return snapshot;
  }
  function updateAnnotations(scope, sourceIdValue, updates) {
    const key = JSON.stringify([scope.episodeId, scope.sourceLanguage, scope.trackKind]);
    const snapshot = (sessions.get(key) ?? []).find((entry) => entry.sourceId === sourceIdValue);
    const batches = snapshot?.targets[keyOf(scope)];
    if (!batches) return false;
    let changed = false;
    for (const update of updates) {
      const batch = batches.find((entry) => entry.itemIndices?.includes(update.index));
      const itemOffset = batch?.itemIndices.indexOf(update.index) ?? -1;
      if (itemOffset < 0) continue;
      const item = batch.items[itemOffset];
      const side = update.annotationSide ?? batch.annotationSide ?? "source";
      const anchor = side === "target" ? item.translatedText : item.sourceText;
      if (item.translatedText !== update.acceptedText || anchor !== update.annotationText) continue;
      if (update.readings) item.readings = update.readings;
      if (update.ruby) item.ruby = update.ruby;
      item.annotationText = update.annotationText;
      batch.annotationSide = side;
      batch.annotationSemantics = "reading-v1";
      changed = true;
    }
    return changed;
  }
  function snapshotsFor(scope) {
    const key = JSON.stringify([scope.episodeId, scope.sourceLanguage, scope.trackKind]);
    return (sessions.get(key) ?? []).map((snapshot) => ({ sourceId: snapshot.sourceId, texts: snapshot.texts.slice(),
      sourceLanguage: snapshot.sourceLanguage, trackKind: snapshot.trackKind,
      batches: (snapshot.targets[keyOf(scope)] ?? []).map((batch) => ({ ...batch, items: batch.items.map((item) => ({ ...item })) })) }));
  }
  function read(scope, texts, snapshots = [], { annotationRequired = false, annotationSide = "source" } = {}) {
    const accepted = new Map();
    const snapshotsForCurrentScope = snapshotsFor(scope).reverse();
    for (const snapshot of [...snapshotsForCurrentScope, ...snapshots]) {
      if (!snapshot || !Array.isArray(snapshot.texts) || snapshot.sourceLanguage !== scope.sourceLanguage || snapshot.trackKind !== scope.trackKind) continue;
      const forced = occurrenceMap(snapshot.texts, texts);
      if (!forced) continue;
      for (const batch of snapshot.batches ?? []) {
        if (batch.targetLanguage !== scope.targetLanguage || (batch.semanticIntent ?? "default-v1") !== (scope.semanticIntent ?? "default-v1")
            || (batch.translationSemantics ?? "cue-v1") !== (scope.translationSemantics ?? "cue-v1")) continue;
        const items = batch.itemIndices ?? [];
        const dependencies = [...(batch.beforeIndices ?? []), ...items, ...(batch.afterIndices ?? [])];
        if (!dependenciesPreserved(forced, snapshot.texts, texts, dependencies)) continue;
        if (!Array.isArray(batch.items) || batch.items.length !== items.length || items.some((index, offset) => !forced.has(index)
            || texts[forced.get(index)] !== snapshot.texts[index] || typeof batch.items[offset]?.text !== "string" || !batch.items[offset].text.trim())) continue;
        for (let offset = 0; offset < items.length; offset++) {
          const oldIndex = items[offset], newIndex = forced.get(oldIndex), item = batch.items[offset];
          const translatedText = item.translatedText ?? item.text;
          const annotationSide = batch.annotationSide ?? (isJapanese(scope.targetLanguage) ? "target" : "source");
          const annotationText = item.annotationText ?? (annotationSide === "target" ? translatedText : item.sourceText);
          const expectedAnnotation = annotationSide === "target" ? translatedText : texts[newIndex];
          const annotationValid = batch.annotationSemantics === "reading-v1" && annotationText === expectedAnnotation;
          const readingsValid = annotationValid && item.readings && typeof item.readings === "object" && !Array.isArray(item.readings)
            && Object.keys(item.readings).length > 0 && Object.entries(item.readings).every(([surface, reading]) =>
              surface && typeof reading === "string" && reading && expectedAnnotation.includes(surface));
          const entry = { text: translatedText, sourceText: texts[newIndex], translatedText,
            ...(readingsValid ? { readings: item.readings } : {}), ...(annotationValid && item.ruby ? { ruby: item.ruby } : {}) };
          const prior = accepted.get(newIndex);
          if (!prior) accepted.set(newIndex, entry);
          else if (prior.text === entry.text && !prior.readings && !prior.ruby && (entry.readings || entry.ruby)) accepted.set(newIndex, entry);
        }
      }
    }
    const kanaOnly = (text) => /^[\u3040-\u309f\u30a0-\u30ff\u30fc\s。、，．！？・「」『』（）()［］【】]+$/.test(text);
    const annotationMissingIndices = annotationRequired ? [...accepted].filter(([_index, item]) => {
      const annotatedText = annotationSide === "target" ? item.translatedText : item.sourceText;
      return !kanaOnly(annotatedText) && !item.readings && !item.ruby;
    }).map(([index]) => index) : [];
    const annotationMissing = annotationMissingIndices.length;
    return { accepted, annotationMissing, annotationMissingIndices };
  }
  function clear(episodeId = "") {
    generation++;
    if (!episodeId) sessions.clear();
    else for (const [key, values] of sessions) {
      const retained = values.filter((snapshot) => snapshot.episodeId !== episodeId);
      if (retained.length) sessions.set(key, retained); else sessions.delete(key);
    }
    return generation;
  }
  return { occurrenceMap, sourceId, remember, updateAnnotations, snapshotsFor, read, clear, generation: () => generation };
};
