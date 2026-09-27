/**
 * [INPUT]: 依赖 browser/chrome storage、tabs 与 runtime API
 * [OUTPUT]: 驱动向导步骤切换、环境握手、模式分流、AI 连通性测试与配置持久化回写
 * [POS]: src/onboarding 的核心交互逻辑，被 onboarding.html 消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const runtime = globalThis.browser ?? globalThis.chrome;
    const hasExtensionApi = Boolean(runtime?.storage?.local && runtime?.runtime);

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
        name: "OpenAI 官方",
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
        name: "硅基流动",
        endpoint: "https://api.siliconflow.cn/v1/chat/completions",
        model: "deepseek-ai/DeepSeek-V3",
        models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-7B-Instruct"],
        requiresKey: true
      },
      ollama: {
        name: "Ollama 本地",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "qwen2.5:7b",
        models: ["qwen2.5:7b", "llama3.2", "deepseek-r1:8b"],
        requiresKey: false
      },
      custom: {
        name: "自定义端点",
        endpoint: "",
        model: "",
        models: [],
        requiresKey: true
      }
    };
    const providerDrafts = {
      openai: { endpoint: "", model: "gpt-4o-mini", key: "", id: "openai", name: "OpenAI 官方", saved: false },
      deepseek: { endpoint: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", key: "", id: "deepseek", name: "DeepSeek", saved: false },
      openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "google/gemini-2.5-flash", key: "", id: "openrouter", name: "OpenRouter", saved: false },
      groq: { endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile", key: "", id: "groq", name: "Groq", saved: false },
      siliconflow: { endpoint: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V3", key: "", id: "siliconflow", name: "硅基流动", saved: false },
      ollama: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:7b", key: "", id: "ollama", name: "Ollama 本地", saved: false },
      custom: { endpoint: "", model: "", key: "", id: "custom", name: "自定义端点", saved: false }
    };

    const stepItems = [document.querySelector("#stepItem1"), document.querySelector("#stepItem2"), document.querySelector("#stepItem3")];
    const panes = [document.querySelector("#pane1"), document.querySelector("#pane2"), document.querySelector("#pane3")];
    const btnBack = document.querySelector("#btnBack");
    const btnForward = document.querySelector("#btnForward");
    const btnSkip = document.querySelector("#btnSkip");
    const optNative = document.querySelector("#optNative");
    const optAi = document.querySelector("#optAi");
    const aiDrawer = document.querySelector("#aiDrawer");
    const presetChips = document.querySelectorAll(".preset-chip");
    const modelDatalist = document.querySelector("#onboardingModelList");
    const inputApiKey = document.querySelector("#inputApiKey");
    const inputBaseUrl = document.querySelector("#inputBaseUrl");
    const inputModel = document.querySelector("#inputModel");
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
    const fontSizeDisplay = document.querySelector("#fontSizeDisplay");
    const offsetDisplay = document.querySelector("#offsetDisplay");
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
        switchVisualRole(activeVisualRole);
        renderVisualPreview();
      };
    }
    layoutChips.forEach((chip) => {
      chip.onclick = () => {
        const layout = chip.dataset.onboardingLayout;
        visualSettings.subtitleLayoutPreset = layout;
        layoutChips.forEach((c) => c.classList.toggle("is-active", c.dataset.onboardingLayout === layout));
        updateVisualDisabled();
        renderVisualPreview();
      };
    });

    function updateVisualDisabled() {
      const isFree = visualSettings.subtitleLayoutPreset === "free";
      if (sliderOffset) {
        sliderOffset.disabled = !isFree;
        const container = sliderOffset.closest(".tuning-field");
        if (container) container.style.opacity = isFree ? "1" : "0.45";
      }
    }

    function switchVisualRole(role) {
      activeVisualRole = role;
      if (btnRolePrimary) btnRolePrimary.classList.toggle("is-active", role === "primary");
      if (btnRoleSecondary) btnRoleSecondary.classList.toggle("is-active", role === "secondary");

      const fs = visualSettings[`${role}FontSize`] || (role === "primary" ? 26 : 28);
      const vo = visualSettings[`${role}VerticalOffset`] || (role === "primary" ? 26 : 18);
      const tc = visualSettings[`${role}TextColor`] || "#FFFFFF";
      const to = visualSettings[`${role}TextOpacity`] ?? 100;
      const bc = visualSettings[`${role}BackgroundColor`] || "#000000";
      const bo = visualSettings[`${role}BackgroundOpacity`] ?? 64;
      const sc = visualSettings[`${role}StrokeColor`] || "#000000";
      const sw = visualSettings[`${role}StrokeWidth`] ?? 1;
      const ff = visualSettings[`${role}FontFamily`] || "system";
      const fw = visualSettings[`${role}FontWeight`] || 700;

      if (sliderFontSize) {
        sliderFontSize.value = fs;
        fontSizeDisplay.textContent = `${fs} px`;
      }
      if (sliderOffset) {
        sliderOffset.value = vo;
        offsetDisplay.textContent = `${vo}%`;
      }
      if (inputTextColor) {
        inputTextColor.value = tc;
        textColorDisplay.textContent = tc.toUpperCase();
      }
      if (sliderTextOpacity) {
        sliderTextOpacity.value = to;
        textOpacityDisplay.textContent = `${to}%`;
      }
      if (inputBgColor) {
        inputBgColor.value = bc;
        bgColorDisplay.textContent = bc.toUpperCase();
      }
      if (sliderBgOpacity) {
        sliderBgOpacity.value = bo;
        bgOpacityDisplay.textContent = `${bo}%`;
      }
      if (inputStrokeColor) {
        inputStrokeColor.value = sc;
        strokeColorDisplay.textContent = sc.toUpperCase();
      }
      if (sliderStrokeWidth) {
        sliderStrokeWidth.value = sw;
        strokeWidthDisplay.textContent = `${sw} px`;
      }
      if (selectFontFamily) selectFontFamily.value = ff;
      if (selectFontWeight) selectFontWeight.value = String(fw);

      updateVisualDisabled();
    }


    // 初始化读取存储与环境
    if (hasExtensionApi) {
      runtime.storage.local.get(null, (stored) => {
        if (!stored) return;
        existingSettings = stored;
        existingProviders = Array.isArray(stored.providers) && stored.providers.length
          ? stored.providers
          : [{ id: "openai", name: "OpenAI 官方", endpoint: "", model: "gpt-4o-mini", credential: "" }];
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
        runtime.tabs.query({ url: ["https://netflix.com/*", "https://www.netflix.com/*"] }, (tabs) => {
          const hasWatch = tabs?.some((t) => t.url && /\/watch\//.test(t.url));
          const hasNetflix = tabs && tabs.length > 0;
          if (hasWatch) {
            envDot.dataset.state = "ready";
            envMessage.textContent = "已连接 Netflix 播放页面，字幕引擎就绪";
            btnOpenNetflix.style.display = "none";
          } else if (hasNetflix) {
            envDot.dataset.state = "ready";
            envMessage.textContent = "已检测到 Netflix 页面，开启影片播放即可就绪";
            btnOpenNetflix.style.display = "none";
          } else {
            envDot.dataset.state = "testing";
            envMessage.textContent = "未检测到 Netflix 页面；可点击右侧按钮开启";
            btnOpenNetflix.style.display = "inline-flex";
          }
        });
      }
    }

    btnOpenNetflix.onclick = () => {
      if (runtime?.tabs?.create) runtime.tabs.create({ url: "https://www.netflix.com" });
      else window.open("https://www.netflix.com", "_blank");
    };

    stepItems.forEach((item, index) => {
      item.style.cursor = "pointer";
      item.onclick = () => setStep(index + 1);
    });

    function setStep(step) {
      state.step = step;
      stepItems.forEach((item, index) => item.classList.toggle("is-active", index + 1 === step));
      panes.forEach((pane, index) => pane.classList.toggle("is-active", index + 1 === step));

      btnBack.style.visibility = step === 1 ? "hidden" : "visible";
      btnForward.textContent = step === 3 ? "完成并开始观影" : "下一步";
      btnForward.classList.toggle("btn-accent", step === 3);
      btnForward.classList.toggle("btn-primary", step !== 3);

      if (step === 3) syncPreview();
    }

    function syncPreview() {
      if (state.mode === "ai") {
        previewBadge.style.display = "flex";
        pane3Subtitle.textContent = "AI 翻译模式已就绪，主字幕播放时副字幕由所选大模型实时生成。";
        previewSecondary.textContent = "不要告诉我几率是多少。";
        previewSecondary.style.color = "#ffd60a";
      } else {
        previewBadge.style.display = "none";
        pane3Subtitle.textContent = "双原生字幕已就绪，两行均由 Netflix 官方原声轨道驱动。";
        previewSecondary.textContent = "永远别跟我提胜率。";
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
      state.model = draft?.model || chosen.model || state.model || "gpt-4o-mini";
      inputBaseUrl.value = draft?.endpoint ?? chosen.endpoint;
      inputModel.value = draft?.model || chosen.model || "";
      inputApiKey.value = "";

      if (draft?.key) {
        inputApiKey.placeholder = "已保存现有密钥 (输入新密钥以覆盖)";
      } else if (!chosen.requiresKey) {
        inputApiKey.placeholder = "本地服务无需密钥，可留空";
      } else {
        inputApiKey.placeholder = "输入该服务的 API Key";
      }

      if (key === "openai") {
        inputBaseUrl.placeholder = "留空使用 OpenAI 官方接口";
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

    btnRunTest.onclick = async () => {
      const key = inputApiKey.value.trim();
      testDot.dataset.state = "testing";
      testFeedback.textContent = "正在测试端点连通性...";
      btnRunTest.disabled = true;

      const endpoint = state.preset === "custom" ? normalizeEndpoint(inputBaseUrl.value) : presets[state.preset].endpoint;
      const model = state.preset === "custom" ? (inputModel.value.trim() || "gpt-4o-mini") : presets[state.preset].model;

      if (!hasExtensionApi) {
        setTimeout(() => {
          testDot.dataset.state = "ready";
          testFeedback.textContent = "连通正常 · 延迟 142ms · 模型响应成功";
          btnRunTest.disabled = false;
        }, 600);
        return;
      }

      // 请求域名权限 (若自定义端点)
      if (endpoint && runtime.permissions?.request) {
        try {
          const url = new URL(endpoint);
          const origin = `${url.protocol}//${url.hostname}/*`;
          const granted = await new Promise((res) => runtime.permissions.request({ origins: [origin] }, res));
          if (!granted) {
            testDot.dataset.state = "error";
            testFeedback.textContent = "失败：未授权服务域名权限";
            btnRunTest.disabled = false;
            return;
          }
        } catch {
          testDot.dataset.state = "error";
          testFeedback.textContent = "失败：端点 URL 格式无效";
          btnRunTest.disabled = false;
          return;
        }
      }

      // 准备测试 provider
      const testId = "onboarding-test";
      const existing = existingProviders.find((p) => p.id === existingProviderId);
      const credential = key || existing?.credential || "";

      if (!credential && presets[state.preset]?.requiresKey) {
        testDot.dataset.state = "error";
        testFeedback.textContent = "请先填入有效 API 密钥后再测试";
        btnRunTest.disabled = false;
        return;
      }

      const candidateProvider = {
        id: testId,
        name: "测试服务",
        endpoint,
        model,
        credential
      };

      const providersToSave = existingProviders.filter((p) => p.id !== testId).concat(candidateProvider);
      runtime.storage.local.set({ providers: providersToSave }, () => {
        runtime.runtime.sendMessage({ type: "BILAYER_TEST_PROVIDER", providerId: testId }, (result) => {
          btnRunTest.disabled = false;
          if (runtime.runtime.lastError || !result?.ok) {
            const errors = {
              auth: "密钥无效", rate_limit: "请求过于频繁", quota: "额度不足",
              permission_denied: "未授权服务域名", configuration: "请先填写有效模型、端点和密钥",
              unavailable: "服务不可达", invalid_response: "服务返回格式有误"
            };
            testDot.dataset.state = "error";
            testFeedback.textContent = `失败：${errors[result?.errorCode] ?? "连接失败"}`;
          } else {
            testDot.dataset.state = result.jsonMode === "none" ? "warning" : "ready";
            if (result.jsonMode === "json_schema") {
              testFeedback.textContent = "连通正常 · 支持 JSON Schema 严格模式";
            } else if (result.jsonMode === "json_object") {
              testFeedback.textContent = "连通正常 · 支持 JSON Object 约束";
            } else {
              testFeedback.textContent = "连通成功，但该模型不支持结构化 JSON，可能出现解析错误导致 AI 字幕不显示";
            }
          }
        });
      });
    };

    if (sliderFontSize) {
      sliderFontSize.oninput = (e) => {
        const val = Number(e.target.value);
        visualSettings[`${activeVisualRole}FontSize`] = val;
        fontSizeDisplay.textContent = `${val} px`;
        renderVisualPreview();
      };
    }

    if (sliderOffset) {
      sliderOffset.oninput = (e) => {
        const val = Number(e.target.value);
        visualSettings[`${activeVisualRole}VerticalOffset`] = val;
        offsetDisplay.textContent = `${val}%`;
        renderVisualPreview();
      };
    }

    if (inputTextColor) {
      inputTextColor.oninput = (e) => {
        const val = e.target.value;
        visualSettings[`${activeVisualRole}TextColor`] = val;
        textColorDisplay.textContent = val.toUpperCase();
        renderVisualPreview();
      };
    }

    if (sliderTextOpacity) {
      sliderTextOpacity.oninput = (e) => {
        const val = Number(e.target.value);
        visualSettings[`${activeVisualRole}TextOpacity`] = val;
        textOpacityDisplay.textContent = `${val}%`;
        renderVisualPreview();
      };
    }

    if (inputBgColor) {
      inputBgColor.oninput = (e) => {
        const val = e.target.value;
        visualSettings[`${activeVisualRole}BackgroundColor`] = val;
        bgColorDisplay.textContent = val.toUpperCase();
        renderVisualPreview();
      };
    }

    if (sliderBgOpacity) {
      sliderBgOpacity.oninput = (e) => {
        const val = Number(e.target.value);
        visualSettings[`${activeVisualRole}BackgroundOpacity`] = val;
        bgOpacityDisplay.textContent = `${val}%`;
        renderVisualPreview();
      };
    }

    if (inputStrokeColor) {
      inputStrokeColor.oninput = (e) => {
        const val = e.target.value;
        visualSettings[`${activeVisualRole}StrokeColor`] = val;
        strokeColorDisplay.textContent = val.toUpperCase();
        renderVisualPreview();
      };
    }

    if (sliderStrokeWidth) {
      sliderStrokeWidth.oninput = (e) => {
        const val = Number(e.target.value);
        visualSettings[`${activeVisualRole}StrokeWidth`] = val;
        strokeWidthDisplay.textContent = `${val} px`;
        renderVisualPreview();
      };
    }

    if (selectFontFamily) {
      selectFontFamily.onchange = (e) => {
        visualSettings[`${activeVisualRole}FontFamily`] = e.target.value;
        renderVisualPreview();
      };
    }

    if (selectFontWeight) {
      selectFontWeight.onchange = (e) => {
        visualSettings[`${activeVisualRole}FontWeight`] = Number(e.target.value);
        renderVisualPreview();
      };
    }

    function renderVisualPreview() {
      applyOnboardingStyle(previewPrimary, "primary");
      applyOnboardingStyle(previewSecondary, "secondary");
    }

    function applyOnboardingStyle(element, role) {
      if (!element) return;
      const val = (suffix) => visualSettings[`${role}${suffix}`];
      const previewFontSize = 10 + (Number(val("FontSize") || 26) - 18) * 0.18;
      const maxWidth = Math.round(330 * Number(val("MaxWidth") || 86) / 100);

      element.style.fontFamily = val("FontFamily") === "serif" ? "Georgia, serif" :
                                 val("FontFamily") === "rounded" ? "\"Arial Rounded MT Bold\", sans-serif" :
                                 val("FontFamily") === "sans" ? "\"Avenir Next\", sans-serif" :
                                 "-apple-system, BlinkMacSystemFont, sans-serif";
      element.style.fontSize = `${previewFontSize}px`;
      element.style.fontWeight = val("FontWeight") || 700;
      element.style.lineHeight = val("LineHeight") || 1.28;
      element.style.maxWidth = `${maxWidth}px`;
      element.style.color = colorWithOpacity(val("TextColor") || "#FFFFFF", val("TextOpacity") || 100);
      element.style.background = colorWithOpacity(val("BackgroundColor") || "#000000", val("BackgroundOpacity") || 64);
      element.style.webkitTextStroke = `${val("StrokeWidth") || 1}px ${val("StrokeColor") || "#000000"}`;
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

    btnForward.onclick = () => {
      if (state.step < 3) {
        setStep(state.step + 1);
        return;
      }

      // 完成并保存
      const finalProviders = existingProviders.filter((p) => p.id !== "onboarding-test");
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

      const patch = {
        onboardingCompleted: true,
        enabled: true,
        aiRole: state.mode === "ai" ? "secondary" : "off",
        aiTargetLanguage: selectTargetLang.value,
        ...visualSettings,
        providers: finalProviders,
        aiProviderId: activeId
      };

      btnForward.textContent = "保存就绪 ✓";
      btnForward.disabled = true;

      if (hasExtensionApi) {
        runtime.storage.local.set(patch, () => {
          setTimeout(() => {
            if (runtime.tabs?.query) {
              runtime.tabs.query({ url: ["https://netflix.com/*", "https://www.netflix.com/*"] }, (tabs) => {
                const watchTab = tabs?.find((t) => t.url && /\/watch\//.test(t.url)) ?? tabs?.[0];
                if (watchTab && Number.isInteger(watchTab.id) && runtime?.tabs?.update) {
                  runtime.tabs.update(watchTab.id, { active: true }, () => dismissTab());
                } else if (runtime?.tabs?.create) {
                  runtime.tabs.create({ url: "https://www.netflix.com" }, () => dismissTab());
                } else {
                  dismissTab("https://www.netflix.com");
                }
              });
            } else {
              dismissTab("https://www.netflix.com");
            }
          }, 300);
        });
      } else {
        setTimeout(() => {
          safeCloseOrRedirect("https://www.netflix.com");
        }, 300);
      }
    };

    btnBack.onclick = () => {
      if (state.step > 1) setStep(state.step - 1);
    };

    btnSkip.onclick = () => {
      btnSkip.textContent = "已跳过...";
      btnSkip.disabled = true;
      if (hasExtensionApi) {
        runtime.storage.local.set({ onboardingCompleted: true }, () => {
          if (runtime?.tabs?.query) {
            runtime.tabs.query({ url: ["https://netflix.com/*", "https://www.netflix.com/*"] }, (tabs) => {
              const watchTab = tabs?.find((t) => t.url && /\/watch\//.test(t.url)) ?? tabs?.[0];
              if (watchTab && Number.isInteger(watchTab.id) && runtime?.tabs?.update) {
                runtime.tabs.update(watchTab.id, { active: true }, () => dismissTab());
                return;
              }
              dismissTab("https://www.netflix.com");
            });
            return;
          }
          dismissTab("https://www.netflix.com");
        });
      } else {
        dismissTab("https://www.netflix.com");
      }
    };

    function dismissTab(fallbackUrl = "https://www.netflix.com") {
      if (hasExtensionApi && runtime?.tabs?.getCurrent) {
        runtime.tabs.getCurrent((tab) => {
          if (tab && Number.isInteger(tab.id) && runtime?.tabs?.remove) {
            runtime.tabs.remove(tab.id, () => {
              if (runtime.runtime?.lastError) safeCloseOrRedirect(fallbackUrl);
            });
            return;
          }
          safeCloseOrRedirect(fallbackUrl);
        });
        return;
      }
      safeCloseOrRedirect(fallbackUrl);
    }

    function safeCloseOrRedirect(fallbackUrl) {
      window.close();
      setTimeout(() => {
        if (!window.closed) {
          location.href = fallbackUrl;
        }
      }, 150);
    }
