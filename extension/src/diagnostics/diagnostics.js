/*
 * [INPUT]: 依赖 background BILAYER_QUERY/GET/EXPORT/SET/CLEAR_RAW_DIAGNOSTICS 协议、runtime.getURL 同源下载框架、i18n 与 settings 提供的 panel root
 * [OUTPUT]: globalThis.BilayerDiagnostics.mount(root) 渲染 root-scoped 检查器并返回 setActive(bool)，refresh 应用摘要/采集状态及分页总数，generation 变化先 fence 并清空旧详情
 * [POS]: settings 窗口内懒挂载的诊断控制器；仅 selected+visible 时读取，异步详情后再次 fencing；存储与偏好失败显式呈现，JSON 与 ruby 用安全节点生成
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const diagnosticsText = (key) => globalThis.i18n.t(key);
(() => {
  "use strict";
  const runtime = globalThis.browser ?? globalThis.chrome;
  let mountedRoot = null;
  globalThis.BilayerDiagnostics = { mount };

  function mount(root) {
    if (!root) throw new TypeError("A diagnostics root is required");
    if (mountedRoot?.root === root) return mountedRoot.controller;
    root.innerHTML = markup();
    const $ = (id) => root.querySelector(`#${id}`);
    const state = { active: false, busy: false, flightEpoch: -1, epoch: 0, clearEpoch: 0, timer: 0, filter: "all", search: "", cursor: null, loadedCursor: null, hasLoadedPages: false, generation: null, version: -1, summaries: [], selectedId: null, pageAnchor: null, detailEpoch: 0, detail: null, payload: "response", tree: false, raw: false, matches: [], matchIndex: -1, exportFrame: null, enabled: false, counts: { all: null, normal: null, abnormal: null, pending: null }, preferenceError: "" };
    const controller = { setActive };
    bind();
    mountedRoot = { root, controller };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return controller;

    function setActive(active) {
      state.active = Boolean(active);
      state.epoch += 1;
      state.detailEpoch += 1;
      clearTimeout(state.timer);
      if (state.active && !document.hidden) { state.busy = false; void refresh(); }
    }

    function onVisibilityChange() {
      if (!state.active) return;
      state.epoch += 1;
      clearTimeout(state.timer);
      if (!document.hidden) { state.busy = false; void refresh(); }
    }

    function bind() {
      root.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
        state.filter = button.dataset.filter; state.cursor = null; state.loadedCursor = null; state.hasLoadedPages = false; state.pageAnchor = null; state.summaries = []; state.epoch += 1; state.busy = false;
        root.querySelectorAll("[data-filter]").forEach((tab) => { tab.setAttribute("aria-selected", String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; });
        void refresh();
      }));
      $("di-search").addEventListener("input", () => { state.search = $("di-search").value.trim(); state.cursor = null; state.loadedCursor = null; state.hasLoadedPages = false; state.pageAnchor = null; state.summaries = []; state.epoch += 1; state.busy = false; void refresh(); });
      $("di-more").addEventListener("click", () => { if (state.cursor) { state.pageAnchor = state.summaries.at(-1)?.id ?? null; void refresh(true); } });
      $("di-refresh").addEventListener("click", () => { state.epoch += 1; state.busy = false; void refresh(); });
      $("di-capture").addEventListener("click", () => void setCapture(!state.enabled));
      $("di-export").addEventListener("click", () => void exportAll());
      $("di-clear").addEventListener("click", () => { $("di-confirm").hidden = false; $("di-clear").hidden = true; $("di-confirm-yes").focus(); });
      $("di-confirm-no").addEventListener("click", () => { $("di-confirm").hidden = true; $("di-clear").hidden = false; });
      $("di-confirm-yes").addEventListener("click", () => void clearAll());
      root.querySelectorAll("[data-payload]").forEach((button) => button.addEventListener("click", () => { state.payload = button.dataset.payload; renderDetail(); }));
      const moreMenu = root.querySelector(".dc-more");
      moreMenu.querySelector("summary").setAttribute("aria-label", `${t("diagnosticsMore")}. ${t("diagnosticsCloseMenuHint")}`);
      moreMenu.addEventListener("keydown", (event) => { if (event.key === "Escape" && moreMenu.open) { moreMenu.open = false; moreMenu.querySelector("summary").focus(); } });
      document.addEventListener("pointerdown", (event) => { if (moreMenu.open && !moreMenu.contains(event.target)) moreMenu.open = false; });
      $("di-json-search").addEventListener("input", updateTreeSearch);
      $("di-json-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } });
      $("di-match-prev").addEventListener("click", () => moveMatch(-1));
      $("di-match-next").addEventListener("click", () => moveMatch(1));
      $("di-expand").addEventListener("click", () => setTreeDepth(Infinity));
      $("di-collapse").addEventListener("click", () => setTreeDepth(2));
      $("di-copy").addEventListener("click", copyPayload);
      $("di-tree-toggle").addEventListener("click", () => { state.tree = !state.tree; renderDetail(); });
      $("di-list").addEventListener("keydown", navigateList);
      root.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("keydown", navigateFilter));
      $("di-format-toggle").addEventListener("click", () => { state.raw = !state.raw; renderDetail(); });
      $("di-payload").addEventListener("focusin", (event) => { const row = event.target.closest(".json-row"); if (row) $("di-path-value").textContent = row.dataset.path; });
      $("di-payload").addEventListener("keydown", navigateTree);
      state.exportFrame = $("di-export-frame");
      state.exportFrame.title = t("diagnosticsDownloadFrame");
      state.exportFrame.src = runtime?.runtime?.getURL?.("src/diagnostics/export.html") ?? "";
      state.exportFrame.addEventListener("load", () => { state.exportReady = true; });
    }
    async function refresh(nextPage = false) {
      if (!state.active || document.hidden) return;
      if (state.busy && state.flightEpoch !== state.epoch) state.busy = false;
      if (state.busy) return;
      const epoch = state.epoch;
      const clearEpoch = state.clearEpoch;
      state.busy = true;
      state.flightEpoch = epoch;
      const queryCursor = nextPage ? state.cursor : null;
      if (nextPage && !queryCursor) { state.busy = false; return; }
      const oldVersion = state.version;
      const oldGeneration = state.generation;
      const listScrollTop = $("di-list-scroll").scrollTop;
      try {
        const result = await send({ type: "BILAYER_QUERY_RAW_DIAGNOSTICS", filter: state.filter, ...(state.search ? { search: state.search } : {}), limit: 100, ...(queryCursor ? { cursor: queryCursor } : {}) });
        if (!state.active || document.hidden || epoch !== state.epoch || clearEpoch !== state.clearEpoch) return;
        if (!result?.ok) {
          if ((result?.error ?? result?.errorCode) === "stale_cursor" && (nextPage || state.pageAnchor)) { state.cursor = null; state.loadedCursor = null; state.hasLoadedPages = false; state.pageAnchor = null; state.summaries = []; state.busy = false; void refresh(); return; }
          if (result?.storageError) updateCapture(result.preferenceKnown !== false, result.storageError);
          status(t("diagnosticsQueryFailed"), "error"); scheduleRefresh(epoch); return;
        }
        state.enabled = Boolean(result.enabled); state.generation = result.generation; state.version = result.version;
        state.counts = result.counts ?? state.counts;
        const generationChanged = oldGeneration !== null && oldGeneration !== result.generation;
        if (generationChanged) {
          state.selectedId = null; state.detail = null; state.detailEpoch += 1; showDetailEmpty();
          state.loadedCursor = null; state.hasLoadedPages = false; state.pageAnchor = null;
        }
        state.summaries = queryCursor ? mergeSummaries(state.summaries, result.records) : generationChanged ? result.records : mergeSummaries(state.summaries, result.records);
        if (generationChanged) { state.loadedCursor = result.nextCursor; state.hasLoadedPages = false; }
        else if (queryCursor) { state.loadedCursor = result.nextCursor; state.hasLoadedPages = true; }
        else if (!state.hasLoadedPages) state.loadedCursor = result.nextCursor;
        else if (result.nextCursor && state.loadedCursor && Number(result.nextCursor.beforeId) < Number(state.loadedCursor.beforeId)) state.loadedCursor = result.nextCursor;
        state.cursor = state.loadedCursor;
        const selectedBefore = state.selectedId;
        const selectedExists = state.summaries.some((record) => String(record.id) === String(selectedBefore));
        if (!state.summaries.length) { state.selectedId = null; state.detail = null; state.detailEpoch += 1; showDetailEmpty(); }
        else if (generationChanged || !selectedExists) await selectRecord(String(state.summaries[0].id), epoch, clearEpoch);
        else {
          state.selectedId = selectedBefore;
          const selected = state.summaries.find((record) => String(record.id) === String(selectedBefore));
          if (state.version !== oldVersion && state.detail?.state === "pending" && selected.state !== "pending") await selectRecord(String(selected.id), epoch, clearEpoch);
        }
        if (!state.active || document.hidden || epoch !== state.epoch || clearEpoch !== state.clearEpoch) return;
        if (!queryCursor) state.pageAnchor = selectedBefore ?? state.pageAnchor ?? state.summaries[0]?.id ?? null;
        renderList(result.total); updateCapture(result.preferenceKnown !== false, result.storageError ?? null); if (state.preferenceError) status(state.preferenceError, "error"); else status("", "idle"); scheduleRefresh(epoch);
        $("di-list-scroll").scrollTop = listScrollTop;
      } catch { if (epoch === state.epoch && state.active) { status(t("diagnosticsQueryFailed"), "error"); scheduleRefresh(epoch); } }
      finally { if (state.flightEpoch === epoch) state.busy = false; }
    }

    function mergeSummaries(current, loaded) {
      const byId = new Map([...current, ...loaded].map((record) => [String(record.id), record]));
      return [...byId.values()].sort((left, right) => Number(right.id) - Number(left.id));
    }
    function scheduleRefresh(epoch) {
      clearTimeout(state.timer);
      if (state.active && !document.hidden && epoch === state.epoch) state.timer = setTimeout(() => void refresh(), 1000);
    }


    async function selectRecord(id, epoch = state.epoch, clearEpoch = state.clearEpoch) {
      state.selectedId = String(id); renderListSelection();
      const detailEpoch = ++state.detailEpoch; const generation = state.generation;
      const numericId = Number(id);
      const result = await send({ type: "BILAYER_GET_RAW_DIAGNOSTIC", id: Number.isSafeInteger(numericId) ? numericId : id, generation });
      if (!result?.ok || result.generation !== generation) { if (detailEpoch !== state.detailEpoch || epoch !== state.epoch || clearEpoch !== state.clearEpoch) return; status(t("diagnosticsDetailFailed"), "error"); return; }
      if (detailEpoch !== state.detailEpoch || epoch !== state.epoch || clearEpoch !== state.clearEpoch || !state.active || document.hidden) return;
      state.detail = result.record; renderDetail();
    }

    function navigateFilter(event) {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = [...root.querySelectorAll("[data-filter]")]; const index = tabs.indexOf(event.target);
      const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      event.preventDefault(); next.focus(); next.click();
    }

    function navigateList(event) {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const rows = [...$("di-list").querySelectorAll("[data-record-id]")]; if (!rows.length) return;
      const index = rows.indexOf(event.target); const next = event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
      event.preventDefault(); next.focus(); void selectRecord(next.dataset.recordId);
    }

    function renderList(total = state.summaries.length) {
      $("di-count-all").textContent = state.counts.all == null ? "–" : String(state.counts.all); $("di-count-normal").textContent = state.counts.normal == null ? "–" : String(state.counts.normal); $("di-count-abnormal").textContent = state.counts.abnormal == null ? "–" : String(state.counts.abnormal); $("di-list-count").textContent = total == null ? "–" : String(total);
      const list = $("di-list"); const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.recordId : null;
      const existing = new Map([...list.querySelectorAll("[data-record-id]")].map((row) => [row.dataset.recordId, row])); const rows = [];
      $("di-empty").hidden = state.summaries.length > 0;
      for (const summary of state.summaries) {
        const id = String(summary.id); const selected = id === String(state.selectedId);
        const row = existing.get(id) ?? document.createElement("button");
        row.type = "button"; row.className = "dc-record"; row.dataset.recordId = id; row.setAttribute("role", "option"); row.setAttribute("aria-current", String(selected)); row.setAttribute("aria-selected", String(selected)); row.tabIndex = selected ? 0 : -1;
        const request = document.createElement("span"); request.textContent = `#${id}`; const time = document.createElement("small"); time.textContent = new Date(summary.at).toLocaleString(); request.append(time);
        const result = document.createElement("span"); result.textContent = summary.state === "pending" ? t("diagnosticsPending") : summary.validated === true && !summary.error && !summary.failure && !summary.errorCode ? t("diagnosticsNormal") : t("diagnosticsAbnormal");
        const model = document.createElement("span"); model.textContent = summary.model || "–";
        const http = document.createElement("span"); http.textContent = summary.httpStatus == null ? "–" : String(summary.httpStatus);
        const elapsed = document.createElement("span"); elapsed.textContent = duration(summary);
        row.replaceChildren(request, result, model, http, elapsed);
        if (!existing.has(id)) row.addEventListener("click", () => void selectRecord(id));
        rows.push(row);
      }
      list.replaceChildren(...rows);
      if (focusedId && rows.some((row) => row.dataset.recordId === focusedId)) rows.find((row) => row.dataset.recordId === focusedId).focus();
      $("di-more").hidden = !(state.cursor || state.hasLoadedPages && state.summaries.length < total);
    }
    function renderListSelection() { $("di-list").querySelectorAll("[data-record-id]").forEach((row) => { const selected = row.dataset.recordId === String(state.selectedId); row.setAttribute("aria-current", String(selected)); row.setAttribute("aria-selected", String(selected)); row.tabIndex = selected ? 0 : -1; }); }
    function showDetailEmpty() { $("di-detail-empty").hidden = false; $("di-detail").hidden = true; }

    function renderDetail() {
      const record = state.detail;
      if (!record) { showDetailEmpty(); return; }
      $("di-detail-empty").hidden = true; $("di-detail").hidden = false;
      const request = record.request ?? {}; const response = record.response;
      const abnormal = record.state !== "pending" && !(record.validated === true && !record.failure && !record.error && !record.errorCode);
      $("di-detail-title").textContent = t("diagnosticsRequestNumber", [record.id]);
      $("di-detail-state").textContent = record.state === "pending" ? t("diagnosticsPending") : abnormal ? t("diagnosticsAbnormal") : t("diagnosticsNormal");
      $("di-detail-state").dataset.state = record.state === "pending" ? "pending" : abnormal ? "error" : "success";
      $("di-info").textContent = JSON.stringify({ at: record.at, completedAt: record.completedAt, url: request.url, method: request.method, httpStatus: response?.status ?? null, durationMs: record.completedAt && record.at ? record.completedAt - record.at : null, validated: record.validated ?? null, failure: record.failure ?? null, error: record.error ?? null, errorCode: record.errorCode ?? null, requestHeaders: request.headers ?? null, responseHeaders: response?.headers ?? null }, null, 2);
      for (const tab of root.querySelectorAll("[data-payload]")) tab.setAttribute("aria-pressed", String(tab.dataset.payload === state.payload));
      if (state.payload === "info") { renderText($("di-payload"), $("di-info").textContent); return; }
      if (state.payload === "subtitles") { $("di-payload").replaceChildren(renderUiPreview(record)); return; }
      renderPayload(state.payload === "request" ? request.body : response?.body ?? "");
    }

    function renderPayload(text) {
      const parsed = parseFormattedJson(text); $("di-format-toggle").hidden = !parsed;
      $("di-format-toggle").textContent = state.raw ? t("diagRaw") : t("diagFormatted"); $("di-format-toggle").setAttribute("aria-pressed", String(!state.raw));
      $("di-tree-toggle").hidden = !parsed; $("di-tree-toggle").textContent = state.tree ? t("diagnosticsCollapse") : t("diagnosticsTree"); $("di-tree-toggle").setAttribute("aria-pressed", String(state.tree));
      $("di-payload").replaceChildren();
      if (state.raw) { $("di-json-tools").hidden = true; renderText($("di-payload"), text || t("diagnosticsNoPayload")); }
      else if (state.tree && parsed) { $("di-payload").append(createJsonNode(parsed, "$", "$", 0)); $("di-json-tools").hidden = false; updateTreeSearch(); }
      else { $("di-json-tools").hidden = true; renderText($("di-payload"), parsed ? JSON.stringify(parsed, null, 2) : text || t("diagnosticsNoPayload")); }
    }
    function renderText(target, text) { const pre = document.createElement("pre"); pre.className = "dc-payload-raw"; pre.textContent = text; target.replaceChildren(pre); }
    function copyPayload() {
      const record = state.detail; if (!record) return;
      let text;
      if (state.payload === "info") text = $("di-info").textContent;
      else if (state.payload === "subtitles") text = subtitleCopy(record);
      else { const body = state.payload === "request" ? record.request?.body : record.response?.body; if (!body) return; const parsed = parseFormattedJson(body); text = !state.raw && parsed ? JSON.stringify(parsed, null, 2) : body; }
      try { void navigator.clipboard.writeText(text).then(() => status(t("diagnosticsCopied"), "idle"), () => status(t("diagnosticsCopyFailed"), "error")); } catch { status(t("diagnosticsCopyFailed"), "error"); }
    }


    async function exportAll() {
      let cursor = null; let snapshot; const records = [];
      try {
        do {
          const result = await send({ type: "BILAYER_EXPORT_RAW_DIAGNOSTICS", limit: 100, ...(cursor ? { cursor } : {}) });
          if (!result?.ok) throw new Error("export");
          if (!snapshot) snapshot = result; else if (snapshot.generation !== result.generation || snapshot.version !== result.version) throw new Error("stale");
          records.push(...result.records); cursor = result.nextCursor;
        } while (cursor);
        const text = JSON.stringify({ schemaVersion: snapshot.schemaVersion, generation: snapshot.generation, version: snapshot.version, records }, null, 2);
        const filename = `bilayer-diagnostics-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.json`;
        if (state.exportReady && state.exportFrame?.contentWindow?.downloadCases) state.exportFrame.contentWindow.downloadCases(filename, text);
        else status(t("diagnosticsDownloadNotReady"), "error");
      } catch { status(t("diagnosticsExportFailed"), "error"); }
    }

    async function setCapture(value) {
      const result = await send({ type: "BILAYER_SET_RAW_DIAGNOSTICS", enabled: value });
      if (!result?.ok || result.persisted !== true) { state.preferenceError = result?.error || t("diagnosticsPreferenceSaveFailed"); status(state.preferenceError, "error"); return; }
      state.enabled = result.enabled; state.preferenceError = ""; updateCapture(true, null);
    }

    async function clearAll() {
      state.clearEpoch += 1; state.epoch += 1; state.detailEpoch += 1; state.busy = false; clearTimeout(state.timer);
      const clearEpoch = state.clearEpoch; const result = await send({ type: "BILAYER_CLEAR_RAW_DIAGNOSTICS" });
      if (!result?.ok || clearEpoch !== state.clearEpoch) { $("di-confirm").hidden = true; $("di-clear").hidden = false; status(t("diagnosticsClearFailed"), "error"); scheduleRefresh(state.epoch); return; }
      state.generation = result.generation; state.version = result.version; state.summaries = []; state.cursor = null; state.loadedCursor = null; state.selectedId = null; state.detail = null; state.counts = { all: 0, normal: 0, abnormal: 0, pending: 0 };
      $("di-confirm").hidden = true; $("di-clear").hidden = false; renderList(0); showDetailEmpty(); status("", "idle");
      if (state.active && !document.hidden) { state.busy = false; void refresh(); }
    }

    function updateCapture(known, storageError) {
      $("di-capture").textContent = state.enabled ? t("diagnosticsCaptureStop") : t("diagnosticsCaptureStart"); $("di-capture").setAttribute("aria-pressed", String(state.enabled));
      $("di-capture-status").textContent = storageError ? t("diagnosticsStorageError", [storageError.reason || storageError]) : known ? state.enabled ? t("diagnosticsCaptureOn") : t("diagnosticsCaptureOff") : t("diagnosticsPreferenceUnknown");
    }
    function status(message, kind) { $("di-status").textContent = message; $("di-status").dataset.state = kind; }
    function t(key, args) { return globalThis.i18n.t(key, args); }

    function updateTreeSearch() {
      const query = $("di-json-search").value.trim().toLowerCase();
      for (const row of state.matches) row.classList.remove("is-match", "is-current-match");
      state.matches = query ? [...$("di-payload").querySelectorAll(".json-row")].filter((row) => query.startsWith("$") ? row.dataset.path.toLowerCase().includes(query) : row.searchText.includes(query)) : [];
      state.matchIndex = state.matches.length ? 0 : -1; state.matches.forEach((row) => row.classList.add("is-match"));
      $("di-match-prev").disabled = !state.matches.length; $("di-match-next").disabled = !state.matches.length;
      $("di-search-status").textContent = state.matches.length ? `1 / ${state.matches.length}` : query ? t("diagnosticsNoSearchMatches") : "";
      if (state.matches.length) revealMatch(false);
    }
    function moveMatch(step) { if (!state.matches.length) return; state.matches[state.matchIndex]?.classList.remove("is-current-match"); state.matchIndex = (state.matchIndex + step + state.matches.length) % state.matches.length; revealMatch(true); }
    function revealMatch(focus) { const row = state.matches[state.matchIndex]; for (let branch = row.closest("details"); branch; branch = branch.parentElement.closest("details")) branch.open = true; row.classList.add("is-current-match"); row.scrollIntoView({ block: "nearest" }); $("di-path-value").textContent = row.dataset.path; $("di-search-status").textContent = `${state.matchIndex + 1} / ${state.matches.length}`; if (focus) row.focus(); }
    function setTreeDepth(depth) { $("di-payload").querySelectorAll(".json-node").forEach((node) => { node.open = Number(node.dataset.depth) < depth; }); if (state.matches.length) revealMatch(false); }
    function navigateTree(event) {
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || $("di-json-tools").hidden) return;
      const rows = [...$("di-payload").querySelectorAll(".json-row")].filter((row) => row.getClientRects().length); if (!rows.length) return;
      const current = event.target.closest(".json-row"); const index = rows.indexOf(current); let next = current;
      if (event.key === "ArrowDown") next = rows[Math.min(index + 1, rows.length - 1)]; else if (event.key === "ArrowUp") next = rows[Math.max(index - 1, 0)]; else if (event.key === "Home") next = rows[0]; else if (event.key === "End") next = rows.at(-1);
      else if (event.key === "ArrowRight" && current?.parentElement.matches("details")) { const branch = current.parentElement; if (!branch.open) branch.open = true; else next = branch.querySelector(".json-children > :first-child > .json-row") ?? current; }
      else if (event.key === "ArrowLeft" && current) { const branch = current.parentElement; if (branch.matches("details") && branch.open) branch.open = false; else next = current.closest(".json-children")?.parentElement.querySelector(":scope > summary") ?? current; }
      event.preventDefault(); (next ?? rows[0]).focus(); (next ?? rows[0]).scrollIntoView({ block: "nearest" });
    }
  }

  function send(message) { return new Promise((resolve) => { if (!runtime?.runtime?.sendMessage) { resolve({ ok: false, error: "unavailable" }); return; } runtime.runtime.sendMessage(message, (response) => resolve(runtime.runtime.lastError ? { ok: false, error: runtime.runtime.lastError.message } : response)); }); }
  function markup() {
    const msg = (key) => globalThis.i18n.t(key);
    return `<section class="dc-root" aria-label="${escapeHtml(msg("diagnosticsHeading"))}"><header class="dc-toolbar"><div class="dc-filter" role="tablist" aria-label="${escapeHtml(msg("diagnosticsFilters"))}"><button type="button" role="tab" data-filter="all" aria-selected="true">${escapeHtml(msg("diagnosticsAll"))}<span id="di-count-all">0</span></button><button type="button" role="tab" data-filter="normal" aria-selected="false" tabindex="-1">${escapeHtml(msg("diagnosticsNormal"))}<span id="di-count-normal">0</span></button><button type="button" role="tab" data-filter="abnormal" aria-selected="false" tabindex="-1">${escapeHtml(msg("diagnosticsAbnormal"))}<span id="di-count-abnormal">0</span></button></div><input id="di-search" type="search" placeholder="${escapeHtml(msg("diagnosticsSearch"))}" aria-label="${escapeHtml(msg("diagnosticsSearch"))}" autocomplete="off"><span id="di-capture-status" role="status"></span><button id="di-refresh" type="button">${escapeHtml(msg("diagnosticsRefresh"))}</button><details class="dc-more"><summary>${escapeHtml(msg("diagnosticsMore"))}</summary><div><button id="di-capture" type="button" aria-pressed="false"></button><button id="di-export" type="button">${escapeHtml(msg("diagnosticsExportAll"))}</button><button id="di-clear" class="quiet-button" type="button">${escapeHtml(msg("diagnosticsClear"))}</button><span id="di-confirm" hidden><span>${escapeHtml(msg("diagnosticsConfirmClear"))}</span><button id="di-confirm-yes" type="button">${escapeHtml(msg("diagnosticsConfirm"))}</button><button id="di-confirm-no" type="button">${escapeHtml(msg("diagnosticsCancel"))}</button></span></div></details></header><p id="di-status" role="status" aria-live="polite"></p><div class="dc-grid"><section class="dc-list-panel"><div class="dc-list-head"><strong>${escapeHtml(msg("diagnosticsRequests"))}</strong><span id="di-list-count">0</span></div><div id="di-list-scroll" class="dc-list-scroll"><div class="dc-list-head dc-columns"><span>${escapeHtml(msg("diagnosticsRequest"))}</span><span>${escapeHtml(msg("diagnosticsResult"))}</span><span>${escapeHtml(msg("diagnosticsModel"))}</span><span>${escapeHtml(msg("diagnosticsHttp"))}</span><span>${escapeHtml(msg("diagnosticsDuration"))}</span></div><div id="di-list" role="listbox" aria-label="${escapeHtml(msg("diagnosticsRequests"))}"></div><p id="di-empty">${escapeHtml(msg("diagnosticsEmpty"))}</p></div><button id="di-more" type="button" hidden>${escapeHtml(msg("diagnosticsLoadMore"))}</button></section><section class="dc-detail-panel"><div id="di-detail-empty">${escapeHtml(msg("diagnosticsSelectRequest"))}</div><div id="di-detail" hidden><header><strong id="di-detail-title"></strong><span id="di-detail-state"></span></header><nav class="dc-payload-tabs" aria-label="${escapeHtml(msg("diagnosticsInspector"))}"><button type="button" data-payload="response" aria-pressed="true">${escapeHtml(msg("diagnosticsResponse"))}</button><button type="button" data-payload="request" aria-pressed="false">${escapeHtml(msg("diagnosticsRequest"))}</button><button type="button" data-payload="subtitles" aria-pressed="false">${escapeHtml(msg("diagnosticsSubtitles"))}</button><button type="button" data-payload="info" aria-pressed="false">${escapeHtml(msg("diagnosticsInfo"))}</button></nav><div class="dc-payload-actions"><button id="di-format-toggle" type="button" hidden>${escapeHtml(msg("diagFormatted"))}</button><button id="di-tree-toggle" type="button" hidden>${escapeHtml(msg("diagnosticsTree"))}</button><button id="di-copy" type="button">${escapeHtml(msg("diagnosticsCopy"))}</button></div><div id="di-json-tools" hidden><input id="di-json-search" type="search" placeholder="${escapeHtml(msg("diagnosticsSearchJson"))}" aria-label="${escapeHtml(msg("diagnosticsSearchJson"))}"><span id="di-search-status" role="status"></span><button id="di-match-prev" type="button" aria-label="${escapeHtml(msg("diagnosticsPreviousMatch"))}">↑</button><button id="di-match-next" type="button" aria-label="${escapeHtml(msg("diagnosticsNextMatch"))}">↓</button><button id="di-expand" type="button">${escapeHtml(msg("diagnosticsExpand"))}</button><button id="di-collapse" type="button">${escapeHtml(msg("diagnosticsCollapse"))}</button><span id="di-path-value">$</span></div><div id="di-payload" tabindex="0"></div><pre id="di-info" hidden></pre></div></section></div><iframe id="di-export-frame" hidden></iframe></section>`;
  }
  function parseFormattedJson(text) { try { const value = JSON.parse(text); for (const message of value?.messages ?? []) if (typeof message.content === "string") message.content = parseEmbeddedJson(message.content); for (const choice of value?.choices ?? []) if (typeof choice.message?.content === "string") choice.message.content = parseEmbeddedJson(choice.message.content); return value; } catch { return null; } }
  function parseEmbeddedJson(content) { if (typeof content !== "string") return content; const candidate = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); try { return JSON.parse(candidate); } catch { const match = candidate.match(/\[[\s\S]*\]|\{[\s\S]*\}/); if (!match) return content; try { return JSON.parse(match[0].replace(/,\s*([}\]])/g, "$1")); } catch { return content; } } }
  function normalizeItems(value) { if (Array.isArray(value)) return value.map(normalizeItem); if (Array.isArray(value?.items)) return value.items.map(normalizeItem); if (value && typeof value === "object" && ("id" in value || "id/" in value)) return [normalizeItem(value)]; return []; }
  function normalizeItem(item) { const normalized = {}; for (const [key, value] of Object.entries(item ?? {})) { const clean = key.replace(/[\W_]+/g, "").toLowerCase(); if (clean === "id") normalized.id = String(value ?? "").trim(); else if (["text", "translation", "content"].includes(clean)) normalized.text = String(value ?? ""); else if (["ruby", "furigana"].includes(clean)) normalized.ruby = String(value ?? ""); else normalized[key] = value; } return normalized; }
  function requestPayload(record) {
    const body = parseFormattedJson(record.request?.body ?? "");
    const user = body?.messages?.find((message) => message.role === "user");
    return typeof user?.content === "string" ? parseEmbeddedJson(user.content) : user?.content;
  }
  function responsePayload(record) {
    const response = parseFormattedJson(record.response?.body ?? "")?.choices?.[0]?.message?.content;
    return typeof response === "string" ? parseEmbeddedJson(response) : response;
  }
  function normalizeReadings(value) {
    const entries = value?.readings ?? value;
    if (Array.isArray(entries)) return new Map(entries.filter((item) => item && typeof item.surface === "string" && typeof item.reading === "string").map((item) => [item.surface, item.reading]));
    if (entries && typeof entries === "object") return new Map(Object.entries(entries).filter(([, reading]) => typeof reading === "string"));
    return new Map();
  }
  function annotateText(text, readings, legacyRuby = "") {
    const mappings = new Map(readings);
    const legacy = String(legacyRuby ?? "").matchAll(/<ruby>\s*([^<]+?)\s*<rt>\s*([^<]+?)\s*<\/rt>\s*<\/ruby>/gi);
    for (const match of legacy) mappings.set(match[1], match[2]);
    let annotated = String(text ?? "");
    for (const [surface, reading] of [...mappings].sort(([left], [right]) => right.length - left.length)) {
      if (!surface || !annotated.includes(surface)) continue;
      const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      annotated = annotated.replace(new RegExp(escaped, "g"), `{${surface}|${String(reading).replace(/[{}|]/g, "")}}`);
    }
    return annotated;
  }
  function renderUiPreview(record) {
    const request = requestPayload(record) ?? {}; const sources = Array.isArray(request.items) ? request.items : [];
    const translated = normalizeItems(responsePayload(record));
    const byId = new Map(translated.map((item, index) => [item.id || String(sources[index]?.id ?? index), item]));
    const wrap = document.createElement("div"); wrap.className = "dc-subtitles";
    const sourceIsJapanese = /^ja(?:[-_]|$)/i.test(String(request.sourceLanguage ?? ""));
    const targetIsJapanese = /^ja(?:[-_]|$)/i.test(String(request.targetLanguage ?? ""));
    for (const [index, source] of sources.entries()) {
      const id = String(source.id ?? index); const target = byId.get(id); const card = document.createElement("section"); card.className = "dc-subtitle";
      const label = document.createElement("small"); label.textContent = `#${id}`; card.append(label);
      if (source.text) { const line = document.createElement("div"); line.className = "dc-source"; const sourceReadings = sourceIsJapanese && !targetIsJapanese ? normalizeReadings(target?.readings) : new Map(); renderRubyText(line, annotateText(source.text, sourceReadings, sourceIsJapanese && !targetIsJapanese ? target?.ruby : "")); card.append(line); }
      if (target?.text) { const line = document.createElement("div"); line.className = "dc-target"; const targetReadings = targetIsJapanese ? normalizeReadings(target.readings) : new Map(); renderRubyText(line, annotateText(target.text, targetReadings, targetIsJapanese ? target.ruby : "")); card.append(line); }
      wrap.append(card);
    }
    return wrap;
  }
  function renderRubyText(container, rawText) {
    let text = String(rawText ?? "").replace(/<ruby>\s*([^<]+?)\s*<rt>\s*([^<]+?)\s*<\/rt>\s*<\/ruby>/gi, "{$1|$2}");
    text = text.replace(/\{([一-龯々〆ヵヶ]+)[(（]([ぁ-ん]+)[)）]\}/g, "{$1|$2}");
    const pattern = /\{([^|{}]+)\|([^|{}]+)\}/g; let last = 0; let match;
    while ((match = pattern.exec(text))) { container.append(document.createTextNode(text.slice(last, match.index))); const ruby = document.createElement("ruby"); ruby.append(document.createTextNode(match[1])); const rt = document.createElement("rt"); rt.textContent = match[2]; ruby.append(rt); container.append(ruby); last = pattern.lastIndex; }
    container.append(document.createTextNode(text.slice(last).replace(/\{([^|{}]+)\}/g, "$1")));
  }
  function subtitleCopy(record) {
    const sources = Array.isArray(requestPayload(record)?.items) ? requestPayload(record).items : [];
    const targets = normalizeItems(responsePayload(record)); const byId = new Map(targets.map((item, index) => [item.id || String(index), item]));
    return sources.map((source, index) => {
      const id = String(source.id ?? index); const target = byId.get(id); if (!target) return null;
      return `[#${id}]\n${globalThis.i18n.t("diagnosticsSourceLabel", [source.text ?? ""])}\n${globalThis.i18n.t("diagnosticsTargetLabel", [target.text ?? ""])}`;
    }).filter(Boolean).join("\n\n");
  }
  function createJsonNode(value, label, path, depth) {
    const collection = value !== null && typeof value === "object"; const node = document.createElement(collection ? "details" : "div");
    if (collection) { node.className = "json-node"; node.dataset.depth = String(depth); node.open = depth < 2; }
    const row = document.createElement(collection ? "summary" : "div"); row.className = `json-row ${collection ? "json-branch" : "json-leaf"}`; row.dataset.path = path; row.searchText = `${label} ${collection ? "" : JSON.stringify(value)}`.toLowerCase(); row.tabIndex = depth === 0 || collection ? 0 : -1;
    const key = document.createElement("span"); key.className = "json-key"; key.textContent = `${label}:`; row.append(key);
    if (collection) { const children = document.createElement("div"); children.className = "json-children"; for (const [name, child] of Array.isArray(value) ? value.entries() : Object.entries(value)) { const index = typeof name === "number"; const childPath = index ? `${path}[${name}]` : `${path}${/^[a-zA-Z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`}`; children.append(createJsonNode(child, index ? `[${name}]` : JSON.stringify(name), childPath, depth + 1)); } node.append(row, children); }
    else { const scalar = document.createElement("span"); scalar.className = `json-${value === null ? "null" : typeof value}`; scalar.textContent = JSON.stringify(value); row.append(scalar); if (typeof value === "string" && value.length > 160) { const expand = document.createElement("button"); expand.type = "button"; expand.className = "json-expand"; expand.textContent = diagnosticsText("diagnosticsExpandValue"); expand.setAttribute("aria-expanded", "false"); expand.addEventListener("click", () => { const expanded = expand.getAttribute("aria-expanded") === "true"; scalar.classList.toggle("is-expanded", !expanded); expand.setAttribute("aria-expanded", String(!expanded)); expand.textContent = diagnosticsText(expanded ? "diagnosticsExpandValue" : "diagnosticsCollapseValue"); }); row.append(expand); } node.append(row); }
    return node;
  }
  function duration(record) { return record.completedAt && record.at ? `${record.completedAt - record.at} ms` : globalThis.i18n.t("diagnosticsPending"); }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
})();
