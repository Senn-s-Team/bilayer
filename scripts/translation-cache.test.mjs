/**
 * [INPUT]: Node test/vm 与 translationCache.js 公开缓存行为
 * [OUTPUT]: 验证重复 occurrence、全体最优强制配对、局部依赖连续性、接受结果与清理
 * [POS]: content cache 行为回归测试，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/content/translationCache.js", import.meta.url), "utf8");
function createCache(options) {
  const window = { Bilayer: {} };
  runInNewContext(source, { window });
  return window.Bilayer.createTranslationCache(options);
}
const scope = { episodeId: "e", sourceLanguage: "ja", trackKind: "sdh", targetLanguage: "en", semanticIntent: "default-v1", translationSemantics: "cue-v1" };

function optimalPairs(left, right) {
  const lengths = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    lengths[i][j] = Math.max(lengths[i + 1][j], lengths[i][j + 1], left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : 0);
  }
  const paths = [];
  function walk(i, j, pairs) {
    if (i === left.length || j === right.length) { paths.push(pairs); return; }
    const best = lengths[i][j];
    if (left[i] === right[j] && lengths[i + 1][j + 1] + 1 === best) walk(i + 1, j + 1, [...pairs, `${i}:${j}`]);
    if (lengths[i + 1][j] === best) walk(i + 1, j, pairs);
    if (lengths[i][j + 1] === best) walk(i, j + 1, pairs);
  }
  walk(0, 0, []);
  const forced = paths[0].filter((pair) => paths.every((path) => path.includes(pair)));
  return new Map(forced.map((pair) => Array.from(pair.split(":"), Number)));
}

test("forced occurrence pairs equal the intersection of every optimal alignment for short sequences", () => {
  const cache = createCache({ maxDistance: 12 });
  const vectors = [[], ["a"], ["b"], ["a", "a"], ["a", "b"], ["b", "a"], ["a", "a", "b"], ["a", "b", "a"], ["b", "a", "a"]];
  for (const left of vectors) for (const right of vectors) {
    assert.deepEqual(Array.from(cache.occurrenceMap(left, right), (pair) => Array.from(pair)), [...optimalPairs(left, right)]);
  }
});

test("identical vectors preserve repeated occurrences positionally", () => {
  assert.deepEqual(Array.from(createCache().occurrenceMap(["x", "x"], ["x", "x"]), (pair) => Array.from(pair)), [[0, 0], [1, 1]]);
});

test("deleting one duplicate block never transfers either distinct accepted result to the surviving occurrence", () => {
  const cache = createCache();
  const texts = ["Opening", "Repeated dialogue.", "Tail A", "Bridge", "Repeated dialogue.", "Tail B"];
  cache.remember(scope, { sourceId: "src", texts, batches: [
    { itemIndices: [1], beforeIndices: [0], afterIndices: [2], targetLanguage: scope.targetLanguage, semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics, items: [{ text: "LEFT", sourceText: texts[1], translatedText: "LEFT" }] },
    { itemIndices: [4], beforeIndices: [3], afterIndices: [5], targetLanguage: scope.targetLanguage, semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics, items: [{ text: "RIGHT", sourceText: texts[4], translatedText: "RIGHT" }] }
  ] });
  const result = cache.read(scope, ["Opening", "Repeated dialogue.", "Tail B"]);
  assert.equal(result.accepted.size, 0);
  assert.equal(cache.occurrenceMap(["Repeated dialogue.", "Repeated dialogue."], ["Repeated dialogue."]).has(0), false);
  assert.equal(cache.occurrenceMap(["Repeated dialogue.", "Repeated dialogue."], ["Repeated dialogue."]).has(1), false);
});

test("missing or inserted source/context dependencies invalidate a whole accepted batch", () => {
  const cache = createCache();
  const texts = ["before", "item", "after"];
  cache.remember(scope, { sourceId: "src", texts, batches: [{ itemIndices: [1], beforeIndices: [0], afterIndices: [2], targetLanguage: scope.targetLanguage, semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics, items: [{ text: "translated", sourceText: texts[1], translatedText: "translated" }] }] });
  assert.equal(cache.read(scope, ["before", "item", "inserted", "after"]).accepted.size, 0);
  assert.equal(cache.read(scope, ["before", "changed", "after"]).accepted.size, 0);
});

test("Japanese annotation completeness is side-aware and honors kana-only empty readings", () => {
  const cache = createCache();
  const texts = ["漢字です", "かなだけ"];
  cache.remember(scope, { sourceId: "src", texts, batches: [{ itemIndices: [0, 1], beforeIndices: [], afterIndices: [], targetLanguage: scope.targetLanguage,
    semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics, annotationSemantics: "reading-v1", items: [
      { id: "0", text: "It is kanji.", sourceText: texts[0], translatedText: "It is kanji." },
      { id: "1", text: "Just kana.", sourceText: texts[1], translatedText: "Just kana." }
    ] }] });
  const result = cache.read(scope, texts, [], { annotationRequired: true, annotationSide: "source" });
  assert.equal(result.accepted.get(0).text, "It is kanji.");
  assert.equal(result.annotationMissing, 1);
  assert.equal(cache.read({ ...scope, sourceLanguage: "en", targetLanguage: "zh-Hans" }, texts, [], { annotationRequired: false }).annotationMissing, 0);
});
test("batch scope mismatch and context span insertion produce no accepted result", () => {
  const cache = createCache();
  const texts = ["lead", "cue", "tail"];
  cache.remember(scope, { sourceId: "src", texts, batches: [{ itemIndices: [1], beforeIndices: [0], afterIndices: [2], targetLanguage: scope.targetLanguage,
    semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics, items: [{ text: "translated", sourceText: texts[1], translatedText: "translated" }] }] });
  assert.equal(cache.read({ ...scope, semanticIntent: "different" }, texts).accepted.size, 0);
  assert.equal(cache.read(scope, ["lead", "cue", "inserted", "tail"]).accepted.size, 0);
});

test("source snapshots preserve distinct accepted text when only one repeated block survives", () => {
  const cache = createCache();
  const texts = ["Start", "Echo", "Between", "Echo", "End"];
  cache.remember(scope, { sourceId: "old", texts, batches: [
    { itemIndices: [1], beforeIndices: [0], afterIndices: [2], targetLanguage: scope.targetLanguage, semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics, items: [{ text: "First echo", sourceText: texts[1], translatedText: "First echo" }] },
    { itemIndices: [3], beforeIndices: [2], afterIndices: [4], targetLanguage: scope.targetLanguage, semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics, items: [{ text: "Second echo", sourceText: texts[3], translatedText: "Second echo" }] }
  ] });
  const surviving = cache.read(scope, ["Start", "Echo", "End"]);
  assert.equal(surviving.accepted.size, 0);
});

test("clearing one episode preserves another episode's distinct accepted result", () => {
  const cache = createCache();
  const first = { ...scope, episodeId: "first" }, second = { ...scope, episodeId: "second" };
  for (const [episode, text] of [[first, "first subtitle"], [second, "second subtitle"]]) {
    cache.remember(episode, { sourceId: episode.episodeId, texts: [text], batches: [{ itemIndices: [0], beforeIndices: [], afterIndices: [],
      targetLanguage: episode.targetLanguage, semanticIntent: episode.semanticIntent, translationSemantics: episode.translationSemantics,
      items: [{ text: `translation for ${episode.episodeId}`, sourceText: text, translatedText: `translation for ${episode.episodeId}` }] }] });
  }
  cache.clear("first");
  assert.equal(cache.read(first, ["first subtitle"]).accepted.size, 0);
  assert.equal(cache.read(second, ["second subtitle"]).accepted.get(0).text, "translation for second");
});
test("session snapshots restore across provider changes but reject target and meaning changes", () => {
 const cache = createCache();
 const texts = ["A", "B", "C"];
 cache.remember(scope, { sourceId: "one", texts, batches: [{ targetLanguage: scope.targetLanguage, semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics,
   beforeIndices: [0], itemIndices: [1], afterIndices: [2], items: [{ text: "Bee", sourceText: texts[1], translatedText: "Bee" }] }] });
 const refreshed = cache.read({ ...scope, providerId: "new-provider" }, texts);
 assert.equal(refreshed.accepted.get(1).text, "Bee");
 assert.equal(cache.read({ ...scope, targetLanguage: "fr" }, texts).accepted.size, 0);
 assert.equal(cache.read({ ...scope, semanticIntent: "formal" }, texts).accepted.size, 0);
});
test("session annotation updates cannot cross target or semantic scope", () => {
  const cache = createCache();
  const texts = ["漢字です"];
  const batch = { itemIndices: [0], beforeIndices: [], afterIndices: [], targetLanguage: scope.targetLanguage,
    semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics, annotationSide: "target",
    items: [{ text: "私は田中です。", sourceText: texts[0], translatedText: "私は田中です。" }] };
  cache.remember(scope, { sourceId: "scope-source", texts, batches: [batch] });
  cache.updateAnnotations(scope, "scope-source", [{ index: 0, annotationText: "私は田中です。", acceptedText: "私は田中です。", ruby: "{私|わたし}は田中です。" }]);
  const changedTarget = { ...scope, targetLanguage: "ja" };
  cache.updateAnnotations(changedTarget, "scope-source", [{ index: 0, annotationText: "私は田中です。", ruby: "wrong target" }]);
  const changedMeaning = { ...scope, semanticIntent: "formal" };
  cache.updateAnnotations(changedMeaning, "scope-source", [{ index: 0, annotationText: "私は田中です。", ruby: "wrong meaning" }]);
  assert.equal(cache.read(scope, texts).accepted.get(0).ruby, "{私|わたし}は田中です。");
  assert.equal(cache.read(changedTarget, texts).accepted.size, 0);
  assert.equal(cache.read(changedMeaning, texts).accepted.size, 0);
});
test("newest accepted translation wins and older annotations cannot mask a changed accepted text", () => {
  const cache = createCache();
  const texts = ["漢字です"];
  const batch = (text, ruby) => ({ itemIndices: [0], beforeIndices: [], afterIndices: [], targetLanguage: scope.targetLanguage,
    semanticIntent: scope.semanticIntent, translationSemantics: scope.translationSemantics, annotationSide: "target",
    annotationSemantics: "reading-v1", items: [{ text, sourceText: texts[0], translatedText: text,
      ...(ruby ? { annotationText: text, ruby } : {}) }] });
  cache.remember(scope, { sourceId: "same-source", texts, batches: [batch("old accepted", "old ruby")] });
  cache.remember(scope, { sourceId: "same-source", texts, batches: [batch("new accepted", null)] });
  const restored = cache.read(scope, texts, [], { annotationRequired: true, annotationSide: "target" });
  assert.equal(restored.accepted.get(0).text, "new accepted");
  assert.equal(restored.accepted.get(0).ruby, undefined);
  assert.equal(restored.annotationMissing, 1);
});
