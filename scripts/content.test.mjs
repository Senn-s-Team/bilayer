/**
 * [INPUT]: 依赖 Node.js test/vm 与扩展 content.js 源码，使用可控浏览器消息和字幕加载器
 * [OUTPUT]: 验证凭证隔离、独立 AI 源、日文源/目标字幕 readings 注音与 ruby 回填、provider 重译、预取变更不丢译文、上下文变更重译及脱敏日志
 * [POS]: scripts 的内容脚本行为回归检查，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/content/content.js", import.meta.url), "utf8");
const schedulerSource = readFileSync(new URL("../extension/src/content/translationScheduler.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function createPage(stored = {}) {
  const listeners = {};
  const frames = [];
  const loads = new Map();
  const translationMessages = [];
  const location = { pathname: "/watch/42", href: "https://www.netflix.com/watch/42", origin: "https://www.netflix.com" };
  const videoEvents = {};
  const timers = new Map();
  let nextTimerId = 1;
  const video = {
    currentTime: 1.5,
    playbackRate: 1,
    paused: true,
    playCount: 0,
    pauseCount: 0,
    addEventListener(type, callback) { videoEvents[type] = callback; },
    removeEventListener(type) { delete videoEvents[type]; },
    play() {
      this.paused = false;
      this.playCount++;
      videoEvents.play?.();
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      this.pauseCount++;
      videoEvents.pause?.();
    },
    emit(type) { videoEvents[type]?.(); }
  };
  const window = {
    location,
    NetflixDualSubtitles: {
      normalizeTracks: (payload) => payload.tracks,
      createSubtitleStore: () => ({ load: (track) => loads.get(track.key).promise, clear() {} }),
      createSubtitleOverlay: () => ({
        applySettings() {},
        render(frame = {}) { frames.push(frame); },
        mount() {}
      })
    },
    addEventListener(type, handler) { listeners[type] = handler; },
    postMessage() {}
  };
  const runtime = {
    storage: {
      local: { get(defaults, callback) { callback({ ...defaults, ...stored }); } },
      onChanged: { addListener(handler) { listeners.storage = handler; } }
    },
    runtime: {
      getURL: (path) => path,
      sendMessage(message, callback) { translationMessages.push({ message, callback }); },
      onMessage: { addListener(handler) { listeners.runtime = handler; } }
    }
  };
  const document = {
    documentElement: {
      append(node) { if (node.onload) queueMicrotask(() => node.onload()); }
    },
    createElement() { return { remove() {}, style: {}, textContent: "" }; },
    querySelector(selector) { return selector === "video" ? video : null; },
    getElementById() { return null; }
  };
  runInNewContext(schedulerSource, { window }, { filename: "translationScheduler.js" });
  runInNewContext(source, {
    window, document, location, browser: runtime,
    MutationObserver: class { observe() {} },
    setInterval: () => 1, clearInterval() {}, queueMicrotask,
    setTimeout(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}
  }, { filename: "content.js" });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    listeners, frames, loads, window, video, translationMessages,
    advance(ms) {
      for (const [id, timer] of timers) {
        if (timer.delay > ms) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    getState() {
      let result;
      listeners.runtime({ type: "NETFLIX_DUAL_SUBTITLES_GET_STATE" }, null, (value) => { result = value; });
      return result;
    },
    announce(tracks) {
      listeners.message({ source: window, data: {
        source: "netflix-dual-subtitles-bridge", type: "tracks", payload: { tracks }
      } });
    }
  };
}

test("provider credentials never appear in popup page state", async () => {
  const providers = [{ id: "openai", name: "OpenAI", model: "m", endpoint: "", credential: "stored-secret" }];
  const page = await createPage({ providers });
  assert.equal(page.getState().settings.providers, undefined);
  page.listeners.storage({
    providers: { newValue: [{ ...providers[0], credential: "updated-secret" }] },
    timingOffsetMs: { newValue: 250 }
  }, "local");
  const settings = page.getState().settings;
  assert.equal(settings.providers, undefined);
  assert.equal(JSON.stringify(page.getState()).includes("updated-secret"), false);
  assert.equal(settings.timingOffsetMs, 250);
});

test("unsupported target languages and empty prompts use safe defaults", async () => {
  const page = await createPage({ aiTargetLanguage: "xx", aiStyleGuide: "" });
  assert.equal(page.getState().settings.aiTargetLanguage, "zh-Hans");
  assert.match(page.getState().settings.aiStyleGuide, /影视字幕翻译员/);
});

test("loaded first subtitle renders before the other subtitle finishes", async () => {
  const page = await createPage({ primaryTrackKey: "en", secondaryTrackKey: "ja" });
  const first = deferred();
  const second = deferred();
  page.loads.set("en", first);
  page.loads.set("ja", second);
  page.announce([
    { key: "en", language: "en", label: "English" },
    { key: "ja", language: "ja", label: "Japanese" }
  ]);

  first.resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "Hello");
  assert.equal(page.frames.at(-1)?.secondaryCues?.length, 0);

  second.resolve([{ startMs: 1000, endMs: 2000, text: "こんにちは" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "こんにちは");
});

test("switching tracks ignores late results without hiding the other subtitle", async () => {
  const page = await createPage({ primaryTrackKey: "en", secondaryTrackKey: "ja" });
  const oldTrack = deferred();
  const newTrack = deferred();
  const otherTrack = deferred();
  page.loads.set("en", oldTrack);
  page.loads.set("es", newTrack);
  page.loads.set("ja", otherTrack);
  page.announce([
    { key: "en", language: "en", label: "English" },
    { key: "es", language: "es", label: "Spanish" },
    { key: "ja", language: "ja", label: "Japanese" }
  ]);

  otherTrack.resolve([{ startMs: 1000, endMs: 2000, text: "こんにちは" }]);
  await new Promise((resolve) => setImmediate(resolve));
  page.listeners.storage({ primaryTrackKey: { newValue: "es" } }, "local");
  oldTrack.resolve([{ startMs: 1000, endMs: 2000, text: "Old" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.primaryCues?.length, 0);
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "こんにちは");
  assert.equal(page.getState().loadStatus.primary.cueCount, 0);

  newTrack.resolve([{ startMs: 1000, endMs: 2000, text: "Nuevo" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "Nuevo");
});

test("AI subtitle replaces native fallback while preserving the source line", async () => {
  const page = await createPage({ primaryTrackKey: "en", secondaryTrackKey: "ja", aiSourceTrackKey: "en", aiRole: "secondary" });
  const sourceTrack = deferred();
  const fallbackTrack = deferred();
  page.loads.set("en", sourceTrack);
  page.loads.set("ja", fallbackTrack);
  page.announce([
    { key: "en", language: "en", label: "English" },
    { key: "ja", language: "ja", label: "Japanese" }
  ]);
  sourceTrack.resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  fallbackTrack.resolve([{ startMs: 1000, endMs: 2000, text: "こんにちは" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "Hello");
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "こんにちは");
  assert.equal(page.translationMessages.length, 1);
  assert.equal(page.translationMessages[0].message.diagnostic, true);

  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好" }],
    trace: [{ stage: "response", status: 200 }, { stage: "validated", itemCount: 1 }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "Hello");
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "你好");
  assert.deepEqual(JSON.parse(JSON.stringify(page.getState().translationStatus.logs.filter(({ event }) => event === "provider_stage")
    .map(({ stage }) => stage))), ["response", "validated"]);
});

test("changing prefetch count keeps translated lines and schedules only newly eligible dialogue", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary", aiPrefetchCount: 0 });
  const sourceTrack = deferred();
  page.loads.set("en", sourceTrack);
  page.announce([{ key: "en", language: "en", label: "English" }]);
  sourceTrack.resolve([
    { startMs: 1000, endMs: 2000, text: "Hello." },
    { startMs: 5000, endMs: 6000, text: "Next." }
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages.length, 1);
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages.length, 1);
  assert.equal(page.getState().translationStatus.count, 1);
  page.listeners.storage({ aiPrefetchCount: { newValue: 1 } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages.length, 2);
  assert.equal(page.translationMessages[1].message.items[0].id, "1");
  assert.equal(page.getState().translationStatus.count, 1);
});

test("changing context count starts a new translation with the updated neighboring lines", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary", aiPrefetchCount: 0 });
  const sourceTrack = deferred();
  page.loads.set("en", sourceTrack);
  page.announce([{ key: "en", language: "en", label: "English" }]);
  sourceTrack.resolve([
    { startMs: 1000, endMs: 2000, text: "Hello." },
    { startMs: 5000, endMs: 6000, text: "Next." }
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(page.translationMessages[0].message.contextAfter)), ["Next."]);
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await new Promise((resolve) => setImmediate(resolve));
  page.listeners.storage({ aiContextCount: { newValue: 0 } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(page.translationMessages[1].message.contextAfter)), []);
  assert.equal(page.translationMessages[1].message.items[0].id, "0");
});

test("AI translation can occupy the first line with original subtitles second", async () => {
  const page = await createPage({ primaryTrackKey: "ja", secondaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "primary" });
  const fallback = deferred();
  const source = deferred();
  page.loads.set("ja", fallback);
  page.loads.set("en", source);
  page.announce([
    { key: "ja", language: "ja", label: "Japanese" },
    { key: "en", language: "en", label: "English" }
  ]);
  fallback.resolve([{ startMs: 1000, endMs: 2000, text: "原生回退" }]);
  source.resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "原生回退");
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "你好");
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "Hello");
});

test("provider failure leaves original and native fallback cues visible", async () => {
  const page = await createPage({ primaryTrackKey: "en", secondaryTrackKey: "ja", aiSourceTrackKey: "en", aiRole: "secondary" });
  const original = deferred();
  const fallback = deferred();
  page.loads.set("en", original);
  page.loads.set("ja", fallback);
  page.announce([
    { key: "en", language: "en", label: "English" },
    { key: "ja", language: "ja", label: "Japanese" }
  ]);
  original.resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  fallback.resolve([{ startMs: 1000, endMs: 2000, text: "こんにちは" }]);
  await new Promise((resolve) => setImmediate(resolve));
  page.translationMessages[0].callback({ ok: false, errorCode: "auth" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "Hello");
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "こんにちは");
  assert.equal(page.getState().translationStatus.error, "auth");
});

test("AI mode waits for the first translation before resuming playback", async () => {
  const page = await createPage({
    primaryTrackKey: "en", secondaryLanguage: "", aiSourceTrackKey: "en", aiRole: "secondary"
  });
  const sourceTrack = deferred();
  page.loads.set("en", sourceTrack);
  page.announce([{ key: "en", language: "en", label: "English" }]);
  sourceTrack.resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  await new Promise((resolve) => setImmediate(resolve));

  await page.video.play();
  assert.equal(page.video.paused, true);
  assert.equal(page.video.pauseCount, 1);
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.video.paused, false);
  assert.equal(page.video.playCount, 2);
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "你好");
});

test("initial translation timeout releases playback without inventing a second line", async () => {
  const page = await createPage({ primaryTrackKey: "en", secondaryLanguage: "", aiSourceTrackKey: "en", aiRole: "secondary" });
  const source = deferred();
  page.loads.set("en", source);
  page.announce([{ key: "en", language: "en", label: "English" }]);
  source.resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  await new Promise((resolve) => setImmediate(resolve));
  await page.video.play();
  page.advance(3000);
  assert.equal(page.video.paused, false);
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "Hello");
  assert.equal(page.frames.at(-1)?.secondaryCues?.length, 0);
  assert.equal(page.getState().translationStatus.error, "initial_timeout");
});

test("manual pause during translation wait prevents automatic playback", async () => {
  const page = await createPage({ primaryTrackKey: "en", secondaryLanguage: "", aiSourceTrackKey: "en", aiRole: "secondary" });
  const source = deferred();
  page.loads.set("en", source);
  page.announce([{ key: "en", language: "en", label: "English" }]);
  source.resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  await new Promise((resolve) => setImmediate(resolve));
  await page.video.play();
  await new Promise((resolve) => setImmediate(resolve));
  page.video.emit("pause");
  page.advance(3000);
  assert.equal(page.video.paused, true);
  assert.equal(page.video.playCount, 1);
});

test("switching a row from AI back to its native track restores both native lines", async () => {
  const page = await createPage({ primaryTrackKey: "en", secondaryTrackKey: "ja", aiSourceTrackKey: "en", aiRole: "off" });
  const original = deferred();
  const fallback = deferred();
  page.loads.set("en", original);
  page.loads.set("ja", fallback);
  page.announce([
    { key: "en", language: "en", label: "English" },
    { key: "ja", language: "ja", label: "Japanese" }
  ]);
  original.resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  fallback.resolve([{ startMs: 1000, endMs: 2000, text: "こんにちは" }]);
  await new Promise((resolve) => setImmediate(resolve));
  page.listeners.storage({ aiRole: { newValue: "secondary" } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages.length, 1);
  page.listeners.storage({ aiRole: { newValue: "off" } }, "local");
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "Hello");
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "こんにちは");
});

test("AI can translate a source track independent of either displayed native row", async () => {
  const page = await createPage({ primaryTrackKey: "en", secondaryTrackKey: "ja", aiSourceTrackKey: "es", aiRole: "secondary" });
  for (const key of ["en", "ja", "es"]) page.loads.set(key, deferred());
  page.announce([
    { key: "en", language: "en", label: "English" },
    { key: "ja", language: "ja", label: "Japanese" },
    { key: "es", language: "es", label: "Español" }
  ]);
  page.loads.get("en").resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  page.loads.get("ja").resolve([{ startMs: 1000, endMs: 2000, text: "こんにちは" }]);
  page.loads.get("es").resolve([{ startMs: 1000, endMs: 2000, text: "Hola" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages[0].message.sourceLanguage, "es");
  assert.equal(page.translationMessages[0].message.items[0].text, "Hola");
  assert.equal(page.frames.at(-1)?.primaryCues?.[0]?.text, "Hello");
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "你好");
});

test("switching providers retranslates the same active source cue", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  page.loads.set("en", deferred());
  page.announce([{ key: "en", language: "en", label: "English" }]);
  page.loads.get("en").resolve([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages.length, 1);
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好" }] });
  await new Promise((resolve) => setImmediate(resolve));
  page.listeners.storage({ aiProviderId: { newValue: "custom" } }, "local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages.length, 2);
  assert.equal(page.translationMessages[1].message.items[0].text, "Hello");
});

test("AI Japanese translation annotates original Japanese subtitle row with ruby furigana", async () => {
  const page = await createPage({
    primaryTrackKey: "ja",
    aiSourceTrackKey: "ja",
    aiRole: "secondary"
  });
  page.loads.set("ja", deferred());
  page.announce([{ key: "ja", language: "ja", label: "Japanese" }]);
  page.loads.get("ja").resolve([{ startMs: 1000, endMs: 2000, text: "私は田中です" }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.translationMessages.length, 1);
  assert.equal(page.translationMessages[0].message.sourceLanguage, "ja");
  page.translationMessages[0].callback({
    ok: true,
    items: [{ id: "0", text: "我是田中", ruby: "{私|わたし}は{田中|たなか}です" }]
  });
  await new Promise((resolve) => setImmediate(resolve));

  const latestFrame = page.frames.at(-1);
  assert.equal(latestFrame?.secondaryCues?.[0]?.text, "我是田中");
  assert.equal(latestFrame?.primaryCues?.[0]?.text, "私は田中です");
  assert.equal(latestFrame?.primaryCues?.[0]?.ruby, "{私|わたし}は{田中|たなか}です");
});

test("Japanese ruby setting carries source readings and annotates the displayed original without changing translation", async () => {
  const page = await createPage({ primaryTrackKey: "ja", aiSourceTrackKey: "ja", aiRole: "secondary", aiJapaneseRuby: true });
  page.loads.set("ja", deferred());
  page.announce([{ key: "ja", language: "ja", label: "Japanese" }]);
  page.loads.get("ja").resolve([{ startMs: 1000, endMs: 2000, text: "私は田中です" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages[0].message.japaneseRuby, true);
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "我是田中", readings: { "私": "わたし", "田中": "たなか" } }] });
  await new Promise((resolve) => setImmediate(resolve));
  const frame = page.frames.at(-1);
  assert.equal(frame.primaryCues[0].text, "私は田中です");
  assert.deepEqual(JSON.parse(JSON.stringify(frame.primaryCues[0].readings)), { "私": "わたし", "田中": "たなか" });
  assert.equal(frame.secondaryCues[0].text, "我是田中");
});

test("Japanese target readings annotate translated row and leave native source unchanged", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary", aiTargetLanguage: "ja", aiJapaneseRuby: true });
  page.loads.set("en", deferred());
  page.announce([{ key: "en", language: "en", label: "English" }]);
  page.loads.get("en").resolve([{ startMs: 1000, endMs: 2000, text: "I am Tanaka." }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.translationMessages[0].message.targetLanguage, "ja");
  assert.equal(page.translationMessages[0].message.japaneseRuby, true);
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "私は田中です", readings: { "私": "わたし", "田中": "たなか" } }] });
  await new Promise((resolve) => setImmediate(resolve));
  const frame = page.frames.at(-1);
  assert.equal(frame.primaryCues[0].text, "I am Tanaka.");
  assert.equal(frame.primaryCues[0].readings, undefined);
  assert.equal(frame.secondaryCues[0].text, "私は田中です");
  assert.deepEqual(JSON.parse(JSON.stringify(frame.secondaryCues[0].readings)), { "私": "わたし", "田中": "たなか" });
});
