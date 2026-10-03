/**
 * [INPUT]: Node.js test/vm 与 translationScheduler.js，注入可控翻译和缓存恢复协议
 * [OUTPUT]: 验证既有调度边界、额度、ruby 与 cache restore fence、连续 miss、only 禁止请求及命中零用量
 * [POS]: scripts 的内容翻译调度行为回归检查，不进入扩展运行时
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
  return window.Bilayer.createTranslationScheduler({ translate, onUpdate() {} });
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
    return window.Bilayer.createTranslationScheduler({
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

test("request logs measure end-to-end time for successes and failures", async () => {
  let now = 1000;
  const pending = [];
  const window = {};
  runInNewContext(source, { window, Date: class extends Date { static now() { return now; } } }, { filename: "translationScheduler.js" });
  const scheduler = window.Bilayer.createTranslationScheduler({
    translate: () => {
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
    onUpdate() {}
  });
  scheduler.setSource({ ...sourceFor("timed-requests", cues.slice(0, 2)), prefetchCount: 0 });
  scheduler.observe(1100);
  await flush();
  now = 1125;
  pending[0].resolve({ ok: true, items: [{ id: "0", text: "你好" }] });
  await flush();
  scheduler.observe(5100);
  await flush();
  now = 1375;
  pending[1].resolve({ ok: false, errorCode: "rate_limit" });
  await flush();
  const completed = scheduler.status().logs.filter(({ event }) => event === "request_succeeded" || event === "request_failed");
  assert.deepEqual(JSON.parse(JSON.stringify(completed.map(({ request, durationMs, error }) => ({ request, durationMs, error })))), [
    { request: 1, durationMs: 125 },
    { request: 2, durationMs: 250, error: "rate_limit" }
  ]);
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

test("scheduler annotates source cues with ruby when translation completes", async () => {
  const jpCues = [
    { startMs: 1000, endMs: 2500, text: "私は田中です。" }
  ];
  const scheduler = create(async (batch) => ({
    ok: true,
    items: batch.items.map(({ id }) => ({ id, text: "我是田中。", ruby: "{私|わたし}は{田中|たなか}です。" }))
  }));
  scheduler.setSource({ identity: "jp-source", cues: jpCues, sourceLanguage: "ja", targetLanguage: "zh-Hans" });
  scheduler.observe(1100);
  await flush();

  const annotated = scheduler.annotateSource(jpCues);
  assert.equal(annotated.length, 1);
  assert.equal(annotated[0].ruby, "{私|わたし}は{田中|たなか}です。");
  assert.equal(annotated[0].text, "私は田中です。");
});

test("scheduler collapses multiline translations into single line without spurious spaces in CJK", async () => {
  const testCues = [
    { startMs: 1000, endMs: 2500, text: "Line 0" },
    { startMs: 3000, endMs: 4500, text: "Line 1" },
    { startMs: 5000, endMs: 6500, text: "Line 2" }
  ];
  const scheduler = create(async () => ({
    ok: true,
    items: [
      { id: "0", text: "你好，\n世界！" },
      { id: "1", text: "Hello,\nworld!" },
      { id: "2", text: "- Who is it?\n- It's me." }
    ]
  }));
  scheduler.setSource({ identity: "multiline", cues: testCues, sourceLanguage: "en", targetLanguage: "zh-Hans" });
  scheduler.observe(1100);
  await flush();

  const translated = scheduler.translatedFor(testCues);
  assert.equal(translated[0].text, "你好，世界！");
  assert.equal(translated[1].text, "Hello, world!");
  assert.equal(translated[2].text, "- Who is it?\n- It's me.");
});

test("scheduler attaches ruby to translated cues when targetLanguage is Japanese", async () => {
  const enCues = [
    { startMs: 1000, endMs: 2500, text: "I am Tanaka." }
  ];
  const scheduler = create(async (batch) => ({
    ok: true,
    items: batch.items.map(({ id }) => ({ id, text: "私は田中です。", ruby: "{私|わたし}は{田中|たなか}です。" }))
  }));
  scheduler.setSource({ identity: "en-to-ja", cues: enCues, sourceLanguage: "en", targetLanguage: "ja", japaneseRuby: true });
  scheduler.observe(1100);
  await flush();

  const translated = scheduler.translatedFor(enCues);
  assert.equal(translated.length, 1);
  assert.equal(translated[0].text, "私は田中です。");
  assert.equal(translated[0].ruby, "{私|わたし}は{田中|たなか}です。");

  // And native English cues should not receive ruby
  const annotatedNative = scheduler.annotateSource(enCues);
  assert.equal(annotatedNative[0].ruby, undefined);
});
test("scheduler restores accepted hits before dispatch and sends only the contiguous uncached run", async () => {
  const requests = [];
  const accepted = new Map([[0, { text: "cached 0" }], [2, { text: "cached 2" }]]);
  const cache = { generation: () => 0, clear() {} };
  const window = {};
  runInNewContext(source, { window }, { filename: "translationScheduler.js" });
  const scheduler = window.Bilayer.createTranslationScheduler({ translationCache: cache, onUpdate() {},
    registerCacheSource: async () => ({ sourceId: "s" }), restoreCache: async () => ({ accepted, annotationMissing: 0 }),
    translate: async (batch) => { requests.push(batch); return { ok: true, items: batch.items.map(({ id }) => ({ id, text: `fresh ${id}` })) }; }
  });
  const entries = cues.slice(0, 3);
  scheduler.setSource({ ...sourceFor("cached", entries), cachePolicy: "prefer", prefetchCount: 2 });
  scheduler.observe(1100);
  await flush(); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.translatedFor(entries).map(({ text }) => text))), ["cached 0", "fresh 1", "cached 2"]);
  assert.deepEqual(JSON.parse(JSON.stringify(requests.map(({ items }) => items.map(({ id }) => id)))), [["1"]]);
  assert.equal(scheduler.status().requests, 1);
});

test("only policy reports cache_miss without calling the translator", async () => {
  let calls = 0;
  const window = {};
  runInNewContext(source, { window }, { filename: "translationScheduler.js" });
  const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate() {}, registerCacheSource: async () => ({ sourceId: "s" }),
    restoreCache: async () => ({ accepted: new Map(), annotationMissing: 0 }), translate: async () => { calls++; return { ok: true, items: [] }; }
  });
  scheduler.setSource({ ...sourceFor("only", cues.slice(0, 1)), cachePolicy: "only" });
  scheduler.observe(1100); await flush(); await flush();
  assert.equal(calls, 0);
  assert.equal(scheduler.status().error, "cache_miss");
  assert.equal(scheduler.status().requests, 0);
});
test("only cache misses clear the initial translated cue readiness wait", async () => {
 const restore = deferred();
 const window = {};
 runInNewContext(source, { window });
 const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate() {},
   translate: () => { throw new Error("must not translate"); },
   registerCacheSource: async () => ({ sourceId: "only" }), restoreCache: () => restore.promise });
 scheduler.setSource({ ...sourceFor("only-wait", cues.slice(0, 1)), cachePolicy: "only" });
 scheduler.observe(1100); await flush();
 assert.equal(scheduler.status().translationCache.restorePending, true);
 restore.resolve({ accepted: new Map(), annotationMissing: 0 }); await flush(); await flush();
 assert.equal(scheduler.status().translationCache.restorePending, false);
 assert.equal(scheduler.status().error, "cache_miss");
 assert.equal(scheduler.readyAt(1100), false);
});
test("scheduler does not bridge cached or pending holes when batching misses", async () => {
 const requests = [];
 const window = {};
 runInNewContext(source, { window });
 const accepted = new Map([[1, { text: "cached 1" }]]);
 const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate() {},
   registerCacheSource: async () => ({ sourceId: "s" }), restoreCache: async () => ({ accepted, annotationMissing: 0 }),
   translate: async (batch) => { requests.push(batch); return { ok: true, items: batch.items.map(({ id }) => ({ id, text: `fresh ${id}` })) }; }
 });
 const entries = cues.slice(0, 3);
 scheduler.setSource({ ...sourceFor("hole", entries), prefetchCount: 2 });
 scheduler.observe(1100); await flush(); await flush();
 assert.deepEqual(requests.flatMap(({ items }) => items.map(({ id }) => id)), ["0", "2"]);
 assert.ok(requests.every(({ items }) => items.every(({ id }, index) => index === 0 || Number(id) === Number(items[index - 1].id) + 1)));
});
test("restored hits do not consume the request or character budget", async () => {
 const window = {};
 runInNewContext(source, { window });
 let calls = 0, usageSyncCalls = 0;
 const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate() {}, syncUsage: async () => { usageSyncCalls++; return { requests: 0, characters: 0 }; },
   registerCacheSource: async () => ({ sourceId: "s" }), restoreCache: async () => ({ accepted: new Map([[0, { text: "cached" }]]), annotationMissing: 0 }),
   translate: async () => { calls++; return { ok: true, items: [] }; }
 });
 const entries = cues.slice(0, 1);
 scheduler.setBudget({ requestLimit: 1, characterLimit: 5 });
 scheduler.setSource({ ...sourceFor("budget-hit", entries), cachePolicy: "prefer" });
 scheduler.observe(1100); await flush(); await flush();
 assert.equal(calls, 0);
 assert.equal(usageSyncCalls, 0);
 assert.equal(scheduler.status().requests, 0);
 assert.equal(scheduler.status().sentCharacters, 0);
 assert.equal(scheduler.translatedFor(entries)[0].text, "cached");
});
test("late cache restore from a replaced source cannot overwrite the current source", async () => {
 const window = {};
 runInNewContext(source, { window });
 let releaseOld;
 const requests = [];
 const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate() {},
   registerCacheSource: async (source) => ({ sourceId: source.identity }),
   restoreCache: async (source) => source.identity === "old" ? await new Promise((resolve) => { releaseOld = resolve; })
     : { accepted: new Map([[0, { text: "current hit" }]]), annotationMissing: 0 },
   translate: async (batch) => { requests.push(batch); return { ok: true, items: batch.items.map(({ id }) => ({ id, text: "fresh" })) }; }
 });
 const entries = cues.slice(0, 1);
 scheduler.setSource({ ...sourceFor("old", entries) });
 await flush();
 scheduler.setSource({ ...sourceFor("current", entries) });
 await flush(); await flush();
 releaseOld({ accepted: new Map([[0, { text: "stale hit" }]]), annotationMissing: 0 });
 await flush(); await flush();
 assert.equal(scheduler.translatedFor(entries)[0].text, "current hit");
 assert.equal(requests.length, 0);
});
test("only policy refuses annotation-only misses while preserving accepted translation text", async () => {
  const requests = [];
  const window = {};
  runInNewContext(source, { window });
  const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate() {},
    registerCacheSource: async () => ({ sourceId: "s" }),
    restoreCache: async () => ({ accepted: new Map([[0, { text: "日本語の訳文" }]]), annotationMissing: 1, annotationMissingIndices: [0] }),
    translate: async (batch) => { requests.push(batch); throw new Error("only cache policy must not request annotations"); }
  });
  const entry = [{ startMs: 1000, endMs: 2400, text: "Hello." }];
  scheduler.setSource({ ...sourceFor("only-annotation", entry), targetLanguage: "ja", japaneseRuby: true, cachePolicy: "only" });
  scheduler.observe(1100); await flush(); await flush();
  assert.equal(scheduler.translatedFor(entry)[0].text, "日本語の訳文");
  assert.equal(requests.length, 0);
  assert.equal(scheduler.status().error, "cache_miss");
  assert.equal(scheduler.status().requests, 0);
});

test("prefer policy requests only missing target readings and anchors them to the accepted translation", async () => {
  const requests = [], updates = [];
  const window = {};
  runInNewContext(source, { window });
  const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate: (status) => updates.push(status),
    registerCacheSource: async () => ({ sourceId: "s" }),
    restoreCache: async () => ({ accepted: new Map([[0, { text: "日本語の訳文" }]]), annotationMissing: 1, annotationMissingIndices: [0] }),
    translate: async (batch) => {
      requests.push(batch);
      return { ok: true, items: batch.items.map(({ id, text }) => ({ id, text: `${text} changed`, readings: { "日本": "にほん" } })) };
    }
  });
  const entry = [{ startMs: 1000, endMs: 2400, text: "Hello." }];
  scheduler.setSource({ ...sourceFor("prefer-annotation", entry), targetLanguage: "ja", japaneseRuby: true, cachePolicy: "prefer" });
  scheduler.observe(1100); await flush(); await flush();
  const output = scheduler.translatedFor(entry);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].annotationOnly, true);
  assert.equal(requests[0].items[0].text, "日本語の訳文");
  assert.equal(output[0].text, "日本語の訳文");
  assert.equal(output[0].readings, undefined);
  assert.equal(scheduler.status().requests, 1);
  assert.equal(updates.at(-1).translationCache.annotationMissing, 1);
});

test("clearing session cache fences a pending accepted result from repopulating it", async () => {
  const pending = deferred(), committed = [];
  let cacheGeneration = 0;
  const cache = { generation: () => cacheGeneration, clear() { cacheGeneration++; } };
  const window = {};
  runInNewContext(source, { window });
  const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate() {}, translationCache: cache,
    registerCacheSource: async () => ({ sourceId: "s" }), restoreCache: async () => ({ accepted: new Map(), annotationMissing: 0 }),
    onAccepted: (...args) => committed.push(args), translate: () => pending.promise
  });
  const entry = [{ startMs: 1000, endMs: 2400, text: "Hello." }];
  scheduler.setSource(sourceFor("clear-pending", entry));
  scheduler.observe(1100); await flush(); await flush();
  assert.equal(scheduler.status().requests, 1);
  scheduler.clearCache("episode-1");
  pending.resolve({ ok: true, items: [{ id: "0", text: "late translation" }] });
  await flush(); await flush();
  assert.equal(committed.length, 0);
  assert.equal(scheduler.translatedFor(entry).length, 0);
});

test("successful text stays visible when cache persistence fails and empty readings remain missing", async () => {
  const requests = [];
  const window = {};
  runInNewContext(source, { window });
  const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate() {},
    registerCacheSource: async () => ({ sourceId: "storage-and-readings" }),
    translate: async (batch) => {
      requests.push(batch);
      return { ok: true, items: batch.items.map(({ id }) => ({ id, text: "今日", readings: {} })),
        cacheMetadata: { storageError: "storage_quota" } };
    }
  });
  const entries = cues.slice(0, 1);
  scheduler.setSource({ ...sourceFor("storage-and-readings", entries), targetLanguage: "ja" });
  scheduler.observe(1100); await flush(); await flush();
  assert.equal(scheduler.translatedFor(entries)[0].text, "今日");
  assert.equal(scheduler.status().translationCache.storageError, "storage_quota");
  assert.equal(scheduler.status().translationCache.annotationMissing, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].annotationOnly, true);
  assert.equal(scheduler.status().error, "invalid_response");
});

test("failed local source registration preserves text and supplements its anchored readings", async () => {
  const requests = [];
  const window = {};
  const cacheSource = readFileSync(new URL("../extension/src/content/translationCache.js", import.meta.url), "utf8");
  runInNewContext(cacheSource, { window });
  runInNewContext(source, { window });
  const scheduler = window.Bilayer.createTranslationScheduler({ onUpdate() {},
    translationCache: window.Bilayer.createTranslationCache(),
    registerCacheSource: async () => { throw new Error("storage_quota"); },
    translate: async (batch) => {
      requests.push(batch);
      return { ok: true, items: batch.items.map(({ id }) => ({ id, text: "今日",
        ...(batch.annotationOnly ? { readings: { "今日": "きょう" } } : {}) })) };
    }
  });
  const entries = cues.slice(0, 1);
  scheduler.setSource({ ...sourceFor("registration-failed", entries), episodeId: "episode-1", trackKind: "subtitles",
    cacheMode: "local", targetLanguage: "ja", japaneseRuby: true });
  scheduler.observe(1100); await flush(); await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].annotationOnly, true);
  assert.equal(requests[1].items[0].text, "今日");
  assert.equal(scheduler.translatedFor(entries)[0].text, "今日");
  assert.equal(scheduler.translatedFor(entries)[0].readings["今日"], "きょう");
  assert.equal(scheduler.status().translationCache.annotationMissing, 0);
  assert.equal(scheduler.status().translationCache.storageError, "storage_quota");
});
