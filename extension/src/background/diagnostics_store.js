/*
 * [INPUT]: 依赖 service worker 原生 IndexedDB 与 storage.local 中的旧诊断迁移数据
 * [OUTPUT]: globalThis.BilayerDiagnosticsStore：诊断记录的事务化写入、查询、详情、导出、迁移与清理
 * [POS]: background 持久化层；摘要与完整报文分表，清理 generation 阻止旧请求复活
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
(() => {
  "use strict";

  const DB_NAME = "bilayer-background";
  const DB_VERSION = 2;
  const SUMMARY = "diagnosticSummaries";
  const PAYLOAD = "diagnosticPayloads";
  const META = "meta";
  const clone = (value) => structuredClone(value);

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("storage_idb_request"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("storage_idb_transaction"));
    });
  }

  let opening;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("storage_unavailable")); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SUMMARY)) db.createObjectStore(SUMMARY, { keyPath: "id" });
        if (!db.objectStoreNames.contains(PAYLOAD)) db.createObjectStore(PAYLOAD, { keyPath: "id" });
        if (!db.objectStoreNames.contains("cacheSources")) db.createObjectStore("cacheSources", { keyPath: "sourceId" });
        let batches;
        if (!db.objectStoreNames.contains("cacheBatches")) batches = db.createObjectStore("cacheBatches", { keyPath: "id" });
        else batches = request.transaction.objectStore("cacheBatches");
        if (!batches.indexNames.contains("sourceId")) batches.createIndex("sourceId", "sourceId", { unique: false });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("storage_unavailable"));
      request.onblocked = () => reject(new Error("storage_blocked"));
    }).catch((error) => { opening = null; throw error; });
    return opening;
  }
  const metaValue = async (store, key, fallback) => (await requestResult(store.get(key)))?.value ?? fallback;

  async function initialize(readLegacy, deleteLegacy) {
    const db = await open();
    const probe = db.transaction(META, "readonly");
    const initialized = await metaValue(probe.objectStore(META), "initialized", false);
    await transactionDone(probe);
    if (!initialized) {
      const old = await readLegacy();
      const tx = db.transaction([SUMMARY, PAYLOAD, META], "readwrite");
      const done = transactionDone(tx);
      const summaries = tx.objectStore(SUMMARY), payloads = tx.objectStore(PAYLOAD), meta = tx.objectStore(META);
      let migrationError = null;
      const check = meta.get("initialized");
      check.onsuccess = () => {
        if (check.result?.value) return;
        const list = Array.isArray(old?.__raw_diagnostics__) ? old.__raw_diagnostics__ : [];
        for (const record of list) {
          if (!record || record.id == null) continue;
          summaries.put(summarize(record, 0));
          payloads.put({ id: record.id, request: record.request ?? null, response: record.response ?? null });
        }
        meta.put({ key: "version", value: Number(old?.__raw_diagnostics_version__) || list.length });
        meta.put({ key: "sequence", value: Number(old?.__raw_diagnostic_seq__) || list.reduce((max, item) => Math.max(max, Number(item?.id) || 0), 0) });
        meta.put({ key: "generation", value: 0 });
        meta.put({ key: "initialized", value: true });
      };
      try { await done; }
      catch (error) { migrationError = error; }
      if (migrationError) throw migrationError;
      await deleteLegacy();
    }
    await markInterrupted(db);
  }

  async function markInterrupted(db) {
    const tx = db.transaction([SUMMARY, META], "readwrite");
    const done = transactionDone(tx);
    const summaries = tx.objectStore(SUMMARY), meta = tx.objectStore(META);
    let changed = false;
    const records = summaries.getAll();
    records.onsuccess = () => {
      for (const summary of records.result) {
        if (summary.state !== "pending") continue;
        summary.state = "abnormal";
        summary.completedAt = Date.now();
        summary.error = "worker_interrupted";
        summary.failure = { errorCode: "unavailable", reason: "worker_interrupted" };
        summaries.put(summary);
        changed = true;
      }
      if (!changed) return;
      const versionRequest = meta.get("version");
      versionRequest.onsuccess = () => meta.put({ key: "version", value: Number(versionRequest.result?.value ?? 0) + 1 });
    };
    await done;
  }

  function summarize(record, generation) {
    const validated = record.validated === true;
    const failure = record.failure && typeof record.failure === "object" ? clone(record.failure) : null;
    const completedAt = record.completedAt ?? null;
    const state = completedAt == null ? "pending" : validated && !failure && !record.error && !record.errorCode ? "normal" : "abnormal";
    return {
      id: record.id,
      generation: record.generation ?? generation,
      at: record.at ?? null,
      completedAt,
      state,
      url: record.request?.url ?? null,
      method: record.request?.method ?? null,
      httpStatus: record.response?.status ?? null,
      model: record.model ?? null,
      validated: typeof record.validated === "boolean" ? record.validated : null,
      error: record.error ?? null,
      errorCode: record.errorCode ?? null,
      failure
    };
  }

  async function captureStart(record, isEnabled) {
    if (!isEnabled) return null;
    const db = await open();
    const tx = db.transaction([SUMMARY, PAYLOAD, META], "readwrite");
    const done = transactionDone(tx);
    const meta = tx.objectStore(META);
    let stored;
    const sequenceRequest = meta.get("sequence");
    sequenceRequest.onsuccess = () => {
      const id = Number(sequenceRequest.result?.value ?? 0) + 1;
      const generationRequest = meta.get("generation");
      generationRequest.onsuccess = () => {
        const generation = Number(generationRequest.result?.value ?? 0);
        const versionRequest = meta.get("version");
        versionRequest.onsuccess = () => {
          const version = Number(versionRequest.result?.value ?? 0) + 1;
          stored = { ...clone(record), id, generation };
          tx.objectStore(SUMMARY).put(summarize(stored, generation));
          tx.objectStore(PAYLOAD).put({ id, request: stored.request, response: null });
          meta.put({ key: "sequence", value: id });
          meta.put({ key: "version", value: version });
        };
      };
    };
    await done;
    return stored ?? null;
  }

  async function captureFinish(record) {
    const db = await open();
    const tx = db.transaction([SUMMARY, PAYLOAD, META], "readwrite");
    const done = transactionDone(tx);
    const summaries = tx.objectStore(SUMMARY);
    let updated = false, stale = false;
    const request = summaries.get(record.id);
    request.onsuccess = () => {
      const existing = request.result;
      if (!existing || existing.generation !== record.generation || existing.state !== "pending") { stale = true; tx.abort(); return; }
      const versionRequest = tx.objectStore(META).get("version");
      versionRequest.onsuccess = () => {
        summaries.put(summarize(record, record.generation));
        tx.objectStore(PAYLOAD).put({ id: record.id, request: record.request, response: record.response ?? null });
        tx.objectStore(META).put({ key: "version", value: Number(versionRequest.result?.value ?? 0) + 1 });
        updated = true;
      };
    };
    try { await done; return updated; }
    catch (error) { if (stale) return false; throw error; }
  }

  async function allSummaries(store) {
    return requestResult(store.getAll());
  }

  function matchesSearch(summary, term) {
    if (!term) return true;
    const text = [summary.id, summary.model, summary.url, summary.at, summary.completedAt,
      summary.httpStatus, summary.error, summary.errorCode, summary.failure?.errorCode, summary.failure?.reason].join(" ").toLowerCase();
    return text.includes(term);
  }

  async function query({ filter = "all", search = "", limit = 50, cursor = null, enabled = false, preferenceKnown = false }) {
    if (!new Set(["all", "normal", "abnormal"]).has(filter) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return { ok: false, errorCode: "configuration" };
    }
    const db = await open();
    const tx = db.transaction([SUMMARY, META], "readonly");
    const done = transactionDone(tx);
    const result = await new Promise((resolve, reject) => {
      const recordsRequest = tx.objectStore(SUMMARY).getAll();
      const generationRequest = tx.objectStore(META).get("generation");
      const versionRequest = tx.objectStore(META).get("version");
      let remaining = 3;
      const fail = () => reject(new Error("storage_idb_request"));
      const finish = () => {
        if (--remaining !== 0) return;
        const generation = Number(generationRequest.result?.value ?? 0), version = Number(versionRequest.result?.value ?? 0);
        const term = typeof search === "string" ? search.trim().toLowerCase() : "";
        if (cursor && (cursor.generation !== generation || cursor.filter !== filter || cursor.search !== term || cursor.limit !== limit)) {
          resolve({ ok: false, errorCode: "stale_cursor" }); return;
        }
        const sorted = recordsRequest.result.sort((a, b) => Number(b.id) - Number(a.id));
        const counts = { all: sorted.length, normal: 0, abnormal: 0, pending: 0 };
        for (const record of sorted) counts[record.state === "normal" && (record.errorCode || record.error || record.failure) ? "abnormal" : record.state]++;
        const filtered = sorted.filter((record) => {
          const state = record.state === "normal" && (record.errorCode || record.error || record.failure) ? "abnormal" : record.state;
          return (filter === "all" || state === filter) && matchesSearch(record, term);
        });
        const anchored = cursor?.beforeId == null ? filtered : filtered.filter((record) => Number(record.id) < Number(cursor.beforeId));
        const page = anchored.slice(0, limit);
        const nextCursor = anchored.length > page.length ? { generation, filter, search: term, limit, beforeId: page.at(-1)?.id, version } : null;
        resolve({ ok: true, enabled, preferenceKnown, generation, version, counts, total: filtered.length, records: page, nextCursor, storageError: null });
      };
      recordsRequest.onsuccess = generationRequest.onsuccess = versionRequest.onsuccess = finish;
      recordsRequest.onerror = generationRequest.onerror = versionRequest.onerror = fail;
    });
    await done;
    return result;
  }

  async function detail(id, requestedGeneration) {
    const db = await open();
    const tx = db.transaction([SUMMARY, PAYLOAD, META], "readonly");
    const done = transactionDone(tx);
    const result = await new Promise((resolve, reject) => {
      const generationRequest = tx.objectStore(META).get("generation");
      const versionRequest = tx.objectStore(META).get("version");
      const summaryRequest = tx.objectStore(SUMMARY).get(id);
      const payloadRequest = tx.objectStore(PAYLOAD).get(id);
      let remaining = 4;
      const fail = () => reject(new Error("storage_idb_request"));
      const finish = () => {
        if (--remaining !== 0) return;
        const generation = Number(generationRequest.result?.value ?? 0), version = Number(versionRequest.result?.value ?? 0);
        if (requestedGeneration !== generation) resolve({ ok: false, errorCode: "stale_cursor" });
        else if (!summaryRequest.result || !payloadRequest.result) resolve({ ok: false, errorCode: "not_found" });
        else resolve({ ok: true, generation, version, record: { ...summaryRequest.result,
          request: payloadRequest.result.request, response: payloadRequest.result.response } });
      };
      for (const request of [generationRequest, versionRequest, summaryRequest, payloadRequest]) {
        request.onsuccess = finish;
        request.onerror = fail;
      }
    });
    await done;
    return result;
  }

  async function exportPage({ limit = 50, cursor = null }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, errorCode: "configuration" };
    const db = await open();
    const tx = db.transaction([SUMMARY, PAYLOAD, META], "readonly");
    const done = transactionDone(tx);
    const result = await new Promise((resolve, reject) => {
      const summariesRequest = tx.objectStore(SUMMARY).getAll();
      const generationRequest = tx.objectStore(META).get("generation");
      const versionRequest = tx.objectStore(META).get("version");
      let remaining = 3, failed = false;
      const fail = () => { if (!failed) { failed = true; reject(new Error("storage_idb_request")); } };
      const finish = () => {
        if (--remaining !== 0 || failed) return;
        const generation = Number(generationRequest.result?.value ?? 0);
        const version = Number(versionRequest.result?.value ?? 0);
        if (cursor && (cursor.generation !== generation || cursor.version !== version || cursor.limit !== limit)) {
          resolve({ ok: false, errorCode: "stale_cursor" });
          return;
        }
        const records = summariesRequest.result.sort((a, b) => Number(b.id) - Number(a.id));
        const anchored = cursor?.beforeId == null ? records : records.filter((item) => Number(item.id) < Number(cursor.beforeId));
        const page = anchored.slice(0, limit);
        const payloadRequests = page.map((summary) => {
          const request = tx.objectStore(PAYLOAD).get(summary.id);
          request.onerror = fail;
          return request;
        });
        let payloadsRemaining = payloadRequests.length;
        const ready = () => {
          if (failed || payloadsRemaining !== 0) return;
          const full = page.map((summary, index) => ({ ...summary, request: payloadRequests[index].result?.request ?? null,
            response: payloadRequests[index].result?.response ?? null }));
          const nextCursor = anchored.length > page.length ? { generation, version, limit, beforeId: page.at(-1)?.id } : null;
          resolve({ ok: true, schemaVersion: 1, generation, version, records: full, nextCursor });
        };
        for (const request of payloadRequests) {
          request.onsuccess = () => { payloadsRemaining--; ready(); };
          request.onerror = fail;
        }
        ready();
      };
      summariesRequest.onsuccess = finish;
      generationRequest.onsuccess = finish;
      versionRequest.onsuccess = finish;
      summariesRequest.onerror = generationRequest.onerror = versionRequest.onerror = fail;
    });
    await done;
    return result;
  }

  async function clear() {
    const db = await open();
    const tx = db.transaction([SUMMARY, PAYLOAD, META], "readwrite");
    const done = transactionDone(tx);
    const meta = tx.objectStore(META);
    let result;
    const generationRequest = meta.get("generation");
    generationRequest.onsuccess = () => {
      const generation = Number(generationRequest.result?.value ?? 0) + 1;
      const versionRequest = meta.get("version");
      versionRequest.onsuccess = () => {
        const version = Number(versionRequest.result?.value ?? 0) + 1;
        tx.objectStore(SUMMARY).clear();
        tx.objectStore(PAYLOAD).clear();
        meta.put({ key: "generation", value: generation });
        meta.put({ key: "version", value: version });
        result = { ok: true, generation, version };
      };
    };
    await done;
    return result;
  }

  globalThis.BilayerDiagnosticsStore = Object.freeze({ open, initialize, captureStart, captureFinish, query, detail, exportPage, clear });
})();
