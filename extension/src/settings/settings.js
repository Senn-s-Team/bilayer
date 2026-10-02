/**
 * [INPUT]: 依赖 browser/chrome storage/tabs/permissions API、document 的 hidden/visibilitychange 及 settings.html 的导航、翻译、会话额度字段（含额度统计窗口选择器）、AI 页当前翻译服务选择器（#aiProviderSelect）和模型下拉控件；保存服务的模型目录由 background 读取密钥并发现，providers 的写入基线由 storage.local 读回，BILAYER_GET_STATE 的 translationBudget 提供当前窗口用量与有效窗口，subtitleAvailability（unknown/unread/none/available）/providerReadiness 提供字幕轨道可用性与翻译服务就绪状态
 * [OUTPUT]: 提供四页签导航、只读模型选择、按服务缓存的模型目录及菜单内过滤、AI 页当前翻译服务选择（写 aiProviderId，与翻译服务页签的主列表双向同步）、会话额度设置（上限与计量窗口）与实时用量读数、AI 不可用提示（无字幕轨道/读不到轨道/未配置服务）与扩展内的字幕/provider 操作，以及常驻窗口的可见性门控轮询（隐藏时不读取标签页、重新可见立即补一轮）和 providers 的读-改-写合并（改字段/新增/删除均以存储最新列表为基线）；新增服务草案的端点校验与模型目录拉取失败就地写进 #newDraftStatus 状态行（data-state=error），不再用阻塞式 alert
 * [POS]: settings 交互层；由 background.openSettingsWindow() 以独立窗口加载，windows API 不可用时回落标签页，字幕模式由 aiRole 单一状态表示，翻译设置、输入额度与统计窗口全局共享，密钥和端点只属于所选 provider；额度读数与不可用提示只读页面状态，不自行计数也不自行探测
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
    name: i18n.t("presetOpenAI"),
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
    name: i18n.t("presetSiliconFlow"),
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "deepseek-ai/DeepSeek-V3",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-7B-Instruct"]
  },
  ollama: {
    name: i18n.t("presetOllama"),
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
  aiRequestBudget: 80,
  aiCharacterBudget: 40000,
  aiBudgetWindow: "session",
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

// 数值设置的合法上界（下界恒为 0）：输入校验与存储归一化共用同一张表，避免两处范围漂移
const NUMBER_RANGES = {
  aiPrefetchCount: 50,
  aiContextCount: 4,
  aiRequestBudget: 1000,
  aiCharacterBudget: 1000000
};

// 两项额度共用的计量窗口：session 为当前观看页/剧集（刷新同一页面继续累计），hour/day 为本机时间分桶
const AI_BUDGET_WINDOWS = ["session", "hour", "day"];
const AI_BUDGET_WINDOW_LABELS = {
  session: "aiBudgetWindowSession",
  hour: "aiBudgetWindowHour",
  day: "aiBudgetWindowDay"
};

const DEFAULT_PROVIDERS = [
  { id: "openai", name: i18n.t("presetOpenAI"), endpoint: "", model: "gpt-4o-mini", credential: "" }
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
  aiRequestBudget: document.querySelector("#aiRequestBudget"),
  aiCharacterBudget: document.querySelector("#aiCharacterBudget"),
  aiBudgetWindow: document.querySelector("#aiBudgetWindow"),
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
  status: document.querySelector("#newDraftStatus"),
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
  aiBudget: document.querySelector("#aiBudget"),
  aiBudgetUsage: document.querySelector("#aiBudgetUsage"),
  aiBudgetExhausted: document.querySelector("#aiBudgetExhausted"),
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
  modeAvailability: document.querySelector("#modeAvailability"),
  modeAvailabilityLabel: document.querySelector("#modeAvailabilityLabel"),
  modeAvailabilityHint: document.querySelector("#modeAvailabilityHint"),
  aiAvailability: document.querySelector("#aiAvailability"),
  aiAvailabilityLabel: document.querySelector("#aiAvailabilityLabel"),
  aiAvailabilityHint: document.querySelector("#aiAvailabilityHint"),
  aiAvailabilityAction: document.querySelector("#aiAvailabilityAction"),
  aiProviderSelect: document.querySelector("#aiProviderSelect"),
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
let connectionHint = i18n.t("statusNotConnectedHint");
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
  // 常驻窗口的可见性自愈：隐藏期间到期的轮询轮次被跳过，重新可见时用既有入口立刻补一轮，链不会因此永久停摆
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleStatePoll(0);
  });
  readCredentialStatus();
  scheduleStatePoll();
}

function showLocalPreview() {
  elements.pageStatus.textContent = i18n.t("settingsLocalPreviewStatus");
  elements.statusDot.dataset.state = "idle";
  controls.primaryTrackKey.add(new Option(i18n.t("trackSelectRuntime"), ""));
  controls.secondaryTrackKey.add(new Option(i18n.t("trackSelectRuntime"), ""));
  providerControls.source.add(new Option(i18n.t("trackSelectSourceRuntime"), ""));
  if (providerControls.masterList) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "provider-master-item is-selected";
    btn.textContent = i18n.t("presetOpenAI");
    providerControls.masterList.appendChild(btn);
  }
  providerControls.editor.hidden = false;
  providerControls.name.value = DEFAULT_PROVIDERS[0].name;
  writeProviderSelect();
  setSelectedModel(providerControls.model, DEFAULT_PROVIDERS[0].model);
  setModelOptions(elements.providerModelList, LLM_PRESETS.openai.models);
  bindModelPicker(providerControls.model, elements.providerModelList, document.querySelector("#providerModelMenu"), document.querySelector("#providerModelSearch"), () => {});
  bindModelPicker(newDraftControls.model, newDraftControls.modelList, document.querySelector("#newDraftModelMenu"), document.querySelector("#newDraftModelSearch"), () => {});
  elements.aiCredentialStatus.textContent = i18n.t("settingsLocalPreviewCredential");
  writeBudgetReadout();
  elements.testProvider.addEventListener("click", () => {
    elements.providerTestStatus.textContent = i18n.t("settingsLocalPreviewTest");
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
  elements.aiAvailabilityAction.addEventListener("click", () => {
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
  // 该影片没有字幕轨道时 AI 模式不可选中：不做静默失败，而是切到 AI 页把原因和解释摆到眼前
  if (mode === "ai" && readSubtitleAvailability(currentPageState) === "none") {
    revealAiUnavailable();
    return;
  }
  if (hasExtensionApi) return selectSubtitleMode(mode);
  currentSettings.aiRole = mode === "ai" ? "secondary" : "off";
  writeModeControls();
}

function revealAiUnavailable() {
  writeAvailabilityNotice();
  selectTab("ai");
  elements.aiAvailability.focus();
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
  // AI 页的当前翻译服务选择器：写入与「翻译服务」页签相同的 aiProviderId 键，随后立即重渲染选择器自身、
  // 页签主列表选中态与 AI 页就绪提示，并经既有状态轮询让 content 侧的就绪/翻译跟上（不新增协议）
  elements.aiProviderSelect.addEventListener("change", () => {
    const provider = currentProviders.find((item) => item.id === elements.aiProviderSelect.value);
    if (!provider || provider.id === currentSettings.aiProviderId) return;
    currentSettings.aiProviderId = provider.id;
    void writeSettings({ aiProviderId: provider.id });
    writeProviderControls();
    writeAvailabilityNotice();
    scheduleStatePoll(0);
  });
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
  for (const [key, max] of Object.entries(NUMBER_RANGES)) {
    const control = aiControls[key];
    control.addEventListener("change", () => {
      const value = Number(control.value);
      const count = control.value.trim() && Number.isInteger(value) && value >= 0 && value <= max
        ? value : DEFAULT_SETTINGS[key];
      control.value = count;
      currentSettings[key] = count;
      void writeSettings({ [key]: count });
      // 会话额度改动立即反映到读数，并复用既有状态轮询让 content 重新评估是否已用满
      if (control === aiControls.aiRequestBudget || control === aiControls.aiCharacterBudget) {
        writeBudgetReadout();
        if (currentSettings.aiRole !== "off") scheduleStatePoll(0);
      }
    });
  }

  aiControls.aiBudgetWindow.addEventListener("change", () => {
    const value = AI_BUDGET_WINDOWS.includes(aiControls.aiBudgetWindow.value)
      ? aiControls.aiBudgetWindow.value : DEFAULT_SETTINGS.aiBudgetWindow;
    aiControls.aiBudgetWindow.value = value;
    currentSettings.aiBudgetWindow = value;
    void writeSettings({ aiBudgetWindow: value });
    // 窗口改动立即改写读数的计量周期前缀，并复用既有状态轮询让 content 按新窗口评估是否已用满
    writeBudgetReadout();
    if (currentSettings.aiRole !== "off") scheduleStatePoll(0);
  });

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
  elements.activePageTitle.textContent = document.querySelector(`[data-tab="${tabName}"]`)?.textContent ?? i18n.t("tabSubtitles");
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
    elements.aiEndpointStatus.textContent = i18n.t("providerUseOpenAI");
    return;
  }
  let url;
  let normalized;
  try {
    normalized = normalizeProviderEndpoint(raw);
    url = new URL(normalized);
  } catch {
    elements.aiEndpointStatus.textContent = i18n.t("providerEndpointNeedHttps");
    return;
  }
  providerControls.endpoint.value = normalized;
  const origin = `${url.protocol}//${url.hostname}/*`;
  if (!runtime.permissions?.request) {
    elements.aiEndpointStatus.textContent = i18n.t("providerEndpointNoPermissionApi");
    return;
  }
  elements.aiEndpointStatus.textContent = i18n.t("providerEndpointRequesting");
  runtime.permissions.request({ origins: [origin] }, (granted) => {
    if (providerId !== currentSettings.aiProviderId) return;
    if (runtime.runtime.lastError || !granted) {
      elements.aiEndpointStatus.textContent = i18n.t("providerEndpointDenied");
      return;
    }
    void updateProviderField("endpoint", normalized);
    elements.aiEndpointStatus.textContent = i18n.t("providerEndpointGranted", [url.host, url.pathname]);
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
  trigger.textContent = model || i18n.t("providerModelSelect");
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
    elements.providerTestStatus.textContent = i18n.t("providerModelsNeedKey");
    return;
  }

  const request = { endpoint: active.endpoint, credential: active.credential, pending: true, models: cached?.endpoint === active.endpoint && cached?.credential === active.credential ? cached.models : null };
  providerModelCatalog.set(providerId, request);
  elements.fetchProviderModels.disabled = true;
  elements.providerTestStatus.textContent = i18n.t("providerModelsFetching");
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
        const errorMsg = result?.errorCode === "auth" ? i18n.t("providerErrorAuth") :
          result?.errorCode === "permission_denied" ? i18n.t("providerErrorPermissionDenied") : i18n.t("providerModelsFailedShort");
        elements.providerTestStatus.textContent = i18n.t("providerModelsFailed", [errorMsg]);
      } else {
        request.models = result.models;
        const search = elements.providerModelList.previousElementSibling;
        const query = search.value.trim().toLocaleLowerCase();
        setModelOptions(elements.providerModelList, [current.model, ...result.models]);
        search.value = query;
        for (const option of elements.providerModelList.children) option.hidden = !option.textContent.toLocaleLowerCase().includes(query);
        elements.providerTestStatus.textContent = i18n.t("providerModelsFetched", [result.models.length]);
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
    writeRoleStatus(currentSettings.aiRole, i18n.t("statusAiWaitingSource"), "loading");
  }
  await writeSettings(update);
  scheduleStatePoll(0);
}

async function reloadTracks() {
  if (!isWatchPage(currentPageState)) return;

  clearTimeout(pollTimer);
  elements.reloadTracks.disabled = true;
  elements.reloadTracks.classList.add("is-busy");
  writePageStatus(i18n.t("statusReloading"), "loading");
  writeRoleStatus("primary", i18n.t("statusWaitingTracks"), "loading");
  writeRoleStatus("secondary", i18n.t("statusWaitingTracks"), "loading");

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
      const budgetWindow = currentSettings.aiBudgetWindow;
      currentSettings = normalizeSettings(pageState.settings);
      currentSettings.aiProviderId = providerId;
      // content 若尚未回传该键（旧版本页面状态），保留设置窗口自己已持久化的窗口，避免读数前缀回退成默认值
      if (pageState.settings.aiBudgetWindow === undefined) currentSettings.aiBudgetWindow = budgetWindow;
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
  writeBudgetReadout();
  writeStatus();
  writeAvailability();
}

function populateTrackSelects() {
  populateTrackSelect("primary");
  populateTrackSelect("secondary");
  const source = findSelectedTrack(currentSettings.aiSourceTrackKey, currentSettings.aiSourceTrackPreference, currentSettings.aiSourceLanguage);
  providerControls.source.replaceChildren(createOption("", i18n.t("trackSelectSourcePlaceholder")), ...currentTracks.map(trackToOption));
  providerControls.source.value = source?.key ?? "";
  // disabled 由 writeAvailabilityNotice() 统一裁决（无轨道、或该影片无轨道时一并关闭），避免两处范围漂移
  updateJapaneseRubyVisibility();
}
function populateTrackSelect(role) {
  const select = controls[`${role}TrackKey`];
  if (currentSettings.aiRole === role) {
    select.replaceChildren(createOption("__ai__", i18n.t("trackSelectAi")));
    select.value = "__ai__";
    return;
  }
  const selected = findSelectedTrack(currentSettings[`${role}TrackKey`], currentSettings[`${role}TrackPreference`], currentSettings[`${role}Language`]);
  select.replaceChildren(createOption("", i18n.t("trackSelectNone")), ...currentTracks.map(trackToOption));
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
    ? i18n.t("modeDescriptionAi")
    : i18n.t("modeDescriptionNativeSwitch");
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
  // 模式与轨道选择变化都会改变不可用条件（如切换 AI 模式），提示必须同步重算，不能留下陈旧警告
  writeAvailabilityNotice();
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
      span.textContent = provider.name || i18n.t("providerUnnamed");
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
      ? i18n.t("providerSavedHost", [new URL(selected.endpoint).host])
      : i18n.t("providerUseOpenAI");

    const catalog = providerModelCatalog.get(selected.id);
    const discovered = catalog?.endpoint === selected.endpoint && catalog?.credential === selected.credential ? catalog.models : null;
    setModelOptions(elements.providerModelList, [selected.model, ...(discovered ?? matchedPreset?.models ?? [])]);
    elements.fetchProviderModels.disabled = Boolean(catalog?.pending);
    if (selected.jsonMode) {
      if (selected.jsonMode === "json_schema") {
        elements.providerTestStatus.dataset.state = "success";
        elements.providerTestStatus.textContent = i18n.t("providerJsonSchema");
      } else if (selected.jsonMode === "json_object") {
        elements.providerTestStatus.dataset.state = "success";
        elements.providerTestStatus.textContent = i18n.t("providerJsonObject");
      } else if (selected.jsonMode === "none") {
        elements.providerTestStatus.dataset.state = "warning";
        elements.providerTestStatus.textContent = i18n.t("providerJsonNone");
      }
    } else {
      elements.providerTestStatus.dataset.state = "";
      elements.providerTestStatus.textContent = "";
    }
    readCredentialStatus();
  }

  writeProviderSelect();
}

// AI 页「当前翻译服务」选择器：与「翻译服务」页签的主列表同源——同一份 currentProviders 与同一个
// currentSettings.aiProviderId，因此两处切换双向一致（页签点击经 writeProviderControls() 回流到这里，
// 删除当前服务由既有的归一化回退到首个服务）。只渲染服务名与其模型，绝不读取或显示凭证。
// 无已配置服务时禁用并给出解释（title 与 aria-label 同文案），选项留一个占位以免出现空白选择器。
function writeProviderSelect() {
  const select = elements.aiProviderSelect;
  if (!select) return;

  if (currentProviders.length === 0) {
    const hint = i18n.t("aiProviderEmptyHint");
    select.replaceChildren(createOption("", i18n.t("aiProviderNone")));
    select.value = "";
    select.disabled = true;
    select.setAttribute("aria-disabled", "true");
    select.setAttribute("aria-label", hint);
    select.title = hint;
    return;
  }

  const label = i18n.t("aiProviderSelect");
  select.replaceChildren(...currentProviders.map((provider) => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name
      ? provider.model ? `${provider.name} · ${provider.model}` : provider.name
      : i18n.t("providerUnnamed");
    return option;
  }));
  select.disabled = false;
  select.removeAttribute("aria-disabled");
  select.setAttribute("aria-label", label);
  select.removeAttribute("title");
  select.value = currentSettings.aiProviderId;
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
  writeDraftStatus("");
  newDraftControls.name.focus();
}

function hideNewDraftView() {
  providerControls.draftView.hidden = true;
  providerControls.detailView.hidden = false;
  writeProviderControls();
}

// 草案服务的校验/拉取失败一律就地写在卡片里的状态行（原来用阻塞式 alert，会打断上下文且不可测试）
function writeDraftStatus(message) {
  const status = newDraftControls.status;
  if (!status) return;
  const text = message ?? "";
  status.textContent = text;
  status.dataset.state = text ? "error" : "";
  status.hidden = !text;
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
    newDraftControls.key.placeholder = i18n.t("providerLocalNoKey");
  } else {
    newDraftControls.key.placeholder = "sk-...";
  }
}

async function saveNewDraftProvider() {
  const name = newDraftControls.name.value.trim() || i18n.t("providerNewName");
  const rawEndpoint = newDraftControls.endpoint.value.trim();
  const credential = newDraftControls.key.value.trim();

  let endpoint = "";
  if (rawEndpoint) {
    try {
      endpoint = normalizeProviderEndpoint(rawEndpoint);
    } catch {
      writeDraftStatus(i18n.t("providerValidEndpoint"));
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

  // 只有在点击“保存密钥并添加”时，才将新服务写入已保存列表；基线取存储里的最新列表，避免抹掉其它表面新增的服务
  currentProviders = [...(await readLatestProviders()), newProvider];
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
      writeDraftStatus(i18n.t("providerValidEndpoint"));
      return;
    }
  }

  if (!credential && endpoint !== "http://localhost:11434/v1/chat/completions") {
    writeDraftStatus(i18n.t("providerNeedKeyToList"));
    newDraftControls.key.focus();
    return;
  }

  if (endpoint && runtime.permissions?.request) {
    try {
      const url = new URL(endpoint);
      const origin = `${url.protocol}//${url.hostname}/*`;
      const granted = await new Promise((res) => runtime.permissions.request({ origins: [origin] }, res));
      if (!granted) {
        writeDraftStatus(i18n.t("providerEndpointDeniedModels"));
        return;
      }
    } catch { /* no-op */ }
  }

  // 通过校验，清掉上一次尝试留下的失败说明，再进入拉取态
  writeDraftStatus("");
  newDraftControls.fetchBtn.disabled = true;
  newDraftControls.fetchBtn.textContent = i18n.t("providerFetchingShort");

  const message = {
    type: "BILAYER_LIST_MODELS",
    credential,
    endpoint
  };

  runtime.runtime.sendMessage(message, (result) => {
    newDraftControls.fetchBtn.disabled = false;
    newDraftControls.fetchBtn.textContent = i18n.t("providerModelFetch");
    if (runtime.runtime.lastError || !result?.ok) {
      writeDraftStatus(result?.errorCode === "auth" ? i18n.t("providerKeyInvalidModels") : i18n.t("providerModelsListFailed"));
      return;
    }
    writeDraftStatus("");
    setModelOptions(newDraftControls.modelList, result.models);
  });
}

async function deleteProvider() {
  if (currentProviders.length <= 1) return;
  const removedId = currentSettings.aiProviderId;
  // 同样以存储最新列表为基线：只剔除被删除的服务，其它表面新增的服务保留；剔除后为空则回落默认服务
  const remaining = (await readLatestProviders()).filter((provider) => provider.id !== removedId);
  currentProviders = remaining.length ? remaining : DEFAULT_PROVIDERS.map((provider) => ({ ...provider }));
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
  elements.providerTestStatus.textContent = i18n.t("providerTesting");
  return new Promise((resolve) => {
    runtime.runtime.sendMessage({ type: "BILAYER_TEST_PROVIDER", providerId }, (result) => {
      elements.testProvider.disabled = false;
      if (providerId !== currentSettings.aiProviderId) { resolve(); return; }
      if (runtime.runtime.lastError || !result?.ok) {
        const errors = {
          auth: i18n.t("providerErrorAuth"), rate_limit: i18n.t("providerErrorRateLimit"), quota: i18n.t("providerErrorQuota"),
          permission_denied: i18n.t("providerErrorPermissionDenied"), configuration: i18n.t("providerErrorConfiguration"),
          unavailable: i18n.t("providerErrorUnavailable"), invalid_response: i18n.t("providerErrorInvalidResponse")
        };
        elements.providerTestStatus.dataset.state = "error";
        elements.providerTestStatus.textContent = i18n.t("providerFailPrefix", [errors[result?.errorCode] ?? i18n.t("providerFailGeneric")]);
      } else {
        if (result.jsonMode === "json_schema") {
          elements.providerTestStatus.dataset.state = "success";
          elements.providerTestStatus.textContent = i18n.t("providerConnectSchema");
        } else if (result.jsonMode === "json_object") {
          elements.providerTestStatus.dataset.state = "success";
          elements.providerTestStatus.textContent = i18n.t("providerConnectObject");
        } else {
          elements.providerTestStatus.dataset.state = "warning";
          elements.providerTestStatus.textContent = i18n.t("providerConnectNone");
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
  // 以存储里的最新列表为基线，只替换目标服务的该字段，其余服务（含其它表面刚新增的）原样保留
  currentProviders = (await readLatestProviders()).map((item) => item.id === provider.id ? { ...item, [field]: value } : item);
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
    writeRoleStatus("primary", i18n.t("statusNotConnected"), "error");
    writeRoleStatus("secondary", i18n.t("statusNotConnected"), "error");
    return;
  }

  if (!isWatchPage(currentPageState)) {
    writePageStatus(i18n.t("statusOpenMovie"), "idle");
    writeRoleStatus("primary", i18n.t("statusWaitingPlayback"), "idle");
    writeRoleStatus("secondary", i18n.t("statusWaitingPlayback"), "idle");
    return;
  }

  const sourceRole = currentSettings.aiRole === "off"
    ? null
    : currentSettings.aiRole === "primary" ? "secondary" : "primary";
  const primary = currentPageState.loadStatus?.primary;
  const secondary = currentPageState.loadStatus?.secondary;
  const sourceStatus = sourceRole === "primary" ? primary : secondary;
  const hasError = sourceRole ? Boolean(sourceStatus?.error) : Boolean(primary?.error || secondary?.error);

  if (currentTracks.length === 0) writePageStatus(i18n.t("statusReading"), "loading");
  else if (hasError) writePageStatus(i18n.t("statusDetectedWithError", [currentTracks.length]), "error");
  else writePageStatus(i18n.t("statusDetected", [currentTracks.length]), "ready");

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

// 会话翻译额度读数：用量取自页面状态的 translationBudget，缺失（未连接播放页或旧 content）时
// 退化为 0 用量 + 存储里的配置上限，因此没有页面也能渲染。上限为 null/0 一律显示为「不限」。
// 计量窗口优先取页面状态的 window（content 返回的有效窗口），缺失时退回存储设置，两者都非法则用默认值。
function writeBudgetReadout() {
  const budget = currentPageState?.translationBudget ?? null;
  const requestsUsed = nonNegativeNumber(budget?.requestsUsed);
  const charactersUsed = nonNegativeNumber(budget?.charactersUsed);
  const requestLimit = budget ? budget.requestLimit : currentSettings.aiRequestBudget;
  const characterLimit = budget ? budget.characterLimit : currentSettings.aiCharacterBudget;
  const requestLimitText = formatBudgetLimit(requestLimit);
  const characterLimitText = formatBudgetLimit(characterLimit);

  setTextIfChanged(elements.aiBudgetUsage, i18n.t("aiBudgetUsage", [
    i18n.t(budgetWindowLabelKey(budget?.window)),
    formatBudgetCount(requestsUsed), requestLimitText,
    formatBudgetCount(charactersUsed), characterLimitText
  ]));

  const exhausted = budgetExhaustedText(budget);
  setTextIfChanged(elements.aiBudgetExhausted, exhausted);
  elements.aiBudgetExhausted.hidden = !exhausted;
  elements.aiBudget.dataset.state = exhausted ? "exhausted" : "ok";
}

// 读数前缀的窗口文案：页面状态报告的窗口优先，其次存储设置，非法或缺失一律回落 session
function budgetWindowLabelKey(windowId) {
  const candidates = [windowId, currentSettings.aiBudgetWindow];
  const effective = candidates.find((candidate) => AI_BUDGET_WINDOWS.includes(candidate))
    ?? DEFAULT_SETTINGS.aiBudgetWindow;
  return AI_BUDGET_WINDOW_LABELS[effective];
}

// 触发 budget_exceeded 的语言行文案：页面报告了是哪一项就点名并带上数字，否则退回通用文案
function budgetExhaustedText(budget = currentPageState?.translationBudget) {
  if (budget?.exhausted === "requests") {
    return i18n.t("aiBudgetExhaustedRequests", [
      formatBudgetCount(nonNegativeNumber(budget.requestsUsed)), formatBudgetLimit(budget.requestLimit)
    ]);
  }
  if (budget?.exhausted === "characters") {
    return i18n.t("aiBudgetExhaustedCharacters", [
      formatBudgetCount(nonNegativeNumber(budget.charactersUsed)), formatBudgetLimit(budget.characterLimit)
    ]);
  }
  return "";
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatBudgetCount(value) {
  return nonNegativeNumber(value).toLocaleString();
}

function formatBudgetLimit(limit) {
  return limit == null || Number(limit) <= 0 ? i18n.t("aiBudgetUnlimited") : formatBudgetCount(limit);
}

function setTextIfChanged(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function writeLoadStatus(role, loadStatus, hasSelection) {
  if (!hasSelection) {
    writeRoleStatus(role, i18n.t("statusNotSelected"), "idle");
    return;
  }

  if (loadStatus?.error) {
    writeRoleStatus(role, friendlyError(loadStatus.error), "error");
    return;
  }

  if (loadStatus?.cueCount > 0) {
    writeRoleStatus(role, i18n.t("statusLoadedCount", [loadStatus.cueCount]), "ready");
    return;
  }

  writeRoleStatus(role, currentTracks.length > 0 ? i18n.t("statusLoading") : i18n.t("statusWaitingTracks"), "loading");
}

function writeTranslationStatus(role, status) {
  switch (status?.phase) {
    case "ready":
      writeRoleStatus(role, i18n.t("statusAiTranslated", [status.count ?? 0]), "ready");
      break;
    case "translating":
      writeRoleStatus(role, i18n.t("statusAiTranslating", [status.count ?? 0]), "loading");
      break;
    case "error": {
      const errors = {
        auth: i18n.t("statusErrorAuth"),
        rate_limit: i18n.t("providerErrorRateLimit"),
        quota: i18n.t("statusErrorQuota"),
        unavailable: i18n.t("statusErrorUnavailable"),
        invalid_response: i18n.t("providerErrorInvalidResponse"),
        configuration: i18n.t("statusErrorConfiguration"),
        permission_denied: i18n.t("statusErrorPermissionDenied"),
        source_unavailable: i18n.t("statusErrorSourceUnavailable"),
        initial_timeout: i18n.t("statusErrorInitialTimeout"),
        budget_exceeded: budgetExhaustedText() || i18n.t("statusErrorBudgetExceeded")
      };
      writeRoleStatus(role, i18n.t("statusAiFailed", [errors[status.error] ?? i18n.t("statusAiCheckSettings")]), "error");
      break;
    }
    default:
      writeRoleStatus(role, i18n.t("statusAiWaitingSource"), "loading");
  }
}

function writeRoleStatus(role, message, state) {
  const element = role === "primary" ? elements.primaryStatus : elements.secondaryStatus;
  element.textContent = message;
  element.dataset.state = state;
}

function markTrackLoading(role) {
  writeRoleStatus(role, i18n.t("statusLoading"), "loading");
}

function writeAvailability() {
  const onWatchPage = isWatchPage(currentPageState);
  const tracksReady = onWatchPage && currentTracks.length > 0;
  controls.primaryTrackKey.disabled = !tracksReady || currentSettings.aiRole === "primary";
  controls.secondaryTrackKey.disabled = !tracksReady || currentSettings.aiRole === "secondary";
  elements.primaryTrackLabel.textContent = currentSettings.aiRole === "primary" ? i18n.t("trackPrimaryAi") : i18n.t("trackPrimaryNative");
  elements.secondaryTrackLabel.textContent = currentSettings.aiRole === "secondary" ? i18n.t("trackSecondaryAi") : i18n.t("trackSecondaryNative");
  elements.swapTracks.disabled = !tracksReady;
  elements.reloadTracks.disabled = !onWatchPage;
  elements.reloadTracks.classList.remove("is-busy");
  elements.trackGrid.setAttribute("aria-disabled", String(!tracksReady));
  writeAvailabilityNotice();
}

// 页面状态里的字幕可用性：只有明确的 "none" 才表示“Netflix 没有为该影片提供轨道”（硬性不可用），
// "unread" 表示等待播放上下文后仍读不到播放器的轨道列表（软提示，不得断言无轨道，也不阻止选 AI），
// "available" 为已就绪；字段缺失或 "unknown"（旧 content、轨道仍在加载）一律按未知处理，不显示任何警告。
function readSubtitleAvailability(pageState) {
  const availability = pageState?.subtitleAvailability;
  return availability === "none" || availability === "unread" || availability === "available"
    ? availability
    : "unknown";
}

// 页面状态里的翻译服务就绪状态：字段缺失（旧 content）返回 null，调用方按“不警告”处理
function readProviderReadiness(pageState) {
  const readiness = pageState?.providerReadiness;
  return readiness && typeof readiness === "object" ? readiness : null;
}

// AI 不可用/未就绪提示的唯一写出点：成因按优先级互斥，且都只依据页面状态，因此状态一变（既有轮询）提示就随写入消失。
//   none       —— Netflix 没有给出任何字幕轨道：双原生与 AI 两行都无从显示，换片/换集才是出路（硬提示、按钮隐藏、AI 模式不可选）
//   未配置服务 —— 已选 AI 模式但 providerReadiness.configured 为 false：文案指向翻译服务页签（硬提示、带配置按钮）
//   unread     —— 等待后仍读不到播放器的轨道列表：软提示，明说“未能读取”而非“没有字幕”，且不阻止选择 AI
// 同时把两处不可用的控件收敛到同一处：AI 源轨道选择（没有源可挑）与 AI 模式卡片（标记 aria-disabled 供样式降噪，
// 但仍可点击——点击由 chooseSubtitleMode 呈现原因，原生 disabled 会吞掉点击）。
function writeAvailabilityNotice() {
  const availability = readSubtitleAvailability(currentPageState);
  const noTracks = availability === "none";
  const tracksUnread = availability === "unread";
  const noProvider = !noTracks && currentSettings.aiRole !== "off"
    && readProviderReadiness(currentPageState)?.configured === false;

  // 优先级：无轨道的硬性不可用 > 未配置服务的可操作提示 > 读不到轨道的软提示
  const label = noTracks ? i18n.t("aiUnavailableNoTracks")
    : noProvider ? i18n.t("aiUnavailableNoProvider")
    : tracksUnread ? i18n.t("aiUnavailableTracksUnread")
    : "";
  const hint = noTracks ? i18n.t("aiUnavailableNoTracksHint")
    : noProvider ? i18n.t("aiUnavailableNoProviderHint")
    : tracksUnread ? i18n.t("aiUnavailableTracksUnreadHint")
    : "";
  const soft = tracksUnread && !noTracks && !noProvider;

  for (const [root, labelElement, hintElement] of [
    [elements.modeAvailability, elements.modeAvailabilityLabel, elements.modeAvailabilityHint],
    [elements.aiAvailability, elements.aiAvailabilityLabel, elements.aiAvailabilityHint]
  ]) {
    root.hidden = !label;
    root.classList.toggle("is-soft", soft);
    setTextIfChanged(labelElement, label);
    setTextIfChanged(hintElement, hint);
  }
  elements.aiAvailabilityAction.hidden = !noProvider;

  providerControls.source.disabled = currentTracks.length === 0 || noTracks;
  elements.aiMode.setAttribute("aria-disabled", String(noTracks));
  elements.aiMode.classList.toggle("is-unavailable", noTracks);
}

function scheduleStatePoll(attempt = 0) {
  clearTimeout(pollTimer);
  if (attempt >= 10 && (!isWatchPage(currentPageState) || currentSettings.aiRole === "off")) return;

  pollTimer = setTimeout(async () => {
    // 常驻窗口可能在后台停留很久：隐藏期间不得发起任何标签页读取（readPageState/tabs.query/sendMessage），
    // 本轮直接作废，链本身由下方 visibilitychange → scheduleStatePoll(0) 在重新可见时立刻接上
    if (document.hidden) return;
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
  if (message.includes("0 cues")) return i18n.t("errorNoSubtitleText");
  if (message.includes("load failed") || message.includes("fetch")) return i18n.t("errorDownloadFailed");
  if (message.includes("timeout")) return i18n.t("errorTimeout");
  return i18n.t("errorLoadFailed");
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

// providers 是整数组存储键：任何单点修改（改字段、新增、删除）都必须先读回存储里的最新列表再按 id 合并，
// 否则另一个表面（新手向导同样写整个数组）在设置页打开期间新增的服务会被这份陈旧快照整体抹掉。
// 空列表与初始化一致回落 DEFAULT_PROVIDERS，并克隆一份以免写回时改到常量本身。
function readLatestProviders() {
  return new Promise((resolve) => {
    runtime.storage.local.get({ providers: DEFAULT_PROVIDERS }, (stored) => {
      const providers = stored?.providers;
      resolve(Array.isArray(providers) && providers.length
        ? providers
        : DEFAULT_PROVIDERS.map((provider) => ({ ...provider })));
    });
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
  for (const [key, max] of Object.entries(NUMBER_RANGES)) {
    if (!Number.isInteger(settings[key]) || settings[key] < 0 || settings[key] > max) settings[key] = DEFAULT_SETTINGS[key];
  }
  if (!AI_BUDGET_WINDOWS.includes(settings.aiBudgetWindow)) settings.aiBudgetWindow = DEFAULT_SETTINGS.aiBudgetWindow;
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
  elements.aiCredentialStatus.textContent = selectedProvider()?.credential ? i18n.t("providerCredentialConfigured") : i18n.t("providerCredentialMissing");
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
    ? i18n.t("netflixNotResponding")
    : i18n.t("netflixNotFound");
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
      title.textContent = i18n.t("aiRubyTitleTarget");
      desc.textContent = i18n.t("aiRubyDescTarget");
    } else if (isSourceJp && !isTargetJp) {
      title.textContent = i18n.t("aiRubyTitleSource");
      desc.textContent = i18n.t("aiRubyDescSource");
    } else {
      title.textContent = i18n.t("aiRubyTitle");
      desc.textContent = i18n.t("aiRubyDesc");
    }
  }
}
