/**
 * [INPUT]: 依赖 browser/chrome runtime.i18n API 与扩展页 DOM 上的 data-i18n / data-i18n-placeholder / data-i18n-title / data-i18n-aria-label 属性
 * [OUTPUT]: 暴露 globalThis.i18n.t(key, substitutions) 与 globalThis.i18n.apply(root)，按浏览器语言解析 _locales 文案，并把 document.documentElement.lang 同步为 runtime.i18n.getUILanguage()
 * [POS]: extension 扩展页共享的国际化薄封装，由 popup/onboarding/diagnostics 以 classic script 前置加载；content/page 不加载
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
(function () {
  const runtime = globalThis.browser ?? globalThis.chrome;

  function uiLanguage() {
    try {
      const language = runtime?.i18n?.getUILanguage?.();
      return typeof language === "string" && language ? language : "en";
    } catch {
      return "en";
    }
  }

  function t(key, substitutions) {
    let message = "";
    try {
      message = runtime?.i18n?.getMessage?.(key) ?? "";
    } catch {
      message = "";
    }
    if (!message) return key;

    const args = substitutions == null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
    if (!args.length) return message;

    return message.replace(/\$(\d)/g, (match, index) => {
      const value = args[Number(index) - 1];
      return value === undefined ? match : String(value);
    });
  }

  function apply(root) {
    const scope = root ?? (typeof document !== "undefined" ? document : null);
    if (!scope?.querySelectorAll) return;

    const assign = (selector, attribute, setter) => {
      for (const element of scope.querySelectorAll(selector)) {
        const key = element.getAttribute(attribute);
        if (key) setter(element, t(key));
      }
    };

    assign("[data-i18n]", "data-i18n", (element, value) => { element.textContent = value; });
    assign("[data-i18n-placeholder]", "data-i18n-placeholder", (element, value) => { element.setAttribute("placeholder", value); });
    assign("[data-i18n-title]", "data-i18n-title", (element, value) => { element.setAttribute("title", value); });
    assign("[data-i18n-aria-label]", "data-i18n-aria-label", (element, value) => { element.setAttribute("aria-label", value); });
  }

  globalThis.i18n = { t, apply, uiLanguage };

  if (typeof document !== "undefined") {
    if (document.documentElement) document.documentElement.lang = uiLanguage();
    apply(document);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => apply(document));
    }
  }
})();
