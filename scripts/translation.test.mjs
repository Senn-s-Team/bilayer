/**
 * [INPUT]: 依赖 Node.js test/vm 与 translationScheduler.js，注入可控翻译请求
 * [OUTPUT]: 验证首句优先、预取条数/时间双上限、邻句数量、seek、预算、译文对齐及链路日志保留
 * [POS]: scripts 的翻译调度行为回归检查，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/content/translationScheduler.js", import.meta.url), "utf8");
const cues = [
  { startMs: 1000, endMs: 2400, text: "Hello." },
  { startMs: 5000, endMs: 6200, text: "Are you there?" },
  { startMs: 45000, endMs: 46700, text: "Goodbye." }
];
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function create(translate) {
  const window = {};
  runInNewContext(source, { window }, { filename: "translationScheduler.js" });
  return window.NetflixDualSubtitles.createTranslationScheduler({ translate, onUpdate() {} });
}
function sourceFor(identity, entries = cues) {
  return { identity, cues: entries, sourceLanguage: "en", targetLanguage: "zh-Hans" };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("first sentence translates before prefetch and inherits source timing", async () => {
  const requests = [];
  const first = deferred();
  const scheduler = create((batch) => {
    requests.push(batch);
    if (requests.length === 1) return first.promise;
    return Promise.resolve({ ok: true, items: batch.items.map(({ id }) => ({ id, text: `译文 ${id}` })) });
  });
  scheduler.setSource(sourceFor("episode-A"));
  scheduler.observe(1100, 1);
  await flush();
  assert.equal(requests[0].items.length, 1);
  assert.equal(requests[0].items[0].text, "Hello.");
  assert.equal(scheduler.translatedFor([cues[0]]).length, 0);

  first.resolve({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.translatedFor([cues[0]]))), [
    { startMs: 1000, endMs: 2400, text: "你好。" }
  ]);
  assert.ok(requests.some((batch) => batch.items.some(({ id }) => id === "1")));
  scheduler.observe(1100, 1);
  await flush();
  assert.equal(requests.filter((batch) => batch.items.some(({ id }) => id === "0")).length, 1);
});

test("prefetch count limits future subtitle groups while preserving the current line", async () => {
  const requests = [];
  const entries = Array.from({ length: 16 }, (_, index) => ({ startMs: 1000 + index * 3000,
    endMs: 2000 + index * 3000, text: `Line ${index}.` }));
  const scheduler = create(async (batch) => {
    requests.push(batch);
    return { ok: true, items: batch.items.map(({ id }) => ({ id, text: `译 ${id}` })) };
  });
  scheduler.setSource({ ...sourceFor("counted", entries), prefetchCount: 3 });
  scheduler.observe(1100);
  await flush();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(requests.flatMap(({ items }) => items.map(({ id }) => id)))), ["0", "1", "2", "3"]);
  scheduler.setSource({ ...sourceFor("current-only", entries), prefetchCount: 0 });
  scheduler.observe(1100);
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1).items.map(({ id }) => id))), ["0"]);
});

test("default prefetch stops at ten future groups and never crosses the time horizon", async () => {
  const requests = [];
  const entries = Array.from({ length: 14 }, (_, index) => ({ startMs: 1000 + index * 3000,
    endMs: 2000 + index * 3000, text: `Line ${index}.` }));
  entries[12] = { startMs: 70000, endMs: 71000, text: "Outside horizon." };
  entries[13] = { startMs: 73000, endMs: 74000, text: "Later." };
  const scheduler = create(async (batch) => {
    requests.push(batch);
    return { ok: true, items: batch.items.map(({ id }) => ({ id, text: `译 ${id}` })) };
  });
  scheduler.setSource(sourceFor("default-ten", entries));
  scheduler.observe(1100);
  await flush();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(requests.flatMap(({ items }) => items.map(({ id }) => id)))),
    Array.from({ length: 11 }, (_, index) => String(index)));
  scheduler.observe(37000);
  await flush();
  assert.equal(requests.some(({ items }) => items.some(({ id }) => id === "12")), true);
});

test("context count controls neighboring lines without changing the translated item", async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({ startMs: 1000 + index * 3000,
    endMs: 2000 + index * 3000, text: `Line ${index}.` }));
  for (const [count, before, after] of [[0, [], []], [1, ["Line 1."], ["Line 3."]]]) {
    const requests = [];
    const scheduler = create(async (batch) => { requests.push(batch); return { ok: false, errorCode: "unavailable" }; });
    scheduler.setSource({ ...sourceFor(`context-${count}`, entries), prefetchCount: 0, contextCount: count });
    scheduler.observe(7100);
    await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].items.map(({ id }) => id))), ["2"]);
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].contextBefore)), before);
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].contextAfter)), after);
  }
});

test("one failed batch does not stop prefetching later subtitle groups", async () => {
  const requests = [];
  const scheduler = create((batch) => {
    requests.push(batch);
    return Promise.resolve(requests.length === 1
      ? { ok: false, errorCode: "invalid_response" }
      : { ok: true, items: batch.items.map(({ id }) => ({ id, text: `译 ${id}` })) });
  });
  scheduler.setSource(sourceFor("failure-prefetch"));
  scheduler.observe(1100, 1);
  await flush();
  await flush();
  assert.ok(requests.some((batch) => batch.items.some(({ id }) => id === "1")));
});

test("late translations from another episode never replace the current subtitle", async () => {
  const oldRequest = deferred();
  const calls = [];
  const scheduler = create((batch) => {
    calls.push(batch);
    if (calls.length === 1) return oldRequest.promise;
    return Promise.resolve({ ok: true, items: [{ id: "0", text: "新剧集" }] });
  });
  scheduler.setSource(sourceFor("episode-A"));
  scheduler.observe(1100, 1);
  await flush();
  scheduler.setSource(sourceFor("episode-B"));
  scheduler.observe(1100, 1);
  await flush();
  oldRequest.resolve({ ok: true, items: [{ id: "0", text: "旧剧集" }] });
  await flush();
  assert.equal(scheduler.translatedFor([cues[0]])[0].text, "新剧集");
});

test("seeking past an in-flight request translates the new position once", async () => {
  const first = deferred();
  const calls = [];
  const scheduler = create((batch) => {
    calls.push(batch);
    if (calls.length === 1) return first.promise;
    return Promise.resolve({ ok: true, items: batch.items.map(({ id }) => ({ id, text: `译 ${id}` })) });
  });
  scheduler.setSource(sourceFor("episode-A"));
  scheduler.observe(1100, 1);
  await flush();
  scheduler.observe(45500, 1, true);
  await flush();
  assert.equal(calls[1].items[0].id, "2");
  assert.equal(scheduler.translatedFor([cues[2]])[0].text, "译 2");
  scheduler.observe(45500, 1);
  await flush();
  assert.equal(calls.filter((batch) => batch.items.some(({ id }) => id === "2")).length, 1);
  first.resolve({ ok: true, items: [{ id: "0", text: "你好" }] });
  await flush();
});

test("session budget stops requests instead of repeatedly charging on seeks", async () => {
  const longTrack = Array.from({ length: 110 }, (_, index) => ({
    startMs: index * 60000 + 1000, endMs: index * 60000 + 2000, text: `Line ${index}.`
  }));
  const calls = [];
  const scheduler = create((batch) => {
    calls.push(batch);
    return Promise.resolve({ ok: true, items: batch.items.map(({ id }) => ({ id, text: `译 ${id}` })) });
  });
  scheduler.setSource(sourceFor("long-episode", longTrack));
  for (const cue of longTrack) {
    scheduler.observe(cue.startMs, 1, true);
    await flush();
    if (scheduler.status().error === "budget_exceeded") break;
  }
  assert.equal(scheduler.status().error, "budget_exceeded");
  const charged = calls.length;
  scheduler.observe(longTrack.at(-1).startMs, 1, true);
  await flush();
  assert.equal(calls.length, charged);
});

test("out-of-order parsed cues prioritize the actual playback position", async () => {
  const unordered = [
    { startMs: 45000, endMs: 47000, text: "Later." },
    { startMs: 1000, endMs: 2000, text: "First." }
  ];
  const requests = [];
  const scheduler = create((batch) => {
    requests.push(batch);
    return Promise.resolve({ ok: true, items: batch.items.map(({ id }) => ({ id, text: `译 ${id}` })) });
  });
  scheduler.setSource(sourceFor("unordered", unordered));
  scheduler.observe(1100, 1);
  await flush();
  assert.equal(requests[0].items[0].id, "1");
  assert.equal(scheduler.translatedFor([unordered[1]])[0].text, "译 1");
});

test("translation status exposes complete request lifecycle logs", async () => {
  const updates = [];
  const scheduler = (() => {
    const window = {};
    runInNewContext(source, { window }, { filename: "translationScheduler.js" });
    return window.NetflixDualSubtitles.createTranslationScheduler({
      translate: async (batch) => ({ ok: true, items: batch.items.map(({ id }) => ({ id, text: `译 ${id}` })) }),
      onUpdate: (status) => updates.push(status)
    });
  })();
  scheduler.setSource(sourceFor("logged-episode"));
  scheduler.observe(1100, 1);
  await flush();
  const logs = scheduler.status().logs;
  assert.ok(logs.some((entry) => entry.event === "request_sent"));
  assert.ok(logs.some((entry) => entry.event === "request_succeeded"));
  assert.ok(updates.at(-1)?.logs.length >= 2);
});

test("scheduler preserves sanitized worker stages with the originating request", async () => {
  const scheduler = create(async () => ({ ok: false, errorCode: "invalid_response", trace: [
    { stage: "request", providerId: "custom", model: "model-a", endpoint: "https://example.test/v1/chat/completions" },
    { stage: "response", status: 200, durationMs: 124 },
    { stage: "rejected", reason: "items_mismatch", expectedCount: 1, receivedCount: 0 }
  ] }));
  scheduler.setSource(sourceFor("diagnostic-chain", [cues[0]]));
  scheduler.observe(1100);
  await flush();
  const stages = scheduler.status().logs.filter((entry) => entry.event === "provider_stage");
  assert.deepEqual(JSON.parse(JSON.stringify(stages.map(({ stage }) => stage))), ["request", "response", "rejected"]);
  assert.ok(stages.every(({ request }) => request === 1));
  assert.equal(stages.at(-1).reason, "items_mismatch");
});

test("switching provider within an episode preserves the prior request chain", async () => {
  const scheduler = create(async (batch) => ({ ok: true, items: batch.items.map(({ id }) => ({ id, text: `译文 ${id}` })),
    trace: [{ stage: "validated", itemCount: batch.items.length }] }));
  scheduler.setSource({ ...sourceFor("first-provider", [cues[0]]), budgetKey: "episode-1" });
  scheduler.observe(1100);
  await flush();
  scheduler.setSource({ ...sourceFor("second-provider", [cues[0]]), budgetKey: "episode-1" });
  scheduler.observe(1100);
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().logs.filter(({ event }) => event === "provider_stage")
    .map(({ request }) => request))), [1, 2]);
});
