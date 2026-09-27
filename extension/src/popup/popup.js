/**
 * [INPUT]: 依赖 browser/chrome storage/tabs/permissions API 及 popup.html 的导航、翻译和模型下拉控件；保存服务的模型目录由 background 读取密钥并发现
 * [OUTPUT]: 提供四页签导航、只读模型选择、按服务缓存的模型目录及菜单内过滤与扩展内的字幕/provider 操作
 * [POS]: popup 交互层；字幕模式由 aiRole 单一状态表示，翻译设置全局共享，密钥和端点只属于所选 provider
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const runtime = globalThis.browser ?? globalThis.chrome;
const hasExtensionApi = Boolean(runtime?.storage?.local && runtime?.tabs && runtime?.runtime);
const DEFAULT_TRANSLATION_PROMPT = "你是一位专业的影视字幕翻译员，也是目标语言的母语使用者。只翻译 items[].text；contextBefore 和 contextAfter 仅用于理解语境，不要翻译或输出。保持每个 id、数量和顺序完全一致，不合并、不拆分、不遗漏字幕。保留人名、专有名词和既有译名；结合上下文处理代词、时态、人物关系和语气。使用自然、简洁、适合屏幕阅读的字幕表达，不添加解释、注释、时间戳或额外字段。";
const LEGACY_TRANSLATION_PROMPT = "请将字幕准确翻译成目标语言。保持原意、人物语气和上下文，使用自然口语；保留人名、专有名词与格式；不要添加解释或额外内容。";
const TARGET_LANGUAGES = new Set([
  "zh-Hans", "zh-Hant", "ja", "ko", "en", "es", "fr", "de", "it", "pt-BR", "ru", "ar", "hi"
]);
const LLM_PRESETS = {
  openai: {
    name: "OpenAI 官方",
    endpoint: "",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "chatgpt-4o-latest"]
  },
  deepseek: {
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"]
  },
  openrouter: {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "google/gemini-2.5-flash",
    models: ["google/gemini-2.5-flash", "anthropic/claude-3.5-haiku", "openai/gpt-4o-mini", "deepseek/deepseek-chat"]
  },
  groq: {
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
  },
  siliconflow: {
    name: "硅基流动",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "deepseek-ai/DeepSeek-V3",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-7B-Instruct"]
  },
  ollama: {
    name: "Ollama 本地",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "qwen2.5:7b",
    models: ["qwen2.5:7b", "llama3.2", "deepseek-r1:8b"]
  }
};

const DEFAULT_SETTINGS = {
  onboardingCompleted: false,
  enabled: true,
  hideNativeSubtitles: true,
  primaryTrackKey: "",
  primaryTrackPreference: "",
  primaryLanguage: "",
  secondaryTrackKey: "",
  secondaryTrackPreference: "",
  secondaryLanguage: "en",
  aiRole: "off",
  aiSourceTrackKey: "",
  aiSourceTrackPreference: "",
  aiSourceLanguage: "",
  aiTargetLanguage: "zh-Hans",
  aiProviderId: "openai",
  aiPrefetchCount: 10,
  aiContextCount: 2,
  aiStyleGuide: DEFAULT_TRANSLATION_PROMPT,
  aiJapaneseRuby: true,
  primaryFontSize: 26,
  secondaryFontSize: 28,
  primaryVerticalOffset: 26,
  secondaryVerticalOffset: 18,
  subtitleLayoutPreset: "balanced",
  primaryFontFamily: "system",
  secondaryFontFamily: "system",
  primaryFontWeight: 700,
  secondaryFontWeight: 700,
  primaryTextColor: "#FFFFFF",
  secondaryTextColor: "#FFFFFF",
  primaryTextOpacity: 100,
  secondaryTextOpacity: 100,
  primaryStrokeWidth: 1,
  secondaryStrokeWidth: 1,
  primaryStrokeColor: "#000000",
  secondaryStrokeColor: "#000000",
  primaryBackgroundColor: "#000000",
  secondaryBackgroundColor: "#000000",
  primaryBackgroundOpacity: 64,
  secondaryBackgroundOpacity: 64,
  primaryLineHeight: 1.28,
  secondaryLineHeight: 1.28,
  primaryMaxWidth: 86,
  secondaryMaxWidth: 86,
  timingOffsetMs: 0
};

const DEFAULT_PROVIDERS = [
  { id: "openai", name: "OpenAI 官方", endpoint: "", model: "gpt-4o-mini", credential: "" }
];

const STYLE_ROLE_SUFFIXES = [
  "FontSize",
  "VerticalOffset",
  "FontFamily",
  "FontWeight",
  "TextColor",
  "TextOpacity",
  "StrokeWidth",
  "StrokeColor",
  "BackgroundColor",
  "BackgroundOpacity",
  "LineHeight",
  "MaxWidth"
];

const STYLE_DEFAULTS = {
  subtitleLayoutPreset: DEFAULT_SETTINGS.subtitleLayoutPreset
};

for (const role of ["primary", "secondary"]) {
  for (const suffix of STYLE_ROLE_SUFFIXES) {
    STYLE_DEFAULTS[`${role}${suffix}`] = DEFAULT_SETTINGS[`${role}${suffix}`];
  }
}

const LAYOUT_PREVIEW = {
  compact: { gap: 4 },
  balanced: { gap: 8 },
  spacious: { gap: 16 }
};

const PREVIEW_FONT_FAMILIES = {
  system: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  sans: '"Avenir Next", Avenir, "Helvetica Neue", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Arial Rounded MT Bold", "SF Pro Rounded", -apple-system, sans-serif'
};

const controls = {
  enabled: document.querySelector("#enabled"),
  hideNativeSubtitles: document.querySelector("#hideNativeSubtitles"),
  primaryTrackKey: document.querySelector("#primaryTrackKey"),
  secondaryTrackKey: document.querySelector("#secondaryTrackKey"),
  timingOffsetMs: document.querySelector("#timingOffsetMs")
};

const aiControls = {
  aiTargetLanguage: document.querySelector("#aiTargetLanguage"),
  aiPrefetchCount: document.querySelector("#aiPrefetchCount"),
  aiContextCount: document.querySelector("#aiContextCount"),
  aiStyleGuide: document.querySelector("#aiStyleGuide"),
  aiJapaneseRuby: document.querySelector("#aiJapaneseRuby")
};
const providerControls = {
  masterList: document.querySelector("#providerMasterList"),
  add: document.querySelector("#addProvider"),
  delete: document.querySelector("#deleteProvider"),
  editor: document.querySelector("#providerEditor"),
  detailView: document.querySelector("#providerDetailView"),
  draftView: document.querySelector("#providerNewDraftView"),
  name: document.querySelector("#providerName"),
  model: document.querySelector("#providerModel"),
  endpoint: document.querySelector("#providerEndpoint"),
  source: document.querySelector("#aiSourceLanguage")
};

const newDraftControls = {
  name: document.querySelector("#newDraftName"),
  endpoint: document.querySelector("#newDraftEndpoint"),
  model: document.querySelector("#newDraftModel"),
  modelList: document.querySelector("#newDraftModelList"),
  key: document.querySelector("#newDraftKey"),
  saveBtn: document.querySelector("#saveNewDraftBtn"),
  cancelBtn: document.querySelector("#cancelNewDraftBtn"),
  cancelTop: document.querySelector("#cancelNewDraftTop"),
  fetchBtn: document.querySelector("#fetchNewDraftModels"),
  pills: document.querySelectorAll("[data-draft-preset]")
};

const advancedControls = {
  FontSize: { element: document.querySelector("#styleFontSize"), numeric: true },
  VerticalOffset: { element: document.querySelector("#styleVerticalOffset"), numeric: true },
  FontFamily: { element: document.querySelector("#styleFontFamily"), numeric: false },
  FontWeight: { element: document.querySelector("#styleFontWeight"), numeric: true },
  TextColor: { element: document.querySelector("#styleTextColor"), numeric: false },
  TextOpacity: { element: document.querySelector("#styleTextOpacity"), numeric: true },
  StrokeWidth: { element: document.querySelector("#styleStrokeWidth"), numeric: true },
  StrokeColor: { element: document.querySelector("#styleStrokeColor"), numeric: false },
  BackgroundColor: { element: document.querySelector("#styleBackgroundColor"), numeric: false },
  BackgroundOpacity: { element: document.querySelector("#styleBackgroundOpacity"), numeric: true },
  LineHeight: { element: document.querySelector("#styleLineHeight"), numeric: true },
  MaxWidth: { element: document.querySelector("#styleMaxWidth"), numeric: true }
};

const elements = {
  activePageTitle: document.querySelector("#activePageTitle"),
  pageStatus: document.querySelector("#pageStatus"),
  statusDot: document.querySelector("#statusDot"),
  primaryStatus: document.querySelector("#primaryStatus"),
  secondaryStatus: document.querySelector("#secondaryStatus"),
  trackGrid: document.querySelector("#trackGrid"),
  primaryTrackLabel: document.querySelector("#primaryTrackLabel"),
  secondaryTrackLabel: document.querySelector("#secondaryTrackLabel"),
  aiCredential: document.querySelector("#aiCredential"),
  aiCredentialStatus: document.querySelector("#aiCredentialStatus"),
  saveAiCredential: document.querySelector("#saveAiCredential"),
  deleteAiCredential: document.querySelector("#deleteAiCredential"),
  aiEndpointStatus: document.querySelector("#aiEndpointStatus"),
  testProvider: document.querySelector("#testProvider"),
  providerTestStatus: document.querySelector("#providerTestStatus"),
  fetchProviderModels: document.querySelector("#fetchProviderModels"),
  providerModelList: document.querySelector("#providerModelList"),
  openOnboarding: document.querySelector("#openOnboarding"),
  openRawDiagnostics: document.querySelector("#openRawDiagnostics"),
  nativeMode: document.querySelector("#nativeMode"),
  aiMode: document.querySelector("#aiMode"),
  modeDescription: document.querySelector("#modeDescription"),
  openAiSettings: document.querySelector("#openAiSettings"),
  openProviderSettings: document.querySelector("#openProviderSettings"),
  swapTracks: document.querySelector("#swapTracks"),
  reloadTracks: document.querySelector("#reloadTracks"),
  resetStyles: document.querySelector("#resetStyles"),
  styleFontSizeValue: document.querySelector("#styleFontSizeValue"),
  styleVerticalOffsetValue: document.querySelector("#styleVerticalOffsetValue"),
  styleTextColorValue: document.querySelector("#styleTextColorValue"),
  styleTextOpacityValue: document.querySelector("#styleTextOpacityValue"),
  styleStrokeWidthValue: document.querySelector("#styleStrokeWidthValue"),
  styleStrokeColorValue: document.querySelector("#styleStrokeColorValue"),
  styleBackgroundColorValue: document.querySelector("#styleBackgroundColorValue"),
  styleBackgroundOpacityValue: document.querySelector("#styleBackgroundOpacityValue"),
  styleLineHeightValue: document.querySelector("#styleLineHeightValue"),
  styleMaxWidthValue: document.querySelector("#styleMaxWidthValue"),
  stylePreview: document.querySelector("#stylePreview"),
  primaryPreview: document.querySelector("#primaryPreview"),
  secondaryPreview: document.querySelector("#secondaryPreview")
};

let currentSettings = { ...DEFAULT_SETTINGS };
let currentProviders = DEFAULT_PROVIDERS.map((provider) => ({ ...provider }));
let currentPageState = null;
let currentTracks = [];
let currentTrackSignature = "";
let activeStyleRole = "primary";
let pollTimer = 0;
let currentWatchId = "";
let connectedTabId = null;
let connectionHint = "未连接 Netflix 页面；请在影片窗口打开弹窗";
const providerModelCatalog = new Map();

bindNavigation();
void init();

async function init() {
  if (!hasExtensionApi) {
    showLocalPreview();
    return;
  }
  const [stored, pageState] = await Promise.all([readStoredSettings(), readPageState()]);
  currentWatchId = readWatchId(pageState);
  currentSettings = normalizeSettings(stored);
  if (stored.aiStyleGuide === LEGACY_TRANSLATION_PROMPT) await writeSettings({ aiStyleGuide: DEFAULT_TRANSLATION_PROMPT });
  currentProviders = Array.isArray(stored.providers) && stored.providers.length ? stored.providers : DEFAULT_PROVIDERS.map((provider) => ({ ...provider }));
  if (!currentProviders.some((provider) => provider.id === currentSettings.aiProviderId)) currentSettings.aiProviderId = currentProviders[0].id;
  applyPageState(pageState, true);
  writeControls();
  bindControls();
  readCredentialStatus();
  scheduleStatePoll();
}

function showLocalPreview() {
  elements.pageStatus.textContent = "界面预览 · 设置请在 Safari 扩展中使用";
  elements.statusDot.dataset.state = "idle";
  controls.primaryTrackKey.add(new Option("播放时选择轨道", ""));
  controls.secondaryTrackKey.add(new Option("播放时选择轨道", ""));
  providerControls.source.add(new Option("播放时选择源轨道", ""));
  if (providerControls.masterList) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "provider-master-item is-selected";
    btn.textContent = "OpenAI 官方";
    providerControls.masterList.appendChild(btn);
  }
  providerControls.editor.hidden = false;
  providerControls.name.value = DEFAULT_PROVIDERS[0].name;
  setSelectedModel(providerControls.model, DEFAULT_PROVIDERS[0].model);
  setModelOptions(elements.providerModelList, LLM_PRESETS.openai.models);
  bindModelPicker(providerControls.model, elements.providerModelList, document.querySelector("#providerModelMenu"), document.querySelector("#providerModelSearch"), () => {});
  bindModelPicker(newDraftControls.model, newDraftControls.modelList, document.querySelector("#newDraftModelMenu"), document.querySelector("#newDraftModelSearch"), () => {});
  elements.aiCredentialStatus.textContent = "在 Safari 扩展中配置密钥";
  elements.testProvider.addEventListener("click", () => {
    elements.providerTestStatus.textContent = "请在 Safari 扩展中测试连通性";
  });
}

function bindNavigation() {
  const tabButtons = [...document.querySelectorAll("[data-tab]")];
  tabButtons.forEach((button, index) => {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
      const target = event.key === "Home" ? 0 : event.key === "End" ? tabButtons.length - 1
        : (index + step + tabButtons.length) % tabButtons.length;
      tabButtons[target].focus();
      selectTab(tabButtons[target].dataset.tab);
    });
  });
  elements.nativeMode.addEventListener("click", () => void chooseSubtitleMode("native"));
  elements.aiMode.addEventListener("click", () => void chooseSubtitleMode("ai"));
  elements.openAiSettings.addEventListener("click", () => {
    selectTab("ai");
    document.querySelector("#aiTab").focus();
  });
  elements.openProviderSettings.addEventListener("click", () => {
    selectTab("provider");
    document.querySelector("#providerTab").focus();
  });
  elements.openOnboarding?.addEventListener("click", () => {
    const url = runtime?.runtime?.getURL("src/onboarding/onboarding.html")
      ?? new URL("../onboarding/onboarding.html", location.href).href;
    if (runtime?.tabs?.create) void runtime.tabs.create({ url });
    else window.open(url, "_blank");
  });
  elements.openRawDiagnostics.addEventListener("click", () => {
    const url = runtime?.runtime?.getURL("src/diagnostics/diagnostics.html")
      ?? new URL("../diagnostics/diagnostics.html", location.href).href;
    if (runtime?.tabs?.create) void runtime.tabs.create({ url });
    else window.open(url, "_blank");
  });
}

function chooseSubtitleMode(mode) {
  if (hasExtensionApi) return selectSubtitleMode(mode);
  currentSettings.aiRole = mode === "ai" ? "secondary" : "off";
  writeModeControls();
}

function bindControls() {
  document.querySelectorAll("[data-layout-preset]").forEach((button) => {
    button.addEventListener("click", () => void selectLayoutPreset(button.dataset.layoutPreset));
  });

  document.querySelectorAll("[data-style-role]").forEach((button) => {
    button.addEventListener("click", () => selectStyleRole(button.dataset.styleRole));
  });

  for (const [key, control] of Object.entries(controls)) {
    control.addEventListener(key.endsWith("TrackKey") ? "change" : "input", () => {
      if (key.endsWith("TrackKey")) {
        selectSubtitleSource(key.startsWith("primary") ? "primary" : "secondary");
        return;
      }
      const update = readUpdate(key, control);
      Object.assign(currentSettings, update);
      void writeSettings(update);
    });
  }

  providerControls.add.addEventListener("click", () => showNewDraftView());
  providerControls.delete.addEventListener("click", () => void deleteProvider());
  newDraftControls.cancelBtn.addEventListener("click", () => hideNewDraftView());
  newDraftControls.cancelTop.addEventListener("click", () => hideNewDraftView());
  newDraftControls.saveBtn.addEventListener("click", () => void saveNewDraftProvider());
  newDraftControls.fetchBtn.addEventListener("click", () => void fetchNewDraftModels());
  newDraftControls.pills.forEach((button) => {
    button.addEventListener("click", () => selectDraftPreset(button.dataset.draftPreset));
  });
  providerControls.name.addEventListener("change", () => void updateProviderField("name", providerControls.name.value.trim()));
  bindModelPicker(providerControls.model, elements.providerModelList, document.querySelector("#providerModelMenu"), document.querySelector("#providerModelSearch"), (model) => void updateProviderField("model", model, false), () => void fetchProviderModels());
  bindModelPicker(newDraftControls.model, newDraftControls.modelList, document.querySelector("#newDraftModelMenu"), document.querySelector("#newDraftModelSearch"), () => {});
  providerControls.endpoint.addEventListener("change", updateEndpoint);
  providerControls.test = elements.testProvider;
  providerControls.test.addEventListener("click", () => void testProviderConnection());
  elements.fetchProviderModels.addEventListener("click", () => void fetchProviderModels(true));
  providerControls.source.addEventListener("change", () => {
    const track = currentTracks.find((item) => item.key === providerControls.source.value);
    const update = {
      aiSourceTrackKey: track?.key ?? "",
      aiSourceTrackPreference: track ? trackPreference(track) : "",
      aiSourceLanguage: track?.language ?? ""
    };
    Object.assign(currentSettings, update);
    void writeSettings(update);
    updateJapaneseRubyVisibility();
    scheduleStatePoll(0);
  });

  for (const key of ["aiTargetLanguage", "aiStyleGuide"]) {
    aiControls[key].addEventListener("change", () => {
      const value = aiControls[key].value.trim() || DEFAULT_SETTINGS[key];
      aiControls[key].value = value;
      currentSettings[key] = value;
      void writeSettings({ [key]: value });
      if (key === "aiTargetLanguage") updateJapaneseRubyVisibility();
      if (currentSettings.aiRole !== "off") scheduleStatePoll(0);
    });
  }
  for (const [key, max] of [["aiPrefetchCount", 50], ["aiContextCount", 4]]) {
    const control = aiControls[key];
    control.addEventListener("change", () => {
      const value = Number(control.value);
      const count = control.value.trim() && Number.isInteger(value) && value >= 0 && value <= max
        ? value : DEFAULT_SETTINGS[key];
      control.value = count;
      currentSettings[key] = count;
      void writeSettings({ [key]: count });
    });
  }

  aiControls.aiJapaneseRuby?.addEventListener("change", () => {
    const value = Boolean(aiControls.aiJapaneseRuby.checked);
    currentSettings.aiJapaneseRuby = value;
    void writeSettings({ aiJapaneseRuby: value });
    if (currentSettings.aiRole !== "off") scheduleStatePoll(0);
  });

  elements.saveAiCredential.addEventListener("click", () => void saveCredential());
  elements.deleteAiCredential.addEventListener("click", () => void deleteCredential());

  for (const [suffix, config] of Object.entries(advancedControls)) {
    config.element.addEventListener("input", () => {
      const key = `${activeStyleRole}${suffix}`;
      const value = config.numeric ? Number(config.element.value) : config.element.value;
      currentSettings[key] = value;
      void writeSettings({ [key]: value });
      writeAdvancedValues();
      writePreview();
    });
  }

  elements.swapTracks.addEventListener("click", () => void swapTracks());
  elements.reloadTracks.addEventListener("click", () => void reloadTracks());
  elements.resetStyles.addEventListener("click", () => void resetStyles());
}

function selectTab(tabName) {
  elements.activePageTitle.textContent = document.querySelector(`[data-tab="${tabName}"]`)?.textContent ?? "字幕";
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });

  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tabName;
  });
}

async function selectLayoutPreset(preset) {
  if (!Object.hasOwn(LAYOUT_PREVIEW, preset) && preset !== "free") return;

  currentSettings.subtitleLayoutPreset = preset;
  writeLayoutPreset();
  writePreview();
  await writeSettings({ subtitleLayoutPreset: preset });
}

function selectStyleRole(role) {
  if (role !== "primary" && role !== "secondary") return;
  activeStyleRole = role;

  document.querySelectorAll("[data-style-role]").forEach((button) => {
    const active = button.dataset.styleRole === role;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  writeAdvancedControls();
}

async function selectSubtitleMode(mode) {
  const aiRole = mode === "native" ? "off" : currentSettings.aiRole === "off" ? "secondary" : currentSettings.aiRole;
  if (aiRole === currentSettings.aiRole) return;

  const update = { aiRole };
  if (aiRole !== "off" && !currentSettings.aiSourceTrackKey && !currentSettings.aiSourceTrackPreference && !currentSettings.aiSourceLanguage) {
    const nativeRole = aiRole === "primary" ? "secondary" : "primary";
    const source = findSelectedTrack(currentSettings[`${nativeRole}TrackKey`], currentSettings[`${nativeRole}TrackPreference`], currentSettings[`${nativeRole}Language`]);
    if (source) {
      update.aiSourceTrackKey = source.key;
      update.aiSourceTrackPreference = trackPreference(source);
      update.aiSourceLanguage = source.language;
    }
  }
  Object.assign(currentSettings, update);
  writeControls();
  writeAvailability();
  writeStatus();
  await writeSettings(update);
  scheduleStatePoll(0);
}

function selectSubtitleSource(role) {
  if (currentSettings.aiRole === role) return;
  const key = `${role}TrackKey`;
  const update = readUpdate(key, controls[key]);
  Object.assign(currentSettings, update);
  void writeSettings(update);
  markTrackLoading(role);
  writeControls();
  writeStatus();
  scheduleStatePoll(0);
}

function updateEndpoint() {
  const providerId = currentSettings.aiProviderId;
  const raw = providerControls.endpoint.value.trim();
  if (!raw) {
    void updateProviderField("endpoint", "");
    elements.aiEndpointStatus.textContent = "使用 OpenAI 官方接口";
    return;
  }
  let url;
  let normalized;
  try {
    normalized = normalizeProviderEndpoint(raw);
    url = new URL(normalized);
  } catch {
    elements.aiEndpointStatus.textContent = "请输入 HTTPS Base URL（自动补全 /v1/chat/completions）";
    return;
  }
  providerControls.endpoint.value = normalized;
  const origin = `${url.protocol}//${url.hostname}/*`;
  if (!runtime.permissions?.request) {
    elements.aiEndpointStatus.textContent = "当前浏览器无法申请该服务的域名访问权限";
    return;
  }
  elements.aiEndpointStatus.textContent = "正在申请服务域名访问权限";
  runtime.permissions.request({ origins: [origin] }, (granted) => {
    if (providerId !== currentSettings.aiProviderId) return;
    if (runtime.runtime.lastError || !granted) {
      elements.aiEndpointStatus.textContent = "未授权该域名；字幕与密钥不会发送";
      return;
    }
    void updateProviderField("endpoint", normalized);
    elements.aiEndpointStatus.textContent = `已授权 ${url.host}；已使用 ${url.pathname}`;
    if (currentSettings.aiRole !== "off") scheduleStatePoll(0);
  });
}

function normalizeProviderEndpoint(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) throw new Error("unsafe endpoint");
  if (url.pathname.endsWith("/chat/completions")) return url.href;
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
  return url.href;
}

function setSelectedModel(trigger, model) {
  trigger.dataset.value = model;
  trigger.textContent = model || "选择模型";
}

function setModelOptions(list, models) {
  list.replaceChildren(...[...new Set(models.filter(Boolean))].map((model) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-option";
    button.setAttribute("role", "option");
    button.textContent = model;
    return button;
  }));
  list.previousElementSibling.value = "";
}

function bindModelPicker(trigger, list, menu, search, onSelect, onOpen) {
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  trigger.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    trigger.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) {
      search.value = "";
      for (const option of list.children) option.hidden = false;
      search.focus();
      onOpen?.();
    }
  });
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase();
    for (const option of list.children) option.hidden = !option.textContent.toLocaleLowerCase().includes(query);
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest(".model-option");
    if (!option) return;
    setSelectedModel(trigger, option.textContent);
    close();
    onSelect(option.textContent);
    trigger.focus();
  });
  menu.addEventListener("keydown", (event) => { if (event.key === "Escape") { close(); trigger.focus(); } });
  document.addEventListener("click", (event) => { if (!menu.contains(event.target) && event.target !== trigger) close(); });
}
async function fetchProviderModels(force = false) {
  const provider = selectedProvider();
  if (!provider) return;
  const providerId = provider.id;
  const cached = providerModelCatalog.get(providerId);
  if (!force && cached?.endpoint === provider.endpoint && cached?.credential === provider.credential && !elements.aiCredential.value.trim()) return;
  if (cached?.pending && cached.endpoint === provider.endpoint && cached.credential === provider.credential) return;

  const typedKey = elements.aiCredential.value.trim();
  if (typedKey) {
    elements.aiCredential.value = "";
    await updateProviderField("credential", typedKey, false);
    readCredentialStatus();
  }
  const active = selectedProvider();
  if (!active || active.id !== providerId) return;
  if (!active.credential && active.endpoint !== "http://localhost:11434/v1/chat/completions") {
    elements.providerTestStatus.textContent = "请先输入 API 密钥";
    return;
  }

  const request = { endpoint: active.endpoint, credential: active.credential, pending: true, models: cached?.endpoint === active.endpoint && cached?.credential === active.credential ? cached.models : null };
  providerModelCatalog.set(providerId, request);
  elements.fetchProviderModels.disabled = true;
  elements.providerTestStatus.textContent = "正在获取模型列表…";
  await new Promise((resolve) => {
    runtime.runtime.sendMessage({ type: "BILAYER_LIST_MODELS", providerId }, (result) => {
      request.pending = false;
      const current = selectedProvider();
      if (providerModelCatalog.get(providerId) !== request || current?.id !== providerId || current.endpoint !== request.endpoint || current.credential !== request.credential) {
        resolve();
        return;
      }
      elements.fetchProviderModels.disabled = false;
      if (runtime.runtime.lastError || !result?.ok || !Array.isArray(result.models)) {
        const errorMsg = result?.errorCode === "auth" ? "密钥无效" :
          result?.errorCode === "permission_denied" ? "未授权服务域名" : "获取模型失败";
        elements.providerTestStatus.textContent = `失败：${errorMsg}；可重试获取模型`;
      } else {
        request.models = result.models;
        const search = elements.providerModelList.previousElementSibling;
        const query = search.value.trim().toLocaleLowerCase();
        setModelOptions(elements.providerModelList, [current.model, ...result.models]);
        search.value = query;
        for (const option of elements.providerModelList.children) option.hidden = !option.textContent.toLocaleLowerCase().includes(query);
        elements.providerTestStatus.textContent = `已获取 ${result.models.length} 个模型，请从列表选择`;
      }
      resolve();
    });
  });
}

async function swapTracks() {
  const update = {
    primaryTrackPreference: currentSettings.secondaryTrackPreference,
    primaryLanguage: currentSettings.secondaryLanguage,
    secondaryTrackKey: currentSettings.primaryTrackKey,
    secondaryTrackPreference: currentSettings.primaryTrackPreference,
    secondaryLanguage: currentSettings.primaryLanguage
  };
  if (currentSettings.aiRole !== "off") {
    update.aiRole = currentSettings.aiRole === "primary" ? "secondary" : "primary";
  }

  for (const suffix of STYLE_ROLE_SUFFIXES) {
    update[`primary${suffix}`] = currentSettings[`secondary${suffix}`];
    update[`secondary${suffix}`] = currentSettings[`primary${suffix}`];
  }

  Object.assign(currentSettings, update);
  writeControls();
  writeAvailability();
  if (currentSettings.aiRole === "off") {
    markTrackLoading("primary");
    markTrackLoading("secondary");
  } else {
    markTrackLoading(currentSettings.aiRole === "primary" ? "secondary" : "primary");
    writeRoleStatus(currentSettings.aiRole, "AI 等待原字幕", "loading");
  }
  await writeSettings(update);
  scheduleStatePoll(0);
}

async function reloadTracks() {
  if (!isWatchPage(currentPageState)) return;

  clearTimeout(pollTimer);
  elements.reloadTracks.disabled = true;
  elements.reloadTracks.classList.add("is-busy");
  writePageStatus("正在重新读取字幕", "loading");
  writeRoleStatus("primary", "等待字幕轨道", "loading");
  writeRoleStatus("secondary", "等待字幕轨道", "loading");

  await sendMessageToActiveTab({ type: "BILAYER_RELOAD" });
  scheduleStatePoll(0);
}

async function resetStyles() {
  Object.assign(currentSettings, STYLE_DEFAULTS);
  writeControls();
  await writeSettings(STYLE_DEFAULTS);
}

function applyPageState(pageState, forceTrackUpdate = false) {
  const nextWatchId = readWatchId(pageState);
  const watchChanged = nextWatchId !== currentWatchId;

  if (watchChanged) {
    currentWatchId = nextWatchId;
    if (pageState?.settings) {
      const providerId = currentSettings.aiProviderId;
      currentSettings = normalizeSettings(pageState.settings);
      currentSettings.aiProviderId = providerId;
    }
    forceTrackUpdate = true;
  }

  currentPageState = pageState;
  currentTracks = pageState?.tracks ?? [];

  const signature = currentTracks.map((track) => track.key).join("\n");
  if (forceTrackUpdate || signature !== currentTrackSignature) {
    currentTrackSignature = signature;
    populateTrackSelects();
  }

  if (watchChanged) writeControls();
  writeStatus();
  writeAvailability();
}

function populateTrackSelects() {
  populateTrackSelect("primary");
  populateTrackSelect("secondary");
  const source = findSelectedTrack(currentSettings.aiSourceTrackKey, currentSettings.aiSourceTrackPreference, currentSettings.aiSourceLanguage);
  providerControls.source.replaceChildren(createOption("", "请选择源语言字幕"), ...currentTracks.map(trackToOption));
  providerControls.source.value = source?.key ?? "";
  providerControls.source.disabled = currentTracks.length === 0;
  updateJapaneseRubyVisibility();
}
function populateTrackSelect(role) {
  const select = controls[`${role}TrackKey`];
  if (currentSettings.aiRole === role) {
    select.replaceChildren(createOption("__ai__", "AI 翻译"));
    select.value = "__ai__";
    return;
  }
  const selected = findSelectedTrack(currentSettings[`${role}TrackKey`], currentSettings[`${role}TrackPreference`], currentSettings[`${role}Language`]);
  select.replaceChildren(createOption("", "不显示"), ...currentTracks.map(trackToOption));
  select.value = selected?.key ?? "";
}

function writeModeControls() {
  const isAi = currentSettings.aiRole !== "off";
  elements.nativeMode.setAttribute("aria-pressed", String(!isAi));
  elements.aiMode.setAttribute("aria-pressed", String(isAi));
  elements.nativeMode.classList.toggle("is-selected", !isAi);
  elements.aiMode.classList.toggle("is-selected", isAi);
  elements.openAiSettings.hidden = !isAi;
  elements.modeDescription.textContent = isAi
    ? "一行保留 Netflix 原字幕，另一行由所选 AI 大模型实时生成口语译文。"
    : "两行分别显示 Netflix 原生字幕；切换模式不会清除轨道或翻译设置。";
}

function writeControls() {
  controls.enabled.checked = currentSettings.enabled;
  controls.hideNativeSubtitles.checked = currentSettings.hideNativeSubtitles;
  populateTrackSelects();
  writeModeControls();
  for (const [key, control] of Object.entries(aiControls)) {
    if (!control) continue;
    if (control.type === "checkbox") control.checked = Boolean(currentSettings[key]);
    else control.value = currentSettings[key];
  }
  writeProviderControls();
  controls.timingOffsetMs.value = currentSettings.timingOffsetMs;
  writeLayoutPreset();
  writeAdvancedControls();
  updateJapaneseRubyVisibility();
}
function selectedProvider() {
  return currentProviders.find((provider) => provider.id === currentSettings.aiProviderId) ?? null;
}

function writeProviderControls() {
  const selected = selectedProvider();
  providerControls.delete.disabled = currentProviders.length <= 1;

  if (providerControls.masterList) {
    providerControls.masterList.replaceChildren(...currentProviders.map((provider) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `provider-master-item${provider.id === currentSettings.aiProviderId ? " is-selected" : ""}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(provider.id === currentSettings.aiProviderId));

      const span = document.createElement("span");
      span.textContent = provider.name || "未命名服务";
      btn.appendChild(span);

      btn.addEventListener("click", () => {
        currentSettings.aiProviderId = provider.id;
        void writeSettings({ aiProviderId: provider.id });
        hideNewDraftView();
        scheduleStatePoll(0);
      });
      return btn;
    }));
  }

  if (selected) {
    providerControls.detailView.hidden = false;
    providerControls.draftView.hidden = true;
    providerControls.name.value = selected.name ?? "";
    setSelectedModel(providerControls.model, selected.model ?? "");
    providerControls.endpoint.value = selected.endpoint ?? "";

    const matchedPreset = Object.values(LLM_PRESETS).find((p) => p.endpoint === (selected.endpoint ?? ""));
    elements.aiEndpointStatus.textContent = selected.endpoint
      ? `已保存 ${new URL(selected.endpoint).host}；使用前需获得域名授权`
      : "使用 OpenAI 官方接口";

    const catalog = providerModelCatalog.get(selected.id);
    const discovered = catalog?.endpoint === selected.endpoint && catalog?.credential === selected.credential ? catalog.models : null;
    setModelOptions(elements.providerModelList, [selected.model, ...(discovered ?? matchedPreset?.models ?? [])]);
    elements.fetchProviderModels.disabled = Boolean(catalog?.pending);
    if (selected.jsonMode) {
      if (selected.jsonMode === "json_schema") {
        elements.providerTestStatus.dataset.state = "success";
        elements.providerTestStatus.textContent = "支持 JSON Schema (严格模式)";
      } else if (selected.jsonMode === "json_object") {
        elements.providerTestStatus.dataset.state = "success";
        elements.providerTestStatus.textContent = "支持 JSON Object 约束";
      } else if (selected.jsonMode === "none") {
        elements.providerTestStatus.dataset.state = "warning";
        elements.providerTestStatus.textContent = "⚠️ 不支持结构化 JSON：可能出现解析错误或 AI 字幕不显示";
      }
    } else {
      elements.providerTestStatus.dataset.state = "";
      elements.providerTestStatus.textContent = "";
    }
    readCredentialStatus();
  }
}

function showNewDraftView() {
  providerControls.detailView.hidden = true;
  providerControls.draftView.hidden = false;
  if (providerControls.masterList) {
    providerControls.masterList.querySelectorAll(".provider-master-item").forEach((item) => {
      item.classList.remove("is-selected");
    });
  }
  selectDraftPreset("openai");
  newDraftControls.key.value = "";
  newDraftControls.name.focus();
}

function hideNewDraftView() {
  providerControls.draftView.hidden = true;
  providerControls.detailView.hidden = false;
  writeProviderControls();
}

function selectDraftPreset(presetKey) {
  newDraftControls.pills.forEach((pill) => {
    pill.classList.toggle("is-active", pill.dataset.draftPreset === presetKey);
  });
  const preset = LLM_PRESETS[presetKey];
  if (!preset) return;

  newDraftControls.name.value = preset.name;
  newDraftControls.endpoint.value = preset.endpoint;
  setSelectedModel(newDraftControls.model, "");
  newDraftControls.model.dataset.fallback = preset.model || "gpt-4o-mini";
  setModelOptions(newDraftControls.modelList, preset.models ?? []);

  if (presetKey === "ollama") {
    newDraftControls.key.placeholder = "本地服务无需密钥，可留空";
  } else {
    newDraftControls.key.placeholder = "sk-...";
  }
}

async function saveNewDraftProvider() {
  const name = newDraftControls.name.value.trim() || "新服务";
  const rawEndpoint = newDraftControls.endpoint.value.trim();
  const credential = newDraftControls.key.value.trim();

  let endpoint = "";
  if (rawEndpoint) {
    try {
      endpoint = normalizeProviderEndpoint(rawEndpoint);
    } catch {
      alert("请输入有效的 HTTPS Base URL 端点");
      return;
    }
  }

  const model = newDraftControls.model.dataset.value || newDraftControls.model.dataset.fallback || "gpt-4o-mini";

  if (endpoint && runtime.permissions?.request) {
    try {
      const url = new URL(endpoint);
      const origin = `${url.protocol}//${url.hostname}/*`;
      runtime.permissions.request({ origins: [origin] }, () => {
        void runtime.runtime.lastError;
      });
    } catch { /* no-op */ }
  }

  const id = crypto.randomUUID();
  const newProvider = {
    id,
    name,
    endpoint,
    model,
    credential
  };

  // 只有在点击“保存密钥并添加”时，才将新服务写入已保存列表
  currentProviders = [...currentProviders, newProvider];
  currentSettings.aiProviderId = id;
  await writeSettings({ providers: currentProviders, aiProviderId: id });
  hideNewDraftView();
  scheduleStatePoll(0);
}

async function fetchNewDraftModels() {
  const credential = newDraftControls.key.value.trim();
  const rawEndpoint = newDraftControls.endpoint.value.trim();
  let endpoint = "";
  if (rawEndpoint) {
    try {
      endpoint = normalizeProviderEndpoint(rawEndpoint);
    } catch {
      alert("请输入有效的 HTTPS Base URL 端点");
      return;
    }
  }

  if (!credential && endpoint !== "http://localhost:11434/v1/chat/completions") {
    alert("请先在下方输入 API 密钥，以便获取模型列表");
    newDraftControls.key.focus();
    return;
  }

  if (endpoint && runtime.permissions?.request) {
    try {
      const url = new URL(endpoint);
      const origin = `${url.protocol}//${url.hostname}/*`;
      const granted = await new Promise((res) => runtime.permissions.request({ origins: [origin] }, res));
      if (!granted) {
        alert("未授权该端点域名访问权限，无法获取模型");
        return;
      }
    } catch { /* no-op */ }
  }

  newDraftControls.fetchBtn.disabled = true;
  newDraftControls.fetchBtn.textContent = "获取中…";

  const message = {
    type: "BILAYER_LIST_MODELS",
    credential,
    endpoint
  };

  runtime.runtime.sendMessage(message, (result) => {
    newDraftControls.fetchBtn.disabled = false;
    newDraftControls.fetchBtn.textContent = "获取模型";
    if (runtime.runtime.lastError || !result?.ok) {
      alert(result?.errorCode === "auth" ? "密钥无效，无法获取模型" : "获取模型列表失败，请检查端点与网络");
      return;
    }
    setModelOptions(newDraftControls.modelList, result.models);
  });
}

async function deleteProvider() {
  if (currentProviders.length <= 1) return;
  currentProviders = currentProviders.filter((p) => p.id !== currentSettings.aiProviderId);
  currentSettings.aiProviderId = currentProviders[0].id;
  await writeSettings({ providers: currentProviders, aiProviderId: currentSettings.aiProviderId });
  hideNewDraftView();
  scheduleStatePoll(0);
}
async function testProviderConnection() {
  const provider = selectedProvider();
  if (!provider) return Promise.resolve();

  const typedKey = elements.aiCredential.value.trim();
  if (typedKey) {
    elements.aiCredential.value = "";
    await updateProviderField("credential", typedKey, false);
    readCredentialStatus();
  }

  const providerId = provider.id;
  elements.testProvider.disabled = true;
  elements.providerTestStatus.textContent = "测试中…";
  return new Promise((resolve) => {
    runtime.runtime.sendMessage({ type: "BILAYER_TEST_PROVIDER", providerId }, (result) => {
      elements.testProvider.disabled = false;
      if (providerId !== currentSettings.aiProviderId) { resolve(); return; }
      if (runtime.runtime.lastError || !result?.ok) {
        const errors = {
          auth: "密钥无效", rate_limit: "请求过于频繁", quota: "额度不足",
          permission_denied: "未授权服务域名", configuration: "请先填写有效模型、端点和密钥",
          unavailable: "服务不可达", invalid_response: "服务返回格式有误"
        };
        elements.providerTestStatus.dataset.state = "error";
        elements.providerTestStatus.textContent = `失败：${errors[result?.errorCode] ?? "请求失败"}`;
      } else {
        if (result.jsonMode === "json_schema") {
          elements.providerTestStatus.dataset.state = "success";
          elements.providerTestStatus.textContent = "连接成功 · 支持 JSON Schema (严格模式)";
        } else if (result.jsonMode === "json_object") {
          elements.providerTestStatus.dataset.state = "success";
          elements.providerTestStatus.textContent = "连接成功 · 支持 JSON Object 约束";
        } else {
          elements.providerTestStatus.dataset.state = "warning";
          elements.providerTestStatus.textContent = "连接成功，但模型不支持结构化 JSON。可能出现解析错误导致 AI 字幕丢失";
        }
      }
      resolve();
    });
  });
}

async function updateProviderField(field, value, refresh = true) {
  const provider = selectedProvider();
  if (!provider) return;
  if (field === "name" && !value) value = provider.name;
  if (field === "model" && /[\s\x00-\x1f]/.test(value)) value = provider.model;
  currentProviders = currentProviders.map((item) => item.id === provider.id ? { ...item, [field]: value } : item);
  await writeSettings({ providers: currentProviders });
  if (refresh) writeProviderControls();
}


function writeLayoutPreset() {
  const preset = currentSettings.subtitleLayoutPreset;
  document.querySelectorAll("[data-layout-preset]").forEach((button) => {
    const active = button.dataset.layoutPreset === preset;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const usesFreePosition = preset === "free";
  advancedControls.VerticalOffset.element.disabled = !usesFreePosition;
}

function writeAdvancedControls() {
  for (const [suffix, config] of Object.entries(advancedControls)) {
    config.element.value = currentSettings[`${activeStyleRole}${suffix}`];
  }

  elements.primaryPreview.classList.toggle("is-editing", activeStyleRole === "primary");
  elements.secondaryPreview.classList.toggle("is-editing", activeStyleRole === "secondary");
  writeAdvancedValues();
  writePreview();
}

function writeAdvancedValues() {
  writeRangeValue(advancedControls.FontSize.element, elements.styleFontSizeValue, (value) => `${value} px`);
  writeRangeValue(advancedControls.VerticalOffset.element, elements.styleVerticalOffsetValue, (value) => `${value}%`);
  elements.styleTextColorValue.value = advancedControls.TextColor.element.value.toUpperCase();
  elements.styleStrokeColorValue.value = advancedControls.StrokeColor.element.value.toUpperCase();
  elements.styleBackgroundColorValue.value = advancedControls.BackgroundColor.element.value.toUpperCase();
  writeRangeValue(advancedControls.TextOpacity.element, elements.styleTextOpacityValue, (value) => `${value}%`);
  writeRangeValue(advancedControls.StrokeWidth.element, elements.styleStrokeWidthValue, (value) => `${formatDecimal(value)} px`);
  writeRangeValue(advancedControls.BackgroundOpacity.element, elements.styleBackgroundOpacityValue, (value) => `${value}%`);
  writeRangeValue(advancedControls.LineHeight.element, elements.styleLineHeightValue, formatDecimal);
  writeRangeValue(advancedControls.MaxWidth.element, elements.styleMaxWidthValue, (value) => `${value}%`);
}

function writeRangeValue(control, output, formatter) {
  output.value = formatter(control.value);
  const progress = ((Number(control.value) - Number(control.min)) / (Number(control.max) - Number(control.min))) * 100;
  control.style.setProperty("--range-progress", `${progress}%`);
}

function writePreview() {
  const preset = currentSettings.subtitleLayoutPreset;
  elements.stylePreview.dataset.layout = preset;

  if (preset === "free") {
    elements.stylePreview.style.setProperty(
      "--preview-primary-bottom",
      `${previewBottom(currentSettings.primaryVerticalOffset)}px`
    );
    elements.stylePreview.style.setProperty(
      "--preview-secondary-bottom",
      `${previewBottom(currentSettings.secondaryVerticalOffset)}px`
    );
  } else {
    elements.stylePreview.style.setProperty("--preview-gap", `${LAYOUT_PREVIEW[preset]?.gap ?? 8}px`);
  }

  applyPreviewStyle(elements.primaryPreview, "primary");
  applyPreviewStyle(elements.secondaryPreview, "secondary");
}

function applyPreviewStyle(element, role) {
  const value = (suffix) => currentSettings[`${role}${suffix}`];
  const previewFontSize = 10 + (Number(value("FontSize")) - 18) * 0.18;
  const maxWidth = Math.round(330 * Number(value("MaxWidth")) / 100);

  element.style.fontFamily = PREVIEW_FONT_FAMILIES[value("FontFamily")] ?? PREVIEW_FONT_FAMILIES.system;
  element.style.fontSize = `${previewFontSize}px`;
  element.style.fontWeight = value("FontWeight");
  element.style.lineHeight = value("LineHeight");
  element.style.maxWidth = `${maxWidth}px`;
  element.style.color = colorWithOpacity(value("TextColor"), value("TextOpacity"));
  element.style.background = colorWithOpacity(value("BackgroundColor"), value("BackgroundOpacity"));
  element.style.webkitTextStroke = `${value("StrokeWidth")}px ${value("StrokeColor")}`;
}

function previewBottom(offset) {
  return 12 + ((Number(offset) - 8) / 34) * 76;
}

function formatDecimal(value) {
  return String(Number(Number(value).toFixed(2)));
}

function colorWithOpacity(color, opacity) {
  const normalized = String(color ?? "#000000").replace(/^#/, "");
  const hex = normalized.length === 3
    ? normalized.split("").map((value) => value + value).join("")
    : normalized.padEnd(6, "0").slice(0, 6);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const alpha = Math.max(0, Math.min(100, Number(opacity ?? 100))) / 100;

  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}

function writeStatus() {
  if (!currentPageState) {
    writePageStatus(connectionHint, "error");
    writeRoleStatus("primary", "未连接 Netflix 页面", "error");
    writeRoleStatus("secondary", "未连接 Netflix 页面", "error");
    return;
  }

  if (!isWatchPage(currentPageState)) {
    writePageStatus("打开影片后可选择字幕", "idle");
    writeRoleStatus("primary", "等待播放", "idle");
    writeRoleStatus("secondary", "等待播放", "idle");
    return;
  }

  const sourceRole = currentSettings.aiRole === "off"
    ? null
    : currentSettings.aiRole === "primary" ? "secondary" : "primary";
  const primary = currentPageState.loadStatus?.primary;
  const secondary = currentPageState.loadStatus?.secondary;
  const sourceStatus = sourceRole === "primary" ? primary : secondary;
  const hasError = sourceRole ? Boolean(sourceStatus?.error) : Boolean(primary?.error || secondary?.error);

  if (currentTracks.length === 0) writePageStatus("正在读取字幕", "loading");
  else if (hasError) writePageStatus(`已识别 ${currentTracks.length} 条，原字幕加载失败`, "error");
  else writePageStatus(`已识别 ${currentTracks.length} 条字幕`, "ready");

  if (sourceRole) {
    writeLoadStatus(sourceRole, sourceStatus, currentSettings[`${sourceRole}TrackKey`] || currentSettings[`${sourceRole}Language`]);
    writeTranslationStatus(currentSettings.aiRole, currentPageState.translationStatus);
  } else {
    writeLoadStatus("primary", primary, currentSettings.primaryTrackKey || currentSettings.primaryLanguage);
    writeLoadStatus("secondary", secondary, currentSettings.secondaryTrackKey || currentSettings.secondaryLanguage);
  }
}

function writePageStatus(message, state) {
  elements.pageStatus.textContent = message;
  elements.statusDot.dataset.state = state;
}

function writeLoadStatus(role, loadStatus, hasSelection) {
  if (!hasSelection) {
    writeRoleStatus(role, "未选择", "idle");
    return;
  }

  if (loadStatus?.error) {
    writeRoleStatus(role, friendlyError(loadStatus.error), "error");
    return;
  }

  if (loadStatus?.cueCount > 0) {
    writeRoleStatus(role, `已加载 ${loadStatus.cueCount} 条`, "ready");
    return;
  }

  writeRoleStatus(role, currentTracks.length > 0 ? "正在加载" : "等待字幕轨道", "loading");
}

function writeTranslationStatus(role, status) {
  switch (status?.phase) {
    case "ready":
      writeRoleStatus(role, `AI 已翻译 ${status.count ?? 0} 条`, "ready");
      break;
    case "translating":
      writeRoleStatus(role, `AI 翻译中 · ${status.count ?? 0} 条`, "loading");
      break;
    case "error": {
      const errors = {
        auth: "API 密钥无效",
        rate_limit: "请求过于频繁",
        quota: "API 额度不足",
        unavailable: "兼容服务网络不可用",
        invalid_response: "服务返回格式有误",
        configuration: "请检查端点、密钥、模型和设置",
        permission_denied: "未授权兼容服务域名",
        source_unavailable: "请选择 AI 源语言字幕轨道",
        initial_timeout: "首批翻译超时，已继续播放原文",
        budget_exceeded: "本集翻译额度已用尽"
      };
      writeRoleStatus(role, `AI 翻译失败：${errors[status.error] ?? "请检查密钥及设置"}`, "error");
      break;
    }
    default:
      writeRoleStatus(role, "AI 等待原字幕", "loading");
  }
}

function writeRoleStatus(role, message, state) {
  const element = role === "primary" ? elements.primaryStatus : elements.secondaryStatus;
  element.textContent = message;
  element.dataset.state = state;
}

function markTrackLoading(role) {
  writeRoleStatus(role, "正在加载", "loading");
}

function writeAvailability() {
  const onWatchPage = isWatchPage(currentPageState);
  const tracksReady = onWatchPage && currentTracks.length > 0;
  controls.primaryTrackKey.disabled = !tracksReady || currentSettings.aiRole === "primary";
  controls.secondaryTrackKey.disabled = !tracksReady || currentSettings.aiRole === "secondary";
  elements.primaryTrackLabel.textContent = currentSettings.aiRole === "primary" ? "第一行 · AI 译文" : "第一行 · Netflix 字幕";
  elements.secondaryTrackLabel.textContent = currentSettings.aiRole === "secondary" ? "第二行 · AI 译文" : "第二行 · Netflix 字幕";
  elements.swapTracks.disabled = !tracksReady;
  elements.reloadTracks.disabled = !onWatchPage;
  elements.reloadTracks.classList.remove("is-busy");
  elements.trackGrid.setAttribute("aria-disabled", String(!tracksReady));
}

function scheduleStatePoll(attempt = 0) {
  clearTimeout(pollTimer);
  if (attempt >= 10 && (!isWatchPage(currentPageState) || currentSettings.aiRole === "off")) return;

  pollTimer = setTimeout(async () => {
    const pageState = await readPageState();
    applyPageState(pageState);
    if (!isWatchPage(pageState)) {
      scheduleStatePoll(attempt + 1);
    } else if (shouldKeepPolling(pageState)) {
      scheduleStatePoll(Math.min(attempt + 1, 10));
    }
  }, attempt === 0 ? 350 : attempt < 10 ? 900 : 2000);
}

function shouldKeepPolling(pageState) {
  if (!isWatchPage(pageState)) return false;
  if (currentSettings.aiRole !== "off") return true;
  if ((pageState?.tracks?.length ?? 0) === 0) return true;

  const nativeRoles = currentSettings.aiRole === "off"
    ? ["primary", "secondary"]
    : [currentSettings.aiRole === "primary" ? "secondary" : "primary"];
  return nativeRoles.some((role) => {
    const selected = currentSettings[`${role}TrackKey`] || currentSettings[`${role}Language`];
    const status = pageState?.loadStatus?.[role];
    return selected && !status?.error && !status?.cueCount;
  });
}

function readUpdate(key, control) {
  if (key === "enabled" || key === "hideNativeSubtitles") return { [key]: control.checked };

  if (key === "primaryTrackKey" || key === "secondaryTrackKey") {
    const prefix = key === "primaryTrackKey" ? "primary" : "secondary";
    const track = currentTracks.find((item) => item.key === control.value);
    return {
      [key]: control.value,
      [`${prefix}TrackPreference`]: track ? trackPreference(track) : "",
      [`${prefix}Language`]: track?.language ?? ""
    };
  }

  return { [key]: Number(control.value) };
}

function trackToOption(track) {
  const language = track.language ? ` · ${track.language}` : "";
  return createOption(track.key, `${track.label}${language}`);
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function trackPreference(track) {
  return JSON.stringify([track.language, track.label, track.type].map((part) => String(part ?? "").trim().toLowerCase()));
}

function findSelectedTrack(trackKey, preference, language) {
  if (trackKey) {
    const selected = currentTracks.find((track) => track.key === trackKey);
    if (selected) return selected;
  }

  if (preference) {
    const selected = currentTracks.find((track) => trackPreference(track) === preference);
    if (selected) return selected;
  }

  const needle = String(language ?? "").toLowerCase();
  if (!needle) return null;

  return currentTracks.find((track) => track.language.toLowerCase() === needle)
    ?? currentTracks.find((track) => track.language.toLowerCase().startsWith(needle))
    ?? null;
}

function friendlyError(error) {
  const message = String(error ?? "").toLowerCase();
  if (message.includes("0 cues")) return "轨道没有文本字幕";
  if (message.includes("load failed") || message.includes("fetch")) return "字幕下载失败";
  if (message.includes("timeout")) return "字幕读取超时";
  return "字幕加载失败";
}

function isWatchPage(pageState) {
  return Boolean(readWatchId(pageState));
}

function readWatchId(pageState) {
  if (pageState?.watchId) return String(pageState.watchId);

  try {
    return new URL(pageState?.url ?? "").pathname.match(/^\/watch\/([^/?#]+)/)?.[1] ?? "";
  } catch {
    return "";
  }
}

function readStoredSettings() {
  return new Promise((resolve) => {
    runtime.storage.local.get({ ...DEFAULT_SETTINGS, providers: DEFAULT_PROVIDERS }, resolve);
  });
}

function writeSettings(update) {
  return new Promise((resolve) => runtime.storage.local.set(update, resolve));
}

function normalizeSettings(stored) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (stored[key] !== undefined) settings[key] = stored[key];
  }

  if (!TARGET_LANGUAGES.has(settings.aiTargetLanguage)) settings.aiTargetLanguage = DEFAULT_SETTINGS.aiTargetLanguage;
  if (!Number.isInteger(settings.aiPrefetchCount) || settings.aiPrefetchCount < 0 || settings.aiPrefetchCount > 50) {
    settings.aiPrefetchCount = DEFAULT_SETTINGS.aiPrefetchCount;
  }
  if (!Number.isInteger(settings.aiContextCount) || settings.aiContextCount < 0 || settings.aiContextCount > 4) {
    settings.aiContextCount = DEFAULT_SETTINGS.aiContextCount;
  }
  if (settings.aiStyleGuide === LEGACY_TRANSLATION_PROMPT || typeof settings.aiStyleGuide !== "string" || !settings.aiStyleGuide.trim()) {
    settings.aiStyleGuide = DEFAULT_TRANSLATION_PROMPT;
  }

  if (stored.fontSize !== undefined && stored.secondaryFontSize === undefined) {
    settings.secondaryFontSize = stored.fontSize;
  }

  if (stored.verticalOffset !== undefined && stored.secondaryVerticalOffset === undefined) {
    settings.secondaryVerticalOffset = stored.verticalOffset;
  }

  if (!Object.hasOwn(LAYOUT_PREVIEW, settings.subtitleLayoutPreset) && settings.subtitleLayoutPreset !== "free") {
    settings.subtitleLayoutPreset = DEFAULT_SETTINGS.subtitleLayoutPreset;
  }

  return settings;
}

function readCredentialStatus() {
  elements.aiCredential.value = "";
  elements.aiCredentialStatus.textContent = selectedProvider()?.credential ? "已配置密钥" : "未配置密钥";
}

async function saveCredential() {
  const credential = elements.aiCredential.value.trim();
  if (!credential || !selectedProvider()) return;
  elements.aiCredential.value = "";
  await updateProviderField("credential", credential, false);
  elements.saveAiCredential.disabled = false;
}

async function deleteCredential() {
  if (!selectedProvider()) return;
  elements.aiCredential.value = "";
  await updateProviderField("credential", "", false);
  elements.deleteAiCredential.disabled = false;
}

function readPageState() {
  return sendMessageToActiveTab({ type: "BILAYER_GET_STATE" });
}

async function sendMessageToActiveTab(message) {
  if (message.type !== "BILAYER_GET_STATE") {
    return connectedTabId === null ? null : sendToTab(connectedTabId, message);
  }

  const tabs = await new Promise(queryActiveTabs);
  let fallback = null;
  let reachable = false;
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id) || (tab.url && !isNetflixUrl(tab.url))) continue;
    reachable = true;
    const state = await sendToTab(tab.id, message);
    if (!isNetflixUrl(state?.url)) continue;
    if (isWatchPage(state)) {
      connectedTabId = tab.id;
      connectionHint = "";
      return state;
    }
    fallback ??= state;
  }
  connectedTabId = null;
  connectionHint = reachable
    ? "Netflix 页面未响应；请刷新影片并检查 Web App 扩展权限"
    : "未找到 Netflix 播放页；请检查 Web App 扩展权限";
  return fallback;
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      runtime.tabs.sendMessage(tabId, message, (response) => {
        resolve(runtime.runtime.lastError ? null : response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

function queryActiveTabs(done) {
  if (!runtime.tabs?.query) {
    done([]);
    return;
  }
  const queries = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true },
    { url: ["https://netflix.com/*", "https://www.netflix.com/*"] }
  ];
  const tabs = new Map();
  const next = () => {
    const query = queries.shift();
    if (!query) { done([...tabs.values()]); return; }
    try {
      runtime.tabs.query(query, (found) => {
        void runtime.runtime.lastError;
        for (const tab of found ?? []) {
          if (!Number.isInteger(tab.id)) continue;
          const current = tabs.get(tab.id);
          if (!current) tabs.set(tab.id, { id: tab.id, url: tab.url });
          else if (!current.url && tab.url) current.url = tab.url;
        }
        next();
      });
    } catch {
      next();
    }
  };
  next();
}

function isNetflixUrl(url) {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "https:" && (parsed.hostname === "netflix.com" || parsed.hostname === "www.netflix.com");
  } catch {
    return false;
  }
}

function isJapanese(lang) {
  return /^(ja|jp)($|[-_])/i.test(String(lang ?? "").trim());
}

function updateJapaneseRubyVisibility() {
  const row = document.querySelector("#aiJapaneseRubyRow");
  if (!row) return;

  const sourceTrack = currentTracks.find((track) => track.key === currentSettings.aiSourceTrackKey)
    ?? currentTracks.find((track) => track.key === providerControls.source?.value);
  const sourceLang = sourceTrack?.language || currentSettings.aiSourceLanguage || "";
  const targetLang = currentSettings.aiTargetLanguage || "";

  const isSourceJp = isJapanese(sourceLang);
  const isTargetJp = isJapanese(targetLang);
  const hasJp = isSourceJp || isTargetJp;

  row.hidden = !hasJp;

  const title = document.querySelector("#aiJapaneseRubyTitle");
  const desc = document.querySelector("#aiJapaneseRubyDesc");
  if (title && desc) {
    if (isTargetJp && !isSourceJp) {
      title.textContent = "日语译文字幕注音 (振假名)";
      desc.textContent = "为 AI 翻译生成的日文译文字幕汉字标注平假名读音";
    } else if (isSourceJp && !isTargetJp) {
      title.textContent = "日语原字幕注音 (振假名)";
      desc.textContent = "源语言为日语时，为原声字幕汉字标注平假名读音";
    } else {
      title.textContent = "日语字幕注音 (振假名)";
      desc.textContent = "为字幕中的日文汉字标注平假名读音";
    }
  }
}
