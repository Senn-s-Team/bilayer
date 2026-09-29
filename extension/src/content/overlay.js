/**
 * [INPUT]: 依赖 DOM/Shadow DOM 渲染能力、字幕样式设置与 subtitleParser 输出的 cue 数组（支持带 ruby 的日文注音）、fullscreenMount 的挂载点选择
 * [OUTPUT]: 对 window.Bilayer 提供双字幕布局与独立视觉样式；逐帧复用未变化的字幕节点（包含 ruby 标记）、渲染假名注音并通过 mount() 接入全屏挂载；render({primaryCues, secondaryCues, pending, notice}) 的 pending 按角色标记等待翻译，无文本的角色在连续 pending ≥200ms 后复用该角色字号/颜色/描边/背景/布局渲染无文字占位动画，收到文本或结束 pending 立即消失，且占位节点复用不产生 churn；notice 缺省/null/空 text 与旧行为一致，非空 {text, kind?} 时在字幕栈最下方（自由布局为最下字幕行之下）渲染唯一复用的惰性 pill 提示条：pointer-events:none、aria-live 关闭，文本由调用方预本地化故本文件不引入 locale 依赖，kind 仅切换 warning/info 配色
 * [POS]: content 的显示层，被 content.js 按播放时间与 AI 可用性驱动；mount() 由 fullscreenMount 接管挂载点；提示条只渲染调用方给定的已本地化文本，保持平台无关
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const SUBTITLE_LAYOUT_PRESETS = {
  compact: { bottom: 14, gap: 4 },
  balanced: { bottom: 18, gap: 8 },
  spacious: { bottom: 22, gap: 16 }
};

const SUBTITLE_FONT_FAMILIES = {
  system: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  sans: '"Avenir Next", Avenir, "Helvetica Neue", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Arial Rounded MT Bold", "SF Pro Rounded", -apple-system, sans-serif'
};

window.Bilayer ??= {};
window.Bilayer.createSubtitleOverlay = function createSubtitleOverlay() {
  const host = document.createElement("div");
  host.id = "bilayer-host";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    contain: "layout style paint"
  });
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host {
        all: initial;
      }

      .subtitle-stack {
        position: fixed;
        left: 50%;
        bottom: var(--subtitle-stack-bottom, 18vh);
        z-index: 2147483647;
        display: flex;
        width: 100%;
        flex-direction: column;
        align-items: center;
        gap: var(--subtitle-stack-gap, 8px);
        pointer-events: none;
        transform: translateX(-50%);
      }

      .subtitle {
        display: grid;
        width: 100%;
        gap: 4px;
        pointer-events: none;
        text-align: center;
      }

      .subtitle[hidden] {
        display: none;
      }

      .subtitle[data-role="primary"] {
        max-width: min(var(--primary-subtitle-max-width, 86vw), 1280px);
      }

      .subtitle[data-role="secondary"] {
        max-width: min(var(--secondary-subtitle-max-width, 86vw), 1280px);
      }

      :host([data-layout="free"]) .subtitle-stack {
        position: static;
        display: block;
        width: auto;
        transform: none;
      }

      :host([data-layout="free"]) .subtitle {
        position: fixed;
        left: 50%;
        z-index: 2147483647;
        transform: translateX(-50%);
      }

      :host([data-layout="free"]) .subtitle[data-role="primary"] {
        bottom: var(--primary-subtitle-offset, 26vh);
      }

      :host([data-layout="free"]) .subtitle[data-role="secondary"] {
        bottom: var(--secondary-subtitle-offset, 18vh);
      }

      :host([data-layout="free"]) .subtitle-notice {
        position: fixed;
        left: 50%;
        z-index: 2147483647;
        bottom: var(--notice-subtitle-offset, 12vh);
        transform: translateX(-50%);
      }

      .line {
        width: fit-content;
        max-width: 100%;
        margin-inline: auto;
        padding: 3px 10px 5px;
        overflow-wrap: anywhere;
        border-radius: 4px;
        white-space: pre-wrap;
      }

      .subtitle-notice {
        box-sizing: border-box;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        max-width: min(var(--notice-subtitle-max-width, 86vw), 1280px);
        margin-inline: auto;
        padding: 2px 12px 4px;
        overflow: hidden;
        overflow-wrap: anywhere;
        border: 1px solid rgba(255, 255, 255, 0.32);
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.62);
        color: rgba(255, 255, 255, 0.92);
        font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
        font-size: var(--notice-subtitle-size, 16px);
        font-weight: 600;
        line-height: 1.3;
        text-align: center;
        -webkit-text-stroke: 0.5px rgba(0, 0, 0, 0.72);
        paint-order: stroke fill;
        text-shadow: 0 2px 2px rgba(0, 0, 0, 0.72);
        pointer-events: none;
        user-select: none;
      }

      .subtitle-notice[hidden] {
        display: none;
      }

      .subtitle-notice[data-kind="warning"] {
        border-color: rgba(255, 176, 32, 0.9);
        background: rgba(52, 30, 0, 0.68);
        color: #ffd694;
      }

      .subtitle[data-role="primary"] .line {
        background: var(--primary-subtitle-background, rgba(0, 0, 0, 0.64));
        color: var(--primary-subtitle-color, #fff);
        font-family: var(--primary-subtitle-font-family, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif);
        font-size: var(--primary-subtitle-size, 26px);
        font-weight: var(--primary-subtitle-weight, 700);
        line-height: var(--primary-subtitle-line-height, 1.28);
        -webkit-text-stroke: var(--primary-subtitle-stroke-width, 1px) var(--primary-subtitle-stroke-color, #000);
        paint-order: stroke fill;
        text-shadow: 0 2px 2px rgba(0, 0, 0, 0.72);
      }

      .subtitle[data-role="secondary"] .line {
        background: var(--secondary-subtitle-background, rgba(0, 0, 0, 0.64));
        color: var(--secondary-subtitle-color, #fff);
        font-family: var(--secondary-subtitle-font-family, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif);
        font-size: var(--secondary-subtitle-size, 28px);
        font-weight: var(--secondary-subtitle-weight, 700);
        line-height: var(--secondary-subtitle-line-height, 1.28);
        -webkit-text-stroke: var(--secondary-subtitle-stroke-width, 1px) var(--secondary-subtitle-stroke-color, #000);
        paint-order: stroke fill;
        text-shadow: 0 2px 2px rgba(0, 0, 0, 0.72);
      }

      .line ruby {
        ruby-align: center;
        ruby-position: over;
      }

      .line rt {
        font-size: 0.52em;
        font-weight: 600;
        line-height: 1;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
        -webkit-text-stroke: 0;
        user-select: none;
      }

      .line.subtitle-placeholder {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.32em;
        min-width: 3.4em;
        min-height: 1em;
      }

      .line.subtitle-placeholder .subtitle-placeholder-dot {
        width: 0.3em;
        height: 0.3em;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.3;
        animation: bilayer-placeholder-pulse 1.1s ease-in-out infinite;
      }

      .line.subtitle-placeholder .subtitle-placeholder-dot:nth-child(2) {
        animation-delay: 0.16s;
      }

      .line.subtitle-placeholder .subtitle-placeholder-dot:nth-child(3) {
        animation-delay: 0.32s;
      }

      @keyframes bilayer-placeholder-pulse {
        0%, 100% {
          opacity: 0.3;
          transform: translateY(0);
        }
        50% {
          opacity: 1;
          transform: translateY(-0.08em);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .line.subtitle-placeholder .subtitle-placeholder-dot {
          animation: none;
          opacity: 0.75;
        }
      }
    </style>
    <div class="subtitle-stack">
      <div class="subtitle" data-role="primary" aria-live="off" hidden></div>
      <div class="subtitle" data-role="secondary" aria-live="off" hidden></div>
      <div class="subtitle-notice" data-notice aria-live="off" aria-hidden="true" hidden></div>
    </div>
  `;

  const primaryContainer = root.querySelector('[data-role="primary"]');
  const secondaryContainer = root.querySelector('[data-role="secondary"]');
  const noticeElement = root.querySelector("[data-notice]");
  const primaryState = createRoleState(primaryContainer);
  const secondaryState = createRoleState(secondaryContainer);

  return {
    applySettings(settings) {
      const layoutPreset = SUBTITLE_LAYOUT_PRESETS[settings.subtitleLayoutPreset]
        ?? SUBTITLE_LAYOUT_PRESETS.balanced;

      host.dataset.layout = settings.subtitleLayoutPreset === "free" ? "free" : "stacked";
      host.style.setProperty("--subtitle-stack-bottom", `${layoutPreset.bottom}vh`);
      host.style.setProperty("--subtitle-stack-gap", `${layoutPreset.gap}px`);
      host.style.setProperty("--primary-subtitle-offset", `${settings.primaryVerticalOffset}vh`);
      host.style.setProperty("--secondary-subtitle-offset", `${settings.secondaryVerticalOffset}vh`);
      applyRoleSettings(host, "primary", settings);
      applyRoleSettings(host, "secondary", settings);
      applyNoticeSettings(host, settings);
    },

    render({ primaryCues = [], secondaryCues = [], pending, notice = null } = {}) {
      ensureMounted(host);
      const pendingState = pending ?? {};
      syncRole(primaryState, primaryCues, pendingState.primary);
      syncRole(secondaryState, secondaryCues, pendingState.secondary);
      syncNotice(noticeElement, notice);
    },

    mount() {
      ensureMounted(host);
      if (host.__fullscreenInstalled) return;
      const install = window.Bilayer?.installFullscreenHostManagement;
      if (typeof install === "function") install(host);
    }
  };
};

const PLACEHOLDER_DELAY_MS = 200;

function createRoleState(container) {
  return {
    container,
    placeholder: createPlaceholderElement(),
    placeholderShown: false,
    waiting: false,
    timer: null,
    pending: false,
    hasCues: false
  };
}

function createPlaceholderElement() {
  const placeholder = document.createElement("div");
  placeholder.className = "line subtitle-placeholder";
  if (typeof placeholder.setAttribute === "function") {
    placeholder.setAttribute("aria-hidden", "true");
  }
  for (let index = 0; index < 3; index++) {
    const dot = document.createElement("span");
    dot.className = "subtitle-placeholder-dot";
    if (typeof placeholder.append === "function") placeholder.append(dot);
  }
  return placeholder;
}

function syncRole(state, cues, isPending) {
  const list = Array.isArray(cues) ? cues : [];
  state.pending = Boolean(isPending);
  state.hasCues = list.length > 0;

  if (state.hasCues || !state.pending) {
    cancelPlaceholderWait(state);
    hidePlaceholder(state);
    renderLines(state.container, list);
    return;
  }

  if (state.placeholderShown || state.waiting) return;

  if (state.container.hidden !== true) state.container.hidden = true;
  state.waiting = true;
  state.timer = schedulePlaceholderTimer(() => {
    state.waiting = false;
    state.timer = null;
    if (!state.pending || state.hasCues) return;
    showPlaceholder(state);
  }, PLACEHOLDER_DELAY_MS);
}

function showPlaceholder(state) {
  state.placeholderShown = true;
  state.container.replaceChildren(state.placeholder);
  state.container.hidden = false;
}

function hidePlaceholder(state) {
  if (!state.placeholderShown) return;
  state.placeholderShown = false;
  state.container.replaceChildren();
}

function cancelPlaceholderWait(state) {
  state.waiting = false;
  if (state.timer !== null) {
    cancelPlaceholderTimer(state.timer);
    state.timer = null;
  }
}

function schedulePlaceholderTimer(callback, delay) {
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    return window.setTimeout(callback, delay);
  }
  if (typeof setTimeout === "function") return setTimeout(callback, delay);
  callback();
  return null;
}

function cancelPlaceholderTimer(timerId) {
  if (timerId === null || timerId === undefined) return;
  if (typeof window !== "undefined" && typeof window.clearTimeout === "function") {
    window.clearTimeout(timerId);
    return;
  }
  if (typeof clearTimeout === "function") clearTimeout(timerId);
}

function applyRoleSettings(host, role, settings) {
  const key = (suffix) => `${role}${suffix}`;
  const textColor = colorWithOpacity(settings[key("TextColor")], settings[key("TextOpacity")]);
  const backgroundColor = colorWithOpacity(
    settings[key("BackgroundColor")],
    settings[key("BackgroundOpacity")]
  );
  const fontFamily = SUBTITLE_FONT_FAMILIES[settings[key("FontFamily")]]
    ?? SUBTITLE_FONT_FAMILIES.system;

  host.style.setProperty(`--${role}-subtitle-size`, `${settings[key("FontSize")]}px`);
  host.style.setProperty(`--${role}-subtitle-max-width`, `${settings[key("MaxWidth")]}vw`);
  host.style.setProperty(`--${role}-subtitle-color`, textColor);
  host.style.setProperty(`--${role}-subtitle-background`, backgroundColor);
  host.style.setProperty(`--${role}-subtitle-font-family`, fontFamily);
  host.style.setProperty(`--${role}-subtitle-weight`, settings[key("FontWeight")]);
  host.style.setProperty(`--${role}-subtitle-line-height`, settings[key("LineHeight")]);
  host.style.setProperty(`--${role}-subtitle-stroke-width`, `${settings[key("StrokeWidth")]}px`);
  host.style.setProperty(`--${role}-subtitle-stroke-color`, settings[key("StrokeColor")]);
}

/**
 * 提示条不是字幕角色，但必须与字幕同一视觉体系：字号取两行字幕较小者的一半左右（并夹在 11-20px），
 * 保证始终小于字幕；宽度沿用角色最大宽度中较宽的一侧；自由布局下贴在最下方字幕行之下。
 */
function applyNoticeSettings(host, settings) {
  const primarySize = Number(settings.primaryFontSize) || 26;
  const secondarySize = Number(settings.secondaryFontSize) || 28;
  const noticeSize = Math.max(11, Math.min(20, Math.round(Math.min(primarySize, secondarySize) * 0.6)));
  const noticeMaxWidth = Math.max(
    Number(settings.primaryMaxWidth) || 86,
    Number(settings.secondaryMaxWidth) || 86
  );
  const primaryOffset = Number(settings.primaryVerticalOffset) || 26;
  const secondaryOffset = Number(settings.secondaryVerticalOffset) || 18;

  host.style.setProperty("--notice-subtitle-size", `${noticeSize}px`);
  host.style.setProperty("--notice-subtitle-max-width", `${noticeMaxWidth}vw`);
  host.style.setProperty("--notice-subtitle-offset", `${Math.max(2, Math.min(primaryOffset, secondaryOffset) - 6)}vh`);
}

/**
 * 单一提示条节点，创建一次后只切换 hidden/文案/kind，重复相同帧与反复显隐都不产生 DOM churn。
 * 无 text（含 null/空串）即隐藏；kind 只区分 warning，其余一律 info。
 */
function syncNotice(element, notice) {
  if (!element) return;
  const text = typeof notice?.text === "string" ? notice.text : "";
  if (text.length === 0) {
    if (element.hidden !== true) element.hidden = true;
    return;
  }
  const kind = notice?.kind === "warning" ? "warning" : "info";
  if (element.dataset.kind !== kind) element.dataset.kind = kind;
  if (element.textContent !== text) element.textContent = text;
  if (element.hidden !== false) element.hidden = false;
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

function ensureMounted(host) {
  if (host.isConnected) return;
  const target = window.Bilayer?.pickMountTarget?.() ?? document.documentElement;
  if (target) target.append(host);
}

function renderLines(container, cues) {
  const children = container.children;
  let changed = children.length !== cues.length;
  if (!changed) {
    for (let index = 0; index < cues.length; index++) {
      const cue = cues[index];
      const expected = (typeof cue === "object" && cue?.readings)
        ? JSON.stringify({ text: cue.text, readings: cue.readings })
        : (cue?.ruby || cue?.text || cue);
      const current = children[index].__rawText ?? children[index].textContent;
      if (current !== expected) {
        changed = true;
        break;
      }
    }
  }
  if (changed) container.replaceChildren(...cues.map((cue) => createLine(cue)));
  if (container.hidden !== (cues.length === 0)) container.hidden = cues.length === 0;
}

function createLine(cue) {
  const text = typeof cue === "string" ? cue : cue?.text ?? "";
  const readings = typeof cue === "object" ? cue?.readings : null;
  const ruby = typeof cue === "object" ? cue?.ruby : "";
  const line = document.createElement("div");
  line.className = "line";

  if (readings && typeof readings === "object" && Object.keys(readings).length > 0) {
    line.__rawText = JSON.stringify({ text, readings });
    renderReadingsTo(line, text, readings);
  } else if (ruby && typeof ruby === "string") {
    line.__rawText = ruby;
    renderRubyText(line, ruby);
  } else {
    line.__rawText = text;
    line.textContent = text;
  }
  return line;
}

function renderReadingsTo(container, text, readings) {
  const tokens = createRubyTokens(text, readings);
  for (const token of tokens) {
    if (token.type === "ruby") {
      const rubyEl = document.createElement("ruby");
      appendSafeText(rubyEl, token.kanji);
      const rtEl = document.createElement("rt");
      rtEl.textContent = token.kana;
      appendChildNode(rubyEl, rtEl);
      appendChildNode(container, rubyEl);
    } else {
      appendSafeText(container, token.value);
    }
  }
}

function createRubyTokens(text, readings) {
  if (!text) return [];
  if (!readings || typeof readings !== "object" || Object.keys(readings).length === 0) {
    return [{ type: "text", value: text }];
  }

  const validEntries = Object.entries(readings)
    .filter(([kanji, kana]) => kanji && kana && typeof kanji === "string" && typeof kana === "string" && text.includes(kanji))
    .sort((a, b) => b[0].length - a[0].length);

  if (validEntries.length === 0) return [{ type: "text", value: text }];

  const pattern = new RegExp(validEntries.map(([k]) => escapeRegex(k)).join("|"), "g");
  const tokens = [];
  let lastIndex = 0;
  let match;
  const readingMap = new Map(validEntries);

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    const kanji = match[0];
    const kana = readingMap.get(kanji);
    tokens.push({ type: "ruby", kanji, kana });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: "text", value: text.slice(lastIndex) });
  }

  return tokens;
}

function escapeRegex(str) {
  return String(str ?? "").replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
}

function renderRubyText(container, rawText) {
  let text = rawText.replace(/<ruby>\s*([^<]+?)\s*<rt>\s*([^<]+?)\s*<\/rt>\s*<\/ruby>/gi, "{$1|$2}");
  text = text.replace(/\{([一-龯々〆ヵヶ]+)[(（]([ぁ-ん]+)[)）]\}/g, "{$1|$2}");
  text = text.replace(/\{([^|{}]+)\|([^|{}]*[一-龯々〆ヵヶ][^|{}]*)\}/g, "$1$2");
  text = text.replace(/\{([^{}|]+)\}/g, "$1");
  const rubyPattern = /\{([^|{}]+)\|([^|{}]+)\}/g;
  let lastIndex = 0;
  let match;
  while ((match = rubyPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      appendSafeText(container, text.slice(lastIndex, match.index));
    }
    const rubyEl = document.createElement("ruby");
    appendSafeText(rubyEl, match[1]);
    const rtEl = document.createElement("rt");
    rtEl.textContent = match[2];
    appendChildNode(rubyEl, rtEl);
    appendChildNode(container, rubyEl);
    lastIndex = rubyPattern.lastIndex;
  }

  if (lastIndex < text.length) {
    appendSafeText(container, text.slice(lastIndex));
  }
}

function appendSafeText(container, string) {
  if (!string) return;
  if (typeof document.createTextNode === "function") {
    appendChildNode(container, document.createTextNode(string));
  } else {
    appendChildNode(container, string);
  }
}

function appendChildNode(container, nodeOrText) {
  if (typeof container.append === "function") {
    container.append(nodeOrText);
  } else if (typeof container.appendChild === "function" && typeof nodeOrText === "object" && nodeOrText !== null) {
    container.appendChild(nodeOrText);
  } else if (typeof nodeOrText === "string") {
    container.textContent = (container.textContent ?? "") + nodeOrText;
  }
}
