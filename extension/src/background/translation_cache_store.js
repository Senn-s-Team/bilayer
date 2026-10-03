/*
 * [INPUT]: 依赖原生 IndexedDB、TextEncoder 与 crypto.subtle；输入 worker 校验过的来源时间线和译文批次
 * [OUTPUT]: globalThis.BilayerTranslationCacheStore：来源注册、成功批次与锚定注音提交、事务化过期/LRU/容量管理、兼容读取与独立 episode/global generation 清理
 * [POS]: background 本地持久层；已接受译文按提交新到旧返回，只存无凭证 provenance；clear generation 阻止在途旧请求重建数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
(() => {
  "use strict";
  const DB_NAME = "bilayer-background";
  const DB_VERSION = 2;
  const SOURCES = "cacheSources";
  const BATCHES = "cacheBatches";
  const META = "meta";
  const encoder = new TextEncoder();
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("storage_idb_request"));
  });
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("storage_idb_transaction"));
  });
  let opening;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("storage_unavailable")); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SOURCES)) db.createObjectStore(SOURCES, { keyPath: "sourceId" });
        let store;
        if (!db.objectStoreNames.contains(BATCHES)) store = db.createObjectStore(BATCHES, { keyPath: "id" });
        else store = request.transaction.objectStore(BATCHES);
        if (!store.indexNames.contains("sourceId")) store.createIndex("sourceId", "sourceId", { unique: false });
        if (!db.objectStoreNames.contains("diagnosticSummaries")) db.createObjectStore("diagnosticSummaries", { keyPath: "id" });
        if (!db.objectStoreNames.contains("diagnosticPayloads")) db.createObjectStore("diagnosticPayloads", { keyPath: "id" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("storage_unavailable"));
      request.onblocked = () => reject(new Error("storage_blocked"));
    }).catch((error) => { opening = null; throw error; });
    return opening;
  }
  const clone = (value) => structuredClone(value);
  const getMeta = async (store, key, fallback) => (await requestResult(store.get(key)))?.value ?? fallback;
  const bytesOf = (value) => encoder.encode(JSON.stringify(value)).byteLength;
  const sourceKey = (input) => JSON.stringify([input.episodeId, input.sourceLanguage, input.trackKind, input.texts]);
  async function hash(value) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function validSource(input) {
    return typeof input?.episodeId === "string" && input.episodeId.length > 0 &&
      typeof input.sourceLanguage === "string" && typeof input.trackKind === "string" &&
      Array.isArray(input.texts) && input.texts.length > 0 && input.texts.every((text) => typeof text === "string");
  }
  async function registerSource(input, mode, settings = {}) {
    if (!validSource(input)) return { ok: false, errorCode: "configuration" };
    const sourceId = await hash(sourceKey(input));
    if (mode !== "local") return { ok: true, sourceId, persisted: false };
    const db = await open();
    const tx = db.transaction(SOURCES, "readwrite");
    const complete = done(tx);
    const store = tx.objectStore(SOURCES);
    let inserted = false;
    const existing = store.get(sourceId);
    existing.onsuccess = () => {
      if (existing.result) {
        existing.result.lastUsedAt = Date.now();
        existing.result.inFlightUntil = Date.now() + 60000;
        store.put(existing.result);
        return;
      }
      const source = { sourceId, episodeId: input.episodeId, sourceLanguage: input.sourceLanguage, trackKind: input.trackKind,
        texts: clone(input.texts), createdAt: Date.now(), lastUsedAt: Date.now(), inFlightUntil: Date.now() + 60000 };
      source.bytes = bytesOf(source);
      if (settings.maxBytes > 0 && source.bytes > settings.maxBytes) { inserted = false; return; }
      store.put(source);
      inserted = true;
    };
    await complete;
    if (inserted || settings.maxBytes) await enforceCap(db, settings.maxBytes ?? 0, new Set([sourceId]));
    return { ok: true, sourceId, persisted: inserted || Boolean(await source(sourceId)) };
  }
  function compatible(batch, query) {
    const intent = String(query.semanticIntent ?? "").trim() || "default-v1";
    return batch.targetLanguage === query.targetLanguage && batch.semanticIntent === intent &&
      batch.translationSemantics === "cue-v1";
  }
  async function read(query, settings = {}) {
    const db = await open();
    await prune(db, settings);
    const cutoff = settings.retentionDays ? Date.now() - settings.retentionDays * 86400000 : 0;
    const snapshot = await readRows(db, cutoff);
    const selectedSources = snapshot.sources.filter((source) => source.episodeId === query.episodeId &&
      source.sourceLanguage === query.sourceLanguage && source.trackKind === query.trackKind);
    const snapshots = [];
    for (const source of selectedSources) {
      const matching = snapshot.batches.filter((batch) => batch.sourceId === source.sourceId && compatible(batch, query))
        .sort((a, b) => b.createdAt - a.createdAt || Number(b.id.slice(6)) - Number(a.id.slice(6)))
        .map(({ id, itemIndices, beforeIndices, afterIndices, items, targetLanguage, semanticIntent,
          translationSemantics, annotationSemantics, annotationSide, provenance, createdAt }) => ({ id, itemIndices,
          beforeIndices, afterIndices, items, targetLanguage, semanticIntent, translationSemantics,
          annotationSemantics, annotationSide, provenance, createdAt }));
      if (!matching.length) continue;
      snapshots.push({ sourceId: source.sourceId, episodeId: source.episodeId, sourceLanguage: source.sourceLanguage, trackKind: source.trackKind, texts: source.texts, batches: matching });
    }
    const usedSourceIds = new Set(snapshots.map((item) => item.sourceId));
    await touchSources(db, usedSourceIds);
    return { ok: true, snapshots };
  }
  async function readRows(db, cutoff) {
    const tx = db.transaction([SOURCES, BATCHES], "readonly");
    const donePromise = done(tx);
    const sourceRequest = tx.objectStore(SOURCES).getAll();
    const batchRequest = tx.objectStore(BATCHES).getAll();
    const rows = await new Promise((resolve, reject) => {
      let remaining = 2;
      const finish = () => { if (--remaining === 0) resolve({ sources: sourceRequest.result, batches: batchRequest.result }); };
      sourceRequest.onsuccess = batchRequest.onsuccess = finish;
      sourceRequest.onerror = batchRequest.onerror = () => reject(new Error("storage_idb_request"));
    });
    await donePromise;
    return { sources: rows.sources, batches: rows.batches.filter((row) => row.createdAt >= cutoff) };
  }
  async function touchSources(db, sourceIds) {
    if (!sourceIds.size) return;
    const tx = db.transaction(SOURCES, "readwrite");
    const complete = done(tx);
    const store = tx.objectStore(SOURCES);
    for (const sourceId of sourceIds) {
      const request = store.get(sourceId);
      request.onsuccess = () => { if (request.result) { request.result.lastUsedAt = Date.now(); store.put(request.result); } };
    }
    await complete;
  }
  async function usage(db) {
    const tx = db.transaction([SOURCES, BATCHES], "readonly");
    const donePromise = done(tx);
    const sourceRequest = tx.objectStore(SOURCES).getAll();
    const batchRequest = tx.objectStore(BATCHES).getAll();
    const rows = await new Promise((resolve, reject) => {
      let remaining = 2;
      const finish = () => { if (--remaining === 0) resolve({ sources: sourceRequest.result, batches: batchRequest.result }); };
      sourceRequest.onsuccess = batchRequest.onsuccess = finish;
      sourceRequest.onerror = batchRequest.onerror = () => reject(new Error("storage_idb_request"));
    });
    await donePromise;
    return { sources: rows.sources, batches: rows.batches,
      bytes: rows.sources.reduce((sum, row) => sum + row.bytes, 0) + rows.batches.reduce((sum, row) => sum + row.bytes, 0) };
  }
  async function stats(episodeId, settings = {}) {
    const db = await open();
    await prune(db, settings);
    const { sources, batches, bytes } = await usage(db);
    const episodes = new Set(sources.map((source) => source.episodeId));
    const currentSources = episodeId == null ? [] : sources.filter((source) => source.episodeId === episodeId);
    const currentIds = new Set(currentSources.map((source) => source.sourceId));
    const currentBatches = batches.filter((batch) => currentIds.has(batch.sourceId));
    const subtitleCount = (rows) => new Set(rows.flatMap((batch) => batch.itemIndices.map((index) => JSON.stringify([
      batch.sourceId, index, batch.targetLanguage, batch.semanticIntent, batch.translationSemantics
    ])))).size;
    return { ok: true, bytes, subtitleCount: subtitleCount(batches), episodeCount: episodes.size,
      currentEpisodeBytes: currentSources.reduce((sum, source) => sum + source.bytes, 0) + currentBatches.reduce((sum, batch) => sum + batch.bytes, 0),
      currentEpisodeSubtitleCount: subtitleCount(currentBatches), storageError: null };
  }
  async function prune(db, settings) {
    const cutoff = settings.retentionDays ? Date.now() - settings.retentionDays * 86400000 : 0;
    const tx = db.transaction([SOURCES, BATCHES], "readwrite");
    const complete = done(tx);
    const sources = tx.objectStore(SOURCES), batches = tx.objectStore(BATCHES);
    const sourceRequest = sources.getAll(), batchRequest = batches.getAll();
    let remaining = 2;
    const expire = () => {
      if (--remaining !== 0) return;
      const liveSourceIds = new Set();
      for (const batch of batchRequest.result) {
        if (batch.createdAt < cutoff) batches.delete(batch.id);
        else liveSourceIds.add(batch.sourceId);
      }
      for (const source of sourceRequest.result) {
        if (!liveSourceIds.has(source.sourceId) && source.createdAt < cutoff && (source.inFlightUntil ?? 0) <= Date.now()) sources.delete(source.sourceId);
      }
    };
    sourceRequest.onsuccess = batchRequest.onsuccess = expire;
    await complete;
    await enforceCap(db, settings.maxBytes ?? 0);
  }
  async function enforceCap(db, maxBytes, protectedSourceIds = new Set()) {
    if (!maxBytes) return;
    const tx = db.transaction([SOURCES, BATCHES], "readwrite");
    const complete = done(tx);
    const sources = tx.objectStore(SOURCES), batches = tx.objectStore(BATCHES);
    const sourceRequest = sources.getAll(), batchRequest = batches.getAll();
    let remaining = 2;
    const evict = () => {
      if (--remaining !== 0) return;
      let excess = sourceRequest.result.reduce((sum, row) => sum + row.bytes, 0) + batchRequest.result.reduce((sum, row) => sum + row.bytes, 0) - maxBytes;
      const now = Date.now();
      const sorted = sourceRequest.result.filter((source) => !protectedSourceIds.has(source.sourceId)).sort((a, b) =>
        Number((a.inFlightUntil ?? 0) > now) - Number((b.inFlightUntil ?? 0) > now) || a.lastUsedAt - b.lastUsedAt);
      for (const source of sorted) {
        if (excess <= 0) break;
        sources.delete(source.sourceId);
        excess -= source.bytes;
        for (const batch of batchRequest.result) if (batch.sourceId === source.sourceId) { batches.delete(batch.id); excess -= batch.bytes; }
      }
    };
    sourceRequest.onsuccess = batchRequest.onsuccess = evict;
    await complete;
  }
  async function commitBatch(input, settings = {}) {
    const db = await open();
    const tx = db.transaction([SOURCES, BATCHES, META], "readwrite");
    const complete = done(tx);
    const sources = tx.objectStore(SOURCES), batches = tx.objectStore(BATCHES), meta = tx.objectStore(META);
    let outcome = { ok: false, errorCode: "cache_source_mismatch" }, rejected = false;
    const globalRequest = meta.get("translationCacheGeneration");
    const episodeRequest = meta.get(`translationCacheGeneration:${input.episodeId}`);
    globalRequest.onsuccess = () => {
      episodeRequest.onsuccess = () => {
        const generation = { global: Number(globalRequest.result?.value ?? 0), episode: Number(episodeRequest.result?.value ?? 0) };
        if (generation.global !== input.generation?.global || generation.episode !== input.generation?.episode) {
          outcome = { ok: false, errorCode: "stale_generation" }; rejected = true; tx.abort(); return;
        }
        const sourceRequest = sources.get(input.sourceId);
        sourceRequest.onsuccess = () => {
          const source = sourceRequest.result;
          if (!source || source.episodeId !== input.episodeId || source.sourceLanguage !== input.sourceLanguage || source.trackKind !== input.trackKind) {
            outcome = { ok: false, errorCode: "cache_source_mismatch" }; rejected = true; tx.abort(); return;
          }
          const arraysValid = (indices, texts) => Array.isArray(indices) && Array.isArray(texts) && indices.length === texts.length &&
            indices.every((index, position) => Number.isInteger(index) && index >= 0 && index < source.texts.length && source.texts[index] === texts[position]);
          const readingsValid = (item) => {
            if (item.readings === undefined) return true;
            if (!item.readings || typeof item.readings !== "object" || Array.isArray(item.readings)) return false;
            const anchor = input.annotationSide === "target" ? item.translatedText : item.sourceText;
            const kanaOnly = (text) => /^[\u3040-\u309f\u30a0-\u30ff\u30fc\s。、，．！？・「」『』（）()［］【】]+$/.test(text);
            if (input.annotationSemantics === "reading-v1" && !kanaOnly(anchor) && Object.keys(item.readings ?? {}).length === 0) return false;
            return typeof anchor === "string" && Object.entries(item.readings).every(([surface, reading]) =>
              typeof surface === "string" && surface.length > 0 && typeof reading === "string" && reading.length > 0 && anchor.includes(surface));
          };
          if (!Array.isArray(input.items) || !arraysValid(input.itemIndices, input.sourceTexts) || !arraysValid(input.beforeIndices, input.beforeTexts) ||
              !arraysValid(input.afterIndices, input.afterTexts) || input.itemIndices.length !== input.items.length ||
              input.items.some((item, position) => !item || typeof item.id !== "string" || typeof item.text !== "string" ||
                item.sourceText !== input.sourceTexts[position] || item.translatedText !== item.text || !readingsValid(item))) {
            outcome = { ok: false, errorCode: "cache_source_mismatch" }; rejected = true; tx.abort(); return;
          }
          const sequenceRequest = meta.get("translationCacheSequence");
          sequenceRequest.onsuccess = () => {
            const sequence = Number(sequenceRequest.result?.value ?? 0) + 1;
            const batch = { id: `batch-${sequence}`, sourceId: source.sourceId, itemIndices: clone(input.itemIndices),
              beforeIndices: clone(input.beforeIndices), afterIndices: clone(input.afterIndices),
              items: clone(input.items), targetLanguage: input.targetLanguage,
              semanticIntent: String(input.semanticIntent ?? "").trim() || "default-v1", translationSemantics: "cue-v1",
              annotationSemantics: input.annotationSemantics === "reading-v1" ? "reading-v1" : null,
              annotationSide: input.annotationSide === "target" ? "target" : "source",
              provenance: clone(input.provenance), createdAt: input.createdAt ?? Date.now(), lastUsedAt: Date.now() };
            batch.bytes = bytesOf(batch); source.lastUsedAt = Date.now(); source.inFlightUntil = 0;
            source.bytes = bytesOf(source);
            batches.put(batch);
            sources.put(source);
            meta.put({ key: "translationCacheSequence", value: sequence });
            outcome = { ok: true, id: batch.id, generation };
          };
        };
      };
    };
    try { await complete; }
    catch (error) { if (rejected) return outcome; throw error; }
    if (outcome.ok) await enforceCap(db, settings.maxBytes ?? 0);
    return outcome;
  }
  async function commitAnnotations(input, settings = {}) {
    const db = await open();
    const tx = db.transaction([SOURCES, BATCHES, META], "readwrite");
    const complete = done(tx);
    const sources = tx.objectStore(SOURCES), batches = tx.objectStore(BATCHES), meta = tx.objectStore(META);
    let rejected = false, outcome = { ok: false, errorCode: "cache_miss" };
    const globalRequest = meta.get("translationCacheGeneration");
    const episodeRequest = meta.get(`translationCacheGeneration:${input.episodeId}`);
    globalRequest.onsuccess = () => episodeRequest.onsuccess = () => {
      const generation = { global: Number(globalRequest.result?.value ?? 0), episode: Number(episodeRequest.result?.value ?? 0) };
      if (generation.global !== input.generation?.global || generation.episode !== input.generation?.episode) {
        outcome = { ok: false, errorCode: "stale_generation" }; rejected = true; tx.abort(); return;
      }
      const sourceRequest = sources.get(input.sourceId);
      sourceRequest.onsuccess = () => {
        const source = sourceRequest.result;
        if (!source || source.episodeId !== input.episodeId || source.sourceLanguage !== input.sourceLanguage || source.trackKind !== input.trackKind) {
          outcome = { ok: false, errorCode: "cache_source_mismatch" }; rejected = true; tx.abort(); return;
        }
        const allBatches = batches.index("sourceId").getAll(input.sourceId);
        allBatches.onsuccess = () => {
          const semanticIntent = String(input.semanticIntent ?? "").trim() || "default-v1";
          const compatibleBatches = allBatches.result.filter((candidate) => candidate.targetLanguage === input.targetLanguage &&
            candidate.semanticIntent === semanticIntent && candidate.translationSemantics === "cue-v1");
          const accepted = [];
          for (const annotation of input.items) {
            if (annotation.id == null || !Number.isInteger(annotation.sourceIndex) || source.texts[annotation.sourceIndex] === undefined) {
              outcome = { ok: false, errorCode: "cache_source_mismatch" }; rejected = true; tx.abort(); return;
            }
            const batch = compatibleBatches.find((candidate) => {
              const item = candidate.items[candidate.itemIndices.indexOf(annotation.sourceIndex)];
              return item && item.translatedText === annotation.acceptedText && item.text === item.translatedText;
            });
            if (!batch) { outcome = { ok: false, errorCode: "cache_miss" }; rejected = true; tx.abort(); return; }
            const item = batch.items[batch.itemIndices.indexOf(annotation.sourceIndex)];
            const anchor = input.annotationSide === "target" ? item.translatedText : source.texts[annotation.sourceIndex];
            if (annotation.annotationText !== anchor || !annotation.readings || typeof annotation.readings !== "object" || Array.isArray(annotation.readings) ||
                !Object.entries(annotation.readings).every(([surface, reading]) => surface && typeof reading === "string" && reading.length > 0 && anchor.includes(surface))) {
              outcome = { ok: false, errorCode: "invalid_annotation" }; rejected = true; tx.abort(); return;
            }
            accepted.push({ annotation, item, anchor, batch });
          }
          const changed = new Set();
          for (const { annotation, item, anchor, batch } of accepted) {
            item.readings = clone(annotation.readings);
            item.annotationText = anchor;
            batch.annotationSemantics = "reading-v1";
            batch.annotationSide = input.annotationSide;
            batch.lastUsedAt = Date.now();
            changed.add(batch);
          }
          for (const batch of changed) { batch.bytes = bytesOf(batch); batches.put(batch); }
          source.lastUsedAt = Date.now();
          source.inFlightUntil = 0;
          source.bytes = bytesOf(source);
          sources.put(source);
          outcome = { ok: true, generation,
            items: accepted.map(({ annotation, item }) => ({ id: annotation.id, text: item.translatedText, readings: item.readings })) };
        };
      };
    };
    try { await complete; }
    catch (error) { if (rejected) return outcome; throw error; }
    if (outcome.ok) await enforceCap(db, settings.maxBytes ?? 0);
    return outcome;
  }
  async function clear(episodeId) {
    const db = await open();
    const tx = db.transaction([SOURCES, BATCHES, META], "readwrite");
    const complete = done(tx);
    const sources = tx.objectStore(SOURCES);
    const batches = tx.objectStore(BATCHES);
    const meta = tx.objectStore(META);
    let result;
    const all = sources.getAll();
    const generationRequest = meta.get("translationCacheGeneration");
    const episodeKey = episodeId == null ? null : `translationCacheGeneration:${episodeId}`;
    const episodeRequest = episodeKey ? meta.get(episodeKey) : null;
    let readsRemaining = episodeRequest ? 3 : 2;
    const clearRows = () => {
      if (--readsRemaining !== 0) return;
      const selected = episodeId == null ? all.result : all.result.filter((source) => source.episodeId === episodeId);
      const globalGeneration = Number(generationRequest.result?.value ?? 0) + (episodeId == null ? 1 : 0);
      const episodeGeneration = episodeKey ? Number(episodeRequest.result?.value ?? 0) + 1 : 0;
      for (const source of selected) {
        sources.delete(source.sourceId);
        const matching = batches.index("sourceId").getAll(source.sourceId);
        matching.onsuccess = () => { for (const batch of matching.result) batches.delete(batch.id); };
      }
      if (episodeId == null) meta.put({ key: "translationCacheGeneration", value: globalGeneration });
      if (episodeKey) meta.put({ key: episodeKey, value: episodeGeneration });
      result = { ok: true, generation: { global: globalGeneration, episode: episodeGeneration }, episodeId: episodeId ?? null };
    };
    all.onsuccess = generationRequest.onsuccess = clearRows;
    if (episodeRequest) episodeRequest.onsuccess = clearRows;
    await complete;
    return result;
  }
  async function source(sourceId) {
    const db = await open();
    const tx = db.transaction(SOURCES, "readonly");
    const result = await requestResult(tx.objectStore(SOURCES).get(sourceId));
    await done(tx);
    return result ?? null;
  }
  async function touchSource(sourceId, inFlightMs = 30000) {
    const db = await open();
    const tx = db.transaction(SOURCES, "readwrite");
    const complete = done(tx);
    const store = tx.objectStore(SOURCES), request = store.get(sourceId);
    request.onsuccess = () => { if (request.result) { request.result.lastUsedAt = Date.now(); request.result.inFlightUntil = Date.now() + inFlightMs; store.put(request.result); } };
    await complete;
  }
  async function generation(episodeId) {
    const db = await open();
    const tx = db.transaction(META, "readonly");
    const donePromise = done(tx);
    const store = tx.objectStore(META);
    const globalRequest = store.get("translationCacheGeneration");
    const episodeRequest = episodeId == null ? null : store.get(`translationCacheGeneration:${episodeId}`);
    const result = await new Promise((resolve, reject) => {
      let remaining = episodeRequest ? 2 : 1;
      const finish = () => {
        if (--remaining === 0) resolve({ global: Number(globalRequest.result?.value ?? 0), episode: Number(episodeRequest?.result?.value ?? 0) });
      };
      globalRequest.onsuccess = finish;
      globalRequest.onerror = () => reject(globalRequest.error ?? new Error("storage_idb_request"));
      if (episodeRequest) {
        episodeRequest.onsuccess = finish;
        episodeRequest.onerror = () => reject(episodeRequest.error ?? new Error("storage_idb_request"));
      }
    });
    await donePromise;
    return result;
  }
  globalThis.BilayerTranslationCacheStore = Object.freeze({ open, registerSource, source, touchSource, read, stats, clear, commitBatch, commitAnnotations, generation, hash });
})();
