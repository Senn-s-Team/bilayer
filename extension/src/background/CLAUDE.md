# background/
> L2 | 父级: ../CLAUDE.md

成员清单
service_worker.js: 初始化全局翻译默认值并迁移旧键，在首次安装时唤起 onboarding 引导页；settings 设置窗口的开窗/聚焦（openSettingsWindow：action.onClicked 与 BILAYER_OPEN_SETTINGS 共用，已开着只聚焦、否则 windows.create 默认 1240×940、windows API 不可用时回落 tabs.create，窗口 id 记在 __settings_window_id__）；字幕下载、多 provider 翻译（日文原文/译文注音使用固定字段的 readings 数组契约，避免动态键字典诱导空对象；请求侧明确注音来源，响应侧兼容旧 readings 字典及 furigana 字符串，集成外来语本地化准则）、settings 与 onboarding 连通性测试、AI 就绪度查询（`BILAYER_AI_READINESS`：只读 provider 条目、`aiProviderId` 与 `uiLanguage` 偏好（同一次 `storage.local.get`），不请求上游不缓存，返回 `{configured, notice, tracksNotice, unreadNotice}`，提示句跟随 `storage.local.uiLanguage`（auto 走 `runtime.i18n.getMessage`，具体语言异步解析包内 `_locales/<code>/messages.json` 并按语言缓存）；`tracksNotice` 对应「本片无轨道」、`unreadNotice` 对应「读不到轨道清单」）、兼容服务解析单字幕对象及逗号分隔对象序列，再严格校验数量、字段与 ID；默认常态保留最近 20 次原始诊断

设计边界:
后台不保存页面级字幕状态；翻译时才读取所选 provider 的本地凭证。官方 OpenAI 使用固定 host 与严格 JSON Schema；兼容端点必须是 HTTPS `/chat/completions`（localhost/127.0.0.1 可用 HTTP），且必须拥有运行时授权。兼容服务可规范化单个 `{id,text}` 或多个逗号分隔对象，结果必须与请求字幕的数量及 ID 完全匹配。原始报文仅由独立 diagnostics 页显式开启和读取；Authorization 只留在 background。

设置窗口（`openSettingsWindow` / `BILAYER_OPEN_SETTINGS`）:
manifest 刻意不声明 `action.default_popup`：只要该键还在，浏览器就自己开弹窗并吞掉 `action.onClicked`，故删键才能拿回工具栏点击。`runtime.action?.onClicked` 与 `BILAYER_OPEN_SETTINGS`（仅 `isAllowedTestSender` 可发，否则回 `{ok:false,errorCode:"configuration"}`）都走同一个 `openSettingsWindow()`，查找顺序：① `windows.getAll({populate:true})` 中任一标签页 URL 等于 `runtime.getURL(SETTINGS_PAGE)` 的窗口 → `windows.update({focused:true})`，命中即复用、重复点击不叠窗；② 记住的窗口 id（`SETTINGS_WINDOW_KEY = "__settings_window_id__"`）经 `windows.get` 验证仍存在 → 聚焦。② 不可省：Chrome 未授予 `tabs` 权限时窗口内每个 `tab.url` 都是 null（连扩展自己的页面也一样），① 会必然落空；③ `windows.create({type:"popup", width:1180, height:940, url})` 并记住新窗口 id——高度是窗口外高（有头 Chrome 实测标题栏约吃掉 88px，内高约 852），1180×860 会让内容约 749px 的 AI 页重新出现面板内滚动，故取 940 让四个页签都不滚动；④ `windows` API 缺失或调用失败 → `runtime.tabs.create({url})`；两者都失败才回 `{ok:false,errorCode:"unavailable"}`，不静默吞掉点击。窗口 id 优先记在 `storage.session`（会话结束即失效，不会被下一次会话复用），不支持时退 `storage.local`，并在 `runtime.runtime.onStartup` 调 `forgetSettingsWindow()` 清旧记录，避免拿上一次会话的 id 去聚焦无关窗口。
授权规则同步收紧为「身份 + URL」：`isAllowedTestSender(sender)` 要求 `sender.id === runtime.runtime.id` 且 URL 命中 settings.html 或 onboarding.html 白名单。旧写法「URL 匹配且 `!sender.tab`」在独立窗口形态下会误杀——窗口/标签页里的文档与内容脚本一样都带 `sender.tab`——使「测试连通性」「获取模型」「AI 就绪度」静默失败；身份仍是必过项，不放宽到任意扩展页或网页。

采集开关状态机（`loadRawDiagnosticsIfNeeded()` 单飞读取 + `BILAYER_SET_RAW_DIAGNOSTICS`）:
- 未知：worker 生命周期初值 `rawCaptureEnabled = false`——“未知”一律 fail-closed，模块初值绝不表示开启。
- 读取成功：采用持久化值（`__raw_capture_enabled__` 未设置视为 true），置 `rawCapturePreferenceKnown`，promise 缓存，此后不再读存储。
- 读取失败（storage 抛错或 `runtime.runtime.lastError`）：不置任何采集值、不缓存失败，promise 清空使下一次调用重试；重试成功前保持 fail-closed。
- 用户显式切换：立即赋值并立即只写 `__raw_capture_enabled__` 开关键（不等待尚未落地的读取），置 `capturePreferenceSetByUser` 与 `rawCapturePreferenceKnown`；前者使随后落地的读取不得覆盖用户值，用户值在本 worker 生命周期内始终权威。
- 已知性规则：`__raw_capture_enabled__` 只在 `rawCapturePreferenceKnown` 为真（读取成功或用户切换过）时写入存储。缓冲落盘（捕获记录、CLEAR）永不写入未知的 fail-closed 占位值——否则“清理缓冲”会把用户从未读到的偏好静默翻转；缓冲/版本/序号三键在任何情况下都照常写入。
- 交错语义：GET、CLEAR 与 translate 都 `await` 同一个加载 promise，因此不会读到模块初值；SET 不等待读取，立即生效并落盘。读取挂起时 SET 先到 → 立即回 `enabled` 并持久化，读取随后落地被跳过；读取先落地则用户值直接覆盖。SET 只单独写开关键，避免缓冲尚未读回时空 `__raw_diagnostics__` 覆盖已存记录；CLEAR 先读回开关再清空并落盘，故其写入的开关值就是用户实际持有的值。

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
授权：`isReadinessSender()` = 观剧页内容脚本（`isAllowedSender`，Netflix `/watch/` 页）∪ 扩展自有页面（settings/onboarding 走 `isAllowedTestSender`，diagnostics 走 `isDiagnosticsSender`）；其余发送者一律 `configuration` 拒绝，且不返回任何文案。
开销：只读一次 `providers`/`aiProviderId`/`uiLanguage`、不请求上游；`auto` 下零额外请求，具体语言下每个语言最多一次包内 fetch（缓存，含失败）；就绪度快照本身仍不缓存——settings 轮询与设置变更会反复问，陈旧快照会掩盖配置变化。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
