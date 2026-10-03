/*
 * [INPUT]: 依赖 Node.js；实现后台 IndexedDB store 所需的确定性原生 API 子集
 * [OUTPUT]: createIndexedDBHarness() 提供共享数据库、reset 与快照，供多个 VM worker 生命周期复用
 * [POS]: 后台持久化测试底座；写入仅在事务完成提交，abort 丢弃本事务变更
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
function keyToken(key) { return JSON.stringify(key); }

export function createIndexedDBHarness() {
  const databases = new Map();
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const api = {
    open(name, version) {
      const request = {};
      queueMicrotask(() => {
        let db = databases.get(name);
        const oldVersion = db?.version ?? 0;
        const upgrade = !db || version > db.version;
        if (!db) { db = { name, version: 0, stores: new Map(), writeQueue: Promise.resolve() }; databases.set(name, db); }
        if (upgrade) {
          db.version = version;
          request.result = makeDb(db);
          request.transaction = { db };
          request.onupgradeneeded?.({ oldVersion, newVersion: version });
        } else request.result = makeDb(db);
        request.onsuccess?.();
      });
      return request;
    }
  };
  function makeDb(state) {
    return {
      get objectStoreNames() {
        const names = [...state.stores.keys()];
        return { contains: (name) => names.includes(name), [Symbol.iterator]: () => names[Symbol.iterator]() };
      },
      createObjectStore(name, options = {}) {
        const store = { name, keyPath: options.keyPath ?? null, indexes: new Map(), rows: new Map() };
        state.stores.set(name, store);
        return makeStoreFactory(store, null, null, true);
      },
      transaction(names, mode = "readonly") { return makeTransaction(state, Array.isArray(names) ? names : [names], mode); },
      close() {}
    };
  }
  function makeStoreFactory(store, tx, working, upgrade = false) {
    const rows = working ?? store.rows;
    const request = (execute) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      if (tx && !upgrade) tx.queueRequest(req, execute);
      else queueMicrotask(() => runRequest(req, execute));
      return req;
    };
    const keyForIndex = (row, path) => path.length === 1 ? row[path[0]] : path.map((part) => row[part]);
    const allByIndex = (indexName, query) => {
      const index = store.indexes.get(indexName);
      if (!index) throw new Error(`missing index ${indexName}`);
      const expected = keyToken(query);
      return [...rows.values()].filter((row) => keyToken(keyForIndex(row, index.keyPath)) === expected);
    };
    return {
      indexNames: { contains: (name) => store.indexes.has(name) },
      createIndex(name, keyPath, options = {}) { store.indexes.set(name, { keyPath: Array.isArray(keyPath) ? keyPath : [keyPath], unique: options.unique === true }); return this; },
      index(name) { return { getAll: (query) => request(() => clone(allByIndex(name, query))) }; },
      get(key) { return request(() => clone(rows.get(keyToken(key)))); },
      getAll(query) { return request(() => clone([...rows.values()].filter((row) => query === undefined || keyToken(row[store.keyPath]) === keyToken(query)))); },
      put(value) {
        if (!upgrade && tx?.mode !== "readwrite") throw new Error("readonly transaction");
        const copy = clone(value);
        const key = store.keyPath ? copy[store.keyPath] : copy.id;
        return request(() => { rows.set(keyToken(key), copy); return key; });
      },
      delete(key) {
        if (!upgrade && tx?.mode !== "readwrite") throw new Error("readonly transaction");
        return request(() => { rows.delete(keyToken(key)); return undefined; });
      },
      clear() {
        if (!upgrade && tx?.mode !== "readwrite") throw new Error("readonly transaction");
        return request(() => { rows.clear(); return undefined; });
      }
    };
  }
  function runRequest(request, execute, tx = null) {
    try { request.result = execute(); }
    catch (error) { request.error = error; request.onerror?.(); if (tx) tx.abort(); return; }
    try { request.onsuccess?.(); }
    catch (error) { request.error = error; if (tx) tx.abort(); else request.onerror?.(); }
  }
  function makeTransaction(db, names, mode) {
    let completeHandler = null, abortHandler = null, errorHandler = null;
    let requestCount = 0, started = false, finished = false, completionScheduled = false, pumping = false;
    let working = new Map(), active = mode !== "readwrite";
    const pending = [];
    const tx = {
      mode, error: null, aborted: false,
      get oncomplete() { return completeHandler; },
      set oncomplete(callback) { completeHandler = callback; if (finished && !tx.aborted) callback?.(); },
      get onabort() { return abortHandler; },
      set onabort(callback) { abortHandler = callback; if (finished && tx.aborted) callback?.(); },
      get onerror() { return errorHandler; },
      set onerror(callback) { errorHandler = callback; }
    };
    for (const name of names) working.set(name, new Map());
    const snapshot = () => {
      if (!working) working = new Map();
      for (const name of names) {
        const store = db.stores.get(name);
        if (!store) throw new Error(`missing object store ${name}`);
        if (mode !== "readwrite") { working.set(name, store.rows); continue; }
        let rows = working.get(name);
        if (!rows) { rows = new Map(); working.set(name, rows); }
        rows.clear();
        for (const [key, row] of store.rows) rows.set(key, clone(row));
      }
    };
    const maybeComplete = () => {
      if (completionScheduled || finished || tx.aborted || !active || !started || requestCount || pending.length) return;
      completionScheduled = true;
      queueMicrotask(() => {
        completionScheduled = false;
        if (finished || tx.aborted || !active || requestCount || pending.length) return;
        if (mode === "readwrite") for (const [name, rows] of working) db.stores.get(name).rows = rows;
        finished = true;
        completeHandler?.();
        tx._release?.();
      });
    };
    const pump = () => {
      if (pumping || !active || finished || tx.aborted) return;
      const next = pending.shift();
      if (!next) { maybeComplete(); return; }
      pumping = true;
      queueMicrotask(() => {
        if (!tx.aborted) runRequest(next.request, next.execute, tx);
        requestCount--;
        pumping = false;
        if (tx.aborted) return;
        if (pending.length) pump();
        else maybeComplete();
      });
    };
    tx.queueRequest = (request, execute) => {
      if (finished || tx.aborted) throw new Error("transaction_inactive");
      requestCount++;
      started = true;
      pending.push({ request, execute });
      pump();
    };
    tx.objectStore = (name) => {
      if (!working?.has(name)) throw new Error("store_not_in_transaction");
      return makeStoreFactory(db.stores.get(name), tx, working.get(name));
    };
    tx.abort = () => {
      if (finished || tx.aborted) return;
      tx.aborted = true;
      if (mode === "readwrite") for (const rows of working.values()) rows.clear();
      queueMicrotask(() => { finished = true; abortHandler?.(); tx._release?.(); });
    };
    if (mode === "readwrite") {
      const previous = db.writeQueue;
      let release;
      db.writeQueue = new Promise((resolve) => { release = resolve; });
      tx._release = release;
      previous.then(() => {
        if (tx.aborted) { tx._release?.(); return; }
        snapshot();
        active = true;
        pump();
      });
    } else {
      snapshot();
      queueMicrotask(() => { active = true; if (!started) started = true; pump(); });
    }
    return tx;
  }
  return {
    indexedDB: api,
    reset(name) { if (name === undefined) databases.clear(); else databases.delete(name); },
    snapshot(name) {
      const db = databases.get(name);
      if (!db) return null;
      return Object.fromEntries([...db.stores].map(([storeName, store]) => [storeName, [...store.rows.values()].map(clone)]));
    }
  };
}
