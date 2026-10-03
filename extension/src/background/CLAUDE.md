# background/
> L2 | 父级: ../CLAUDE.md

成员清单
service_worker.js: 初始化全局翻译默认值并迁移旧键，在首次安装时唤起 onboarding 引导页；settings 设置窗口的开窗/聚焦（openSettingsWindow：action.onClicked 与 BILAYER_OPEN_SETTINGS 共用，已开着只聚焦、扩展页 tab.url 不可见时按记住的窗口 id 复核复用，否则 windows.create 默认 1240×940，windows API 不可用或创建失败时回落 tabs.create；__settings_window_id__ 优先记在 storage.session，不支持时退回 storage.local 并在 onStartup 作废；设置页/向导页授权要求扩展身份与 URL 白名单，不排除 sender.tab）；字幕下载、多 provider 翻译（日文原文/译文注音使用固定字段的 readings 数组契约，避免动态键字典诱导空对象；请求侧明确注音来源，响应侧兼容旧 readings 字典及 furigana 字符串，集成外来语本地化准则）、settings 与 onboarding 连通性测试、AI 就绪度查询（`BILAYER_AI_READINESS`：只读 provider 条目、`aiProviderId` 与 `uiLanguage` 偏好（同一次 `storage.local.get`），不请求上游不缓存，返回 `{configured, notice, tracksNotice, unreadNotice}`，提示句跟随 `storage.local.uiLanguage`（auto 走 `runtime.i18n.getMessage`，具体语言异步解析包内 `_locales/<code>/messages.json` 并按语言缓存）；`tracksNotice` 对应「本片无轨道」、`unreadNotice` 对应「读不到轨道清单」）、兼容服务解析单字幕对象、逗号分隔对象序列及顶层条目数组，逐条规范化 readings 后再严格校验数量、字段与 ID；默认常态保留最近 20 次原始诊断，失败摘要仅按白名单保留错误码、原因与显式提供且非 undefined 的 expectedCount/receivedCount，不复制正文或凭证

diagnostics_store.js: 与 translation_cache_store.js 共用 `bilayer-background` IndexedDB v2；以 diagnosticSummaries、diagnosticPayloads、meta 分表保存摘要/完整报文/版本游标，旧 storage.local 记录仅在事务提交后删除，pending 请求在新 worker 启动时标为 worker_interrupted，generation 阻止 clear 后的迟到完成复活记录；query/detail/export 的所有 request 在同一事务 callback 链完成，EXPORT 每页 payload 请求在事务完成前排队，防止原生 IndexedDB transaction inactive。
translation_cache_store.js: 与 diagnostics_store.js 共用 `bilayer-background` IndexedDB v2；cacheSources 保存精确时间线和 trackKind，cacheBatches 保存已接受译文及无凭证 provenance，meta 持有 sequence/generation；统计按已接受 occurrence 去重，不把整轨长度当缓存译文数；注音补齐按原文或已接受译文逐字锚定并跨原批次更新；clear-current 只递增对应 episode token，clear-all 递增全局 token。

IndexedDB 持久化（`importScripts("diagnostics_store.js", "translation_cache_store.js")` 必须位于 classic worker 入口最前）：两模块共享 `bilayer-background` v2，升级都创建同一组 store/index；不得另设数据库版本或只由单个模块升级 schema。`diagnostics_store.js` 把摘要/完整 request-response/meta 分表，无业务条数/年龄上限；旧 `__raw_diagnostics__` 仅在事务提交后删除，clear generation 阻止在途 finalize 复活已清记录。`service_worker.js` SET diagnostics preference 在加载读取前同步写入用户意图，序列化每次实际值写入，前一次写失败不毒化后续队列；读取迟到不得覆盖用户选择。
诊断协议（仅接受自有 `settings.html` URL 与精确 `runtime.id`；旧 diagnostics 页面已删除）：`BILAYER_QUERY_RAW_DIAGNOSTICS` 接受 filter/search/limit/cursor，返回摘要分页与 filter counts/version/generation；`BILAYER_GET_RAW_DIAGNOSTIC` 用 id+generation 取完整单条；`BILAYER_EXPORT_RAW_DIAGNOSTICS` 按 cursor 导出完整记录页；`BILAYER_SET_RAW_DIAGNOSTICS` 设置持久采集偏好；`BILAYER_CLEAR_RAW_DIAGNOSTICS` 原子递增 generation 并清空摘要与 payload。存储错误必须显式返回 `storage_unavailable`，不得回成空结果。摘要的 `errorCode`、`error` 或 `failure` 任何一项存在时均属 abnormal，即使 validated 为 true。
翻译缓存协议：REGISTER/READ 仅本扩展 Netflix watch 内容脚本，episode 必须等于 sender 的 watchId；STATS/CLEAR 仅精确自有 settings.html。source 身份散列 episode/sourceLanguage/trackKind/完整文本序列，READ 返回这些 scope 字段并仅返回有兼容批次的时间线。每次缓存操作读取当前 mode/retention/cap，避免 worker 已加载偏好后继续使用旧值。超过 maxBytes 的单条时间线不写入；过期及 LRU 删除在 readwrite 事务中选择和删除，防止用旧快照删掉并发新提交，容量优先保留在途来源但不会无条件超限。成功批次保存实际 prompt 的 semanticIntent、无凭证 provenance 和逐条 sourceText/translatedText；generation 在 dispatch 前读取并在提交事务中校验。成功 provider response 始终返回实际 cacheMetadata，持久化失败只附 storageError。subtitleCount/currentEpisodeSubtitleCount 按已接受 occurrence 去重，bytes 含时间线与批次；session 的存储由 content 持有。
`aiCachePolicy="only"` 在后台拒绝任何 provider dispatch；缓存命中由 content 在发消息前消费，因此未命中不会制造 provider/诊断记录。
注音补齐：`BILAYER_TRANSLATE_BATCH` 可带 `annotationOnly:true` 和 `annotationCapture`，逐项包含 sourceIndex、acceptedText、annotationText、annotationSide。后台请求回显注音锚点并只生成 readings；目标正文不相同或读音不属于锚点时拒绝响应，源注音始终保留已接受译文。local 补齐在 dispatch 前读取 generation，提交事务校验 token 与实际 semanticIntent，缓存写入失败不使有效译文/注音失效；补齐后重新执行容量限制。
缓存并发边界：mode、policy、retention 和 capacity 按每条消息读取并归一化，翻译成功提交使用该请求的配置快照；并发管理消息不能改变已派发请求的持久化选择。READ 在每条时间线内按 createdAt 与提交 sequence 新到旧返回，新重译正文优先于旧正文。

设置窗口（`openSettingsWindow` / `BILAYER_OPEN_SETTINGS`）:
后台诊断历史与缓存管理均仅接受精确自有 `settings.html` URL（另校验 `sender.id === runtime.runtime.id`）；diagnostics 内容不再由独立 diagnostics 页访问，onboarding/Netflix 页面不能读取诊断历史或触发管理操作。
授权规则同步收紧为「身份 + URL」：`isAllowedTestSender(sender)` 要求 `sender.id === runtime.runtime.id` 且 URL 命中 settings.html 或 onboarding.html 白名单；诊断历史和缓存管理使用 `isSettingsSender(sender)` 的 settings.html 精确 URL。身份仍是必过项，不放宽到任意扩展页或网页。

采集开关状态机（`loadRawDiagnosticsIfNeeded()` 单飞读取 + `BILAYER_SET_RAW_DIAGNOSTICS`）:
- 未知：worker 生命周期初值 `rawCaptureEnabled = false`——“未知”一律 fail-closed，模块初值绝不表示开启。
- 读取成功：采用持久化值（`__raw_capture_enabled__` 未设置视为 true），置 `rawCapturePreferenceKnown`，promise 缓存，此后不再读存储。
- 读取失败（storage 抛错或 `runtime.runtime.lastError`）：不置任何采集值、不缓存失败，promise 清空使下一次调用重试；重试成功前保持 fail-closed。
- 用户显式切换：立即赋值并立即只写 `__raw_capture_enabled__` 开关键（不等待尚未落地的读取），置 `capturePreferenceSetByUser` 与 `rawCapturePreferenceKnown`；前者使随后落地的读取不得覆盖用户值，用户值在本 worker 生命周期内始终权威。
- 写入边界：SET 只序列化写 `__raw_capture_enabled__`，返回持久化成功或失败；诊断报文及版本/序号由 IndexedDB 事务持有，CLEAR 不修改采集偏好。
- 交错语义：QUERY、CLEAR 与 translate 等待单飞读取；SET 同步生效且等实际写入完成才回响应，迟到读取不得覆盖用户值；读取失败允许下次重试。
加载或迁移失败时 QUERY/GET/EXPORT/CLEAR 返回显式 storageError，不伪造空历史；翻译继续成功但该次不采集，下一次调用重试初始化。报文写失败保留在 QUERY.storageError，下一次成功报文提交才清除。

AI 就绪度查询（`BILAYER_AI_READINESS`）:
契约：请求 `{ type: "BILAYER_AI_READINESS" }` → `{ ok: true, configured: boolean, notice: string|null, tracksNotice: string, unreadNotice: string }`；失败（读取存储抛错/`runtime.runtime.lastError`）回 `{ ok: false, errorCode: "unavailable" }`，授权失败回 `{ ok: false, errorCode: "configuration" }`。
`configured` 是「当前 provider 真的能用」的唯一判据，与 settings 的「获取模型/测试连通性」门槛同一规则、不另立判据：按 `aiProviderId` 用 `pickProvider()` 取条目（取不到＝未配置），条目有非空 `credential`，或 `endpoint` 落在无需凭证的本地端点白名单 `KEYLESS_ENDPOINTS`（`http://localhost:11434/v1/chat/completions`，即 Ollama 预设）即视为已配置。注意翻译链路本身仍要求凭证，本地端点免密钥只覆盖「就绪度/模型发现」这一层。
文案：`notice`（key `noticeProviderMissing`）仅在未配置时解析，配置就绪时为 `null`；`tracksNotice`（key `noticeSubtitleTracksMissing`）恒为字符串，content 侧只在 `subtitleAvailability === "none"`（真的收到过播放器清单载荷且其中无可用轨道）时使用；`unreadNotice`（key `noticeSubtitleTracksUnread`）恒为字符串，content 侧只在 `subtitleAvailability === "unread"`（watch 页有 video 但 20s 内没等到任何 player-api 载荷）时使用——两条轨道提示对应证据强度不同的两种事实，故不共用同一句文案。`content` 不携带 UI 字符串。键缺失时 `notice` 回落 `null`、两条 `*Notice` 回落空串——宁可没有提示，也不显示半句话；content 侧对空文本同样不渲染提示条。

文案语言来源（与 `extension/src/i18n.js` 同语义，跟随扩展自身的界面语言偏好而非浏览器语言）:
- 偏好键 `runtime.storage.local.uiLanguage` ∈ `auto`（默认，跟随浏览器）| `en` | `zh_CN`；与 `providers`/`aiProviderId` **同一次** `storage.local.get` 读出，missing/非字符串/非包内码一律按 `auto`（与 i18n.js 的 `normalizePreference` 同一规则，`zh-CN` 之类的别名不算具体语言）。
- `auto` → `runtime.i18n.getMessage(key)`，**任何情况下都不加载报文包**（与 i18n.js 的 `auto 永不加载包` 一致）。
- 具体语言 → 异步 `fetch(runtime.getURL("_locales/<code>/messages.json"))` 并解析 `{message}` 取值形状（兼容字符串条目，同 i18n.js 的 `fromBundle`）；命中即返回，不再回落 getMessage。
- 缓存：模块级 `localeBundles: Map<locale, Promise<bundle|null>>`，**成功与不可用（缺文件、非 2xx、非法 JSON、fetch 拒绝、无 `fetch`）都按语言缓存**，同 worker 生命周期内只取一次；worker 回收重启后自然重试。settings 的轮询因此不会把一次不可用放大成反复失败的网络请求。
- 降级链（每一步都不抛错、不返回半句话）：包内报文 → `runtime.i18n.getMessage` → `""`。fetch 失败只影响文案来源，**绝不变成 `{ok:false}`**。
- **潜在同类风险（未修，约束后来者）**：回落分支 `runtime.i18n?.getMessage?.(key)`（service_worker.js:822）不传 substitutions，浏览器会把报文里的 `$1…$9` 抹成空串——与 `extension/src/i18n.js` 修复前的 auto 缺陷同源。当前被取的三个键 `noticeProviderMissing`/`noticeSubtitleTracksMissing`/`noticeSubtitleTracksUnread` 都不含 `$n`，故这条路径暂不可达；**一旦给后台投递的文案加 `$n`（无论哪个键），auto/回落路径就会渲染成半句话**，届时必须像 i18n.js 的 `browserArguments()` 那样把缺位补齐为字面占位符再下传。
- 刻意的重复实现：service worker 没有 DOM 与 `localStorage`，无法加载 `i18n.js`（该模块解析期依赖同步 XHR），平台也拒绝 worker 内的同步请求，故这里只能异步取包并自持缓存；两处都必须与对方保持同一语义与同一键集。
授权：`isReadinessSender()` 仅包含精确本扩展身份的 Netflix watch 内容脚本与 settings/onboarding URL 白名单；诊断历史仅 settings，已删除独立 diagnostics 页面入口。
开销：只读一次 `providers`/`aiProviderId`/`uiLanguage`、不请求上游；`auto` 下零额外请求，具体语言下每个语言最多一次包内 fetch（缓存，含失败）；就绪度快照本身仍不缓存——settings 轮询与设置变更会反复问，陈旧快照会掩盖配置变化。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
