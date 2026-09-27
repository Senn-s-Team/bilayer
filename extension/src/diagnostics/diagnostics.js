/**
 * [INPUT]: 依赖 browser/chrome runtime 消息 API 与 diagnostics.html 的报文面板
 * [OUTPUT]: 轮询原始报文，提供紧凑检查器、可搜索 JSON 树、层级控制及逐字原文切换
 * [POS]: diagnostics 模块的交互层，只允许扩展诊断页读取 background 内存记录
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const runtime = globalThis.browser ?? globalThis.chrome;
const elements = {
  liveStatus: document.querySelector("#liveStatus"),
  toggle: document.querySelector("#toggleCapture"),
  refresh: document.querySelector("#refreshRecords"),
  clear: document.querySelector("#clearRecords"),
  recordCount: document.querySelector("#recordCount"),
  recordList: document.querySelector("#recordList"),
  empty: document.querySelector("#emptyState"),
  detailEmpty: document.querySelector("#detailEmpty"),
  detailContent: document.querySelector("#detailContent"),
  detailMeta: document.querySelector("#detailMeta"),
  detailTitle: document.querySelector("#detailTitle"),
  detailResult: document.querySelector("#detailResult"),
  transportSummary: document.querySelector("#transportSummary"),
  requestMeta: document.querySelector("#requestMeta"),
  headersView: document.querySelector("#headersView"),
  payloadView: document.querySelector("#payloadView"),
  payloadShape: document.querySelector("#payloadShape"),
  jsonTools: document.querySelector("#jsonTools"),
  jsonSearch: document.querySelector("#jsonSearch"),
  searchStatus: document.querySelector("#searchStatus"),
  previousMatch: document.querySelector("#previousMatch"),
  nextMatch: document.querySelector("#nextMatch"),
  expandTree: document.querySelector("#expandTree"),
  collapseTree: document.querySelector("#collapseTree"),
  jsonPath: document.querySelector("#jsonPath"),
  jsonPathValue: document.querySelector("#jsonPathValue"),
  toggleRaw: document.querySelector("#toggleRaw")
};

let records = [];
let selectedId = null;
let payloadKind = "request";
let showRaw = false;
let version = -1;
let renderedPayload = null;
let searchMatches = [];
let activeMatch = -1;

void init();

async function init() {
  bindControls();
  if (!runtime?.runtime?.sendMessage) {
    showLocalPreview();
    return;
  }
  await send({ type: "NETFLIX_DUAL_SUBTITLES_SET_RAW_DIAGNOSTICS", enabled: true });
  await refresh();
  window.addEventListener("pagehide", () => {
    void send({ type: "NETFLIX_DUAL_SUBTITLES_SET_RAW_DIAGNOSTICS", enabled: false });
  });
  window.setInterval(refresh, 1000);
}

function showLocalPreview() {
  const at = Date.now();
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "请保持字幕自然、简洁。" },
      { role: "user", content: JSON.stringify({ items: [{ id: "42", text: "We should get going." }], contextBefore: ["It's getting late."], contextAfter: ["The train leaves soon."] }) }
    ],
    temperature: 0.2
  });
  records = [{ id: 1, at, completedAt: at + 842, validated: true,
    request: { url: "https://api.openai.com/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json" }, body },
    response: { status: 200, statusText: "OK", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ items: [{ id: "42", text: "そろそろ行こう。" }] }) } }] }) }
  }];
  selectedId = 1;
  elements.liveStatus.textContent = "界面预览 · 示例数据";
  elements.liveStatus.dataset.state = "idle";
  elements.toggle.disabled = true;
  elements.refresh.disabled = true;
  elements.clear.disabled = true;
  render();
}

function bindControls() {
  elements.refresh.addEventListener("click", () => void refresh());
  elements.toggle.addEventListener("click", async () => {
    await send({ type: "NETFLIX_DUAL_SUBTITLES_SET_RAW_DIAGNOSTICS", enabled: elements.toggle.dataset.enabled !== "true" });
    await refresh();
  });
  elements.clear.addEventListener("click", async () => {
    await send({ type: "NETFLIX_DUAL_SUBTITLES_CLEAR_RAW_DIAGNOSTICS" });
    records = [];
    selectedId = null;
    version = -1;
    render();
  });
  document.querySelectorAll("[data-payload]").forEach((button) => {
    button.addEventListener("click", () => {
      payloadKind = button.dataset.payload;
      document.querySelectorAll("[data-payload]").forEach((item) => item.classList.toggle("is-active", item === button));
      renderDetail();
    });
  });
  elements.toggleRaw.addEventListener("click", () => {
    showRaw = !showRaw;
    elements.toggleRaw.textContent = showRaw ? "查看格式化 JSON" : "查看原文";
    elements.toggleRaw.setAttribute("aria-pressed", String(showRaw));
    renderDetail();
  });
  elements.jsonSearch.addEventListener("input", updateSearch);
  elements.jsonSearch.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    selectSearchMatch(event.shiftKey ? -1 : 1, true);
  });
  elements.previousMatch.addEventListener("click", () => selectSearchMatch(-1, true));
  elements.nextMatch.addEventListener("click", () => selectSearchMatch(1, true));
  elements.expandTree.addEventListener("click", () => setTreeDepth(Infinity));
  elements.collapseTree.addEventListener("click", () => setTreeDepth(2));
  elements.payloadView.addEventListener("focusin", (event) => {
    const row = event.target.closest(".json-row");
    if (row) elements.jsonPathValue.textContent = row.dataset.path;
  });
  elements.payloadView.addEventListener("click", (event) => {
    if (event.target.closest(".json-string-button")) return;
    event.target.closest(".json-row")?.focus();
  });
  elements.payloadView.addEventListener("keydown", navigateJsonTree);
}

async function refresh() {
  const result = await send({ type: "NETFLIX_DUAL_SUBTITLES_GET_RAW_DIAGNOSTICS", version });
  if (!result?.ok) {
    elements.liveStatus.textContent = "后台连接失败";
    elements.liveStatus.dataset.state = "error";
    return;
  }
  if (Array.isArray(result.records)) {
    records = result.records;
    if (selectedId !== null && !records.some((record) => record.id === selectedId)) selectedId = null;
    if (selectedId === null && records.length) selectedId = records.at(-1).id;
    version = result.version;
    render();
  }
  elements.liveStatus.textContent = result.enabled ? "原始采集中" : "未开启采集";
  elements.liveStatus.dataset.state = result.enabled ? "ready" : "idle";
  elements.toggle.dataset.enabled = String(result.enabled);
  elements.toggle.textContent = result.enabled ? "停止采集" : "开始采集";
}

function render() {
  elements.recordCount.textContent = String(records.length);
  const scrollTop = elements.recordList.scrollTop;
  elements.recordList.replaceChildren();
  elements.empty.hidden = records.length > 0;
  for (const record of records.slice().reverse()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `record-item${record.id === selectedId ? " is-active" : ""}`;
    button.setAttribute("aria-current", String(record.id === selectedId));
    button.dataset.state = record.validated ? "success" : record.failure || record.error ? "error" : "loading";
    const status = record.validated ? "成功" : record.failure?.errorCode ?? record.error ?? "处理中";
    const duration = record.completedAt && record.at ? `${record.completedAt - record.at} ms` : "进行中";
    const request = record.request ?? {};
    button.title = request.url ?? "";
    button.innerHTML = `<span class="record-top"><strong>请求 ${escapeHtml(record.id)}</strong><time>${escapeHtml(new Date(record.at ?? Date.now()).toLocaleTimeString())}</time></span><span class="record-model">${escapeHtml(requestModel(request.body))}</span><span class="record-state"><em>${escapeHtml(status)}</em><span>${escapeHtml(duration)}</span></span>`;
    button.addEventListener("click", () => {
      selectedId = record.id;
      elements.recordList.querySelectorAll(".record-item").forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-current", String(active));
      });
      renderDetail();
    });
    elements.recordList.append(button);
  }
  elements.recordList.scrollTop = scrollTop;
  renderDetail();
}

function requestModel(body) {
  try {
    const model = JSON.parse(body)?.model;
    return typeof model === "string" && model ? model : "未指定模型";
  } catch {
    return "未指定模型";
  }
}

function renderDetail() {
  const record = records.find((item) => item.id === selectedId);
  elements.detailEmpty.hidden = Boolean(record);
  elements.detailContent.hidden = !record;
  if (!record) return;

  const request = record.request ?? {};
  const response = record.response;
  const status = record.validated ? "成功" : record.failure?.errorCode ?? record.error ?? (response ? "已返回，未完成校验" : "请求中");
  elements.detailMeta.textContent = new Date(record.at ?? Date.now()).toLocaleString();
  elements.detailTitle.textContent = `请求 ${record.id}`;
  elements.detailResult.textContent = status;
  elements.detailResult.dataset.state = record.validated ? "success" : record.failure || record.error ? "error" : "loading";
  elements.transportSummary.textContent = `${request.method ?? "请求"} · ${response?.status ?? "等待响应"} · ${record.completedAt && record.at ? `${record.completedAt - record.at} ms` : "进行中"}`;
  elements.requestMeta.replaceChildren(
    meta("URL", request.url ?? ""),
    meta("方法", request.method ?? ""),
    meta("请求体字节", byteLength(request.body)),
    meta("响应状态", response ? `${response.status} ${response.statusText ?? ""}`.trim() : "等待响应"),
    meta("响应体字节", byteLength(response?.body)),
    meta("完整耗时", record.completedAt && record.at ? `${record.completedAt - record.at} ms` : "进行中")
  );
  elements.headersView.textContent = JSON.stringify({ request: request.headers, response: response?.headers ?? null }, null, 2);
  const body = payloadKind === "request" ? request.body : response?.body;
  const text = body ?? (record.error ? `请求未收到响应：${record.error}` : "响应尚未返回");
  renderPayload(record.id, text);
}

function renderPayload(recordId, text) {
  if (renderedPayload?.recordId === recordId && renderedPayload.text === text &&
      renderedPayload.kind === payloadKind && renderedPayload.raw === showRaw) return;
  renderedPayload = { recordId, text, kind: payloadKind, raw: showRaw };
  elements.payloadView.replaceChildren();
  elements.jsonPathValue.textContent = "$";
  const parsed = showRaw ? null : parseFormattedJson(text);
  elements.jsonPath.hidden = !parsed;
  elements.jsonTools.hidden = !parsed;
  elements.payloadShape.textContent = showRaw ? "原始文本" : parsed ? describeJson(parsed.value) : "纯文本";
  if (parsed) {
    elements.payloadView.append(createJsonNode(parsed.value, "$", "$", 0));
    updateSearch();
  } else {
    searchMatches = [];
    activeMatch = -1;
    const raw = document.createElement("pre");
    raw.className = "payload-raw";
    raw.textContent = text;
    elements.payloadView.append(raw);
  }
}

function describeJson(value) {
  if (Array.isArray(value)) return `JSON 数组 · ${value.length} 项`;
  if (value !== null && typeof value === "object") return `JSON 对象 · ${Object.keys(value).length} 个字段`;
  return `JSON · ${value === null ? "null" : typeof value}`;
}

function parseFormattedJson(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed?.messages)) {
      for (const entry of parsed.messages) {
        if (typeof entry?.content === "string") entry.content = parseEmbeddedJson(entry.content);
      }
    }
    if (Array.isArray(parsed?.choices)) {
      for (const choice of parsed.choices) {
        const message = choice?.message;
        if (typeof message?.content === "string") message.content = parseEmbeddedJson(message.content);
      }
    }
    return { value: parsed };
  } catch {
    return null;
  }
}

function parseEmbeddedJson(content) {
  try { return JSON.parse(content); } catch {
    if (!content.trimStart().startsWith("{")) return content;
    try { return JSON.parse(`[${content}]`); } catch { return content; }
  }
}
function createJsonNode(value, label, path, depth) {
  const collection = value !== null && typeof value === "object";
  const node = document.createElement(collection ? "details" : "div");
  if (collection) {
    node.className = "json-node";
    node.dataset.depth = String(depth);
    node.open = depth < 2;
  }
  const row = document.createElement(collection ? "summary" : "div");
  row.className = `json-row ${collection ? "json-branch" : "json-leaf"}`;
  row.dataset.path = path;
  row.searchText = `${label} ${collection ? "" : JSON.stringify(value)}`.toLowerCase();
  row.tabIndex = -1;
  const key = document.createElement("span");
  key.className = "json-key";
  key.textContent = `${label}:`;
  row.append(key);
  if (collection) {
    const isArray = Array.isArray(value);
    const bracket = document.createElement("span");
    bracket.className = "json-bracket";
    bracket.textContent = isArray ? "[" : "{";
    const type = document.createElement("span");
    type.className = "json-type";
    type.textContent = isArray ? "数组" : "对象";
    const count = document.createElement("span");
    count.className = "json-count";
    count.textContent = `${isArray ? value.length : Object.keys(value).length} ${isArray ? "项" : "字段"}`;
    row.append(bracket, type, count);
    const children = document.createElement("div");
    children.className = "json-children";
    for (const [name, child] of isArray ? value.entries() : Object.entries(value)) {
      const index = typeof name === "number";
      const childPath = index ? `${path}[${name}]` : `${path}${/^[a-zA-Z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`}`;
      children.append(createJsonNode(child, index ? `[${name}]` : JSON.stringify(name), childPath, depth + 1));
    }
    const close = document.createElement("div");
    close.className = "json-close";
    close.textContent = isArray ? "]" : "}";
    node.append(row, children, close);
  } else {
    const valueType = value === null ? "null" : typeof value;
    if (valueType === "string" && value.length > 160) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "json-string-button";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", `展开 ${path} 的完整字符串`);
      button.textContent = `${JSON.stringify(value.slice(0, 160))}…`;
      button.addEventListener("click", () => {
        const expanded = button.getAttribute("aria-expanded") === "true";
        button.setAttribute("aria-expanded", String(!expanded));
        button.setAttribute("aria-label", `${expanded ? "展开" : "收起"} ${path} 的完整字符串`);
        button.textContent = expanded ? `${JSON.stringify(value.slice(0, 160))}…` : JSON.stringify(value);
      });
      row.append(button);
    } else {
      const scalar = document.createElement("span");
      scalar.className = `json-${valueType}`;
      scalar.textContent = JSON.stringify(value);
      row.append(scalar);
    }
    node.append(row);
  }
  return node;
}

function updateSearch() {
  const query = elements.jsonSearch.value.trim().toLowerCase();
  for (const row of searchMatches) row.classList.remove("is-match", "is-current-match");
  searchMatches = query ? [...elements.payloadView.querySelectorAll(".json-row")].filter((row) =>
    query.startsWith("$") ? row.dataset.path.toLowerCase().includes(query) : row.searchText.includes(query)) : [];
  activeMatch = searchMatches.length ? 0 : -1;
  for (const row of searchMatches) row.classList.add("is-match");
  elements.previousMatch.disabled = !searchMatches.length;
  elements.nextMatch.disabled = !searchMatches.length;
  elements.searchStatus.textContent = !query ? "搜索 JSON" : searchMatches.length ? `1 / ${searchMatches.length}` : "无匹配";
  if (searchMatches.length) revealSearchMatch(false);
}

function selectSearchMatch(step, focus) {
  if (!searchMatches.length) return;
  searchMatches[activeMatch]?.classList.remove("is-current-match");
  activeMatch = (activeMatch + step + searchMatches.length) % searchMatches.length;
  revealSearchMatch(focus);
}

function revealSearchMatch(focus) {
  const row = searchMatches[activeMatch];
  for (let branch = row.closest("details"); branch; branch = branch.parentElement.closest("details")) branch.open = true;
  row.classList.add("is-current-match");
  row.scrollIntoView({ block: "nearest" });
  elements.jsonPathValue.textContent = row.dataset.path;
  elements.searchStatus.textContent = `${activeMatch + 1} / ${searchMatches.length}`;
  if (focus) row.focus();
}

function setTreeDepth(depth) {
  for (const node of elements.payloadView.querySelectorAll(".json-node")) node.open = Number(node.dataset.depth) < depth;
  if (searchMatches.length) revealSearchMatch(false);
}

function navigateJsonTree(event) {
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || elements.jsonPath.hidden) return;
  const rows = [...elements.payloadView.querySelectorAll(".json-row")].filter((row) => row.getClientRects().length);
  if (!rows.length) return;
  const current = event.target.closest(".json-row");
  const index = rows.indexOf(current);
  let next = current;
  if (event.key === "ArrowDown") next = rows[Math.min(index + 1, rows.length - 1)];
  else if (event.key === "ArrowUp") next = rows[Math.max(index - 1, 0)];
  else if (event.key === "Home") next = rows[0];
  else if (event.key === "End") next = rows.at(-1);
  else if (event.key === "ArrowRight" && current?.parentElement.matches("details")) {
    const branch = current.parentElement;
    if (!branch.open) branch.open = true;
    else next = branch.querySelector(".json-children > :first-child > .json-row") ?? current;
  } else if (event.key === "ArrowLeft" && current) {
    const branch = current.parentElement;
    if (branch.matches("details") && branch.open) branch.open = false;
    else next = current.closest(".json-children")?.parentElement.querySelector(":scope > summary") ?? current;
  }
  event.preventDefault();
  (next ?? rows[0]).focus();
  (next ?? rows[0]).scrollIntoView({ block: "nearest" });
}


function meta(label, value) {
  const item = document.createElement("div");
  item.className = "meta-item";
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = String(value ?? "");
  item.append(term, description);
  return item;
}

function byteLength(value) {
  return typeof value === "string" ? new TextEncoder().encode(value).length : 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function send(message) {
  return new Promise((resolve) => {
    runtime.runtime.sendMessage(message, (response) => resolve(runtime.runtime.lastError ? { ok: false } : response));
  });
}
