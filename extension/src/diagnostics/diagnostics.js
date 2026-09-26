/**
 * [INPUT]: 依赖 browser/chrome runtime 消息 API 与 diagnostics.html 的报文面板
 * [OUTPUT]: 轮询原始报文，提供折叠 JSON 树、键盘路径导航、长字符串预览及逐字原文切换
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
  requestMeta: document.querySelector("#requestMeta"),
  headersView: document.querySelector("#headersView"),
  payloadView: document.querySelector("#payloadView"),
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

void init();

async function init() {
  bindControls();
  await send({ type: "NETFLIX_DUAL_SUBTITLES_SET_RAW_DIAGNOSTICS", enabled: true });
  await refresh();
  window.addEventListener("pagehide", () => {
    void send({ type: "NETFLIX_DUAL_SUBTITLES_SET_RAW_DIAGNOSTICS", enabled: false });
  });
  window.setInterval(refresh, 1000);
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
  if (parsed) {
    elements.payloadView.append(createJsonNode(parsed.value, "$", "$"));
  } else {
    const raw = document.createElement("pre");
    raw.className = "payload-raw";
    raw.textContent = text;
    elements.payloadView.append(raw);
  }
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
function createJsonNode(value, label, path) {
  const collection = value !== null && typeof value === "object";
  const node = document.createElement(collection ? "details" : "div");
  if (collection) {
    node.className = "json-node";
    node.open = true;
  }
  const row = document.createElement(collection ? "summary" : "div");
  row.className = `json-row${collection ? "" : " json-leaf"}`;
  row.dataset.path = path;
  row.tabIndex = -1;
  const key = document.createElement("span");
  key.className = "json-key";
  key.textContent = `${label}:`;
  row.append(key);
  if (collection) {
    const count = document.createElement("span");
    count.className = "json-count";
    count.textContent = `${Array.isArray(value) ? value.length : Object.keys(value).length} 项`;
    row.append(count);
    const children = document.createElement("div");
    children.className = "json-children";
    for (const [name, child] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
      const index = typeof name === "number";
      const childPath = index ? `${path}[${name}]` : `${path}${/^[a-zA-Z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`}`;
      children.append(createJsonNode(child, index ? `[${name}]` : JSON.stringify(name), childPath));
    }
    node.append(row, children);
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
