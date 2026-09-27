/**
 * [INPUT]: 依赖 DOM/Shadow DOM 渲染能力、字幕样式设置与 subtitleParser 输出的 cue 数组（支持带 ruby 的日文注音）、fullscreenMount 的挂载点选择
 * [OUTPUT]: 对 window.NetflixDualSubtitles 提供双字幕布局与独立视觉样式；逐帧复用未变化的字幕节点（包含 ruby 标记）、渲染假名注音并通过 mount() 接入全屏挂载
 * [POS]: content 的显示层，被 content.js 按播放时间驱动；mount() 由 fullscreenMount 接管挂载点
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

window.NetflixDualSubtitles ??= {};
window.NetflixDualSubtitles.createSubtitleOverlay = function createSubtitleOverlay() {
  const host = document.createElement("div");
  host.id = "netflix-dual-subtitles-host";
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

      .line {
        width: fit-content;
        max-width: 100%;
        margin-inline: auto;
        padding: 3px 10px 5px;
        overflow-wrap: anywhere;
        border-radius: 4px;
        white-space: pre-wrap;
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
    </style>
    <div class="subtitle-stack">
      <div class="subtitle" data-role="primary" aria-live="off" hidden></div>
      <div class="subtitle" data-role="secondary" aria-live="off" hidden></div>
    </div>
  `;

  const primaryContainer = root.querySelector('[data-role="primary"]');
  const secondaryContainer = root.querySelector('[data-role="secondary"]');

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
    },

    render({ primaryCues = [], secondaryCues = [] } = {}) {
      ensureMounted(host);
      renderLines(primaryContainer, primaryCues);
      renderLines(secondaryContainer, secondaryCues);
    },

    mount() {
      ensureMounted(host);
      if (host.__fullscreenInstalled) return;
      const install = window.NetflixDualSubtitles?.installFullscreenHostManagement;
      if (typeof install === "function") install(host);
    }
  };
};

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
  const target = window.NetflixDualSubtitles?.pickMountTarget?.() ?? document.documentElement;
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
