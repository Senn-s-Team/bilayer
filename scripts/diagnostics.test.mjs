/*
 * [INPUT]: 依赖 Node.js test/vm 与真实 diagnostics.js，通过 mount(root) 驱动 query/detail/export/clear 协议
 * [OUTPUT]: 验证用户可见筛选、分页、详情、原文/ruby/copy、轮询可见性和竞态行为
 * [POS]: diagnostics controller 的集成行为回归，不依赖 diagnostics.html 或私有 controller 函数
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/src/diagnostics/diagnostics.js", import.meta.url), "utf8");
const locale = JSON.parse(readFileSync(new URL("../extension/_locales/en/messages.json", import.meta.url), "utf8"));
function t(key, args = []) {
  return (locale[key]?.message ?? key).replace(/\$(\d)/g, (match, index) => args[Number(index) - 1] === undefined ? match : String(args[Number(index) - 1]));
}

class Element {
  constructor(tag = "div", ownerDocument = null) {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.ownerDocument = ownerDocument; this.className = ""; this.parentElement = null; this.open = false;
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); }, remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(" "); }, contains: (name) => this.className.split(/\s+/).includes(name), toggle: (name, force) => { const add = force ?? !this.className.split(/\s+/).includes(name); if (add) this.classList.add(name); else this.classList.remove(name); return add; } };
  }
  set innerHTML(value) {
    this.html = String(value); this.children = [];
    const tokens = this.html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? [];
    const stack = [this];
    for (const token of tokens) {
      if (token.startsWith("<!--")) continue;
      if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith("<")) { if (token.trim()) stack.at(-1).append(Object.assign(new Element("#text", this.ownerDocument), { textContent: token })); continue; }
      const match = token.match(/^<([a-z][\w-]*)\b([^>]*)>/i); if (!match) continue;
      const tag = match[1].toLowerCase(); const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((item) => [item[1], item[2] ?? ""]));
      const child = this.ownerDocument.createElement(tag); child.id = attrs.id ?? ""; child.className = attrs.class ?? ""; child.attributes = attrs; child.dataset = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])); child.hidden = "hidden" in attrs; child.value = attrs.value ?? ""; child.tabIndex = Number(attrs.tabindex ?? 0);
      stack.at(-1).append(child);
      if (!/^(input|img|br|hr|meta|link|iframe|source)$/.test(tag) && !token.endsWith("/>")) stack.push(child);
    }
  }
  get innerHTML() { return this.html ?? ""; }
  get textContent() { return this.text ?? this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.text = String(value); for (const child of this.children) child.parentElement = null; this.children = []; }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
  append(...nodes) {
    if (this.text) this.children.push(Object.assign(new Element("#text", this.ownerDocument), { text: this.text, parentElement: this }));
    this.text = undefined;
    for (const node of nodes) { node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1); node.parentElement = this; node.ownerDocument ??= this.ownerDocument; this.children.push(node); }
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === "id") this.id = String(value); if (key === "class") this.className = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  matches(selector) {
    return selector.split(",").some((part) => {
      const s = part.trim();
      const descendant = s.match(/^(.*?)\s+(\S+)$/);
      if (descendant) return this.matches(descendant[2]) && Boolean(this.parentElement?.closest(descendant[1]));
      if (s.startsWith("#")) return this.id === s.slice(1);
      if (s.startsWith(".")) return this.classList.contains(s.slice(1));
      const attr = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (attr) {
        const value = attr[1].startsWith("data-") ? this.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this.attributes[attr[1]];
        return value !== undefined && (attr[2] === undefined || value === attr[2]);
      }
      return this.tagName.toLowerCase() === s.toLowerCase();
    });
  }
  querySelectorAll(selector) { const found = []; const visit = (node) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(target) { for (let node = target; node; node = node.parentElement) if (node === this) return true; return false; }
  dispatchEvent(type) { for (const handler of this.listeners[type] ?? []) handler(); }
  async dispatch(type, init = {}) { const event = { target: this, key: "", preventDefault() { this.defaultPrevented = true; }, ...init }; for (const handler of this.listeners[type] ?? []) await handler(event); return event; }
  async click() { return this.dispatch("click"); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  getClientRects() { return this.hidden ? [] : [1]; }
}

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function cueRecord(id, { state = "completed", validated = true, errorCode = null, failure = null } = {}) {
  const body = JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: JSON.stringify({ items: [{ id: "cue-1", text: "字幕甲" }] }) }] });
  const responseBody = JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ id: "cue-1", text: "译文甲", ruby: "{青い|あおい}" }]) } }] });
  return { id, at: 1700000000000 + id, completedAt: state === "pending" ? null : 1700000000200 + id, state, validated, errorCode, failure, request: { method: "POST", url: "https://api.example.invalid/chat/completions", headers: { "Content-Type": "application/json" }, body }, response: state === "pending" ? null : { status: 200, statusText: "OK", headers: {}, body: responseBody } };
}
function makeHarness({ records = [], queryHook = null, detailHook = null, exportRecords = null, frameReady = true, captureError = false, clearError = false, exportHook = null } = {}) {
  const calls = []; const clipboard = []; const timers = []; let enabled = false; let generation = 4; let version = 1; let hidden = false;
  const frameDownloads = [], frames = [];
  const document = { hidden: false, activeElement: null, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    createElement(tag) {
      const node = new Element(tag, document);
      if (tag === "iframe") {
        node.contentWindow = frameReady ? { downloadCases(filename, text) { frameDownloads.push({ filename, text }); } } : null;
        frames.push(node);
      }
      return node;
    },
    createTextNode(text) { return Object.assign(new Element("#text", document), { textContent: String(text) }); }
  };
  const runtime = { runtime: { getURL: (path) => `extension://bilayer/${path}`, lastError: null, sendMessage(message, callback) { calls.push(structuredClone(message));
    const reply = async () => {
      if (message.type === "BILAYER_QUERY_RAW_DIAGNOSTICS") {
        if (queryHook) await queryHook(message);
        const all = records.filter((record) => message.filter === "all" || message.filter === "normal" && record.state !== "pending" && record.validated === true && !record.failure && !record.errorCode || message.filter === "abnormal" && record.state !== "pending" && !(record.validated === true && !record.failure && !record.errorCode));
        const filtered = (message.search ? all.filter((record) => `${record.id} ${record.model ?? "fixture-model"} ${record.request?.url ?? ""} ${record.errorCode ?? ""}`.toLowerCase().includes(message.search.toLowerCase())) : all).sort((left, right) => right.id - left.id);
        const before = Number(message.cursor?.beforeId ?? Infinity); const anchored = filtered.filter((record) => record.id < before); const page = anchored.slice(0, message.limit);
        return { ok: true, enabled, preferenceKnown: true, generation, version, counts: { all: records.length, normal: records.filter((r) => r.state !== "pending" && r.validated === true && !r.failure && !r.errorCode).length, abnormal: records.filter((r) => r.state !== "pending" && !(r.validated === true && !r.failure && !r.errorCode)).length, pending: records.filter((r) => r.state === "pending").length }, total: filtered.length, records: page.map(({ request, response, ...summary }) => structuredClone({ ...summary, model: summary.model ?? "fixture-model", httpStatus: response?.status ?? null })), nextCursor: anchored.length > page.length ? { generation, filter: message.filter, search: message.search ?? "", limit: message.limit, beforeId: page.at(-1)?.id, version } : null };
      }
      if (message.type === "BILAYER_GET_RAW_DIAGNOSTIC") { if (detailHook) await detailHook(message); if (message.generation !== generation) return { ok: false, error: "stale_generation" }; const record = records.find((item) => item.id === message.id); return record ? { ok: true, generation, version, record: structuredClone(record) } : { ok: false, error: "not_found" }; }
      if (message.type === "BILAYER_EXPORT_RAW_DIAGNOSTICS") { if (exportHook) await exportHook(message); const rows = (exportRecords ?? records).slice().sort((left, right) => Number(right.id) - Number(left.id)); const anchored = rows.filter((record) => record.id < Number(message.cursor?.beforeId ?? Infinity)); const page = anchored.slice(0, message.limit); return { ok: true, schemaVersion: 1, generation, version, records: page, nextCursor: anchored.length > page.length ? { generation, version, limit: message.limit, beforeId: page.at(-1)?.id } : null }; }
      if (message.type === "BILAYER_SET_RAW_DIAGNOSTICS") { if (captureError) return { ok: false, persisted: false, errorCode: "storage_unavailable" }; enabled = message.enabled; return { ok: true, enabled, persisted: true }; }
      if (message.type === "BILAYER_CLEAR_RAW_DIAGNOSTICS") { if (clearError) return { ok: false, errorCode: "storage_idb_transaction" }; records = []; generation += 1; version += 1; return { ok: true, generation, version }; }
      throw new Error(`Unexpected controller protocol: ${message.type}`);
    };
    reply().then(callback);
  } } };
  const sandbox = { document, browser: runtime, globalThis: null, i18n: { t }, navigator: { clipboard: { async writeText(text) { clipboard.push(text); } } }, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, URL, Blob, TextEncoder, Date, structuredClone };
  sandbox.globalThis = sandbox; runInNewContext(source, sandbox, { filename: "diagnostics.js" });
  const root = new Element("main", document); const controller = sandbox.BilayerDiagnostics.mount(root);
  return { root, document, runtime, calls, clipboard, frameDownloads, frames, timers, controller, activate() { controller.setActive(true); }, deactivate() { controller.setActive(false); }, async click(selector) { const node = root.querySelector(selector); assert.ok(node, `missing ${selector}`); await node.click(); }, async tick() { await new Promise((resolve) => setImmediate(resolve)); await Promise.resolve(); }, setHidden(value) { hidden = value; document.hidden = value; for (const fn of document.listeners.visibilitychange ?? []) fn(); }, advanceGeneration() { generation += 1; version += 1; records = []; }, bumpVersion() { version += 1; }, loadFrame() { for (const frame of frames) frame.dispatchEvent("load"); }, get records() { return records; }, get enabled() { return enabled; }, get generation() { return generation; } };
}

test("mount is inert until active, then renders paged summaries and numeric detail ID", async () => {
  const page = makeHarness({ records: [cueRecord(41)] });
  assert.equal(page.calls.length, 0);
  page.activate(); await page.tick();
  assert.deepEqual(page.calls.map((call) => call.type), ["BILAYER_QUERY_RAW_DIAGNOSTICS", "BILAYER_GET_RAW_DIAGNOSTIC"]);
  assert.equal(page.calls[1].id, 41);
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 1);
  assert.equal(page.enabled, false);
  const row = page.root.querySelector("[data-record-id]");
  assert.equal(row.children.length, 5);
  assert.match(row.children[0].textContent, /^#41/);
  assert.deepEqual(row.children.slice(1).map((cell) => cell.textContent), [t("diagnosticsNormal"), "fixture-model", "200", "200 ms"]);
  assert.equal(row.getAttribute("role"), "option"); assert.equal(row.tabIndex, 0);
  await row.click(); await page.tick(); assert.equal(page.calls.filter((call) => call.type === "BILAYER_GET_RAW_DIAGNOSTIC").length, 2);
});
test("request rows expose result before model and preserve focused row through polling refresh", async () => {
  const page = makeHarness({ records: [cueRecord(51)] }); page.activate(); await page.tick();
  const row = page.root.querySelector('[data-record-id="51"]');
  assert.deepEqual(row.children.slice(0, 4).map((cell) => cell.textContent), [row.children[0].textContent, t("diagnosticsNormal"), "fixture-model", "200"]);
  row.focus(); page.controller.setActive(false); page.controller.setActive(true); await page.tick();
  assert.equal(page.document.activeElement.dataset.recordId, "51");
  assert.equal(page.root.querySelector('[data-record-id="51"]'), row);
});
test("visible activation resumes after an in-flight reply is fenced", async () => {
  const first = deferred(); let queryCount = 0;
  const page = makeHarness({ records: [cueRecord(1)], queryHook: async () => { queryCount += 1; if (queryCount === 1) await first.promise; } });
  page.activate(); page.deactivate(); page.activate(); await page.tick();
  assert.ok(queryCount >= 2, "reactivation starts a new query while the stale one is unresolved");
  first.resolve(); await page.tick();
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 1);
});
test("more menu closes on Escape and outside pointer without changing capture preference", async () => {
  const page = makeHarness({ records: [cueRecord(1)] }); page.activate(); await page.tick();
  const menu = page.root.querySelector(".dc-more"); const summary = menu.querySelector("summary"); menu.open = true;
  await menu.dispatch("keydown", { key: "Escape" }); assert.equal(menu.open, false);
  menu.open = true; for (const handler of page.document.listeners.pointerdown ?? []) handler({ target: page.root.querySelector("#di-search") });
  assert.equal(menu.open, false); assert.equal(page.calls.some((call) => call.type === "BILAYER_SET_RAW_DIAGNOSTICS"), false);
  assert.equal(summary.getAttribute("aria-label"), `${t("diagnosticsMore")}. ${t("diagnosticsCloseMenuHint")}`);
});
test("polling after loading later pages preserves the deepest cursor and does not repeat rows", async () => {
  const records = Array.from({ length: 250 }, (_, index) => cueRecord(index + 1));
  const page = makeHarness({ records }); page.activate(); await page.tick();
  await page.click("#di-more"); await page.tick();
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 200);
  page.controller.setActive(false); page.controller.setActive(true); await page.tick();
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 200);
  await page.click("#di-more"); await page.tick();
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 250);
  const cursors = page.calls.filter((call) => call.type === "BILAYER_QUERY_RAW_DIAGNOSTICS").map((call) => call.cursor?.beforeId ?? null);
  assert.deepEqual(cursors, [null, 151, null, 51]);
});

test("completed HTTP 200 validation errors are abnormal; unknown global counts remain unknown", async () => {
  const page = makeHarness({ records: [cueRecord(2, { validated: false, errorCode: "items_mismatch" }), cueRecord(3, { state: "pending", validated: null })] });
  page.activate(); await page.tick();
  assert.equal(page.root.querySelector("#di-count-abnormal").textContent, "1");
  assert.deepEqual(new Set(page.root.querySelectorAll("[data-record-id]").map((row) => row.dataset.recordId)), new Set(["2", "3"]));
  await page.click('[data-record-id="2"]'); await page.tick();
  assert.equal(page.root.querySelector("#di-detail-state").textContent, t("diagnosticsAbnormal"));
  await page.click('[data-filter="abnormal"]'); await page.tick();
  assert.deepEqual(page.root.querySelectorAll("[data-record-id]").map((row) => row.dataset.recordId), ["2"]);
  assert.equal(page.root.querySelector("#di-detail-state").textContent, t("diagnosticsAbnormal"));
});
test("filter with no matches removes stale rows and detail", async () => {
  const page = makeHarness({ records: [cueRecord(11)] }); page.activate(); await page.tick();
  await page.click('[data-filter="abnormal"]'); await page.tick();
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 0);
  assert.equal(page.root.querySelector("#di-detail-empty").hidden, false);
  assert.equal(page.root.querySelector("#di-detail").hidden, true);
});

test("selected pending detail reloads when its summary completes", async () => {
  const pending = cueRecord(17, { state: "pending", validated: null });
  const page = makeHarness({ records: [pending] }); page.activate(); await page.tick();
  assert.equal(page.root.querySelector("#di-detail-state").textContent, t("diagnosticsPending"));
  pending.state = "completed"; pending.validated = true; pending.completedAt = pending.at + 500; pending.response = { status: 200, body: "{}", headers: {} };
  page.bumpVersion();
  page.controller.setActive(false); page.controller.setActive(true); await page.tick();
  assert.equal(page.calls.filter((call) => call.type === "BILAYER_GET_RAW_DIAGNOSTIC").length, 2);
});

test("generation change clears stale detail and fences its late response", async () => {
  const oldDetail = deferred(); let hold = false;
  const page = makeHarness({ records: [cueRecord(5)], detailHook: () => hold ? oldDetail.promise : Promise.resolve() });
  page.activate(); await page.tick();
  hold = true; await page.click('[data-record-id="5"]'); await page.tick();
  assert.equal(page.calls.filter((call) => call.type === "BILAYER_GET_RAW_DIAGNOSTIC").length, 2);
  page.advanceGeneration(); page.controller.setActive(false); page.controller.setActive(true); await page.tick();
  assert.equal(page.root.querySelector("#di-detail-empty").hidden, false);
  oldDetail.resolve(); await page.tick();
  assert.equal(page.root.querySelector("#di-detail-empty").hidden, false);
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 0);
});

test("deactivated or hidden panels do not render late query results or keep polling", async () => {
  const gate = deferred(); const page = makeHarness({ records: [cueRecord(8)], queryHook: () => gate.promise });
  page.activate(); page.deactivate(); gate.resolve(); await page.tick();
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 0);
  const hiddenPage = makeHarness({ records: [cueRecord(9)] }); hiddenPage.setHidden(true); hiddenPage.activate(); await hiddenPage.tick();
  assert.equal(hiddenPage.calls.length, 0);
});

test("late detail response after confirmed clear cannot restore selected record", async () => {
  const detail = deferred(); const page = makeHarness({ records: [cueRecord(24)], detailHook: () => detail.promise });
  page.activate(); await page.tick();
  await page.click("#di-clear"); await page.click("#di-confirm-yes"); await page.tick();
  detail.resolve(); await page.tick();
  assert.equal(page.root.querySelector("#di-detail-empty").hidden, false);
  assert.equal(page.generation, 5);
});

test("ruby rendering and top-level array normalization preserve subtitle copy", async () => {
  const sample = cueRecord(30); sample.request.body = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ sourceLanguage: "ja", targetLanguage: "en", items: [{ id: "cue-1", text: "青い箱" }] }) }] }); sample.response.body = JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ id: "cue-1", text: "Blue box", ruby: "<ruby>青い<rt>あおい</rt></ruby>" }]) } }] });
  const page = makeHarness({ records: [sample] }); page.activate(); await page.tick();
  await page.click('[data-payload="subtitles"]');
  assert.equal(page.root.querySelector(".dc-source ruby").children[0].textContent, "青い");
  assert.equal(page.root.querySelector("rt").textContent, "あおい");
  assert.equal(page.root.querySelector(".dc-target").textContent, "Blue box");
});
test("reading map decorates source text without replacing it and copy separates source from translation", async () => {
  const sample = cueRecord(32);
  sample.request.body = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ sourceLanguage: "ja", targetLanguage: "en", items: [{ id: "cue-1", text: "青い箱" }] }) }] });
  sample.response.body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ id: "cue-1", text: "Blue box", readings: [{ surface: "青い", reading: "あおい" }] }] }) } }] });
  const page = makeHarness({ records: [sample] }); page.activate(); await page.tick(); await page.click('[data-payload="subtitles"]');
  assert.equal(page.root.querySelector(".dc-source ruby").children[0].textContent, "青い");
  assert.equal(page.root.querySelector(".dc-source rt").textContent, "あおい");
  assert.equal(page.root.querySelector(".dc-target").textContent, "Blue box");
  await page.click("#di-copy");
  assert.match(page.clipboard[0], /Source: 青い箱/); assert.match(page.clipboard[0], /Translation: Blue box/);
});
test("tree toggle, long value expansion, and copy controls invoke their user actions", async () => {
  const sample = cueRecord(61); const longValue = "x".repeat(200);
  sample.response.body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ longValue }) } }] });
  const page = makeHarness({ records: [sample] }); page.activate(); await page.tick();
  await page.click("#di-tree-toggle");
  const expand = page.root.querySelector(".json-expand"); assert.ok(expand);
  await expand.click(); assert.equal(expand.getAttribute("aria-expanded"), "true");
  await page.click("#di-copy"); assert.equal(JSON.parse(page.clipboard.at(-1)).choices[0].message.content.longValue, longValue);
});
test("same-surface readings stay attached to their cue ID and target language controls ruby side", async () => {
  const first = cueRecord(33); first.request.body = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ sourceLanguage: "en", targetLanguage: "ja", items: [{ id: "a", text: "Today" }, { id: "b", text: "At night" }] }) }] });
  first.response.body = JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ id: "a", text: "今日", readings: [{ surface: "今日", reading: "きょう" }] }, { id: "b", text: "今日", readings: [{ surface: "今日", reading: "こんにち" }] }]) } }] });
  const page = makeHarness({ records: [first] }); page.activate(); await page.tick(); await page.click('[data-payload="subtitles"]');
  const ruby = page.root.querySelectorAll("rt").map((node) => node.textContent);
  assert.deepEqual(ruby, ["きょう", "こんにち"]);
  assert.deepEqual(page.root.querySelectorAll(".dc-source").map((node) => node.textContent), ["Today", "At night"]);
  assert.deepEqual(page.root.querySelectorAll(".dc-target ruby").map((node) => node.children[0].textContent), ["今日", "今日"]);
});
test("raw mode displays and copies exact response body; formatted mode copies parsed JSON", async () => {
  const rawBody = '{"choices":[{"message":{"content":"[ {\\"id\\":\\"cue-1\\",\\"text\\":\\"x\\"} ]"}}]}';
  const sample = cueRecord(31); sample.response.body = rawBody;
  const page = makeHarness({ records: [sample] }); page.activate(); await page.tick();
  await page.click("#di-copy"); assert.notEqual(page.clipboard.at(-1), rawBody);
  await page.click("#di-format-toggle");
  assert.equal(page.root.querySelector(".dc-payload-raw").textContent, rawBody);
  await page.click("#di-copy"); assert.equal(page.clipboard.at(-1), rawBody);
});


test("controller leaves the capture preference unchanged and exports through the same-origin frame", async () => {
  const all = Array.from({ length: 205 }, (_, id) => cueRecord(id + 1)); const page = makeHarness({ records: [all[0]], exportRecords: all }); page.activate(); await page.tick();
  assert.equal(page.calls.some((call) => call.type === "BILAYER_SET_RAW_DIAGNOSTICS"), false);
  page.loadFrame();
  await page.click("#di-export");
  await page.tick();
  const requests = page.calls.filter((call) => call.type === "BILAYER_EXPORT_RAW_DIAGNOSTICS");
  assert.equal(requests.length, 3); assert.equal(requests.every((call) => !("filter" in call) && !("search" in call)), true);
  assert.deepEqual(requests.map((call) => call.cursor?.beforeId ?? null), [null, 106, 6]);
  assert.equal(page.frameDownloads.length, 1); assert.equal(JSON.parse(page.frameDownloads[0].text).records.length, 205);
  assert.equal(page.calls.some((call) => call.download), false);
});

test("capture save failures remain visible after a successful query refresh", async () => {
  const page = makeHarness({ records: [cueRecord(1)], captureError: true }); page.activate(); await page.tick();
  await page.click("#di-capture"); await page.tick();
  assert.equal(page.root.querySelector("#di-status").dataset.state, "error");
  page.deactivate(); page.activate(); await page.tick();
  assert.equal(page.root.querySelector("#di-status").dataset.state, "error");
  assert.equal(page.enabled, false);
});

test("clear failure preserves records and resumes polling", async () => {
  const page = makeHarness({ records: [cueRecord(1)], clearError: true }); page.activate(); await page.tick();
  await page.click("#di-clear"); await page.click("#di-confirm-yes"); await page.tick();
  assert.equal(page.root.querySelector("#di-clear").hidden, false);
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 1);
  assert.equal(page.root.querySelector("#di-status").dataset.state, "error");
  const queries = page.calls.filter((call) => call.type === "BILAYER_QUERY_RAW_DIAGNOSTICS").length;
  page.timers.at(-1)(); await page.tick();
  assert.ok(page.calls.filter((call) => call.type === "BILAYER_QUERY_RAW_DIAGNOSTICS").length > queries);
});

test("both Japanese languages annotate only the accepted target line", async () => {
  const record = cueRecord(1);
  record.request.body = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ sourceLanguage: "ja", targetLanguage: "ja", items: [{ id: "0", text: "今日" }] }) }] });
  record.response.body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ id: "0", text: "今日", readings: [{ surface: "今日", reading: "きょう" }] }] }) } }] });
  const page = makeHarness({ records: [record] }); page.activate(); await page.tick(); await page.click('[data-payload="subtitles"]');
  assert.equal(page.root.querySelectorAll(".dc-source rt").length, 0);
  assert.equal(page.root.querySelector(".dc-source").textContent, "今日");
  assert.equal(page.root.querySelector(".dc-target rt").textContent, "きょう");
});

test("changing export version refuses a partial download", async () => {
  let page;
  page = makeHarness({ records: [cueRecord(1)], exportRecords: Array.from({ length: 101 }, (_, index) => cueRecord(index + 1)), exportHook: (message) => { if (message.cursor) page.bumpVersion(); } });
  page.activate(); await page.tick(); page.loadFrame(); await page.click("#di-export"); await page.tick();
  assert.equal(page.frameDownloads.length, 0);
  assert.equal(page.root.querySelector("#di-status").dataset.state, "error");
});

test("hiding while initial detail is pending prevents late list and payload rendering", async () => {
  const gate = deferred();
  const page = makeHarness({ records: [cueRecord(1)], detailHook: () => gate.promise });
  page.activate(); await page.tick();
  assert.equal(page.calls.some((call) => call.type === "BILAYER_GET_RAW_DIAGNOSTIC"), true);
  page.setHidden(true); gate.resolve(); await page.tick();
  assert.equal(page.root.querySelectorAll("[data-record-id]").length, 0);
  assert.equal(page.root.querySelector("#di-detail").hidden, true);
});
