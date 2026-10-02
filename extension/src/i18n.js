/**
 * [INPUT]: 依赖 browser/chrome runtime.i18n（浏览器语言与默认文案）、runtime.storage.local 的 uiLanguage 偏好、runtime.getURL("_locales/<code>/messages.json") 指向的包内文案（同步 XHR 读取），DOM 上依赖 data-i18n / data-i18n-placeholder / data-i18n-title / data-i18n-aria-label / data-i18n-language
 * [OUTPUT]: 暴露 globalThis.i18n 的冻结 API：t(key, substitutions)、apply(root)、uiLanguage()、availableLanguages=["auto","en","zh_CN"]、setLanguage(code)、mountLanguageSwitcher()；auto 走 runtime.i18n.getMessage（substitutions 一并下传，参数补齐到 $1…$9），具体语言从 _locales JSON 同步解析后本地替换
 * [POS]: extension 扩展页共享的国际化薄封装，由 settings/onboarding/diagnostics 以 classic script 前置加载；content/page 不加载。存储本地化的唯一入口，页面脚本不得自行读取 uiLanguage 或直接调用 runtime.i18n.getMessage
 * [CONTRACT]:
 *   偏好键: runtime.storage.local["uiLanguage"]，取值 "auto"（默认，等价改造前的浏览器语言行为）| "en" | "zh_CN"；
 *   非 auto 时 i18n.t() 从 _locales/<code>/messages.json 同步解析，缺失/损坏时退化为 getMessage，再退化为 key 本身。
 *   占位符语义两态一致：$1…$n 按调用方传入的顺序替换；未提供的参数保留原占位符（auto 侧靠把缺位填成字面 $n 再交给
 *   getMessage 实现——浏览器会把没传参数的 $n 抹成空串，因此绝不能只传调用方原样的数组）；替换只扫一遍报文，
 *   参数值本身不会被二次展开。绝不抛错，也不返回半句话。
 *   uiLanguage() 返回包码（"zh_CN"），documentElement.lang 写合法 BCP-47 标签（"zh-CN"）。
 *   标记契约: 页面只需 <select data-i18n-language>（内部留空，含 aria-label 时用 data-i18n-aria-label），
 *   选项由 mountLanguageSwitcher() 依据 availableLanguages 生成并在脚本载入时自动挂载（DOM 未就绪则等 DOMContentLoaded），
 *   选中项来自已存偏好，change 事件调用 setLanguage()；挂载幂等，无需任何页面侧 JS。
 *   语言切换会 location.reload()，使页面脚本在顶层求值的动态文案（如预设表）按新语言重建。
 *   同步视图: 权威值在 runtime.storage.local["uiLanguage"]，localStorage["bilayer.uiLanguage"] 只是同一值的同步镜像，
 *   因为真实浏览器的存储回调是异步任务，而页面脚本在顶层求值时就调用 i18n.t()；镜像与存储真值不一致时按真值纠正，
 *   并且每会话最多重载一次（sessionStorage 标记）以让脚本内建字符串整体重建。
 *   同步 XHR 被平台拒绝时，同一包内文件改由异步 fetch 补取：成功则替换缓存中的 null 并走同一个一次性重载闸门，
 *   失败则静默保持 getMessage 降级（不写存储、不重载、不报错）；auto 永不加载包。闸门已用尽时异步补取只纠正
 *   DOM 文案，脚本在解析期内建的字符串留待下次载入——同步读取被永久拒绝时它们无法在本轮重建。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
(function () {
  const runtime = globalThis.browser ?? globalThis.chrome;

  const PREFERENCE_KEY = "uiLanguage";
  const AUTO = "auto";
  const FALLBACK_LOCALE = "en";
  // 包内实际存在的 _locales 目录名；auto 之外的可选语言即这些码，新增目录必须同步这里与 availableLanguages
  const BUNDLED_LOCALES = ["en", "zh_CN"];
  const AVAILABLE_LANGUAGES = Object.freeze([AUTO, ...BUNDLED_LOCALES]);
  const OPTION_KEYS = { auto: "uiLanguageAuto", en: "uiLanguageEn", zh_CN: "uiLanguageZhCn" };
  // 同步偏好缓存：真实浏览器里 storage 回调是异步任务，而扩展页脚本在顶层求值时就调用 i18n.t()
  // （settings/onboarding 的预设表），故需要一份解析期可同步读取的镜像。权威事实始终是
  // runtime.storage.local.uiLanguage，镜像只是同一值的同步视图，setLanguage 两者同写。
  const CACHE_KEY = "bilayer.uiLanguage";
  const RELOAD_FLAG = "bilayer.uiLanguage.reloaded";

  const bundles = new Map();
  const bundleRequests = new Set();
  const mountedSwitches = [];
  let preference = AUTO;
  let userSelected = false;
  let reloading = false;

  function normalizePreference(value) {
    const code = typeof value === "string" ? value.trim() : "";
    return AVAILABLE_LANGUAGES.includes(code) ? code : AUTO;
  }

  // "zh-CN"/"zh_CN" 精确命中 zh_CN 包；"zh-Hans-CN"/"zh-TW" 按语言前缀命中；"de-DE" 落回 en
  function normalizeLocale(code) {
    const raw = typeof code === "string" ? code.trim().replace(/_/g, "-").toLowerCase() : "";
    if (!raw) return FALLBACK_LOCALE;

    for (const locale of BUNDLED_LOCALES) {
      if (locale.replace(/_/g, "-").toLowerCase() === raw) return locale;
    }

    const language = raw.split("-")[0];
    for (const locale of BUNDLED_LOCALES) {
      if (locale.split("_")[0].toLowerCase() === language) return locale;
    }

    return FALLBACK_LOCALE;
  }

  function browserLanguage() {
    try {
      const language = runtime?.i18n?.getUILanguage?.();
      return typeof language === "string" && language ? language : FALLBACK_LOCALE;
    } catch {
      return FALLBACK_LOCALE;
    }
  }

  // auto 路径必须把 substitutions 一并交给浏览器：getMessage(key) 会把 $1…$9 当成“未提供的参数”抹成空串，
  // 那样 31 个带占位符的键在默认 auto 下全是半句话（本模块原先的缺陷）。
  function fromBrowser(key, substitutions) {
    try {
      return runtime?.i18n?.getMessage?.(key, substitutions) ?? "";
    } catch {
      return "";
    }
  }

  // 交给浏览器的参数补齐到 $1…$9：缺位填成它自己的字面占位符，浏览器一次性替换后原位留下 $n，
  // 于是 auto 与包内两条路径的替换语义完全一致（未提供的参数保留原占位符，绝不被静默抹掉）。
  // 浏览器替换只扫一遍报文，不会二次展开参数值本身。
  function browserArguments(args) {
    return Array.from({ length: 9 }, (unused, index) => {
      const value = args[index];
      return value === undefined ? `$${index + 1}` : String(value);
    });
  }

  // 包内路径的本地替换：与 browserArguments 同一语义（未提供即保留 $n），键名/文案不改。
  function substitute(message, args) {
    if (!args.length) return message;
    return message.replace(/\$(\d)/g, (match, index) => {
      const value = args[Number(index) - 1];
      return value === undefined ? match : String(value);
    });
  }

  function bundleUrl(locale) {
    try {
      return runtime?.runtime?.getURL?.(`_locales/${locale}/messages.json`) ?? "";
    } catch {
      return "";
    }
  }

  function parseBundle(text) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function loadBundleSync(locale) {
    try {
      const url = bundleUrl(locale);
      if (!url || typeof XMLHttpRequest !== "function") return null;
      const request = new XMLHttpRequest();
      // 同步读取扩展包内文件：页面脚本在顶层求值时就要拿到文案，不允许异步初始化
      request.open("GET", url, false);
      request.send(null);
      const status = Number(request.status);
      // 扩展页同步 XHR 的状态码可能是 200 或 0（file:// 语义），两者都按成功处理
      if (status !== 0 && (status < 200 || status >= 300)) return null;
      return parseBundle(request.responseText);
    } catch {
      return null;
    }
  }

  // 同步 XHR 是解析期唯一可用的读取方式，但平台可能拒绝同步请求。此时异步补取同一个包内文件：
  // 成功则替换缓存中的 null 并重载一次，让页面脚本内建的字符串按目标语言重建；失败则静默保持
  // getMessage 降级行为（不写存储、不重载、不报错）。auto 永不加载包，因此不受影响。
  function loadBundleAsync(locale) {
    if (bundleRequests.has(locale) || typeof fetch !== "function") return;
    const url = bundleUrl(locale);
    if (!url) return;
    bundleRequests.add(locale);

    fetch(url)
      .then((response) => (response?.ok ? response.text() : ""))
      .then((text) => {
        const bundle = parseBundle(text);
        if (!bundle || preference !== locale) return;
        bundles.set(locale, bundle);
        syncDocument();
        reloadOnce();
      })
      .catch(() => {});
  }

  function messages(locale) {
    if (bundles.has(locale)) return bundles.get(locale);

    const bundle = loadBundleSync(locale);
    bundles.set(locale, bundle);
    if (!bundle) loadBundleAsync(locale);
    return bundle;
  }

  function fromBundle(bundle, key) {
    const entry = bundle?.[key];
    const message = typeof entry === "string" ? entry : entry?.message;
    return typeof message === "string" && message ? message : "";
  }

  function t(key, substitutions) {
    const args = substitutions == null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];

    // auto 只走浏览器报文，绝不加载包内文件；显式语言先取包内报文，缺失才回落 getMessage
    const bundled = preference === AUTO ? "" : fromBundle(messages(preference), key);
    if (bundled) return substitute(bundled, args);

    return fromBrowser(key, browserArguments(args)) || key;
  }

  function uiLanguage() {
    const language = preference === AUTO ? normalizeLocale(browserLanguage()) : preference;
    // uiLanguage() 返回包码（zh_CN，调用方按它匹配）；documentElement.lang 必须是合法 BCP-47 标签
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = language.replace(/_/g, "-");
    }
    return language;
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

  function readCache() {
    try {
      const cached = globalThis.localStorage?.getItem(CACHE_KEY);
      return AVAILABLE_LANGUAGES.includes(cached) ? cached : null;
    } catch {
      return null;
    }
  }

  function writeCache(value) {
    try {
      globalThis.localStorage?.setItem(CACHE_KEY, value);
    } catch {
      // 同步缓存不可用时退化为仅 storage.local；解析期语言回落到浏览器语言，界面在异步真值到达后纠正
    }
  }

  function reloadPage() {
    if (reloading) return;
    reloading = true;
    if (typeof location !== "undefined" && typeof location.reload === "function") location.reload();
  }

  // 补偿性重载的唯一闸门：镜像纠正与异步补取共用同一 sessionStorage 标记，每会话最多重载一次，
  // 因此同步路径、镜像路径与异步路径不可能叠加成重载循环。
  // 会话存储不可用或被静默丢弃时一律不重载——标记写不进去就等于闸门失效，绝不能放行。
  function reloadOnce() {
    try {
      const store = globalThis.sessionStorage;
      if (!store) return false;
      if (store.getItem(RELOAD_FLAG) === "1") return false;
      store.setItem(RELOAD_FLAG, "1");
      if (store.getItem(RELOAD_FLAG) !== "1") return false;
    } catch {
      return false;
    }
    reloadPage();
    return true;
  }

  function syncDocument() {
    if (typeof document === "undefined") return;
    uiLanguage();
    apply(document);
    for (const select of mountedSwitches) select.value = preference;
  }

  // 同步缓存与权威值不一致时（存储被清空或他页改写）：先按真值纠正文档，
  // 再重载一次，让页面脚本在解析期按缓存语言生成的字符串整体重建为真值语言。
  function correctToStoredPreference(next) {
    if (userSelected || next === preference) return;
    preference = next;
    writeCache(next);
    syncDocument();
    reloadOnce();
  }

  // 存储回调可能在同一个 tick 内同步返回（测试与部分实现），也可能在真实浏览器里异步到达；
  // 异步真值到达后由 correctToStoredPreference 收敛。
  function readStoredPreference() {
    let initializing = true;
    let answered = false;
    let value = AUTO;

    const accept = (result) => {
      if (!result || typeof result !== "object") return;
      const next = normalizePreference(result[PREFERENCE_KEY]);
      if (initializing) {
        answered = true;
        value = next;
        return;
      }
      correctToStoredPreference(next);
    };

    let request;
    try {
      request = runtime?.storage?.local?.get?.({ [PREFERENCE_KEY]: AUTO }, accept) ?? undefined;
    } catch {
      request = undefined;
    }
    initializing = false;

    if (answered) {
      preference = value;
      return;
    }

    const cached = readCache();
    if (cached !== null) preference = cached;
    if (request && typeof request.then === "function") request.then(accept, () => {});
  }

  function setLanguage(code) {
    const next = typeof code === "string" ? code.trim() : "";
    if (!AVAILABLE_LANGUAGES.includes(next)) return false;

    userSelected = true;
    preference = next;
    writeCache(next);

    try {
      const request = runtime?.storage?.local?.set?.({ [PREFERENCE_KEY]: next }, reloadPage);
      if (request && typeof request.then === "function") request.then(reloadPage, reloadPage);
    } catch {
      reloadPage();
    }

    return true;
  }

  function mountLanguageSwitcher() {
    if (typeof document === "undefined" || !document.querySelectorAll) return;

    for (const select of document.querySelectorAll("[data-i18n-language]")) {
      if (String(select?.tagName ?? "").toLowerCase() !== "select") continue;
      if (mountedSwitches.includes(select)) continue;
      mountedSwitches.push(select);

      select.textContent = "";
      for (const code of AVAILABLE_LANGUAGES) {
        const option = document.createElement("option");
        option.value = code;
        option.textContent = t(OPTION_KEYS[code]);
        select.appendChild(option);
      }
      select.value = preference;
      select.addEventListener("change", () => { setLanguage(select.value); });
    }
  }

  globalThis.i18n = {
    t,
    apply,
    uiLanguage,
    availableLanguages: AVAILABLE_LANGUAGES,
    setLanguage,
    mountLanguageSwitcher
  };

  readStoredPreference();

  if (typeof document !== "undefined") {
    uiLanguage();
    apply(document);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        mountLanguageSwitcher();
        apply(document);
      });
    } else {
      mountLanguageSwitcher();
    }
  }
})();
