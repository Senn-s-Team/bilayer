/**
 * [INPUT]: cue timeline, injected translation request and optional occurrence-cache hooks (register/restore/generation/clear); usage sync remains owned by content
 * [OUTPUT]: window.Bilayer.createTranslationScheduler; restores accepted cache before selecting misses, keeps cache hits outside request/character budgets, dispatches contiguous miss runs in prefer mode, and forbids network requests in only mode
 * [POS]: content 纯调度层；恢复和提交受世代隔离，存储失败保留成功正文并显式报告，空读音不作为汉字注音完成证据
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
window.Bilayer ??= {};
window.Bilayer.createTranslationScheduler = function createTranslationScheduler({ translate, onUpdate, syncUsage = null, restoreCache = null, registerCacheSource = null, translationCache = null, onAccepted = null }) {
  // 与 content 的 DEFAULT_SETTINGS 一致：未调用 setBudget 时保持既有 80/40000 行为。
  const DEFAULT_REQUEST_LIMIT = 80;
  const DEFAULT_CHARACTER_LIMIT = 40000;
  const MAX_BATCH_ITEMS = 12;
  const MAX_BATCH_CHARACTERS = 600;
  let cues = [];
  let groups = [];
  // 字幕 id -> 所属分组：pendingRoles 每帧按活跃行查等待状态，避免线性扫描分组表。
  let groupIds = new Map();
  let identity = "";
  let budgetKey = "";
  // AI 翻译占用的字幕行角色（primary/secondary），由 content 注入，仅用于报告等待占位。
  let aiRole = "";
  let sourceLanguage = "";
  let targetLanguage = "";
  let semanticIntent = "default-v1";
  let sourceEpisodeId = "";
  let sourceTrackKind = "unknown";
  let sourceSubtitleEpoch = 0;
  let generation = 0;
  let requests = 0;
  let sentCharacters = 0;
  let requestLimit = DEFAULT_REQUEST_LIMIT;
  let characterLimit = DEFAULT_CHARACTER_LIMIT;
  // 派发闸门与单飞：syncUsage 注入后派发要跨 await，重入的 observe 只排队一次，避免同批重复计费。
  const usageSync = typeof syncUsage === "function" ? syncUsage : null;
  let pumping = false;
  let pumpQueued = false;
  // 最近一次被预算挡下的原因（含“本批次放不下”的字符前瞻判定）；setSource（换源/换邻句）与上限变化会重算，
  // clear() 不清算已用额度也不清掉这个原因：设置变更发生在同一计量窗口内，守住的是按窗口计的 runaway 成本。
  let budgetStop = null;
  let inFlight = 0;
  let positionMs = 0;
  let leadMs = 60000;
  let prefetchCount = 10;
  let contextCount = 2;
  let japaneseRuby = true;
  let urgentSeek = false;
  let hasObserved = false;
  let failure = "";
  let translations = new Map();
  let readingsMap = new Map();
  let rubies = new Map();
  let cueIds = new WeakMap();
  let pending = new Set();
  let failed = new Set();
  let logs = [];
  let cacheToken = 0;
  let cacheSourceId = "";
  let cachePolicy = "prefer";
  let cacheMode = "session";
  let restorePending = false;
  let bypassRestoreOnce = false;
  let cacheStats = { hits: 0, subtitleCount: 0, annotationMissing: 0, storageError: null, restorePending: false };

  function addLog(event, message, details = {}) {
    logs.push({ at: Date.now(), event, message, ...details });
  }

  const notify = () => onUpdate?.(status());

  // null 表示不限；0 不在 setBudget 里代表不限（0 由 content 从设置转换为 null），非正整数视为无效并保留当前值。
  const normalizeLimit = (value, current) => {
    if (value === null) return null;
    if (Number.isInteger(value) && value > 0) return value;
    return current;
  };

  // 已消耗量本身是否已经顶到上限：降额到已消耗量以下时无需等到下一次派发即可上报原因。
  function exhaustedNow() {
    if (requestLimit !== null && requests >= requestLimit) return "requests";
    if (characterLimit !== null && sentCharacters >= characterLimit) return "characters";
    return null;
  }

  const normalizeCounter = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

  function budgetState() {
    return {
      requestsUsed: requests,
      charactersUsed: sentCharacters,
      requestLimit,
      characterLimit,
      exhausted: budgetStop ?? exhaustedNow()
    };
  }

  // 外部（content 的持久化存储与其它标签页）看到的用量视图。窗口不同则换锚并按该视图重新起算；
  // 窗口相同则逐项取较大值——两个标签页各自只记自己的消耗，取大值即并集，避免上限被翻倍。
  function setUsage(windowKey, usage) {
    if (!windowKey || typeof windowKey !== "string") return;
    const nextRequests = normalizeCounter(usage?.requests);
    const nextCharacters = normalizeCounter(usage?.characters);
    if (windowKey !== budgetKey) {
      budgetKey = windowKey;
      requests = nextRequests;
      sentCharacters = nextCharacters;
      budgetStop = null;
      if (failure === "budget_exceeded" && exhaustedNow() === null) failure = "";
      notify();
      return;
    }
    if (nextRequests <= requests && nextCharacters <= sentCharacters) return;
    requests = Math.max(requests, nextRequests);
    sentCharacters = Math.max(sentCharacters, nextCharacters);
    // 另一标签页把用量推到上限后不必等到下一次派发才撤销预算错误。
    if (failure === "budget_exceeded" && exhaustedNow() === null) failure = "";
    notify();
  }

  function setBudget(next = {}) {
    const nextRequestLimit = normalizeLimit(next.requestLimit, requestLimit);
    const nextCharacterLimit = normalizeLimit(next.characterLimit, characterLimit);
    if (nextRequestLimit === requestLimit && nextCharacterLimit === characterLimit) return;
    requestLimit = nextRequestLimit;
    characterLimit = nextCharacterLimit;
    budgetStop = null;
    // 提额且已不再顶格时必须撤掉预算错误，否则调度恢复但状态仍停在 error。
    if (failure === "budget_exceeded" && exhaustedNow() === null) failure = "";
    notify();
  }

  function status() {
    return { phase: !identity ? "off" : failure ? "error" : inFlight ? "translating" : translations.size ? "ready" : "waiting",
      count: translations.size, error: failure, requests, sentCharacters, budget: budgetState(), budgetKey,
      logs: logs.map((entry) => ({ ...entry })), translationCache: { ...cacheStats, sourceId: cacheSourceId, mode: cacheMode, policy: cachePolicy, restorePending } };
  }

  function setSource(source) {
    prefetchCount = Number.isInteger(source.prefetchCount) && source.prefetchCount >= 0 && source.prefetchCount <= 50
      ? source.prefetchCount : 10;
    contextCount = Number.isInteger(source.contextCount) && source.contextCount >= 0 && source.contextCount <= 4
      ? source.contextCount : 2;
    const nextJapaneseRuby = source.japaneseRuby !== false;
    const rubyChanged = japaneseRuby !== nextJapaneseRuby;
    japaneseRuby = nextJapaneseRuby;
    aiRole = source.role === "primary" || source.role === "secondary" ? source.role : "";
    const skipRestore = bypassRestoreOnce;
    bypassRestoreOnce = false;
    if (source.identity === identity && source.cues === cues) {
      const nextPolicy = source.cachePolicy === "only" ? "only" : "prefer";
      const policyChanged = nextPolicy !== cachePolicy;
      if (failure === "invalid_response" && !policyChanged && !rubyChanged && !skipRestore) { notify(); return; }
      if (failure !== "invalid_response" || policyChanged || rubyChanged || skipRestore) { failed.clear(); failure = ""; }
      if (policyChanged || rubyChanged || skipRestore) {
        cacheToken++;
        cachePolicy = nextPolicy;
        if (skipRestore) { failed.clear(); failure = ""; restorePending = false; notify(); if (hasObserved) pump(); return; }
        const token = cacheToken;
        const annotationRequired = japaneseRuby && (isJp(sourceLanguage) || isJp(targetLanguage));
        const annotationSide = isJp(targetLanguage) ? "target" : "source";
        restorePending = true;
        void Promise.resolve().then(() => restoreCache?.({ ...source, sourceId: cacheSourceId, annotationRequired, annotationSide }))
          .then((restored) => {
            if (token !== cacheToken) return;
            cacheStats = { ...cacheStats, annotationMissing: restored?.annotationMissing ?? 0 };
            for (const [index, entry] of restored?.accepted ?? []) {
              const id = String(index);
              translations.set(id, entry.text);
              if (entry.readings) readingsMap.set(id, entry.readings);
              if (entry.ruby) rubies.set(id, entry.ruby);
            }
            restorePending = false; notify(); if (hasObserved) pump();
          }).catch((error) => {
            if (token !== cacheToken) return;
            cacheStats = { ...cacheStats, storageError: String(error?.message ?? error) };
            restorePending = false; notify(); if (hasObserved) pump();
          });
      } else if (cachePolicy === "only" && !restorePending) pump();
      return;
    }
    const cancelledRequests = inFlight;
    if (source.budgetKey !== budgetKey) {
      logs = [];
      budgetKey = source.budgetKey;
      requests = 0;
      sentCharacters = 0;
    }
    budgetStop = null;
    translations = new Map(); readingsMap = new Map(); rubies = new Map();
    pending.clear(); failed.clear(); inFlight = 0; failure = ""; urgentSeek = false;
    bypassRestoreOnce = false;
    generation++;
    sourceSubtitleEpoch = source.subtitleEpoch ?? 0;
    identity = source.identity;
    cues = source.cues;
    sourceLanguage = source.sourceLanguage;
    sourceEpisodeId = source.episodeId ?? "";
    cueIds = new WeakMap(cues.map((cue, index) => [cue, String(index)]));
    targetLanguage = source.targetLanguage;
    semanticIntent = source.semanticIntent ?? "default-v1";
    sourceTrackKind = source.trackKind ?? source.type ?? source.kind ?? "unknown";
    cacheMode = source.cacheMode === "local" ? "local" : "session";
    cachePolicy = source.cachePolicy === "only" ? "only" : "prefer";
    groups = buildGroups(cues);
    groupIds = new Map(groups.flatMap((group) => group.ids.map((id) => [id, group])));
    cacheStats = { hits: 0, subtitleCount: cues.length, annotationMissing: 0, storageError: null };
    addLog("source_changed", "翻译来源已切换", { cancelledRequests });
    addLog("source_ready", "字幕翻译源已准备", { cueCount: cues.length, sourceLanguage, targetLanguage });
    const token = ++cacheToken, sourceGeneration = generation;
    cacheSourceId = translationCache?.sourceId?.({ ...source, cues }) ?? "";
    restorePending = true;
    void Promise.resolve().then(() => registerCacheSource?.({ ...source, cues }) ?? ({ sourceId: translationCache?.sourceId?.({ ...source, cues }) ?? "" })).then(async (registered) => {
      if (token !== cacheToken || sourceGeneration !== generation) return;
      cacheSourceId = registered?.sourceId ?? "";
      const annotationRequired = japaneseRuby && (isJp(sourceLanguage) || isJp(targetLanguage));
      const annotationSide = isJp(targetLanguage) ? "target" : "source";
      const restored = skipRestore ? { accepted: new Map(), annotationMissing: 0 }
        : await restoreCache?.({ ...source, sourceId: cacheSourceId, annotationRequired, annotationSide })
          ?? { accepted: new Map(), annotationMissing: 0 };
      if (token !== cacheToken || sourceGeneration !== generation) return;
      for (const [index, entry] of restored.accepted ?? []) {
        const id = String(index);
        if (!translations.has(id)) translations.set(id, entry.text);
        if (translations.get(id) !== entry.text) continue;
        if (entry.readings) readingsMap.set(id, entry.readings);
        if (entry.ruby) rubies.set(id, entry.ruby);
      }
      cacheStats = { ...cacheStats, hits: translations.size, subtitleCount: cues.length,
        annotationMissing: restored.annotationMissing ?? 0, storageError: restored.storageError ?? null };
      restorePending = false; notify(); if (hasObserved) pump();
    }).catch((error) => {
      if (token !== cacheToken || sourceGeneration !== generation) return;
      cacheStats = { ...cacheStats, storageError: String(error?.message ?? error) };
      restorePending = false; notify(); if (hasObserved) pump();
    });
    notify();
  }

  function clear({ clearCache = false } = {}) {
    if (clearCache) translationCache?.clear?.(sourceEpisodeId);
    generation++;
    cacheToken++;
    identity = "";
    cues = [];
    groups = [];
    groupIds = new Map();
    japaneseRuby = true;
    cueIds = new WeakMap();
    translations.clear(); readingsMap.clear(); rubies.clear(); failed.clear(); pending.clear();
    inFlight = 0; failure = ""; logs = []; restorePending = false;
    cacheSourceId = "";
    cacheStats = { hits: 0, subtitleCount: 0, annotationMissing: 0, storageError: null, restorePending: false };
    notify();
  }

  function observe(timeMs, rate = 1, seek = false) {
    if (!identity || groups.length === 0) return;
    hasObserved = true;
    positionMs = Math.max(0, timeMs);
    leadMs = Math.min(120000, 60000 * Math.max(1, rate));
    urgentSeek ||= seek;
    pump();
  }

  // 派发入口：syncUsage 注入后派发要跨 await，因此用单飞 + 一次排队保证重入的 observe 不会重复计费。
  function pump() {
    if (!identity) return;
    if (pumping) {
      pumpQueued = true;
      return;
    }
    void drain();
  }

  async function drain() {
    pumping = true;
    try {
      await pumpBatches();
    } catch {
      // 派发循环里的意外异常只影响本轮：恢复 pumping 后由 observe / finally 再次触发。
    } finally {
      pumping = false;
    }
    if (pumpQueued) {
      pumpQueued = false;
      pump();
    }
  }

  async function pumpBatches() {
    if (restorePending) return;
    if (!identity) return;
    const loopGeneration = generation;
    const start = groups.findIndex((group) => group.endMs >= positionMs);
    if (start < 0) return;
    const last = Math.min(groups.length - 1, start + prefetchCount);
    const maxConcurrent = urgentSeek ? 2 : 1;
    while (inFlight < maxConcurrent) {
      if (loopGeneration !== generation) return;
      const items = [];
      const selected = [];
      let characters = 0;
      let first = -1;
      for (let index = start; index <= last && groups[index].startMs <= positionMs + leadMs; index++) {
        const group = groups[index];
        if (isDone(group)) {
          if (first >= 0) break;
          continue;
        }
        const missing = group.ids.filter((id) => !translations.has(id));
        if (missing.length) {
          if (cachePolicy === "only") {
            failure = "cache_miss"; failed.add(group);
            addLog("cache_miss", "缓存中没有可用的字幕", { cueIds: group.ids });
            notify(); break;
          }
          if (first < 0) first = index;
          const missingCharacters = missing.reduce((sum, id) => sum + cues[Number(id)].text.length, 0);
          if (selected.length && (items.length + missing.length > MAX_BATCH_ITEMS || characters + missingCharacters > MAX_BATCH_CHARACTERS)) break;
          selected.push(group);
          for (const id of missing) { items.push({ id, text: cues[Number(id)].text }); characters += cues[Number(id)].text.length; }
          if (first === start) break;
        } else {
          const missingAnnotations = group.ids.filter(annotationNeeded);
          if (missingAnnotations.length && cachePolicy === "only") {
            failure = "cache_miss"; failed.add(group);
            addLog("cache_miss", "缓存中缺少字幕注音", { cueIds: missingAnnotations });
            notify(); break;
          }
          if (missingAnnotations.length) {
            for (const id of missingAnnotations) {
              const annotationSide = isJp(targetLanguage) ? "target" : "source";
              const acceptedText = translations.get(id);
              const annotationText = annotationSide === "target" ? acceptedText : cues[Number(id)].text;
              items.push({ id, text: annotationText, annotationOnly: true, annotationSide, acceptedText, annotationText });
              characters += annotationText.length;
            }
            selected.push(group); first = index; break;
          }
        }
      }
      if (first < 0 || !items.length) break;
      const itemIndices = items.map(({ id }) => Number(id));
      const firstItem = Number(items[0].id), lastItem = Number(items.at(-1).id);
      const beforeIndices = contextCount === 0 ? [] : Array.from({ length: Math.min(firstItem, contextCount) }, (_, index) => firstItem - Math.min(firstItem, contextCount) + index);
      const afterIndices = contextCount === 0 ? [] : Array.from({ length: Math.min(cues.length - lastItem - 1, contextCount) }, (_, index) => lastItem + index + 1);
      const before = beforeIndices.map((index) => cues[index].text);
      const after = afterIndices.map((index) => cues[index].text);
      const totalCharacters = characters + before.join("").length + after.join("").length;
      if (cachePolicy !== "only" && usageSync) {
        const windowBefore = budgetKey;
        let merged = null;
        try {
          merged = await usageSync({ windowKey: budgetKey, requests, characters: sentCharacters });
        } catch {
          merged = null;
        }
        if (loopGeneration !== generation) return;
        if (merged) {
          const mergedRequests = normalizeCounter(merged.requests);
          const mergedCharacters = normalizeCounter(merged.characters);
          if (budgetKey === windowBefore) {
            requests = Math.max(requests, mergedRequests);
            sentCharacters = Math.max(sentCharacters, mergedCharacters);
          } else {
            requests = mergedRequests;
            sentCharacters = mergedCharacters;
          }
        }
      }
      const stopReason = requestLimit !== null && requests >= requestLimit ? "requests"
        : characterLimit !== null && sentCharacters + totalCharacters > characterLimit ? "characters"
        : null;
      if (stopReason) {
        budgetStop = stopReason;
        failure = "budget_exceeded";
        addLog("budget_exceeded", "本集翻译预算已用尽", { requests, sentCharacters });
        notify();
        break;
      }
      budgetStop = null;
      const requestNumber = ++requests;
      sentCharacters += totalCharacters;
      inFlight++;
      for (const group of selected) pending.add(group);
      const requestGeneration = generation;
      const cacheGeneration = translationCache?.generation?.() ?? 0;
      const cacheCapture = cacheSourceId && items.every((item) => !item.annotationOnly)
        ? { sourceId: cacheSourceId, episodeId: sourceEpisodeId, subtitleEpoch: sourceSubtitleEpoch, itemIndices,
          beforeIndices, afterIndices, trackKind: sourceTrackKind } : null;
      const annotationItems = items.filter((item) => item.annotationOnly);
      const annotationCapture = annotationItems.length === items.length && cacheSourceId
        ? { sourceId: cacheSourceId, episodeId: sourceEpisodeId, trackKind: sourceTrackKind, sourceLanguage, targetLanguage,
          semanticIntent, translationSemantics: "cue-v1", items: annotationItems.map(({ id, annotationSide, annotationText, acceptedText }) =>
            ({ id, sourceIndex: Number(id), annotationSide, annotationText, acceptedText })) } : null;
      const batch = { sourceLanguage, targetLanguage, semanticIntent, subtitleEpoch: sourceSubtitleEpoch,
        items: items.map(({ id, text }) => ({ id, text })), contextBefore: before, contextAfter: after, japaneseRuby,
        ...(cacheCapture ? { cacheCapture } : {}), ...(annotationCapture ? { annotationOnly: true, annotationCapture } : {}) };
      const requestStartedAt = Date.now();
      addLog("request_sent", "正在请求字幕翻译", { request: requestNumber, cueIds: items.map(({ id }) => id), characters: totalCharacters });
      notify();
      void Promise.resolve().then(() => translate(batch)).then((response) => {
        if (requestGeneration !== generation || cacheGeneration !== (translationCache?.generation?.() ?? 0)) return;
        if (response?.cacheMetadata?.storageError) cacheStats.storageError = String(response.cacheMetadata.storageError);
        if (Array.isArray(response?.trace)) {
          for (const step of response.trace) addLog("provider_stage", "LLM 请求链路", { ...step, request: requestNumber });
        }
        const received = response?.ok ? response.items : null;
        const byId = new Map(Array.isArray(received) ? received.map((entry) => [entry.id, entry.text]) : []);
        const byReadings = new Map(Array.isArray(received)
          ? received.filter((entry) => entry.readings && typeof entry.readings === "object" && !Array.isArray(entry.readings) && Object.keys(entry.readings).length > 0).map((entry) => [entry.id, entry.readings])
          : []);
        const byRuby = new Map(Array.isArray(received)
          ? received.filter((entry) => typeof entry.ruby === "string" && entry.ruby.trim()).map((entry) => [entry.id, entry.ruby])
          : []);
        const valid = Array.isArray(received) && received.length === items.length
          && byId.size === items.length && items.every(({ id }) => typeof byId.get(id) === "string" && byId.get(id).trim())
          && items.every((item) => !item.annotationOnly || ((item.annotationSide !== "target" || byId.get(item.id) === item.acceptedText)
            && (byReadings.has(item.id) && Object.keys(byReadings.get(item.id)).length > 0 || byRuby.has(item.id))));
        if (valid) {
          for (const item of items) {
            const { id } = item;
            const responseText = byId.get(id);
            const targetAnchorValid = item.annotationSide !== "target" || responseText === item.acceptedText;
            if (!item.annotationOnly) translations.set(id, collapseLines(responseText));
            if (targetAnchorValid && byReadings.has(id)) readingsMap.set(id, byReadings.get(id));
            if (targetAnchorValid && byRuby.has(id)) rubies.set(id, collapseLines(byRuby.get(id)));
            if (item.annotationOnly && targetAnchorValid) {
              translationCache?.updateAnnotations?.({ episodeId: sourceEpisodeId, sourceLanguage, trackKind: sourceTrackKind,
                targetLanguage, semanticIntent, translationSemantics: "cue-v1" }, cacheSourceId,
                [{ index: Number(id), annotationSide: item.annotationSide, annotationText: item.annotationText, acceptedText: item.acceptedText,
                  readings: byReadings.get(id), ruby: byRuby.has(id) ? collapseLines(byRuby.get(id)) : undefined }]);
            }
          }
          cacheStats.annotationMissing = cues.reduce((count, _cue, index) => count + Number(annotationNeeded(String(index))), 0);
          onAccepted?.(batch, response);
          addLog("request_succeeded", "字幕翻译完成", { request: requestNumber, cueIds: items.map(({ id }) => id), durationMs: Date.now() - requestStartedAt });
        } else {
          for (const group of selected) failed.add(group);
          failure = response?.errorCode ?? "invalid_response";
          addLog("request_failed", "字幕翻译失败", { request: requestNumber, cueIds: items.map(({ id }) => id), error: failure, durationMs: Date.now() - requestStartedAt });
        }
      }).catch(() => {
        if (requestGeneration !== generation || cacheGeneration !== (translationCache?.generation?.() ?? 0)) return;
        for (const group of selected) failed.add(group);
        failure = "unavailable";
        addLog("request_failed", "字幕翻译请求异常", { request: requestNumber, cueIds: items.map(({ id }) => id), error: failure, durationMs: Date.now() - requestStartedAt });
      }).finally(() => {
        if (requestGeneration !== generation) return;
        inFlight--;
        for (const group of selected) pending.delete(group);
        urgentSeek = false;
        notify();
        pump();
      });
      if (first === start) break;
    }
  }

  function isDone(group) {
    return pending.has(group) || failed.has(group) || group.ids.every((id) => translations.has(id) && !annotationNeeded(id));
  }

  function readyAt(timeMs) {
    const group = groups.find((entry) => entry.endMs >= timeMs);
    return !group || group.ids.every((id) => translations.has(id));
  }

  const isJp = (lang) => /^(ja|jp)($|[-_])/i.test(String(lang ?? "").trim());
  function annotationNeeded(id) {
    if (!japaneseRuby || !(isJp(sourceLanguage) || isJp(targetLanguage))) return false;
    const annotationText = isJp(targetLanguage) ? translations.get(id) : cues[Number(id)]?.text ?? "";
    const annotated = readingsMap.has(id) || rubies.has(id);
    return Boolean(translations.get(id)) && !annotated && /[一-龯々〆ヵヶ]/.test(annotationText);
  }

  // 活跃字幕对象可能来自外部重建的列表（overlay 桥接），先按对象身份找，再按时间与文本回退。
  function cueIdOf(cue) {
    const direct = cueIds.get(cue);
    if (direct !== undefined) return direct;
    const found = cues.findIndex((candidate) => Math.abs(candidate.startMs - cue.startMs) < 200 && candidate.text === cue.text);
    return found >= 0 ? String(found) : undefined;
  }

  function translatedFor(activeCues) {
    const result = [];
    const targetIsJp = isJp(targetLanguage);
    for (const cue of activeCues) {
      const id = cueIds.get(cue);
      const text = id !== undefined ? translations.get(id) : undefined;
      const readings = (japaneseRuby && targetIsJp && id !== undefined) ? readingsMap.get(id) : undefined;
      const ruby = (japaneseRuby && targetIsJp && id !== undefined) ? rubies.get(id) : undefined;
      if (text !== undefined) {
        result.push({
          startMs: cue.startMs,
          endMs: cue.endMs,
          text,
          ...(readings ? { readings } : {}),
          ...(ruby ? { ruby } : {})
        });
      }
    }
    return result;
  }

  // 该行是否还在等一个可能到达的译文：分组在途且未译出为 true；已译出、已永久失败、
  // 以及根本没被派出（例如额度断流）都是 false，overlay 因此不会留下永不消失的占位。
  function pendingRoles(activeCues) {
    if (!identity || !aiRole || !Array.isArray(activeCues) || activeCues.length === 0) return {};
    const awaiting = activeCues.some((cue) => {
      const id = cueIdOf(cue);
      if (id === undefined || translations.has(id)) return false;
      const group = groupIds.get(id);
      return Boolean(group) && pending.has(group) && !failed.has(group);
    });
    return awaiting ? { [aiRole]: true } : {};
  }

  function annotateSource(activeCues) {
    const sourceIsJp = isJp(sourceLanguage);
    if (!japaneseRuby || !sourceIsJp || isJp(targetLanguage) || (readingsMap.size === 0 && rubies.size === 0) || !Array.isArray(activeCues)) {
      return activeCues;
    }
    return activeCues.map((cue) => {
      const id = cueIdOf(cue);
      const readings = id !== undefined ? readingsMap.get(id) : undefined;
      const ruby = id !== undefined ? rubies.get(id) : undefined;
      if (readings || ruby) {
        return {
          ...cue,
          ...(readings ? { readings } : {}),
          ...(ruby ? { ruby } : {})
        };
      }
      return cue;
    });
  }

  function bypassCacheRestoreOnce() { bypassRestoreOnce = true; }
  return { setSource, setBudget, setUsage, clear, clearCache: (episodeId) => { translationCache?.clear(episodeId); clear(); }, bypassCacheRestoreOnce, observe, readyAt, translatedFor, annotateSource, pendingRoles, status };
};

function collapseLines(text) {
  const helper = window.Bilayer?.collapseSubtitleLines;
  if (typeof helper === "function") return helper(text);
  return collapseSubtitleLinesLocal(text);
}

function collapseSubtitleLinesLocal(text) {
  if (!text || typeof text !== "string") return "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "";
  const result = [lines[0]];
  const dialogueDashPattern = /^[-–—―・]\s*/;
  const cjkCharPattern = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  for (let index = 1; index < lines.length; index++) {
    const prevLine = result[result.length - 1];
    const currLine = lines[index];
    if (dialogueDashPattern.test(currLine)) {
      result.push(currLine);
      continue;
    }
    const prevPlain = prevLine.replace(/\{[^|{}]+\|[^|{}]+\}/g, (match) => match.slice(1, match.indexOf("|")));
    const currPlain = currLine.replace(/\{[^|{}]+\|[^|{}]+\}/g, (match) => match.slice(1, match.indexOf("|")));
    const prevLastChar = prevPlain.slice(-1);
    const currFirstChar = currPlain.slice(0, 1);
    if (cjkCharPattern.test(prevLastChar) && cjkCharPattern.test(currFirstChar)) {
      result[result.length - 1] = prevLine + currLine;
    } else {
      result[result.length - 1] = prevLine + " " + currLine;
    }
  }
  return result.join("\n");
}

function buildGroups(cues) {
  const groups = [];
  const ordered = cues.map((cue, index) => ({ cue, index }))
    .sort((left, right) => left.cue.startMs - right.cue.startMs || left.index - right.index);
  for (let position = 0; position < ordered.length; position++) {
    const { cue, index } = ordered[position];
    const previous = ordered[position - 1]?.cue;
    const group = groups.at(-1);
    const continues = group && previous && cue.startMs >= previous.endMs
      && cue.startMs - previous.endMs < 1000 && group.ids.length < 3
      && group.characters + cue.text.length < 240 && !/[.!?。？！]$/.test(previous.text.trim());
    if (continues) {
      group.ids.push(String(index));
      group.endMs = cue.endMs;
      group.characters += cue.text.length;
    } else {
      groups.push({ ids: [String(index)], startMs: cue.startMs, endMs: cue.endMs, characters: cue.text.length });
    }
  }
  return groups;
}
