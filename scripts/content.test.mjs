/**
 * [INPUT]: 依赖 Node.js test/vm 与扩展 content.js、translationCache.js、translationScheduler.js，使用可控浏览器消息、共享 runtime.storage.local 与虚拟时钟
 * [OUTPUT]: 验证字幕加载、缓存注册/读取 scope、命中与策略、注音、预算、跨标签页状态、可用性与设置 sender 授权
 * [POS]: scripts 的内容脚本行为回归检查，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/content/content.js", import.meta.url), "utf8");
const schedulerSource = readFileSync(new URL("../extension/src/content/translationScheduler.js", import.meta.url), "utf8");
const cacheSource = readFileSync(new URL("../extension/src/content/translationCache.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// 测试用固定时钟：content 的窗口键与持久化锚点都按 Date 计算，冻结后断言可以写出精确值。
const BUDGET_EPOCH = new Date(2026, 0, 15, 10, 30, 0).getTime();

function createClock(epochMs = BUDGET_EPOCH) {
  let current = epochMs;
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(current);
      else super(...args);
    }
    static now() { return current; }
  }
  return {
    Date: FakeDate,
    set(nextMs) { current = nextMs; }
  };
}

// 共享的 runtime.storage.local：写入对其它上下文可见（派发 storage.onChanged），
// 写入方自己收不到通知，与浏览器行为一致（content 也不依赖自己的回写通知）。
function createStorage(initial = {}) {
  const data = { ...initial };
  const listeners = [];
  return {
    data,
    get(defaults, callback) { callback({ ...defaults, ...data }); },
    set(items, callback, owner) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      }
      for (const entry of listeners) {
        if (entry.owner !== owner) entry.handler(changes, "local");
      }
      callback?.();
    },
    subscribe(owner, handler) { listeners.push({ owner, handler }); }
  };
}

async function createPage(stored = {}, { storage = null, pathname = "/watch/42", clock = null } = {}) {
  const listeners = {};
  const frames = [];
  const loads = new Map();
  const translationMessages = [];
  const readinessMessages = [];
  const backgroundMessages = [];
  const shared = storage ?? createStorage();
  // 页面读取的设置来自存储：新建存储时写入，共享存储时并入（模拟同一份 runtime.storage.local）。
  Object.assign(shared.data, stored);
  const timer = clock ?? createClock();
  const location = { pathname, href: `https://www.netflix.com${pathname}`, origin: "https://www.netflix.com" };
  const videoEvents = {};
  const timers = new Map();
  const intervals = new Map();
  let nextTimerId = 1;
  let nextIntervalId = 1;
  // 虚拟时钟：定时器/间隔都记录到期时刻，advance() 推进“现在”后按时间顺序追平（回调中新排的也随之执行）。
  let now = 0;
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
    Bilayer: {
      normalizeTracks: (payload) => payload.tracks,
      createSubtitleStore: () => ({ load: (track) => loads.get(track.key).promise, clear() {} }),
      createSubtitleOverlay: () => ({ applySettings() {}, render(frame = {}) { frames.push(frame); }, mount() {} })
    },
    addEventListener(type, handler) { listeners[type] = handler; },
    postMessage() {}
  };
  const storageFacade = {
    local: {
      get: (defaults, callback) => shared.get(defaults, callback),
      set: (items, callback) => shared.set(items, callback, storageFacade)
    },
    onChanged: {
      addListener(handler) {
        listeners.storage = handler;
        shared.subscribe(storageFacade, handler);
      }
    }
  };
  const runtime = {
    storage: storageFacade,
    runtime: {
      getURL: (path) => `extension://${path}`,
      id: "extension-id",
      lastError: null,
      sendMessage(message, callback) {
        if (message?.type === "BILAYER_AI_READINESS") {
          readinessMessages.push({ message, callback });
          return;
        }
        if (message?.type?.startsWith("BILAYER_") && message.type !== "BILAYER_AI_READINESS" && message.type !== "BILAYER_TRANSLATE_BATCH") {
          backgroundMessages.push(message);
          if (message.type === "BILAYER_REGISTER_TRANSLATION_CACHE_SOURCE") callback({ ok: true, sourceId: "source-42" });
          else if (message.type === "BILAYER_READ_TRANSLATION_CACHE") callback({ ok: true, snapshots: [] });
          else callback?.({ ok: true });
          return;
        }
        translationMessages.push({ message, callback });
      },
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
  runInNewContext(cacheSource, { window }, { filename: "translationCache.js" });
  const createTranslationCache = window.Bilayer.createTranslationCache;
  runInNewContext(schedulerSource, { window, Date: timer.Date }, { filename: "translationScheduler.js" });
  const createTranslationScheduler = window.Bilayer.createTranslationScheduler;
  window.Bilayer.createTranslationCache = createTranslationCache;
  window.Bilayer.createTranslationScheduler = createTranslationScheduler;
  runInNewContext(source, {
    window, document, location, browser: runtime, Date: timer.Date, URL,
    MutationObserver: class { observe() {} },
    setInterval(callback, delay) { const id = nextIntervalId++; intervals.set(id, { callback, delay, nextAt: now + delay }); return id; },
    clearInterval(id) { intervals.delete(id); }, queueMicrotask,
    setTimeout(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay, dueAt: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}
  }, { filename: "content.js" });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    listeners, frames, loads, window, video, translationMessages, readinessMessages, backgroundMessages,
    settingsSender: { id: "extension-id", url: "extension://src/settings/settings.html" }, storage: shared, clock: timer,
    advance(ms) {
      const until = now + ms;
      // 按时间顺序追平到期的一次性定时器与周期间隔（回调里新排的、以及同一时间窗内再次到期的间隔也会执行）。
      for (;;) {
        const events = [
          ...[...timers.entries()].map(([id, entry]) => ({ at: entry.dueAt, run: () => { timers.delete(id); entry.callback(); } })),
          ...[...intervals.entries()].map(([, entry]) => ({ at: entry.nextAt, run: () => { entry.nextAt += entry.delay; entry.callback(); } }))
        ].filter((event) => event.at <= until).sort((left, right) => left.at - right.at);
        if (events.length === 0) break;
        now = Math.max(now, events[0].at);
        events[0].run();
      }
      now = Math.max(now, until);
    },
    // 仍然悬挂的定时器延时（用于断言复位后没有泄漏的兜底计时器）。
    pendingTimerDelays() {
      return [...timers.values()].map((timer2) => timer2.delay);
    },
    getState() {
      let result;
      listeners.runtime({ type: "BILAYER_GET_STATE" }, null, (value) => { result = value; });
      return result;
    },
    cacheAction(action, sender = { id: "extension-id", url: "extension://src/settings/settings.html" }, episodeId) {
      let result;
      listeners.runtime({ type: "BILAYER_CACHE_ACTION", action, ...(episodeId ? { episodeId } : {}) }, sender, (value) => { result = value; });
      return result;
    },
    announce(tracks) {
      listeners.message({ source: window, data: {
        source: "bilayer-bridge", type: "tracks", payload: { tracks }
      } });
    },
    // bridge 的播放器轨道清单载荷：只在原始列表非空时发布，且必带 movieId（见 netflix-page-bridge.js queryPlayerApi）。
    announcePlayerTracks(movieId, tracks) {
      listeners.message({ source: window, data: {
        source: "bilayer-bridge", type: `player-api:${movieId}:poll`,
        payload: { source: "player-api", playerApi: true, movieId, activeTrack: null, tracks }
      } });
    },
    // 回答最近一次 BILAYER_AI_READINESS 请求；不回答时 content 保留上一次已知快照。
    answerReadiness({ configured = false, notice = null, tracksNotice = "[tracks-notice]", unreadNotice = "[unread-notice]" } = {}) {
      readinessMessages.at(-1)?.callback({ ok: true, configured, notice, tracksNotice, unreadNotice });
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

test("context changes keep accepted text and affect only newly requested subtitles", async () => {
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
  assert.equal(page.translationMessages.length, 1);
  assert.equal(page.getState().translationStatus.count, 1);
  assert.equal(page.frames.at(-1).secondaryCues[0].text, "你好。");
  page.video.currentTime = 5.5;
  page.video.emit("seeked");
  await flush();
  assert.equal(page.translationMessages.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(page.translationMessages[1].message.contextBefore)), []);
  assert.equal(page.translationMessages[1].message.items[0].id, "1");
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

// ---------------------------------------------------------------------------
// 预算：设置 → setBudget → 用量/耗尽原因 → 页面状态实时上报
// ---------------------------------------------------------------------------

const flush = () => new Promise((resolve) => setImmediate(resolve));

// 两句字幕：第一句单独成批（正文 6 + 后文 5 = 11 字符），第二句成批（正文 5 + 前文 6 = 11 字符）。
const BUDGET_CUES = [
  { startMs: 1000, endMs: 2000, text: "Hello." },
  { startMs: 5000, endMs: 6000, text: "Next." }
];

const budgetOf = (page) => JSON.parse(JSON.stringify(page.getState().translationBudget));

// 持久化台账（runtime state，跨 content 实例共享）：每个计量窗口一项，互不覆盖。
const budgetLedger = (page) => JSON.parse(JSON.stringify(page.storage.data.__ai_budget_usage__));
const storedRecord = (page, windowKey) => budgetLedger(page).records[windowKey];

// 冻结载荷里随页面新增的窗口字段：session 窗口在本页首个锚点时刻起算（测试时钟固定）。
const budgetWindow = (windowKey = "session:42", resetAt = BUDGET_EPOCH) => ({
  window: windowKey.split(":")[0], windowKey, resetAt
});

async function createTranslatingPage(stored = {}, options = {}) {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary", ...stored }, options);
  page.loads.set("en", deferred());
  page.announce([{ key: "en", language: "en", label: "English" }]);
  page.loads.get("en").resolve(BUDGET_CUES);
  await flush();
  return page;
}

function createScheduler() {
  const window = {};
  runInNewContext(schedulerSource, { window }, { filename: "translationScheduler.js" });
  const batches = [];
  const scheduler = window.Bilayer.createTranslationScheduler({
    translate: (batch) => {
      const entry = { batch, ...deferred() };
      batches.push(entry);
      return entry.promise;
    },
    onUpdate() {}
  });
  return { scheduler, batches };
}

const budgetSource = (identity, budgetKey) => ({ identity, budgetKey, cues: BUDGET_CUES, sourceLanguage: "en", targetLanguage: "zh-Hans" });

test("scheduler keeps the 80/40000 default budget until setBudget is called", async () => {
  const { scheduler } = createScheduler();
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 0, charactersUsed: 0, requestLimit: 80, characterLimit: 40000, exhausted: null
  });
});

test("setBudget accepts custom caps and reports live usage per dispatched batch", async () => {
  const { scheduler, batches } = createScheduler();
  scheduler.setBudget({ requestLimit: 3, characterLimit: 100 });
  scheduler.setSource(budgetSource("episode", "k1"));
  scheduler.observe(1500, 1);
  await flush();
  assert.equal(batches.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 3, characterLimit: 100, exhausted: null
  });

  batches[0].resolve({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(batches.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 3, characterLimit: 100, exhausted: null
  });
});

test("setBudget treats null as unlimited and ignores values that are not positive integers", async () => {
  const { scheduler, batches } = createScheduler();
  scheduler.setBudget({ requestLimit: 2, characterLimit: 30 });
  scheduler.setBudget({ requestLimit: 2.5, characterLimit: "many" });
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 0, charactersUsed: 0, requestLimit: 2, characterLimit: 30, exhausted: null
  });

  scheduler.setBudget({ requestLimit: null, characterLimit: null });
  scheduler.setSource(budgetSource("episode", "k1"));
  scheduler.observe(1500, 1);
  await flush();
  batches[0].resolve({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  batches[1].resolve({ ok: true, items: [{ id: "1", text: "下一条。" }] });
  await flush();
  assert.equal(batches.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: null, characterLimit: null, exhausted: null
  });
  assert.equal(scheduler.status().error, "");
});

test("scheduler stops at the request cap, reports exhausted requests, then resumes when the cap is raised", async () => {
  const { scheduler, batches } = createScheduler();
  scheduler.setBudget({ requestLimit: 1, characterLimit: 40000 });
  scheduler.setSource(budgetSource("episode", "k1"));
  scheduler.observe(1500, 1);
  await flush();
  assert.equal(batches.length, 1);

  batches[0].resolve({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(batches.length, 1);
  assert.equal(scheduler.status().error, "budget_exceeded");
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 1, characterLimit: 40000, exhausted: "requests"
  });

  scheduler.setBudget({ requestLimit: 5, characterLimit: 40000 });
  scheduler.observe(1500, 1);
  await flush();
  assert.equal(scheduler.status().error, "");
  assert.equal(batches.length, 2);
  assert.equal(batches[1].batch.items[0].id, "1");

  batches[1].resolve({ ok: true, items: [{ id: "1", text: "下一条。" }] });
  await flush();
  assert.equal(batches.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.translatedFor(BUDGET_CUES))), [
    { startMs: 1000, endMs: 2000, text: "你好。" },
    { startMs: 5000, endMs: 6000, text: "下一条。" }
  ]);
});

test("scheduler reports exhausted characters when the next batch alone would exceed the cap", async () => {
  const { scheduler, batches } = createScheduler();
  scheduler.setBudget({ requestLimit: 80, characterLimit: 20 });
  scheduler.setSource(budgetSource("episode", "k1"));
  scheduler.observe(1500, 1);
  await flush();
  assert.equal(batches.length, 1);

  batches[0].resolve({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(batches.length, 1);
  assert.equal(scheduler.status().error, "budget_exceeded");
  // 已用 11 < 上限 20：exhausted 记录的是被挡下的那一批（含它自身与前文/后文字符）的原因。
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 80, characterLimit: 20, exhausted: "characters"
  });
});

test("scheduler resets usage only when the watch-session key changes, not on clear()", async () => {
  const { scheduler, batches } = createScheduler();
  scheduler.setBudget({ requestLimit: 5, characterLimit: 40000 });
  scheduler.setSource(budgetSource("episode-1", "watch-1"));
  scheduler.observe(1500, 1);
  await flush();
  batches[0].resolve({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  batches[1].resolve({ ok: true, items: [{ id: "1", text: "下一条。" }] });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 5, characterLimit: 40000, exhausted: null
  });

  // 同一会话键下换源（provider/上下文等触发的重建）保留用量
  scheduler.setSource(budgetSource("episode-1b", "watch-1"));
  assert.equal(scheduler.status().budget.requestsUsed, 2);

  // clear() 不是会话边界：用量与上限都保留
  scheduler.clear();
  assert.equal(scheduler.status().phase, "off");
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 5, characterLimit: 40000, exhausted: null
  });

  // 会话键变化才是重置点，上限不变
  scheduler.setSource(budgetSource("episode-2", "watch-2"));
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 0, charactersUsed: 0, requestLimit: 5, characterLimit: 40000, exhausted: null
  });
  scheduler.observe(1500, 1);
  await flush();
  assert.equal(scheduler.status().budget.requestsUsed, 1);
});

test("clear() keeps a still-reached cap reported", async () => {
  const { scheduler, batches } = createScheduler();
  // 上限 20 而只用了 11：只有“下一批放不下”的前瞻判定能给出 characters，耗尽原因必须在 clear() 后存活。
  scheduler.setBudget({ requestLimit: 80, characterLimit: 20 });
  scheduler.setSource(budgetSource("episode-1", "watch-1"));
  scheduler.observe(1500, 1);
  await flush();
  batches[0].resolve({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 80, characterLimit: 20, exhausted: "characters"
  });

  scheduler.clear();
  assert.equal(scheduler.status().phase, "off");
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 80, characterLimit: 20, exhausted: "characters"
  });

  scheduler.setSource(budgetSource("episode-2", "watch-2"));
  assert.deepEqual(JSON.parse(JSON.stringify(scheduler.status().budget)), {
    requestsUsed: 0, charactersUsed: 0, requestLimit: 80, characterLimit: 20, exhausted: null
  });
});

test("page state always carries the budget and updates usage as translation proceeds", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 0, charactersUsed: 0, requestLimit: 80, characterLimit: 40000, exhausted: null, ...budgetWindow()
  });

  page.loads.set("en", deferred());
  page.announce([{ key: "en", language: "en", label: "English" }]);
  page.loads.get("en").resolve(BUDGET_CUES);
  await flush();
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 80, characterLimit: 40000, exhausted: null, ...budgetWindow()
  });

  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 80, characterLimit: 40000, exhausted: null, ...budgetWindow()
  });
});

test("budget settings fall back to defaults when absent, invalid, or out of range", async () => {
  const absent = await createPage({});
  assert.deepEqual(budgetOf(absent), {
    requestsUsed: 0, charactersUsed: 0, requestLimit: 80, characterLimit: 40000, exhausted: null, ...budgetWindow()
  });

  for (const stored of [
    { aiRequestBudget: "40", aiCharacterBudget: null },
    { aiRequestBudget: 3.5, aiCharacterBudget: -1 },
    { aiRequestBudget: 1001, aiCharacterBudget: 1000001 },
    { aiRequestBudget: true, aiCharacterBudget: {} }
  ]) {
    const page = await createPage(stored);
    assert.deepEqual(budgetOf(page), {
      requestsUsed: 0, charactersUsed: 0, requestLimit: 80, characterLimit: 40000, exhausted: null, ...budgetWindow()
    });
  }

  const bounds = await createPage({ aiRequestBudget: 1000, aiCharacterBudget: 1000000 });
  assert.equal(budgetOf(bounds).requestLimit, 1000);
  assert.equal(budgetOf(bounds).characterLimit, 1000000);
});

test("a zero budget means unlimited for each cap independently", async () => {
  const requestUnlimited = await createTranslatingPage({ aiRequestBudget: 0 });
  assert.equal(budgetOf(requestUnlimited).requestLimit, null);
  requestUnlimited.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.deepEqual(budgetOf(requestUnlimited), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: null, characterLimit: 40000, exhausted: null, ...budgetWindow()
  });
  assert.equal(requestUnlimited.getState().translationStatus.error, "");

  const characterUnlimited = await createTranslatingPage({ aiCharacterBudget: 0 });
  assert.equal(budgetOf(characterUnlimited).characterLimit, null);
  characterUnlimited.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.deepEqual(budgetOf(characterUnlimited), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 80, characterLimit: null, exhausted: null, ...budgetWindow()
  });
  assert.equal(characterUnlimited.getState().translationStatus.error, "");
});

test("character cap reports exhausted characters and stops before the cap is exceeded", async () => {
  const page = await createTranslatingPage({ aiCharacterBudget: 20 });
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 80, characterLimit: 20, exhausted: null, ...budgetWindow()
  });

  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(page.translationMessages.length, 1);
  assert.equal(page.getState().translationStatus.error, "budget_exceeded");
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 80, characterLimit: 20, exhausted: "characters", ...budgetWindow()
  });
});

test("lowering either cap mid-session stops further requests at once and keeps rendered lines", async () => {
  const page = await createTranslatingPage();
  assert.equal(page.translationMessages.length, 1);

  page.listeners.storage({ aiCharacterBudget: { newValue: 10 } }, "local");
  await flush();
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 80, characterLimit: 10, exhausted: "characters", ...budgetWindow()
  });
  assert.equal(page.translationMessages.length, 1);

  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(page.translationMessages.length, 1);
  assert.equal(page.getState().translationStatus.error, "budget_exceeded");
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "你好。");

  page.listeners.storage({ aiRequestBudget: { newValue: 1 } }, "local");
  await flush();
  assert.equal(page.getState().translationStatus.error, "budget_exceeded");
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 1, characterLimit: 10, exhausted: "requests", ...budgetWindow()
  });
  assert.equal(page.translationMessages.length, 1);
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "你好。");
});

test("raising a cap mid-session resumes translation without losing translated lines", async () => {
  const page = await createTranslatingPage({ aiRequestBudget: 1 });
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(page.translationMessages.length, 1);
  assert.equal(page.getState().translationStatus.error, "budget_exceeded");
  assert.equal(page.getState().translationStatus.count, 1);
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 1, characterLimit: 40000, exhausted: "requests", ...budgetWindow()
  });

  page.listeners.storage({ aiRequestBudget: { newValue: 5 } }, "local");
  await flush();
  assert.equal(page.getState().translationStatus.error, "");
  assert.equal(page.translationMessages.length, 2);
  assert.equal(page.translationMessages[1].message.items[0].id, "1");
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 5, characterLimit: 40000, exhausted: null, ...budgetWindow()
  });

  page.translationMessages[1].callback({ ok: true, items: [{ id: "1", text: "下一条。" }] });
  await flush();
  assert.equal(page.getState().translationStatus.count, 2);
  assert.equal(page.translationMessages.filter(({ message }) => message.items.some(({ id }) => id === "0")).length, 1);
});

test("budget usage survives in-session settings changes and reloads within the watch session", async () => {
  const page = await createTranslatingPage({ aiRequestBudget: 3, aiCharacterBudget: 5000 });
  assert.equal(budgetOf(page).requestsUsed, 1);

  // AI 设置变更会触发 translator.clear()，但它不是窗口边界：已用额度不得回零，重译的那次继续累加
  page.listeners.storage({ aiStyleGuide: { newValue: "自定义翻译风格" } }, "local");
  await flush();
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 3, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });

  // 会话被拆除（clearSubtitleState 递增 subtitleEpoch 后重新读字幕）时用量仍然保留
  page.listeners.runtime({ type: "BILAYER_RELOAD" }, null, () => {});
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 3, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });

  // 同一集的重新加载不换计量窗口：新一轮字幕加载继续在原有额度上累加
  page.loads.set("en", deferred());
  page.announce([{ key: "en", language: "en", label: "English" }]);
  page.loads.get("en").resolve(BUDGET_CUES);
  await flush();
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 3, charactersUsed: 33, requestLimit: 3, characterLimit: 5000, exhausted: "requests", ...budgetWindow()
  });

  // 同一份用量已经持久化，刷新页面（同一窗口）后从 3/33 继续
  assert.deepEqual(storedRecord(page, "session:42"), {
    requests: 3, characters: 33, startedAt: BUDGET_EPOCH, updatedAt: BUDGET_EPOCH
  });

  // 顶到上限后继续观剧不会再派发（窗口不因设置变更而重置，也就不会重新武装额度）
  page.video.emit("timeupdate");
  await flush();
  assert.equal(page.translationMessages.length, 3);
});

// ---------------------------------------------------------------------------
// 计量窗口：持久化跨刷新、窗口身份、多标签页合并与等待占位
// ---------------------------------------------------------------------------

test("translation budget persists across a reload of the same watch page", async () => {
  const storage = createStorage();
  const first = await createTranslatingPage({ aiRequestBudget: 5, aiCharacterBudget: 5000 }, { storage });
  assert.equal(first.translationMessages.length, 1);
  assert.deepEqual(budgetOf(first), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 5, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });

  // 刷新同一集页面：新的 content 实例、同一份 runtime.storage.local，计数从 1/11 继续
  const second = await createTranslatingPage({ aiRequestBudget: 5, aiCharacterBudget: 5000 }, { storage });
  assert.equal(second.translationMessages.length, 1);
  assert.deepEqual(budgetOf(second), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 5, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });
  assert.deepEqual(storedRecord(second, "session:42"), {
    requests: 2, characters: 22, startedAt: BUDGET_EPOCH, updatedAt: BUDGET_EPOCH
  });
});

test("a different watch id starts a fresh budget window", async () => {
  const storage = createStorage();
  const first = await createTranslatingPage({ aiRequestBudget: 5 }, { storage });
  assert.equal(first.translationMessages.length, 1);

  // 换剧集/标题：session 窗口锚在 watchId 上，新键从 0 起算并重写锚点
  const second = await createTranslatingPage({ aiRequestBudget: 5 }, { storage, pathname: "/watch/99" });
  assert.equal(second.translationMessages.length, 1);
  assert.deepEqual(budgetOf(second), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 5, characterLimit: 40000, exhausted: null,
    ...budgetWindow("session:99")
  });
  assert.deepEqual(storedRecord(second, "session:99"), {
    requests: 1, characters: 11, startedAt: BUDGET_EPOCH, updatedAt: BUDGET_EPOCH
  });

  // 两集在同一本台账里各占一项：互不覆盖，各自继续在自己的计数上累加
  first.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(budgetOf(first).requestsUsed, 2);
  assert.equal(budgetOf(second).requestsUsed, 1);
  assert.equal(storedRecord(first, "session:42").requests, 2);
  assert.equal(storedRecord(first, "session:99").requests, 1);

  second.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(budgetOf(second).requestsUsed, 2);
  assert.equal(budgetOf(first).requestsUsed, 2);
  assert.equal(storedRecord(first, "session:42").requests, 2);
  assert.equal(storedRecord(first, "session:99").requests, 2);
});

test("a non-watch page shows zero usage without stealing the watch anchor", async () => {
  const storage = createStorage();
  const watch = await createTranslatingPage({ aiRequestBudget: 5 }, { storage });
  assert.equal(budgetOf(watch).requestsUsed, 1);

  // 浏览页/首页（没有 watchId）不会派发请求，也就不该覆盖存储里那条锚点
  const browse = await createPage({}, { storage, pathname: "/browse" });
  const browseBudget = budgetOf(browse);
  assert.equal(browseBudget.windowKey, "session:");
  assert.equal(browseBudget.requestsUsed, 0);
  assert.equal(browseBudget.resetAt, null);
  assert.deepEqual(budgetLedger(browse).records, {
    "session:42": { requests: 1, characters: 11, startedAt: BUDGET_EPOCH, updatedAt: BUDGET_EPOCH }
  });

  // 观剧页的下一批继续在自己的窗口键上累计
  watch.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(budgetOf(watch).requestsUsed, 2);
  assert.deepEqual(storedRecord(watch, "session:42"), {
    requests: 2, characters: 22, startedAt: BUDGET_EPOCH, updatedAt: BUDGET_EPOCH
  });
});

test("hour and day windows roll over and re-anchor", async () => {
  const hourStart = (ms) => {
    const date = new Date(ms);
    date.setMinutes(0, 0, 0);
    return date.getTime();
  };

  // 整点翻页：同一标签页跨过整点后按新桶从 0 起算
  const hourStorage = createStorage();
  const clock = createClock(BUDGET_EPOCH);
  const hour = await createTranslatingPage(
    { aiRequestBudget: 5, aiBudgetWindow: "hour", aiPrefetchCount: 0 }, { storage: hourStorage, clock }
  );
  assert.equal(hour.translationMessages.length, 1);
  const beforeHour = budgetOf(hour);
  assert.equal(beforeHour.window, "hour");
  assert.match(beforeHour.windowKey, /^hour:\d{4}-\d{2}-\d{2}T\d{2}$/);
  assert.equal(beforeHour.resetAt, hourStart(BUDGET_EPOCH));
  assert.equal(beforeHour.requestsUsed, 1);

  hour.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(hour.translationMessages.length, 1);       // 预取关闭：只有当前句被派出

  const nextHour = BUDGET_EPOCH + 3600000;
  hour.clock.set(nextHour);
  hour.video.emit("timeupdate");
  await flush();
  const afterHour = budgetOf(hour);
  assert.notEqual(afterHour.windowKey, beforeHour.windowKey);
  assert.equal(afterHour.resetAt, hourStart(nextHour));
  assert.equal(afterHour.requestsUsed, 0);                // 新桶：不是累计的 1
  assert.deepEqual(storedRecord(hour, afterHour.windowKey), {
    requests: 0, characters: 0, startedAt: nextHour, updatedAt: nextHour
  });

  // 新桶里的下一次派发从 1 开始计，而不是接着旧桶的数字
  hour.video.currentTime = 5.5;
  hour.video.emit("timeupdate");
  await flush();
  assert.equal(hour.translationMessages.length, 2);
  assert.equal(budgetOf(hour).requestsUsed, 1);
  assert.equal(budgetOf(hour).charactersUsed, 11);
  assert.deepEqual(storedRecord(hour, afterHour.windowKey), {
    requests: 1, characters: 11, startedAt: nextHour, updatedAt: nextHour
  });

  // 跨日：day 桶同样换键重锚
  const dayStorage = createStorage();
  const dayClock = createClock(BUDGET_EPOCH);
  const day = await createTranslatingPage(
    { aiRequestBudget: 5, aiBudgetWindow: "day", aiPrefetchCount: 0 }, { storage: dayStorage, clock: dayClock }
  );
  const beforeDay = budgetOf(day);
  assert.equal(beforeDay.window, "day");
  assert.match(beforeDay.windowKey, /^day:\d{4}-\d{2}-\d{2}$/);
  assert.equal(beforeDay.requestsUsed, 1);
  day.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();

  const nextDay = new Date(2026, 0, 16, 10, 30, 0).getTime();
  dayClock.set(nextDay);
  day.video.emit("timeupdate");
  await flush();
  const afterDay = budgetOf(day);
  assert.notEqual(afterDay.windowKey, beforeDay.windowKey);
  assert.match(afterDay.windowKey, /^day:\d{4}-\d{2}-\d{2}$/);
  assert.equal(afterDay.requestsUsed, 0);
  assert.deepEqual(storedRecord(day, afterDay.windowKey), {
    requests: 0, characters: 0, startedAt: nextDay, updatedAt: nextDay
  });
});

test("an invalid aiBudgetWindow falls back to the session window", async () => {
  for (const stored of [{ aiBudgetWindow: "weekly" }, { aiBudgetWindow: 7 }, { aiBudgetWindow: null }, {}]) {
    const page = await createPage(stored);
    assert.equal(page.getState().settings.aiBudgetWindow, "session");
    assert.deepEqual(budgetOf(page), {
      requestsUsed: 0, charactersUsed: 0, requestLimit: 80, characterLimit: 40000, exhausted: null, ...budgetWindow()
    });
  }

  // 设置里写非法值：运行期也回落 session，不把窗口键变成垃圾值
  const page = await createTranslatingPage({ aiRequestBudget: 5 });
  page.listeners.storage({ aiBudgetWindow: { newValue: "month" } }, "local");
  await flush();
  assert.equal(page.getState().settings.aiBudgetWindow, "session");
  assert.equal(budgetOf(page).windowKey, "session:42");

  // 切到合法窗口：即刻换锚并按新窗口的持久化用量起算
  page.listeners.storage({ aiBudgetWindow: { newValue: "day" } }, "local");
  await flush();
  assert.equal(budgetOf(page).window, "day");
  assert.match(budgetOf(page).windowKey, /^day:\d{4}-\d{2}-\d{2}$/);
  assert.equal(budgetOf(page).requestsUsed, 0);
});

test("a second tab cannot double the cap because dispatch re-reads persisted usage", async () => {
  const storage = createStorage();
  const tabA = await createTranslatingPage({ aiRequestBudget: 2, aiCharacterBudget: 5000 }, { storage });
  tabA.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(tabA.translationMessages.length, 2);
  tabA.translationMessages[1].callback({ ok: true, items: [{ id: "1", text: "下一条。" }] });
  await flush();
  assert.deepEqual(budgetOf(tabA), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 2, characterLimit: 5000, exhausted: "requests", ...budgetWindow()
  });
  assert.deepEqual(storedRecord(tabA, "session:42"), {
    requests: 2, characters: 22, startedAt: BUDGET_EPOCH, updatedAt: BUDGET_EPOCH
  });

  // 同一集新开标签页：启动读到的就是 2/2，派发前再对齐一次，因此一条都不会再发
  const tabB = await createTranslatingPage({ aiRequestBudget: 2, aiCharacterBudget: 5000 }, { storage });
  assert.equal(tabB.translationMessages.length, 0);
  assert.equal(tabB.getState().translationStatus.error, "budget_exceeded");
  assert.deepEqual(budgetOf(tabB), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 2, characterLimit: 5000, exhausted: "requests", ...budgetWindow()
  });
});

test("another tab's consumption arrives through storage changes", async () => {
  const storage = createStorage();
  const tabB = await createTranslatingPage({ aiRequestBudget: 5, aiCharacterBudget: 5000 }, { storage });
  assert.deepEqual(budgetOf(tabB), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 5, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });
  const beforeA = storage.data.__ai_budget_usage__;

  // 第二个标签页启动时读回 B 的 1/11，派发前再对齐一次，因此从 2/22 开始
  const tabA = await createTranslatingPage({ aiRequestBudget: 5, aiCharacterBudget: 5000 }, { storage });
  assert.equal(tabA.translationMessages.length, 1);
  assert.deepEqual(budgetOf(tabA), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 5, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });
  // B 没有派发也没有刷新，却经 storage.onChanged 立刻看到 A 的消耗
  assert.notEqual(beforeA, storage.data.__ai_budget_usage__);
  assert.deepEqual(budgetOf(tabB), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 5, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });

  // A 再发一批：两地读数一起前进到 3/33
  tabA.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(tabA.translationMessages.length, 2);
  assert.deepEqual(budgetOf(tabA), {
    requestsUsed: 3, charactersUsed: 33, requestLimit: 5, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });
  assert.deepEqual(budgetOf(tabB), {
    requestsUsed: 3, charactersUsed: 33, requestLimit: 5, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });
});

test("a persisted cap keeps stopping new tabs and resumes when the cap is raised", async () => {
  const storage = createStorage();
  const first = await createTranslatingPage({ aiRequestBudget: 1, aiCharacterBudget: 5000 }, { storage });
  first.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(budgetOf(first).exhausted, "requests");

  // 刷新后仍是 1/1：上限与用量都来自持久化，不会因为重新加载而重新开闸
  const second = await createTranslatingPage({ aiRequestBudget: 1, aiCharacterBudget: 5000 }, { storage });
  assert.equal(second.translationMessages.length, 0);
  assert.deepEqual(budgetOf(second), {
    requestsUsed: 1, charactersUsed: 11, requestLimit: 1, characterLimit: 5000, exhausted: "requests", ...budgetWindow()
  });

  // 提高上限：在已有用量上继续，而不是从 0 重新计
  second.listeners.storage({ aiRequestBudget: { newValue: 5 } }, "local");
  await flush();
  assert.equal(second.getState().translationStatus.error, "");
  assert.equal(second.translationMessages.length, 1);
  assert.deepEqual(budgetOf(second), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 5, characterLimit: 5000, exhausted: null, ...budgetWindow()
  });

  // 降低到已用量以下：立即停发，已渲染的译文保留
  second.listeners.storage({ aiRequestBudget: { newValue: 2 } }, "local");
  await flush();
  assert.deepEqual(budgetOf(second), {
    requestsUsed: 2, charactersUsed: 22, requestLimit: 2, characterLimit: 5000, exhausted: "requests", ...budgetWindow()
  });
  second.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(second.getState().translationStatus.error, "budget_exceeded");
  assert.equal(second.translationMessages.length, 1);
  assert.equal(second.frames.at(-1)?.secondaryCues?.[0]?.text, "你好。");
});

test("the AI row reports a pending role only while a translation can still arrive", async () => {
  const page = await createTranslatingPage({ aiPrefetchCount: 0 });
  assert.equal(page.translationMessages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.pending)), { secondary: true });
  assert.equal(page.frames.at(-1)?.secondaryCues?.length, 0);

  // 译文到达：等待标记撤销，译文进入该行
  page.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.pending)), {});
  assert.equal(page.frames.at(-1)?.secondaryCues?.[0]?.text, "你好。");

  // 永久失败：不再有等待占位，原生回退行照常显示
  const failing = await createTranslatingPage({ aiPrefetchCount: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(failing.frames.at(-1)?.pending)), { secondary: true });
  failing.translationMessages[0].callback({ ok: false, errorCode: "auth" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(failing.frames.at(-1)?.pending)), {});
  assert.equal(failing.getState().translationStatus.error, "auth");

  // 额度断流：那一行根本不会被派出，因此不能留下永不消失的等待占位
  const stopped = await createTranslatingPage({ aiRequestBudget: 1, aiPrefetchCount: 1 });
  stopped.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(stopped.getState().translationStatus.error, "budget_exceeded");
  stopped.video.currentTime = 5.5;
  stopped.video.emit("timeupdate");
  await flush();
  assert.equal(stopped.translationMessages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(stopped.frames.at(-1)?.pending)), {});
  assert.equal(stopped.frames.at(-1)?.secondaryCues?.length, 0);
});

test("episodes keep separate ledger entries so a reload recovers its own count", async () => {
  const storage = createStorage();
  const episodeA = await createTranslatingPage({ aiRequestBudget: 5 }, { storage });
  const episodeB = await createTranslatingPage({ aiRequestBudget: 5 }, { storage, pathname: "/watch/99" });
  episodeA.translationMessages[0].callback({ ok: true, items: [{ id: "0", text: "你好。" }] });
  await flush();
  assert.equal(budgetOf(episodeA).requestsUsed, 2);
  assert.equal(budgetOf(episodeB).requestsUsed, 1);

  // 两条记录并存：B 的启动与写入不会覆盖 A 的窗口项
  assert.deepEqual(storedRecord(episodeB, "session:42"), {
    requests: 2, characters: 22, startedAt: BUDGET_EPOCH, updatedAt: BUDGET_EPOCH
  });
  assert.deepEqual(storedRecord(episodeB, "session:99"), {
    requests: 1, characters: 11, startedAt: BUDGET_EPOCH, updatedAt: BUDGET_EPOCH
  });

  // A 刷新（新 content 实例）：从自己的 2/22 继续，而不是被 B 的窗口项带回 0
  const reloadedA = await createTranslatingPage({ aiRequestBudget: 5 }, { storage });
  assert.equal(reloadedA.translationMessages.length, 1);
  assert.deepEqual(budgetOf(reloadedA), {
    requestsUsed: 3, charactersUsed: 33, requestLimit: 5, characterLimit: 40000, exhausted: null, ...budgetWindow()
  });
  // B 的记录与读数都不受影响
  assert.deepEqual(storedRecord(reloadedA, "session:99"), {
    requests: 1, characters: 11, startedAt: BUDGET_EPOCH, updatedAt: BUDGET_EPOCH
  });
  assert.equal(budgetOf(episodeB).requestsUsed, 1);
});

test("the persisted ledger stays bounded and keeps the current window", async () => {
  const storage = createStorage();
  const clock = createClock(BUDGET_EPOCH);
  const keys = [];
  let page = null;
  let now = BUDGET_EPOCH;
  for (const id of [11, 12, 13, 14, 15]) {
    now += 1000;
    clock.set(now);
    page = await createTranslatingPage({ aiRequestBudget: 5 }, { storage, clock, pathname: `/watch/${id}` });
    keys.push(`session:${id}`);
  }

  const records = budgetLedger(page).records;
  assert.deepEqual(Object.keys(records).sort(), keys.slice(-4).sort());
  assert.equal(records[keys.at(-1)].requests, 1);       // 当前窗口必留
  assert.equal(records[keys[0]], undefined);            // 最早写入的那一项被淘汰
});

test("the legacy single-record ledger migrates into the per-window map", async () => {
  const storage = createStorage();
  const legacyStartedAt = BUDGET_EPOCH - 60000;
  storage.data.__ai_budget_usage__ = {
    windowKey: "session:42", requests: 4, characters: 40, startedAt: legacyStartedAt
  };
  const page = await createPage(
    { primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary", aiRequestBudget: 5 }, { storage }
  );

  // 旧形状启动即迁移成映射，沿用旧记录里的既用量与窗口起点
  const ledger = budgetLedger(page);
  assert.equal(ledger.windowKey, undefined);
  assert.deepEqual(ledger.records, {
    "session:42": { requests: 4, characters: 40, startedAt: legacyStartedAt, updatedAt: BUDGET_EPOCH }
  });
  assert.deepEqual(budgetOf(page), {
    requestsUsed: 4, charactersUsed: 40, requestLimit: 5, characterLimit: 40000, exhausted: null,
    ...budgetWindow("session:42", legacyStartedAt)
  });

  // 迁移后的第一批在自己的窗口项上继续累加，而不是从 0 重新开闸
  page.loads.set("en", deferred());
  page.announce([{ key: "en", language: "en", label: "English" }]);
  page.loads.get("en").resolve(BUDGET_CUES);
  await flush();
  assert.equal(page.translationMessages.length, 1);
  assert.deepEqual(storedRecord(page, "session:42"), {
    requests: 5, characters: 51, startedAt: legacyStartedAt, updatedAt: BUDGET_EPOCH
  });
  assert.equal(budgetOf(page).exhausted, "requests");
});

// ---------------------------------------------------------------------------
// 字幕可用性（播放器轨道清单报告）与字幕位置的 AI 提示行
// ---------------------------------------------------------------------------

test("subtitle availability follows player track-list reports and never downgrades for the same title", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  assert.equal(page.getState().subtitleAvailability, "unknown");

  // 普通载荷（无 movieId、非播放器清单）不足以判定：播放器还没报告过轨道
  page.announce([{ key: "en", language: "en", label: "English" }]);
  assert.equal(page.getState().subtitleAvailability, "unknown");

  // 播放器清单报告（bridge 只在原始列表非空时发布，故空结果＝本片没有可用轨道）
  page.announcePlayerTracks("80000001", []);
  assert.equal(page.getState().subtitleAvailability, "none");

  // 同一影片随后报出可用轨道：升级为 available
  page.announcePlayerTracks("80000001", [{ key: "en", language: "en", label: "English" }]);
  assert.equal(page.getState().subtitleAvailability, "available");

  // 同一影片的空报告不得回退
  page.announcePlayerTracks("80000001", []);
  assert.equal(page.getState().subtitleAvailability, "available");

  // 同一 watchId 下换片（movieId 变化）：解除锁定，按新片证据重新判定
  page.announcePlayerTracks("80000002", []);
  assert.equal(page.getState().subtitleAvailability, "none");
});

test("a watch-id change resets availability until the new title reports", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  page.announcePlayerTracks("80000001", [{ key: "en", language: "en", label: "English" }]);
  assert.equal(page.getState().subtitleAvailability, "available");

  // Netflix SPA 换集：路由变了，新影片的轨道证据还没到
  page.window.location.pathname = "/watch/43";
  page.announce([]);
  assert.equal(page.getState().subtitleAvailability, "unknown");
  await flush();

  page.announcePlayerTracks("80000002", []);
  assert.equal(page.getState().subtitleAvailability, "none");
});

test("AI mode shows the localized hint at the subtitle position with tracks outranking the provider", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  const source = deferred();
  page.loads.set("en", source);
  page.announce([{ key: "en", language: "en", label: "English" }]);
  source.resolve([]);
  await flush();
  // 后台还没回答就绪度：宁可不显示，也不显示半句话
  assert.equal(page.frames.at(-1)?.notice ?? null, null);

  page.answerReadiness({ configured: false, notice: "[provider-missing]", tracksNotice: "[tracks-missing]" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[provider-missing]", kind: "warning" });

  // 本片没有可用轨道：轨道提示优先于 provider 提示
  page.announcePlayerTracks("80000001", []);
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[tracks-missing]", kind: "warning" });

  // provider 已配置，轨道缺失仍优先
  page.answerReadiness({ configured: true, notice: null, tracksNotice: "[tracks-missing]" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[tracks-missing]", kind: "warning" });

  // 轨道出现：提示自动消失，无需刷新页面
  page.announcePlayerTracks("80000001", [{ key: "en", language: "en", label: "English" }]);
  assert.equal(page.getState().subtitleAvailability, "available");
  assert.equal(page.frames.at(-1)?.notice ?? null, null);
});

test("the provider hint disappears once a provider becomes configured, without a reload", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary", aiProviderId: "custom" });
  page.answerReadiness({ configured: false, notice: "[provider-missing]", tracksNotice: "[tracks-missing]" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[provider-missing]", kind: "warning" });

  // 用户写入凭证：content 立即重问后台，不需要刷新页面
  const requests = page.readinessMessages.length;
  page.listeners.storage({ providers: { newValue: [{ id: "custom", name: "Custom", endpoint: "", model: "m", credential: "sk-live" }] } }, "local");
  assert.equal(page.readinessMessages.length, requests + 1);
  page.answerReadiness({ configured: true, notice: null, tracksNotice: "[tracks-missing]" });
  await flush();
  assert.equal(page.frames.at(-1)?.notice ?? null, null);
  assert.deepEqual(JSON.parse(JSON.stringify(page.getState().providerReadiness)), { configured: true, notice: null });
});

test("native (AI off) mode never carries a notice and the page state exposes trimmed readiness", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiRole: "off" });
  page.answerReadiness({ configured: false, notice: "[provider-missing]", tracksNotice: "[tracks-missing]" });
  await flush();
  page.announcePlayerTracks("80000001", []);

  assert.equal(page.getState().subtitleAvailability, "none");
  assert.equal(page.frames.at(-1)?.notice, null);
  assert.deepEqual(JSON.parse(JSON.stringify(page.getState().providerReadiness)),
    { configured: false, notice: "[provider-missing]" });
});

test("the popup state poll refreshes provider readiness", async () => {
  const page = await createPage({});
  const requests = page.readinessMessages.length;
  const state = page.getState();
  // 轮询顺带重问后台，但本次响应仍携带上一轮快照
  assert.equal(page.readinessMessages.length, requests + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(state.providerReadiness)), { configured: false, notice: null });

  page.answerReadiness({ configured: true, notice: null });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(page.getState().providerReadiness)), { configured: true, notice: null });
});

// ---------------------------------------------------------------------------
// 轨道读取超时（unread）：兜底计时器 20s，与 none 的证据强度严格分开
// ---------------------------------------------------------------------------

test("a watch page with a video and no player report stays unknown until 20s then turns unread", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  // 启动即武装兜底计时器：watch 页 + video 已就绪 + 尚无 player-api 载荷
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), [20000]);

  page.advance(19999);
  assert.equal(page.getState().subtitleAvailability, "unknown");

  page.advance(1);
  assert.equal(page.getState().subtitleAvailability, "unread");
  // 到期即卸载计时器，不留悬挂
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), []);

  // unread 的提示行在 AI 模式下出现（文案来自 background，本地化键缺失就不显示）
  page.answerReadiness({ configured: true, notice: null, unreadNotice: "[tracks-unread]" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[tracks-unread]", kind: "warning" });

  // 与 popup 同序：provider 未配置是可操作提示，优先于 unread 这个观察态软提示
  page.answerReadiness({ configured: false, notice: "[provider-missing]", unreadNotice: "[tracks-unread]" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[provider-missing]", kind: "warning" });

  // 配置好之后 unread 提示自己回来，无需刷新页面
  page.answerReadiness({ configured: true, notice: null, unreadNotice: "[tracks-unread]" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[tracks-unread]", kind: "warning" });
});

test("a late player report moves unread to none/available and drops the stall notice", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  page.answerReadiness({ configured: true, notice: null, tracksNotice: "[tracks-missing]", unreadNotice: "[tracks-unread]" });
  await flush();
  page.advance(20000);
  assert.equal(page.getState().subtitleAvailability, "unread");
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[tracks-unread]", kind: "warning" });

  // 超时之后才到的载荷仍然有效：空清单 → none（换成“本片无轨道”的文案），绝不停留在 unread
  page.announcePlayerTracks("80000001", []);
  assert.equal(page.getState().subtitleAvailability, "none");
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[tracks-missing]", kind: "warning" });

  // 同一影片报出可用轨道 → available，提示消失
  page.announcePlayerTracks("80000001", [{ key: "en", language: "en", label: "English" }]);
  assert.equal(page.getState().subtitleAvailability, "available");
  assert.equal(page.frames.at(-1)?.notice ?? null, null);
});

test("a payload before the deadline cancels the stall timer", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  page.announcePlayerTracks("80000001", [{ key: "en", language: "en", label: "English" }]);
  assert.equal(page.getState().subtitleAvailability, "available");
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), []);

  // 即使把时钟推过 20s，也不会有迟到的 unread 覆盖 available
  page.advance(60000);
  assert.equal(page.getState().subtitleAvailability, "available");
});

test("available never downgrades when an empty payload arrives after the deadline", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  page.announcePlayerTracks("80000001", [{ key: "en", language: "en", label: "English" }]);
  page.advance(20000);
  page.announcePlayerTracks("80000001", []);
  assert.equal(page.getState().subtitleAvailability, "available");
});

test("watch-id, movie-id and reload boundaries reset to unknown and restart the stall timer", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  page.advance(20000);
  assert.equal(page.getState().subtitleAvailability, "unread");

  // 换集（watchId 变化）：回到 unknown，并且重新武装 20s 计时器
  page.window.location.pathname = "/watch/43";
  page.announce([]);
  assert.equal(page.getState().subtitleAvailability, "unknown");
  await flush();
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), [20000]);
  page.advance(20000);
  assert.equal(page.getState().subtitleAvailability, "unread");

  // 同一 watchId 下换片（movieId 变化）：解除 available 锁定，按新片载荷重新判定（否则会因为锁定而停在 available）
  page.announcePlayerTracks("80000001", [{ key: "en", language: "en", label: "English" }]);
  assert.equal(page.getState().subtitleAvailability, "available");
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), []);
  page.announcePlayerTracks("80000002", []);
  assert.equal(page.getState().subtitleAvailability, "none");
  // 换片复位时会先武装兜底计时器，载荷到达后立即取消：不留悬挂
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), []);

  // 换集且新片迟迟没有载荷：计时器兜底推进到 unread
  page.window.location.pathname = "/watch/44";
  page.announce([]);
  assert.equal(page.getState().subtitleAvailability, "unknown");
  await flush();
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), [20000]);
  page.advance(20000);
  assert.equal(page.getState().subtitleAvailability, "unread");

  // BILAYER_RELOAD：显式重载同样复位并重启计时器
  page.listeners.runtime({ type: "BILAYER_RELOAD" }, null, () => {});
  assert.equal(page.getState().subtitleAvailability, "unknown");
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), [20000]);
});

test("no stall timer is armed outside a watch page", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" }, { pathname: "/browse" });
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), []);

  // 越过 20s 也不会有任何 unread
  page.advance(60000);
  assert.equal(page.getState().subtitleAvailability, "unknown");

  // 同一页面随后进入 watch 页：计时器才武装
  page.window.location.pathname = "/watch/42";
  page.announce([]);
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), [20000]);

  // 再离开 watch 页：定位轮询（500ms）走复位路径，取消计时器，不留悬挂
  page.window.location.pathname = "/browse";
  page.advance(500);
  assert.equal(page.getState().subtitleAvailability, "unknown");
  assert.deepEqual(page.pendingTimerDelays().filter((delay) => delay === 20000), []);

  // 离开后再越过 20s：仍然不会有 unread（没有播放上下文，就没有兜底判定）
  page.advance(20000);
  assert.equal(page.getState().subtitleAvailability, "unknown");
  // 复位路径把兜底计时器彻底清干净：此时页面上不应再有任何悬挂定时器
  assert.deepEqual(page.pendingTimerDelays(), []);
});
test("cache preferences normalize to safe documented defaults and bounds", async () => {
 const page = await createPage({ aiCacheMode: "remote", aiCachePolicy: "unbounded", aiCacheRetentionDays: 4000, aiCacheMaxMiB: -1 });
 assert.equal(page.getState().settings.aiCacheMode, "session");
 assert.equal(page.getState().settings.aiCachePolicy, "prefer");
 assert.equal(page.getState().settings.aiCacheRetentionDays, 30);
 assert.equal(page.getState().settings.aiCacheMaxMiB, 256);
});

test("an unread page without a loadable unread notice shows no empty pill", async () => {
  const page = await createPage({ primaryTrackKey: "en", aiSourceTrackKey: "en", aiRole: "secondary" });
  // 本地化键缺失（后台给空串）：宁可没有提示行，也不显示空文本
  page.answerReadiness({ configured: true, notice: null, tracksNotice: "[tracks-missing]", unreadNotice: "" });
  await flush();
  page.advance(20000);
  assert.equal(page.getState().subtitleAvailability, "unread");
  assert.equal(page.frames.at(-1)?.notice ?? null, null);

  // provider 也未配置但其文案同样缺失：两条都是空文本，依旧没有提示条（不显示半句无意义的话）
  page.answerReadiness({ configured: false, notice: null, tracksNotice: "", unreadNotice: "" });
  await flush();
  assert.equal(page.frames.at(-1)?.notice ?? null, null);

  // 只有 provider 文案可解析时按新优先级显示 provider 提示（unread 让位）
  page.answerReadiness({ configured: false, notice: "[provider-missing]", unreadNotice: "[tracks-unread]" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(page.frames.at(-1)?.notice)), { text: "[provider-missing]", kind: "warning" });
});
test("cache management actions accept only the settings page and report the active episode", async () => {
  const page = await createPage({ aiRole: "secondary" });
  const state = page.getState();
  assert.equal(state.episodeId, "42");
  assert.equal(state.translationCache.mode, "session");
  assert.equal(state.translationCache.policy, "prefer");

  assert.equal(page.cacheAction("clear-current", { id: "untrusted", url: "src/settings/settings.html" }), undefined);
  assert.equal(page.cacheAction("clear-all", { id: "extension-id", url: "https://example.test/src/settings/settings.html" }), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(page.cacheAction("clear-current"))), { ok: true, episodeId: "42" });
  assert.deepEqual(JSON.parse(JSON.stringify(page.cacheAction("retranslate", page.settingsSender, "another-episode"))), { ok: true, episodeId: "42" });
});
