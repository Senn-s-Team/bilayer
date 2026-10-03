/*
 * [INPUT]: 依赖 Node.js test/vm、诊断 store IIFE 与行为型 IndexedDB harness
 * [OUTPUT]: 验证迁移、pending/validated 状态、查询/详情/导出、清理 generation 与失败不伪造空结果
 * [POS]: 后台 IndexedDB 持久层回归，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { createIndexedDBHarness } from "./indexeddb-harness.mjs";

const source = readFileSync(new URL("../extension/src/background/diagnostics_store.js", import.meta.url), "utf8");
function storeFor(harness, clone = structuredClone) {
  const context = { indexedDB: harness.indexedDB, structuredClone: clone };
  runInNewContext(source, context);
  return context.BilayerDiagnosticsStore;
}

test("diagnostics migrate legacy rows transactionally and retain full payload separately", async () => {
  const harness = createIndexedDBHarness();
  const store = storeFor(harness);
  let deleted = false;
  await store.initialize(async () => ({ __raw_diagnostics_version__: 7, __raw_diagnostic_seq__: 41,
    __raw_diagnostics__: [{ id: 41, at: 10, completedAt: 11, validated: true,
      request: { url: "https://api.example/v1", method: "POST", body: "request" },
      response: { status: 200, body: "response" } }] }), async () => { deleted = true; });
  assert.equal(deleted, true);
  const page = await store.query({ filter: "all", limit: 10 });
  assert.equal(page.version, 7);
  assert.equal(page.counts.normal, 1);
  assert.equal("request" in page.records[0], false);
  assert.equal((await store.detail(41, page.generation)).record.response.body, "response");
  const dump = await store.exportPage({ limit: 10 });
  assert.equal(dump.records[0].request.body, "request");
});

test("pending entries classify abnormal after restart and validation is the normal boundary", async () => {
  const harness = createIndexedDBHarness();
  const store = storeFor(harness);
  await store.initialize(async () => ({}), async () => {});
  const pending = await store.captureStart({ at: 1, model: "m", request: { url: "https://host/a", method: "POST", body: "secret prompt" } }, true);
  const completed = await store.captureStart({ at: 2, model: "m", request: { url: "https://host/a", method: "POST", body: "q" } }, true);
  completed.response = { status: 200, body: "invalid" };
  completed.completedAt = 3;
  completed.failure = { errorCode: "invalid_response", reason: "items_mismatch", expectedCount: 1, receivedCount: null };
  await store.captureFinish(completed);
  const page = await store.query({ filter: "all", limit: 10 });
  assert.equal(page.counts.pending, 1);
  assert.equal(page.counts.abnormal, 1);
  assert.equal((await store.detail(pending.id, page.generation)).record.state, "pending");
  assert.equal((await store.detail(completed.id, page.generation)).record.failure.receivedCount, null);
  const restarted = storeFor(harness);
  await restarted.initialize(async () => { throw new Error("migration must not replay"); }, async () => {});
  const afterRestart = await restarted.query({ filter: "all", limit: 10 });
  assert.equal(afterRestart.counts.pending, 0);
  assert.equal(afterRestart.counts.abnormal, 2);
  assert.equal((await restarted.detail(pending.id, afterRestart.generation)).record.failure.reason, "worker_interrupted");
  assert.equal(await restarted.captureFinish({ ...pending, completedAt: 10, validated: true }), false);
  assert.equal((await restarted.detail(pending.id, afterRestart.generation)).record.state, "abnormal");
});

test("clear fences in-flight completion and invalidates page cursors", async () => {
  const harness = createIndexedDBHarness();
  const store = storeFor(harness);
  await store.initialize(async () => ({}), async () => {});
  const pending = await store.captureStart({ at: 1, request: { url: "u", method: "POST", body: "b" } }, true);
  const old = await store.query({ filter: "all", limit: 1 });
  const cleared = await store.clear();
  pending.validated = true;
  pending.completedAt = 2;
  assert.equal(await store.captureFinish(pending), false);
  assert.equal((await store.query({ filter: "all", limit: 1 })).counts.all, 0);
  assert.deepEqual(structuredClone(await store.detail(pending.id, old.generation)), { ok: false, errorCode: "stale_cursor" });
  assert.equal(cleared.generation, old.generation + 1);
});

test("completed diagnostic summaries retain errorCode and classify validation failures as abnormal", async () => {
  const store = storeFor(createIndexedDBHarness());
  await store.initialize(async () => ({}), async () => {});
  const record = await store.captureStart({ at: 1, request: { url: "u", method: "POST", body: "b" } }, true);
  record.validated = true;
  record.errorCode = "invalid_response";
  record.completedAt = 2;
  assert.equal(await store.captureFinish(record), true);
  const page = await store.query({ filter: "abnormal", limit: 10 });
  assert.equal(page.counts.abnormal, 1);
  assert.equal(page.records[0].errorCode, "invalid_response");
});

test("export pagination rejects a changed storage version without returning a mixed snapshot", async () => {
  const store = storeFor(createIndexedDBHarness());
  await store.initialize(async () => ({}), async () => {});
  const first = await store.captureStart({ at: 1, request: { url: "u", method: "POST", body: "first" } }, true);
  first.completedAt = 2; first.validated = true;
  await store.captureFinish(first);
  await store.captureStart({ at: 2, request: { url: "u", method: "POST", body: "pending" } }, true);
  const page = await store.exportPage({ limit: 1 });
  assert.ok(page.nextCursor);
  const second = await store.captureStart({ at: 3, request: { url: "u", method: "POST", body: "second" } }, true);
  second.completedAt = 4; second.validated = true;
  await store.captureFinish(second);
  assert.deepEqual(structuredClone(await store.exportPage({ limit: 1, cursor: page.nextCursor })), { ok: false, errorCode: "stale_cursor" });
});


test("a request callback exception aborts the IndexedDB transaction instead of committing partial rows", async () => {
  const harness = createIndexedDBHarness();
  const store = storeFor(harness, (value) => {
    if (value?.request?.body === "throw-in-clone") throw new Error("clone failed");
    return structuredClone(value);
  });
  await store.initialize(async () => ({}), async () => {});
  await assert.rejects(store.captureStart({ at: 1, request: { url: "u", method: "POST", body: "throw-in-clone" } }, true));
  const snapshot = harness.snapshot("bilayer-background");
  assert.equal(snapshot.diagnosticSummaries.length, 0);
  assert.equal(snapshot.diagnosticPayloads.length, 0);
});
