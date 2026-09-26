/**
 * [INPUT]: 依赖 Node.js test/vm 与扩展 content.js 源码，使用可控浏览器消息和字幕加载器
 * [OUTPUT]: 验证页面状态不泄露扩展私有存储、快轨字幕不受慢轨阻塞
 * [POS]: scripts 的内容脚本行为回归检查，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/content/content.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function createPage(stored = {}) {
  const listeners = {};
  const frames = [];
  const loads = new Map();
  const location = { pathname: "/watch/42", href: "https://www.netflix.com/watch/42", origin: "https://www.netflix.com" };
  const video = {
    currentTime: 1.5,
    addEventListener() {},
    removeEventListener() {}
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
  runInNewContext(source, {
    window, document, location, browser: runtime,
    MutationObserver: class { observe() {} },
    setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}
  }, { filename: "content.js" });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    listeners, frames, loads, window,
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

test("private storage values never appear in popup page state", async () => {
  const page = await createPage({ aiCredential: "stored-secret" });
  assert.equal(page.getState().settings.aiCredential, undefined);

  page.listeners.storage({
    aiCredential: { newValue: "updated-secret" },
    timingOffsetMs: { newValue: 250 }
  }, "local");
  const settings = page.getState().settings;
  assert.equal(settings.aiCredential, undefined);
  assert.equal(settings.timingOffsetMs, 250);
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
