/**
 * [INPUT]: 依赖 browser/chrome storage、tabs、permissions 与 runtime 消息 API，依赖 i18n 全局取本地化文案
 * [OUTPUT]: 驱动向导步骤切换、环境握手、模式分流、AI 连通性测试与模型发现、双字幕全量外观回写，并保证最后一步确定性进入可交互完成态
 * [POS]: src/onboarding 的核心交互逻辑，被 onboarding.html 消费；模型发现与 popup 的「获取模型」共用 BILAYER_LIST_MODELS 协议
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const runtime = globalThis.browser ?? globalThis.chrome;
    const hasExtensionApi = Boolean(runtime?.storage?.local && runtime?.runtime);

    const NETFLIX_URLS = ["https://netflix.com/*", "https://www.netflix.com/*"];
    const NETFLIX_HOME = "https://www.netflix.com";
    // Safari 可能永不回调或直接拒绝标签页/消息操作，所有异步路径都必须有截止时间，避免按钮永久禁用
    const STORAGE_DEADLINE_MS = 1200;
    const TAB_ACTION_DEADLINE_MS = 600;
    const PROVIDER_CALL_TIMEOUT_MS = 30000;

    // 临时 provider（id 见 MODEL_TEST_PROVIDER_ID）只为向导存活期内的 background 调用落盘，
    // 一旦写入就必须在跳过向导或页面离开时回滚，避免密钥残留在用户的服务列表里
    let tempProviderWritten = false;

    const state = {
      step: 1,
      mode: "native",
      preset: "openai",
      apiKey: "",
      targetLang: "zh-Hans",
      endpoint: "",
      model: "gpt-4o-mini",
      fontSize: 22,
      bottomOffset: 24
    };

    let existingProviders = [];
    let existingSettings = {};
    let existingProviderId = "openai";

    const presets = {
      openai: {
        name: i18n.t("presetOpenAI"),
        endpoint: "",
        model: "gpt-4o-mini",
        models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "chatgpt-4o-latest"],
        requiresKey: true
      },
      deepseek: {
        name: "DeepSeek",
        endpoint: "https://api.deepseek.com/v1/chat/completions",
        model: "deepseek-chat",
        models: ["deepseek-chat", "deepseek-reasoner"],
        requiresKey: true
      },
      openrouter: {
        name: "OpenRouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model: "google/gemini-2.5-flash",
        models: ["google/gemini-2.5-flash", "anthropic/claude-3.5-haiku", "openai/gpt-4o-mini", "deepseek/deepseek-chat"],
        requiresKey: true
      },
      groq: {
        name: "Groq",
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        model: "llama-3.3-70b-versatile",
        models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
        requiresKey: true
      },
      siliconflow: {
        name: i18n.t("presetSiliconFlow"),
        endpoint: "https://api.siliconflow.cn/v1/chat/completions",
        model: "deepseek-ai/DeepSeek-V3",
        models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-7B-Instruct"],
        requiresKey: true
      },
      ollama: {
        name: i18n.t("presetOllama"),
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "qwen2.5:7b",
        models: ["qwen2.5:7b", "llama3.2", "deepseek-r1:8b"],
        requiresKey: false
      },
      custom: {
        name: i18n.t("presetCustomEndpoint"),
        endpoint: "",
        model: "",
        models: [],
        requiresKey: true
      }
    };
    const providerDrafts = {
      openai: { endpoint: "", model: "gpt-4o-mini", key: "", id: "openai", name: i18n.t("presetOpenAI"), saved: false },
      deepseek: { endpoint: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", key: "", id: "deepseek", name: "DeepSeek", saved: false },
      openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "google/gemini-2.5-flash", key: "", id: "openrouter", name: "OpenRouter", saved: false },
      groq: { endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile", key: "", id: "groq", name: "Groq", saved: false },
      siliconflow: { endpoint: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V3", key: "", id: "siliconflow", name: i18n.t("presetSiliconFlow"), saved: false },
      ollama: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:7b", key: "", id: "ollama", name: i18n.t("presetOllama"), saved: false },
      custom: { endpoint: "", model: "", key: "", id: "custom", name: i18n.t("presetCustomEndpoint"), saved: false }
    };

    const stepItems = [document.querySelector("#stepItem1"), document.querySelector("#stepItem2"), document.querySelector("#stepItem3")];
    const panes = [document.querySelector("#pane1"), document.querySelector("#pane2"), document.querySelector("#pane3")];
    const btnBack = document.querySelector("#btnBack");
    const btnForward = document.querySelector("#btnForward");
    const btnSkip = document.querySelector("#btnSkip");
    const optNative = document.querySelector("#optNative");
    const optAi = document.querySelector("#optAi");
    const aiDrawer = document.querySelector("#aiDrawer");
    const presetChips = [...document.querySelectorAll(".preset-chip")].filter((chip) => chip.dataset.preset);
    const modelDatalist = document.querySelector("#onboardingModelList");
    const inputApiKey = document.querySelector("#inputApiKey");
    const inputBaseUrl = document.querySelector("#inputBaseUrl");
    const inputModel = document.querySelector("#inputModel");
    const modelTrigger = document.querySelector("#modelTrigger");
    const modelMenu = document.querySelector("#modelMenu");
    const modelSearch = document.querySelector("#modelSearch");
    const modelOptions = document.querySelector("#modelOptions");
    const btnFetchModels = document.querySelector("#btnFetchModels");
    const selectTargetLang = document.querySelector("#selectTargetLang");
    const toggleKeyVisibility = document.querySelector("#toggleKeyVisibility");
    const btnRunTest = document.querySelector("#btnRunTest");
    const testDot = document.querySelector("#testDot");
    const testFeedback = document.querySelector("#testFeedback");
    const previewBadge = document.querySelector("#previewBadge");
    const previewStage = document.querySelector("#previewStage");
    const previewPrimary = document.querySelector("#previewPrimary");
    const previewSecondary = document.querySelector("#previewSecondary");
    const pane3Subtitle = document.querySelector("#pane3Subtitle");
    const sliderFontSize = document.querySelector("#sliderFontSize");
    const sliderOffset = document.querySelector("#sliderOffset");
    const sliderLineHeight = document.querySelector("#sliderLineHeight");
    const sliderMaxWidth = document.querySelector("#sliderMaxWidth");
    const fontSizeDisplay = document.querySelector("#fontSizeDisplay");
    const offsetDisplay = document.querySelector("#offsetDisplay");
    const lineHeightDisplay = document.querySelector("#lineHeightDisplay");
    const maxWidthDisplay = document.querySelector("#maxWidthDisplay");
    const envDot = document.querySelector("#envDot");
    const envMessage = document.querySelector("#envMessage");
    const btnOpenNetflix = document.querySelector("#btnOpenNetflix");
    let activeVisualRole = "primary";
    const visualSettings = {
      subtitleLayoutPreset: "balanced",
      primaryFontSize: 26,
      secondaryFontSize: 28,
      primaryVerticalOffset: 26,
      secondaryVerticalOffset: 18,
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
      secondaryMaxWidth: 86
    };

    // 与 popup 外观面板同源：预览间距与字体族映射必须逐字一致
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

    const btnRolePrimary = document.querySelector("#btnRolePrimary");
    const btnRoleSecondary = document.querySelector("#btnRoleSecondary");
    const btnResetStyles = document.querySelector("#btnResetStyles");
    const layoutChips = document.querySelectorAll("[data-onboarding-layout]");

    const inputTextColor = document.querySelector("#inputTextColor");
    const textColorDisplay = document.querySelector("#textColorDisplay");
    const sliderTextOpacity = document.querySelector("#sliderTextOpacity");
    const textOpacityDisplay = document.querySelector("#textOpacityDisplay");
    const inputBgColor = document.querySelector("#inputBgColor");
    const bgColorDisplay = document.querySelector("#bgColorDisplay");
    const sliderBgOpacity = document.querySelector("#sliderBgOpacity");
    const bgOpacityDisplay = document.querySelector("#bgOpacityDisplay");
    const inputStrokeColor = document.querySelector("#inputStrokeColor");
    const strokeColorDisplay = document.querySelector("#strokeColorDisplay");
    const sliderStrokeWidth = document.querySelector("#sliderStrokeWidth");
    const strokeWidthDisplay = document.querySelector("#strokeWidthDisplay");
    const selectFontFamily = document.querySelector("#selectFontFamily");
    const selectFontWeight = document.querySelector("#selectFontWeight");
    const completionNote = document.querySelector("#completionNote");
    const completionText = document.querySelector("#completionText");
    const btnCompletionNetflix = document.querySelector("#btnCompletionNetflix");

    // 外观控件表：suffix 与 popup 的 STYLE_ROLE_SUFFIXES 同名，直接拼出 visualSettings 键
    const styleControls = {
      FontSize: { element: sliderFontSize, display: fontSizeDisplay, numeric: true, format: (value) => `${value} px` },
      VerticalOffset: { element: sliderOffset, display: offsetDisplay, numeric: true, format: (value) => `${value}%` },
      LineHeight: { element: sliderLineHeight, display: lineHeightDisplay, numeric: true, format: formatDecimal },
      MaxWidth: { element: sliderMaxWidth, display: maxWidthDisplay, numeric: true, format: (value) => `${value}%` },
      TextColor: { element: inputTextColor, display: textColorDisplay, numeric: false, format: (value) => String(value).toUpperCase() },
      TextOpacity: { element: sliderTextOpacity, display: textOpacityDisplay, numeric: true, format: (value) => `${value}%` },
      BackgroundColor: { element: inputBgColor, display: bgColorDisplay, numeric: false, format: (value) => String(value).toUpperCase() },
      BackgroundOpacity: { element: sliderBgOpacity, display: bgOpacityDisplay, numeric: true, format: (value) => `${value}%` },
      StrokeColor: { element: inputStrokeColor, display: strokeColorDisplay, numeric: false, format: (value) => String(value).toUpperCase() },
      StrokeWidth: { element: sliderStrokeWidth, display: strokeWidthDisplay, numeric: true, format: (value) => `${formatDecimal(value)} px` },
      FontFamily: { element: selectFontFamily, display: null, numeric: false, format: null },
      FontWeight: { element: selectFontWeight, display: null, numeric: true, format: null }
    };

    function formatDecimal(value) {
      return String(Number(Number(value).toFixed(2)));
    }

    function previewBottom(offset) {
      return 12 + ((Number(offset) - 8) / 34) * 76;
    }

    function writeStyleDisplay(suffix, value) {
      const control = styleControls[suffix];
      if (control?.display) control.display.textContent = control.format(value);
    }

    function writeStyleControls() {
      for (const [suffix, control] of Object.entries(styleControls)) {
        if (!control.element) continue;
        const value = visualSettings[`${activeVisualRole}${suffix}`];
        control.element.value = value;
        // 与 popup 的 writeAdvancedValues 一致：读数取自控件本身，滑块对齐 step 后才显示
        writeStyleDisplay(suffix, control.numeric ? Number(control.element.value) : value);
      }
      if (previewPrimary) previewPrimary.classList.toggle("is-editing", activeVisualRole === "primary");
      if (previewSecondary) previewSecondary.classList.toggle("is-editing", activeVisualRole === "secondary");
      updateVisualDisabled();
    }

    for (const [suffix, control] of Object.entries(styleControls)) {
      if (!control.element) continue;
      const isSelect = control.element.tagName === "SELECT";
      control.element[isSelect ? "onchange" : "oninput"] = (inputEvent) => {
        const value = control.numeric ? Number(inputEvent.target.value) : inputEvent.target.value;
        visualSettings[`${activeVisualRole}${suffix}`] = value;
        writeStyleDisplay(suffix, value);
        renderVisualPreview();
      };
    }

    if (btnRolePrimary && btnRoleSecondary) {
      btnRolePrimary.onclick = () => switchVisualRole("primary");
      btnRoleSecondary.onclick = () => switchVisualRole("secondary");
    }

    if (btnResetStyles) {
      btnResetStyles.onclick = () => {
        const isPrimary = activeVisualRole === "primary";
        visualSettings[`${activeVisualRole}FontSize`] = isPrimary ? 26 : 28;
        visualSettings[`${activeVisualRole}VerticalOffset`] = isPrimary ? 26 : 18;
        visualSettings[`${activeVisualRole}TextColor`] = "#FFFFFF";
        visualSettings[`${activeVisualRole}TextOpacity`] = 100;
        visualSettings[`${activeVisualRole}BackgroundColor`] = "#000000";
        visualSettings[`${activeVisualRole}BackgroundOpacity`] = 64;
        visualSettings[`${activeVisualRole}StrokeColor`] = "#000000";
        visualSettings[`${activeVisualRole}StrokeWidth`] = 1;
        visualSettings[`${activeVisualRole}FontFamily`] = "system";
        visualSettings[`${activeVisualRole}FontWeight`] = 700;
        visualSettings[`${activeVisualRole}LineHeight`] = 1.28;
        visualSettings[`${activeVisualRole}MaxWidth`] = 86;
        switchVisualRole(activeVisualRole);
      };
    }

    layoutChips.forEach((chip) => {
      chip.onclick = () => {
        // 与 popup 一致：位置预设只切 subtitleLayoutPreset，逐行偏移量由自由模式滑杆单独维护
        const layout = chip.dataset.onboardingLayout;
        visualSettings.subtitleLayoutPreset = layout;
        layoutChips.forEach((c) => c.classList.toggle("is-active", c.dataset.onboardingLayout === layout));
        updateVisualDisabled();
        renderVisualPreview();
      };
    });

    function updateVisualDisabled() {
      if (!sliderOffset) return;
      const isFree = visualSettings.subtitleLayoutPreset === "free";
      sliderOffset.disabled = !isFree;
      const container = sliderOffset.closest(".tuning-field");
      if (container) container.style.opacity = isFree ? "1" : "0.45";
    }

    function switchVisualRole(role) {
      activeVisualRole = role;
      if (btnRolePrimary) btnRolePrimary.classList.toggle("is-active", role === "primary");
      if (btnRoleSecondary) btnRoleSecondary.classList.toggle("is-active", role === "secondary");
      writeStyleControls();
      renderVisualPreview();
    }

    // 存储回调可能不落地，控件必须一开始就与视觉状态一致（禁用态、预览几何、编辑标记）
    switchVisualRole(activeVisualRole);


    // 初始化读取存储与环境
    if (hasExtensionApi) {
      runtime.storage.local.get(null, (stored) => {
        if (!stored) return;
        existingSettings = stored;
        existingProviders = Array.isArray(stored.providers) && stored.providers.length
          ? stored.providers
          : [{ id: "openai", name: i18n.t("presetOpenAI"), endpoint: "", model: "gpt-4o-mini", credential: "" }];
        existingProviderId = stored.aiProviderId || existingProviders[0].id;
        const active = existingProviders.find((p) => p.id === existingProviderId) ?? existingProviders[0];

        if (stored.aiRole && stored.aiRole !== "off") {
          selectMode("ai");
        }
        if (stored.aiTargetLanguage) {
          selectTargetLang.value = stored.aiTargetLanguage;
          state.targetLang = stored.aiTargetLanguage;
        }
        for (const k of Object.keys(visualSettings)) {
          if (stored[k] !== undefined) visualSettings[k] = stored[k];
        }
        switchVisualRole("primary");
        layoutChips.forEach((c) => c.classList.toggle("is-active", c.dataset.onboardingLayout === visualSettings.subtitleLayoutPreset));
        renderVisualPreview();
        existingProviders.forEach((p) => {
          let matchedKey = "custom";
          if (!p.endpoint) matchedKey = "openai";
          else {
            for (const [k, preset] of Object.entries(presets)) {
              if (k !== "custom" && p.endpoint === preset.endpoint) {
                matchedKey = k;
                break;
              }
            }
          }
          providerDrafts[matchedKey] = {
            id: p.id,
            name: p.name,
            endpoint: p.endpoint,
            model: p.model,
            key: p.credential || "",
            saved: true
          };
        });

        if (active) {
          let activeKey = "custom";
          if (!active.endpoint) activeKey = "openai";
          else {
            for (const [k, preset] of Object.entries(presets)) {
              if (k !== "custom" && active.endpoint === preset.endpoint) {
                activeKey = k;
                break;
              }
            }
          }
          selectPreset(activeKey);
        }
      });

      if (runtime.tabs?.query) {
        const reportEnvironment = (tabs) => {
          const hasWatch = tabs?.some((t) => t.url && /\/watch\//.test(t.url));
          const hasNetflix = tabs && tabs.length > 0;
          if (hasWatch) {
            envDot.dataset.state = "ready";
            envMessage.textContent = i18n.t("onboardingEnvConnected");
            btnOpenNetflix.style.display = "none";
          } else if (hasNetflix) {
            envDot.dataset.state = "ready";
            envMessage.textContent = i18n.t("onboardingEnvDetected");
            btnOpenNetflix.style.display = "none";
          } else {
            envDot.dataset.state = "testing";
            envMessage.textContent = i18n.t("onboardingEnvMissing");
            btnOpenNetflix.style.display = "inline-flex";
          }
        };
        try {
          runtime.tabs.query({ url: NETFLIX_URLS }, reportEnvironment);
        } catch {
          reportEnvironment([]);
        }
      }
    }

    btnOpenNetflix.onclick = () => openNetflix();

    stepItems.forEach((item, index) => {
      item.style.cursor = "pointer";
      item.onclick = () => setStep(index + 1);
    });

    function setStep(step) {
      state.step = step;
      stepItems.forEach((item, index) => item.classList.toggle("is-active", index + 1 === step));
      panes.forEach((pane, index) => pane.classList.toggle("is-active", index + 1 === step));

      btnBack.style.visibility = step === 1 ? "hidden" : "visible";
      btnForward.textContent = step === 3 ? i18n.t("onboardingFinish") : i18n.t("onboardingNext");
      btnForward.classList.toggle("btn-accent", step === 3);
      btnForward.classList.toggle("btn-primary", step !== 3);

      if (step === 3) syncPreview();
    }

    function syncPreview() {
      if (state.mode === "ai") {
        previewBadge.style.display = "flex";
        pane3Subtitle.textContent = i18n.t("onboardingVisualSubtitleAi");
        previewSecondary.textContent = i18n.t("sampleAi");
        previewSecondary.style.color = "#ffd60a";
      } else {
        previewBadge.style.display = "none";
        pane3Subtitle.textContent = i18n.t("onboardingVisualSubtitleNative");
        previewSecondary.textContent = i18n.t("sampleNative");
        previewSecondary.style.color = "#4cd964";
      }
    }

    function selectMode(mode) {
      state.mode = mode;
      optNative.classList.toggle("is-selected", mode === "native");
      optAi.classList.toggle("is-selected", mode === "ai");
      aiDrawer.classList.toggle("is-open", mode === "ai");
    }

    optNative.onclick = () => selectMode("native");
    optAi.onclick = () => selectMode("ai");

    function selectPreset(key) {
      if (providerDrafts[state.preset]) {
        providerDrafts[state.preset].endpoint = inputBaseUrl.value.trim();
        providerDrafts[state.preset].model = inputModel.value.trim();
        if (inputApiKey.value.trim()) {
          providerDrafts[state.preset].key = inputApiKey.value.trim();
        }
      }

      state.preset = key;
      presetChips.forEach((c) => c.classList.toggle("is-active", c.dataset.preset === key));
      const chosen = presets[key];
      const draft = providerDrafts[key];

      if (modelDatalist && chosen?.models) {
        modelDatalist.replaceChildren(...chosen.models.map((m) => {
          const opt = document.createElement("option");
          opt.value = m;
          return opt;
        }));
      }

      state.endpoint = draft?.endpoint ?? chosen.endpoint;
      inputBaseUrl.value = draft?.endpoint ?? chosen.endpoint;
      // 模型选择必须同时落到 state.model、#inputModel 与触发器标签
      applyModelSelection(draft?.model || chosen.model || "");
      inputApiKey.value = "";

      if (draft?.key) {
        inputApiKey.placeholder = i18n.t("providerSavedKeyPlaceholder");
      } else if (!chosen.requiresKey) {
        inputApiKey.placeholder = i18n.t("providerLocalNoKey");
      } else {
        inputApiKey.placeholder = i18n.t("providerEnterKeyPlaceholder");
      }

      if (key === "openai") {
        inputBaseUrl.placeholder = i18n.t("providerNewDraftEndpointPlaceholder");
      } else if (key === "custom") {
        inputBaseUrl.placeholder = "https://api.example.com/v1";
      }
    }

    presetChips.forEach((chip) => {
      chip.onclick = () => selectPreset(chip.dataset.preset);
    });

    toggleKeyVisibility.onclick = () => {
      const isPwd = inputApiKey.type === "password";
      inputApiKey.type = isPwd ? "text" : "password";
      toggleKeyVisibility.textContent = isPwd ? "🔒" : "👁";
    };

    function normalizeEndpoint(input) {
      const trimmed = (input ?? "").trim();
      if (!trimmed) return "";
      try {
        const parsed = new URL(trimmed);
        const pathname = parsed.pathname.replace(/\/+$/, "");
        if (pathname.endsWith("/chat/completions")) return parsed.origin + pathname;
        if (pathname === "" || pathname === "/v1") return `${parsed.origin}${pathname}/chat/completions`;
        return `${parsed.origin}${pathname}`;
      } catch {
        return trimmed;
      }
    }

    // background 消息回调可能永不触发（Safari 拒绝或 worker 异常），统一用超时收敛，
    // 保证调用方一定会拿到结果、按钮一定会恢复可点。
    function sendWithDeadline(message, onResult) {
      let settled = false;
      const finish = (result) => { if (settled) return; settled = true; onResult(result); };
      try {
        runtime.runtime.sendMessage(message, (result) => {
          if (runtime.runtime.lastError && !result) finish({ ok: false, errorCode: "unavailable" });
          else finish(result);
        });
      } catch {
        finish({ ok: false, errorCode: "unavailable" });
        return;
      }
      setTimeout(() => finish(undefined), PROVIDER_CALL_TIMEOUT_MS);
    }

    async function requestEndpointPermission(endpoint) {
      if (!endpoint || !runtime.permissions?.request) return true;
      const url = new URL(endpoint);
      const origin = `${url.protocol}//${url.hostname}/*`;
      return Boolean(await new Promise((resolve) => runtime.permissions.request({ origins: [origin] }, resolve)));
    }

    btnRunTest.onclick = async () => {
      const key = inputApiKey.value.trim();
      testDot.dataset.state = "testing";
      testFeedback.textContent = i18n.t("providerTestRunning");
      btnRunTest.disabled = true;

      const endpoint = state.preset === "custom" ? normalizeEndpoint(inputBaseUrl.value) : presets[state.preset].endpoint;
      const model = state.preset === "custom" ? (inputModel.value.trim() || "gpt-4o-mini") : presets[state.preset].model;

      if (!hasExtensionApi) {
        setTimeout(() => {
          testDot.dataset.state = "ready";
          testFeedback.textContent = i18n.t("providerTestMockOk");
          btnRunTest.disabled = false;
        }, 600);
        return;
      }

      // 请求域名权限 (若自定义端点)
      try {
        if (!await requestEndpointPermission(endpoint)) {
          testDot.dataset.state = "error";
          testFeedback.textContent = i18n.t("providerTestDenied");
          btnRunTest.disabled = false;
          return;
        }
      } catch {
        testDot.dataset.state = "error";
        testFeedback.textContent = i18n.t("providerTestBadUrl");
        btnRunTest.disabled = false;
        return;
      }

      // 准备测试 provider
      const testId = "onboarding-test";
      const existing = existingProviders.find((p) => p.id === existingProviderId);
      const credential = key || existing?.credential || "";

      if (!credential && presets[state.preset]?.requiresKey) {
        testDot.dataset.state = "error";
        testFeedback.textContent = i18n.t("providerTestNeedKey");
        btnRunTest.disabled = false;
        return;
      }

      const candidateProvider = {
        id: testId,
        name: i18n.t("providerTestServiceName"),
        endpoint,
        model,
        credential
      };

      const providersToSave = existingProviders.filter((p) => p.id !== testId).concat(candidateProvider);
      writeTempProvider(providersToSave, () => {
        sendWithDeadline({ type: "BILAYER_TEST_PROVIDER", providerId: testId }, (result) => {
          btnRunTest.disabled = false;
          if (runtime.runtime.lastError || !result?.ok) {
            const errors = {
              auth: i18n.t("providerErrorAuth"), rate_limit: i18n.t("providerErrorRateLimit"), quota: i18n.t("providerErrorQuota"),
              permission_denied: i18n.t("providerErrorPermissionDenied"), configuration: i18n.t("providerErrorConfiguration"),
              unavailable: i18n.t("providerErrorUnavailable"), invalid_response: i18n.t("providerErrorInvalidResponse")
            };
            testDot.dataset.state = "error";
            testFeedback.textContent = i18n.t("providerFailPrefix", [errors[result?.errorCode] ?? i18n.t("providerConnectionFailed")]);
          } else {
            testDot.dataset.state = result.jsonMode === "none" ? "warning" : "ready";
            if (result.jsonMode === "json_schema") {
              testFeedback.textContent = i18n.t("providerTestOkSchema");
            } else if (result.jsonMode === "json_object") {
              testFeedback.textContent = i18n.t("providerTestOkObject");
            } else {
              testFeedback.textContent = i18n.t("providerTestOkNone");
            }
          }
        });
      });
    };

    // ===== 模型发现：与 popup 的「获取模型」共用 background 的 BILAYER_LIST_MODELS =====
    // background 只从存储中的 provider 读取密钥，所以发送前必须先把当前草稿落盘为临时 provider
    const MODEL_TEST_PROVIDER_ID = "onboarding-test";

    // 进入向导时的服务列表（已剔除可能残留的临时 provider），作为跳过/离开时的回滚基准
    function entryProviders() {
      return existingProviders.filter((p) => p.id !== MODEL_TEST_PROVIDER_ID);
    }

    function writeTempProvider(providersToSave, done) {
      tempProviderWritten = true;
      try {
        runtime.storage.local.set({ providers: providersToSave }, () => done());
      } catch {
        done();
      }
    }

    // 页面卸载时的兜底：向导未完成就关掉标签页时，尽力清掉临时 provider。
    // 幂等、不抛错；完成态或从未写过临时 provider 时绝不改写 providers。
    function restoreEntryProviders() {
      if (state.completed || !tempProviderWritten) return;
      tempProviderWritten = false;
      if (!hasExtensionApi || !runtime?.storage?.local?.set) return;
      try {
        runtime.storage.local.set({ providers: entryProviders() });
      } catch { /* 卸载阶段尽力而为，失败不影响页面 */ }
    }

    window.addEventListener("pagehide", restoreEntryProviders);

    function applyModelSelection(model, { writeInput = true } = {}) {
      state.model = model;
      if (writeInput) inputModel.value = model;
      if (modelTrigger) {
        modelTrigger.dataset.value = model;
        modelTrigger.textContent = model || i18n.t("providerModelSelect");
      }
    }

    function writeModelFeedback(stateName, message) {
      if (testDot) testDot.dataset.state = stateName;
      if (testFeedback) testFeedback.textContent = message;
    }

    function setModelOptions(models) {
      if (!modelOptions) return;
      modelOptions.replaceChildren(...[...new Set(models.filter(Boolean))].map((model) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "model-option";
        option.setAttribute("role", "option");
        option.textContent = model;
        return option;
      }));
      if (modelSearch) modelSearch.value = "";
    }

    function bindModelPicker() {
      if (!modelTrigger || !modelMenu || !modelOptions || !modelSearch) return;
      const close = () => {
        modelMenu.hidden = true;
        modelTrigger.setAttribute("aria-expanded", "false");
      };
      modelTrigger.addEventListener("click", () => {
        modelMenu.hidden = !modelMenu.hidden;
        modelTrigger.setAttribute("aria-expanded", String(!modelMenu.hidden));
        if (modelMenu.hidden) return;
        modelSearch.value = "";
        for (const option of modelOptions.children) option.hidden = false;
        modelSearch.focus();
      });
      modelSearch.addEventListener("input", () => {
        const query = modelSearch.value.trim().toLocaleLowerCase();
        for (const option of modelOptions.children) option.hidden = !option.textContent.toLocaleLowerCase().includes(query);
      });
      modelOptions.addEventListener("click", (clickEvent) => {
        const option = clickEvent.target.closest(".model-option");
        if (!option) return;
        applyModelSelection(option.textContent);
        close();
        modelTrigger.focus();
      });
      modelMenu.addEventListener("keydown", (keyEvent) => {
        if (keyEvent.key !== "Escape") return;
        close();
        modelTrigger.focus();
      });
      document.addEventListener("click", (clickEvent) => {
        if (modelMenu.hidden) return;
        if (modelMenu.contains?.(clickEvent.target) || clickEvent.target === modelTrigger) return;
        close();
      });
    }
    bindModelPicker();

    // 存储不可用时也要让触发器显示真实模型；i18n.apply 会在 DOMContentLoaded 重写带
    // data-i18n 的触发器文案，因此在那一刻之后再回填一次，保证标签与真实模型一致
    const syncModelLabel = () => applyModelSelection(inputModel.value.trim(), { writeInput: false });
    syncModelLabel();
    document.addEventListener("DOMContentLoaded", syncModelLabel);

    inputModel.oninput = () => applyModelSelection(inputModel.value.trim(), { writeInput: false });

    btnFetchModels.onclick = async () => {
      const typedKey = inputApiKey.value.trim();
      const existing = existingProviders.find((p) => p.id === existingProviderId);
      const credential = typedKey || existing?.credential || "";
      const endpoint = state.preset === "custom" ? normalizeEndpoint(inputBaseUrl.value) : presets[state.preset]?.endpoint ?? "";
      const model = inputModel.value.trim() || presets[state.preset]?.model || state.model || "gpt-4o-mini";

      const showError = (message) => {
        btnFetchModels.disabled = false;
        writeModelFeedback("error", message);
      };

      // 与 popup 的「获取模型」一致：没有密钥先要求保存/输入密钥
      if (!credential) {
        showError(i18n.t("providerModelsNeedKey"));
        inputApiKey.focus();
        return;
      }

      btnFetchModels.disabled = true;
      writeModelFeedback("testing", i18n.t("providerModelsFetching"));

      if (!hasExtensionApi) {
        setTimeout(() => showError(i18n.t("providerModelsFailed", [i18n.t("providerModelsFailedShort")])), 400);
        return;
      }

      try {
        if (!await requestEndpointPermission(endpoint)) {
          showError(i18n.t("providerEndpointDeniedModels"));
          return;
        }
      } catch {
        showError(i18n.t("providerTestBadUrl"));
        return;
      }

      const candidateProvider = {
        id: MODEL_TEST_PROVIDER_ID,
        name: i18n.t("providerTestServiceName"),
        endpoint,
        model,
        credential
      };
      const providersToSave = existingProviders.filter((p) => p.id !== MODEL_TEST_PROVIDER_ID).concat(candidateProvider);

      writeTempProvider(providersToSave, () => {
        sendWithDeadline({ type: "BILAYER_LIST_MODELS", providerId: MODEL_TEST_PROVIDER_ID }, (result) => {
          if (runtime.runtime.lastError || !result?.ok || !Array.isArray(result.models)) {
            const reason = result?.errorCode === "auth" ? i18n.t("providerErrorAuth")
              : result?.errorCode === "permission_denied" ? i18n.t("providerErrorPermissionDenied")
              : i18n.t("providerModelsFailedShort");
            showError(i18n.t("providerModelsFailed", [reason]));
            return;
          }
          setModelOptions([state.model, ...result.models]);
          btnFetchModels.disabled = false;
          writeModelFeedback("ready", i18n.t("providerModelsFetched", [result.models.length]));
        });
      });
    };

    function renderVisualPreview() {
      // 与 popup writePreview 一致：预设决定堆叠间距，自由模式才使用逐行底部位置
      const preset = visualSettings.subtitleLayoutPreset;
      if (previewStage) {
        previewStage.dataset.layout = preset;
        if (preset === "free") {
          previewStage.style.setProperty("--preview-primary-bottom", `${previewBottom(visualSettings.primaryVerticalOffset)}px`);
          previewStage.style.setProperty("--preview-secondary-bottom", `${previewBottom(visualSettings.secondaryVerticalOffset)}px`);
        } else {
          previewStage.style.setProperty("--preview-gap", `${LAYOUT_PREVIEW[preset]?.gap ?? LAYOUT_PREVIEW.balanced.gap}px`);
        }
      }
      applyOnboardingStyle(previewPrimary, "primary");
      applyOnboardingStyle(previewSecondary, "secondary");
    }

    // 与 popup applyPreviewStyle 逐行同构：同一套字号缩放、最大宽度与字体族映射
    function applyOnboardingStyle(element, role) {
      if (!element) return;
      const val = (suffix) => visualSettings[`${role}${suffix}`];
      const previewFontSize = 10 + (Number(val("FontSize")) - 18) * 0.18;
      const maxWidth = Math.round(330 * Number(val("MaxWidth")) / 100);

      element.style.fontFamily = PREVIEW_FONT_FAMILIES[val("FontFamily")] ?? PREVIEW_FONT_FAMILIES.system;
      element.style.fontSize = `${previewFontSize}px`;
      element.style.fontWeight = val("FontWeight");
      element.style.lineHeight = val("LineHeight");
      element.style.maxWidth = `${maxWidth}px`;
      element.style.color = colorWithOpacity(val("TextColor"), val("TextOpacity"));
      element.style.background = colorWithOpacity(val("BackgroundColor"), val("BackgroundOpacity"));
      element.style.webkitTextStroke = `${val("StrokeWidth")}px ${val("StrokeColor")}`;
    }

    function colorWithOpacity(color, opacity) {
      const normalized = String(color ?? "#000000").replace(/^#/, "");
      const hex = normalized.length === 3
        ? normalized.split("").map((v) => v + v).join("")
        : normalized.padEnd(6, "0").slice(0, 6);
      const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
      const alpha = Math.max(0, Math.min(100, Number(opacity ?? 100))) / 100;
      return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
    }

    function buildCompletionPatch() {
      const finalProviders = entryProviders();
      let activeId = existingProviderId;

      if (state.mode === "ai") {
        if (providerDrafts[state.preset]) {
          providerDrafts[state.preset].endpoint = state.preset === "custom" ? normalizeEndpoint(inputBaseUrl.value) : presets[state.preset].endpoint;
          providerDrafts[state.preset].model = inputModel.value.trim() || presets[state.preset].model || "gpt-4o-mini";
          if (inputApiKey.value.trim()) {
            providerDrafts[state.preset].key = inputApiKey.value.trim();
          }
        }

        for (const [key, draft] of Object.entries(providerDrafts)) {
          if (!draft.key && key !== state.preset && !draft.saved) continue;
          const idx = finalProviders.findIndex((p) => p.id === draft.id);
          const item = {
            id: draft.id,
            name: draft.name,
            endpoint: draft.endpoint,
            model: draft.model,
            credential: draft.key
          };
          if (idx >= 0) finalProviders[idx] = { ...finalProviders[idx], ...item };
          else finalProviders.push(item);
        }
        activeId = providerDrafts[state.preset].id;
      }

      return {
        onboardingCompleted: true,
        enabled: true,
        aiRole: state.mode === "ai" ? "secondary" : "off",
        aiTargetLanguage: selectTargetLang.value,
        ...visualSettings,
        providers: finalProviders,
        aiProviderId: activeId
      };
    }

    // 存储回调可能永不触发，用截止时间兜底，完成态不依赖任何回调
    function persistSettings(patch, done) {
      if (!hasExtensionApi || !runtime?.storage?.local?.set) { done(); return; }
      let settled = false;
      const finish = () => { if (settled) return; settled = true; done(); };
      try {
        runtime.storage.local.set(patch, finish);
      } catch {
        finish();
        return;
      }
      setTimeout(finish, STORAGE_DEADLINE_MS);
    }

    function showCompletionState() {
      state.completed = true;
      if (completionText) completionText.textContent = i18n.t("onboardingSaved");
      if (completionNote) completionNote.hidden = false;
      if (btnCompletionNetflix) {
        btnCompletionNetflix.hidden = false;
        btnCompletionNetflix.disabled = false;
      }
      for (const button of [btnBack, btnSkip, btnForward]) {
        if (button) button.hidden = true;
      }
    }

    function openNetflix() {
      if (runtime?.tabs?.create) {
        try {
          runtime.tabs.create({ url: NETFLIX_HOME });
          return;
        } catch { /* 落到 window.open */ }
      }
      window.open(NETFLIX_HOME, "_blank");
    }

    // Safari 可能永不回调或直接抛错，任何被守卫的调用都必须收敛为"成功或超时"
    function guardedCall(invoke, done) {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; done(); };
      try {
        invoke(finish);
      } catch {
        finish();
        return;
      }
      setTimeout(finish, TAB_ACTION_DEADLINE_MS);
    }

    function bestEffortDismiss(fallbackUrl = NETFLIX_HOME) {
      if (!hasExtensionApi || !runtime.tabs?.query) { dismissTab(fallbackUrl); return; }
      try {
        runtime.tabs.query({ url: NETFLIX_URLS }, (tabs) => {
          const watchTab = tabs?.find((t) => t.url && /\/watch\//.test(t.url)) ?? tabs?.[0];
          if (!watchTab || !Number.isInteger(watchTab.id) || !runtime.tabs?.update) { dismissTab(fallbackUrl); return; }
          guardedCall((done) => runtime.tabs.update(watchTab.id, { active: true }, done), () => dismissTab(fallbackUrl));
        });
      } catch {
        dismissTab(fallbackUrl);
      }
    }

    // 完成态已渲染后才会走到这里，关闭失败也不影响已经给出的页内出口
    function finishOnboarding(patch) {
      if (state.completed) return;
      // 先把完成意图落定：完成 patch 已剔除临时 provider，页面卸载兜底不得再回写旧列表
      state.completed = true;
      if (btnForward) {
        btnForward.disabled = true;
        btnForward.textContent = i18n.t("onboardingSaved");
      }
      persistSettings(patch, () => {
        tempProviderWritten = false;
        showCompletionState();
        bestEffortDismiss();
      });
    }

    btnForward.onclick = () => {
      if (state.step < 3) {
        setStep(state.step + 1);
        return;
      }
      finishOnboarding(buildCompletionPatch());
    };

    btnBack.onclick = () => {
      if (state.step > 1) setStep(state.step - 1);
    };

    btnSkip.onclick = () => {
      if (state.completed) return;
      btnSkip.textContent = i18n.t("onboardingSkipped");
      btnSkip.disabled = true;
      // 只有本次向导真的写过临时 provider 才回滚服务列表：跳过本身不得凭空造出默认 provider
      const patch = tempProviderWritten
        ? { onboardingCompleted: true, providers: entryProviders() }
        : { onboardingCompleted: true };
      persistSettings(patch, () => {
        tempProviderWritten = false;
        showCompletionState();
        bestEffortDismiss();
      });
    };

    if (btnCompletionNetflix) btnCompletionNetflix.onclick = () => openNetflix();

    function dismissTab(fallbackUrl = NETFLIX_HOME) {
      if (!hasExtensionApi || !runtime?.tabs?.getCurrent) { safeCloseOrRedirect(fallbackUrl); return; }
      let settled = false;
      const fallback = () => { if (settled) return; settled = true; safeCloseOrRedirect(fallbackUrl); };
      let answered = false;
      try {
        runtime.tabs.getCurrent((tab) => {
          answered = true;
          if (!tab || !Number.isInteger(tab.id) || !runtime.tabs?.remove) { fallback(); return; }
          try {
            runtime.tabs.remove(tab.id, () => {
              if (runtime.runtime?.lastError) fallback();
            });
          } catch {
            fallback();
          }
        });
      } catch {
        fallback();
        return;
      }
      setTimeout(() => { if (!answered) fallback(); }, TAB_ACTION_DEADLINE_MS);
    }

    function safeCloseOrRedirect(fallbackUrl) {
      window.close();
      setTimeout(() => {
        if (!window.closed) {
          location.href = fallbackUrl;
        }
      }, 150);
    }
