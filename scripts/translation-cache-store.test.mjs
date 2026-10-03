/*
 * [INPUT]: 依赖 Node.js test/vm、translation cache store IIFE 与行为型 IndexedDB harness
 * [OUTPUT]: 验证来源去重、精确兼容读取、过期清理、容量上限、clear generation 与错误语义
 * [POS]: 后台本地翻译缓存回归，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { createIndexedDBHarness } from "./indexeddb-harness.mjs";

const source = readFileSync(new URL("../extension/src/background/translation_cache_store.js", import.meta.url), "utf8");
function storeFor(harness) {
  const context = { indexedDB: harness.indexedDB, structuredClone, TextEncoder,
    crypto: { subtle: { digest: async (_algorithm, bytes) => new Uint8Array(await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest())) } } };
  runInNewContext(source, context);
  return context.BilayerTranslationCacheStore;
}
const timeline = { episodeId: "42", sourceLanguage: "en", trackKind: "sdh", texts: ["A!", "B?"] };

test("local source registration deduplicates exact timeline and accepted batches are scoped by semantics", async () => {
  const store = storeFor(createIndexedDBHarness());
  const source = await store.registerSource(timeline, "local");
  assert.equal((await store.registerSource(timeline, "local")).sourceId, source.sourceId);
  const generation = await store.generation("42");
  const committed = await store.commitBatch({ sourceId: source.sourceId, episodeId: "42", sourceLanguage: "en", trackKind: "sdh",
    targetLanguage: "ja-JP", semanticIntent: " tone ", itemIndices: [0], beforeIndices: [], afterIndices: [1],
    sourceTexts: ["A!"], beforeTexts: [], afterTexts: ["B?"], items: [{ id: "0", text: "翻訳", sourceText: "A!", translatedText: "翻訳", readings: { "翻訳": "ほんやく" } }],
    annotationSemantics: "reading-v1", annotationSide: "target",
    provenance: { providerId: "p", providerName: "P", model: "m", endpoint: "https://host/v1/chat/completions" }, generation }, { maxBytes: 0 });
  assert.equal(committed.ok, true);
  const read = await store.read({ ...timeline, targetLanguage: "ja-JP", semanticIntent: "tone", translationSemantics: "cue-v1" }, { retentionDays: 30 });
  assert.equal(read.snapshots[0].batches[0].items[0].text, "翻訳");
  const stats = await store.stats("42");
  assert.equal(stats.subtitleCount, 1);
  assert.equal(stats.currentEpisodeSubtitleCount, 1);
});

test("newly registered source survives first read pruning and capacity enforcement until accepted batch commit", async () => {
  const store = storeFor(createIndexedDBHarness());
  const source = await store.registerSource(timeline, "local", { maxBytes: 4096 });
  const emptyRead = await store.read({ ...timeline, targetLanguage: "zh-Hans", semanticIntent: "default-v1", translationSemantics: "cue-v1" }, { retentionDays: 30, maxBytes: 4096 });
  assert.equal(emptyRead.snapshots.length, 0);
  assert.equal((await store.source(source.sourceId)).sourceId, source.sourceId);
  const generation = await store.generation("42");
  const committed = await store.commitBatch({ sourceId: source.sourceId, episodeId: "42", sourceLanguage: "en", trackKind: "sdh",
    targetLanguage: "zh-Hans", semanticIntent: "default-v1", itemIndices: [0], beforeIndices: [], afterIndices: [],
    sourceTexts: ["A!"], beforeTexts: [], afterTexts: [], items: [{ id: "0", text: "one", sourceText: "A!", translatedText: "one" }],
    provenance: {}, generation }, { maxBytes: 1 });
  assert.equal(committed.ok, true);
});

test("source text mismatch and clear generation reject stale writes without resurrecting data", async () => {
  const store = storeFor(createIndexedDBHarness());
  const source = await store.registerSource(timeline, "local");
  const generation = await store.generation("42");
  const base = { sourceId: source.sourceId, episodeId: "42", sourceLanguage: "en", trackKind: "sdh", targetLanguage: "zh-Hans",
    semanticIntent: "default-v1", itemIndices: [0], beforeIndices: [], afterIndices: [], sourceTexts: ["wrong"], beforeTexts: [], afterTexts: [],
    items: [{ id: "0", text: "甲", sourceText: "wrong", translatedText: "甲" }], provenance: {}, generation };
  const good = { ...base, sourceTexts: ["A!"], items: [{ id: "0", text: "甲", sourceText: "A!", translatedText: "甲" }] };
  assert.equal((await store.commitBatch(base, { maxBytes: 0 })).errorCode, "cache_source_mismatch");
  await store.clear("42");
  assert.deepEqual(structuredClone(await store.commitBatch(good, { maxBytes: 0 })), { ok: false, errorCode: "stale_generation" });
  assert.equal((await store.stats()).subtitleCount, 0);
});

test("retention is based on createdAt and bounded cache evicts oldest episode", async () => {
  const store = storeFor(createIndexedDBHarness());
  const oldSource = await store.registerSource({ ...timeline, episodeId: "old" }, "local");
  const generation = await store.generation("old");
  const batch = (sourceId, episodeId, createdAt) => ({ sourceId, episodeId, sourceLanguage: "en", trackKind: "sdh",
    targetLanguage: "zh-Hans", semanticIntent: "default-v1", itemIndices: [0], beforeIndices: [], afterIndices: [],
    sourceTexts: ["A!"], beforeTexts: [], afterTexts: [], items: [{ id: "0", text: "translation", sourceText: "A!", translatedText: "translation" }], provenance: {}, generation, createdAt });
  await store.commitBatch(batch(oldSource.sourceId, "old", 1), { maxBytes: 0 });
  assert.equal((await store.read({ episodeId: "old", sourceLanguage: "en", trackKind: "sdh", targetLanguage: "zh-Hans", semanticIntent: "default-v1", translationSemantics: "cue-v1" }, { retentionDays: 1 })).snapshots.length, 0);
  const current = await store.registerSource(timeline, "local");
  await store.commitBatch(batch(current.sourceId, "42", Date.now()), { maxBytes: 1 });
  assert.equal((await store.stats()).bytes <= 1, true);
});

test("clearing one episode preserves unrelated in-flight cache commits", async () => {
  const store = storeFor(createIndexedDBHarness());
  const other = await store.registerSource({ ...timeline, episodeId: "other" }, "local");
  const generation = await store.generation("other");
  await store.clear("42");
  const committed = await store.commitBatch({ sourceId: other.sourceId, episodeId: "other", sourceLanguage: "en", trackKind: "sdh", targetLanguage: "ja",
    semanticIntent: "default-v1", generation, itemIndices: [0], beforeIndices: [], afterIndices: [], sourceTexts: ["A!"], beforeTexts: [], afterTexts: [],
    items: [{ id: "0", text: "甲", sourceText: "A!", translatedText: "甲" }], provenance: {} });
  assert.equal(committed.ok, true);
  assert.equal((await store.stats("other")).currentEpisodeSubtitleCount, 1);
});

test("newer retranslation is returned before older text for the same occurrence", async () => {
  const store = storeFor(createIndexedDBHarness());
  const source = await store.registerSource(timeline, "local");
  const generation = await store.generation("42");
  const base = { sourceId: source.sourceId, episodeId: "42", sourceLanguage: "en", trackKind: "sdh", targetLanguage: "zh-Hans",
    semanticIntent: "default-v1", generation, itemIndices: [0], beforeIndices: [], afterIndices: [], sourceTexts: ["A!"], beforeTexts: [], afterTexts: [], provenance: {}, createdAt: Date.now() };
  for (const text of ["旧译文", "新译文"]) {
    assert.equal((await store.commitBatch({ ...base, items: [{ id: "0", text, sourceText: "A!", translatedText: text }] }, { maxBytes: 0 })).ok, true);
  }
  const read = await store.read({ ...timeline, targetLanguage: "zh-Hans", semanticIntent: "default-v1", translationSemantics: "cue-v1" });
  assert.equal(read.snapshots[0].batches[0].items[0].text, "新译文");
  assert.equal((await store.stats("42")).subtitleCount, 1);
});
