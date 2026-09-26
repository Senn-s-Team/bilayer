/**
 * [INPUT]: 依赖 Node.js test/vm 与真实 subtitleStore.js、可控字幕下载回调
 * [OUTPUT]: 验证同轨加载合并、剧集切换后旧响应不污染新缓存
 * [POS]: scripts 的字幕数据层行为回归检查，不进入扩展运行时
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/content/subtitleStore.js", import.meta.url), "utf8");
const track = { key: "en", language: "en", url: "https://example.test/subtitles.vtt" };

function createStore() {
  const requests = [];
  const window = {
    location: { origin: "https://www.netflix.com" },
    addEventListener() {},
    NetflixDualSubtitles: {
      parseSubtitle(text) { return [{ startMs: 1000, endMs: 2000, text }]; }
    }
  };
  const browser = { runtime: { sendMessage(message, callback) { requests.push(callback); } } };
  runInNewContext(source, { window, browser, setTimeout, clearTimeout }, { filename: "subtitleStore.js" });
  return { store: window.NetflixDualSubtitles.createSubtitleStore(), requests };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("concurrent loads of the same track share a download", async () => {
  const { store, requests } = createStore();
  const first = store.load(track);
  const second = store.load(track);
  await flush();
  assert.equal(requests.length, 1);
  requests[0]({ ok: true, text: "Hello", contentType: "text/vtt" });
  assert.equal((await first)[0].text, "Hello");
  assert.equal((await second)[0].text, "Hello");
});

test("clearing a track prevents a late old response from becoming new-episode cache", async () => {
  const { store, requests } = createStore();
  const old = store.load(track);
  await flush();
  store.clear();
  requests[0]({ ok: true, text: "Old", contentType: "text/vtt" });
  await old;
  const next = store.load(track);
  await flush();
  assert.equal(requests.length, 2);
  requests[1]({ ok: true, text: "New", contentType: "text/vtt" });
  assert.equal((await next)[0].text, "New");
});
