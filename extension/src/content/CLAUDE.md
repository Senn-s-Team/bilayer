# content/
> L2 | 父级: ../CLAUDE.md

成员清单
content.js: 内容脚本入口，连接 page bridge、三轨加载及 occurrence cache/scheduler；local 模式经 background 注册/读取持久化快照，session 模式仅保留当前内容脚本生命周期内的接受结果；成功翻译按后台返回的实际 cacheMetadata 提交 session snapshot，source id、字幕世代与缓存 generation 阻止迟到 completion 写入；BILAYER_GET_STATE 暴露 cache 状态，BILAYER_CACHE_ACTION 只接受扩展自身 settings.html
netflixAdapter.js: Netflix 字幕轨道归一化器，把私有响应折叠成稳定 Track
overlay.js: Shadow DOM 字幕层，负责布局与独立样式；支持基于权威原文字幕与 readings 读音字典精准渲染 <ruby>/<rt> 振假名，兼任兼容模式解析，并在节点未变化时逐帧复用以维持视觉稳定；render({primaryCues, secondaryCues, pending, notice}) 的 pending 按角色标记等待翻译，无文本的角色连续 pending ≥200ms 后渲染无文字占位，收到文本或结束 pending 立即消失；notice 为可选的本地化提示行（{text, kind?}），缺省/null/空文本与旧行为一致，非空时在字幕栈最下方渲染唯一复用的提示条（节点复用，无重建）；通过 mount() 接入 fullscreenMount
translationCache.js: 以 source family 与 occurrence 为锚的接受结果缓存；完整 cue 向量位置匹配，编辑后仅复用所有最优 LCS 中强制配对且原请求与局部依赖窗口连续的 occurrence；语义目标匹配，provider/context 参数只作 provenance，注音独立锚定实际 source/target 文本；session 快照留在当前内容脚本，local 快照由 background IDB 恢复，证明不足或工作上限不足时 miss
translationScheduler.js: cue grouping、预算同步与异步批次派发；恢复完成前阻止 miss 选择，cache hit 不消耗请求/字符预算；prefer 只派发连续 miss，并可为已接受正文补请求注音，only 的任何缺失都不调用 provider；成功回包经 onAccepted 按实际 cacheMetadata 提交，invalid_response 对相同源保持失败直到源、语义、注音或策略显式改变；source 与 cache generation 阻止迟到恢复及清理后 completion 复活
管理动作：重新翻译以稳定 cacheRevision 切换调度源并跳过一次恢复，后续轨道报告不得把它切回旧缓存；清理先由设置完成本机事务再广播，播放页同步清空内存与调度状态。汉字的空 readings 仍为注音缺失；源和目标同为日语时仅目标行消费目标读音。cacheMetadata.storageError 不改变成功正文，但进入页面 translationCache 状态；local 源注册失败时保留内存来源身份，后续补读音仍按已接受正文锚定并报告存储失败。

设计边界:
Netflix 私有变化只进入 adapter；字幕格式变化只进入 parser；AI 翻译的纯时间轴调度留在 scheduler，网络凭证只在 background 读取；DOM 视觉变化只进入 overlay。content 只向 settings 返回已知设置字段，不泄露 storage 的其他键。预算边界：一次请求 = 一次批量翻译调用，字符数按实际发出的正文加已配置前后文累计；上限与用量的唯一真相在 scheduler，content 只把设置换算成上限（0→不限）并转述状态，因此 AI 设置变更触发的 clear() 不会重新武装已经消耗掉的额度。

计量窗口与持久化（content.js）:
窗口键是唯一计量边界，也是台账中每条用量记录的归属标识。`session:<watchId>` 锚在剧集上，刷新同一集页面继续累计、换剧集/换标题即换键重新起算；`hour:<YYYY-MM-DDTHH>` 与 `day:<YYYY-MM-DD>` 按本机时间分桶。`aiBudgetWindow` ∈ session|hour|day，缺省或非法一律回落 session，改窗口只换锚点、不清空已有译文。
用量落在 `runtime.storage.local` 的 `__ai_budget_usage__`（runtime 状态，不进 DEFAULT_SETTINGS），形状是多窗口台账 `{ records: { "<windowKey>": { requests, characters, startedAt, updatedAt } }, updatedAt }`：读只取当前窗口那一项，写只更新那一项，因此两个标签页看不同剧集（`session:<watchId>` 不同）时各自保有记录，刷新任一侧都从自己的数字继续，不会互相清零。台账上限 4 项（`BUDGET_RECORD_LIMIT`）：当前窗口始终保留，其余按 `updatedAt` 从新到旧淘汰，够覆盖“本集 + 本小时 + 本日 + 上一个窗口”。旧版单记录形状 `{ windowKey, requests, characters, startedAt }` 读到时迁移成映射并保留其中的计数（顶层旧字段与映射同时存在时按同窗口取并集），迁移后的形状在本次启动的回写中落盘。
读失败（抛错或 `runtime.runtime.lastError`）一律按“未知即不采用”：既不换锚也不回写，避免把 0 覆盖到别人的记录上；本页仍按内存镜像计量，下一次派发前的读回会重新校准。写是读改写（`flushBudgetStore`）：先并入存储里当前的其它窗口项再落盘，值未变则跳过（每次 notify 都会回写，只有真正消耗额度或换窗口才写）；同一批写入用单飞 + 一次排队合并，避免抖动。
多上下文合并规则：派发前（scheduler 的 syncUsage 闸门）与收到 `__ai_budget_usage__` 存储变更时，都只把**同一窗口**的持久化用量与本地用量逐项取较大值——两个标签页各自只记自己的消耗，取大值即并集。跨标签页的残留竞态只有并发派发重叠：两个标签页可以同时读到同一份派发前快照，各发一批后各写同值，台账因此少记一次（每个标签页每次最多 1 条，seek 至多 2 条）；读改写之间另一标签页若整本台账被覆盖，下一次读回或它自己的派发会把丢失的窗口项补回（每页始终保留自己窗口的计数）。这是成本护栏而非计费口径：少记的量恒小于并发派发数，且不会让上限失效（下一次派发前仍会读到当前快照）。
只有能派发翻译的观剧页面（有 watchId）才写台账；浏览页、首页只在本页内存里归零。

字幕可用性与 AI 提示行（content.js）:
`subtitleAvailability` 四态（`BILAYER_GET_STATE` 顶层字段）由**播放器轨道清单报告**与**读不到载荷时的兜底计时器**共同推进；`none` 与 `unread` 的证据强度严格分开，不可互相替代：

| 状态 | 判据 | 触发点 |
|---|---|---|
| `unknown` | 尚未收到带 `movieId` 的 `player-api` 载荷，且兜底计时器未到期 | 页面加载、换集/换片/重载后的复位 |
| `unread` | `/watch/` 页且 `video` 元素已就绪后，`TRACK_REPORT_TIMEOUT_MS = 20000` 内仍没有任何 `player-api` 载荷 | 兜底计时器到期（取证失败，**不代表**本片没有轨道） |
| `none` | 收到该载荷但 `normalizeTracks()` 归一化后无可用轨道 | 播放器已就绪而本片确实没有可用字幕轨道 |
| `available` | 同一影片的载荷里有 ≥1 条可用轨道 | 之后不再因空载荷回退 |

迁移：`unknown → unread`（计时器到期）；`unknown|unread → none|available`（载荷到达，计时器同时取消）；`unread` 可以从未是 `none` 而直接变成 `none`/`available`；`available` 不降级。
`unread` 为何必须存在：`extension/src/page/netflix-page-bridge.js` 的 `queryPlayerApi()`（第 170–189 行）先 `readTimedTextTrackList(activePlayer)` 逐条 `serializeTrack`，**`tracks.length === 0` 时第 181 行直接 `return`**，只有非空才 `publish("player-api:<movieId>:<reason>", {...})`（第 183 行）。于是「播放器已就绪但原始列表为空」与「播放器根本没就绪」在 content 侧都表现为『桥一直沉默』——这正是需要一条软提示的原因，而「本片没有轨道」（`none`）只能由真的收到过载荷来断言。
计时器生命周期（`armTrackReportTimer()` / `clearTrackReportTimer()`）：只在 `unknown` + `/watch/` 页 + `video` 已就绪三者同时成立时武装——`boot()` 经 `watchVideoElement → bindVideo()` 首次挂载时武装，`clearSubtitleState()` 每次复位后重新武装；载荷到达（`observeTrackReport()`）与所有复位路径（`clearSubtitleState()`：换 watchId、换 movieId、`BILAYER_RELOAD`、离开 watch 页）都先取消；回调自身再复核状态与页面条件，因此导航之后不会越权推进，也不会留下悬挂定时器（`scripts/content.test.mjs` 用假时钟与 `pendingTimerDelays()` 断言 19.999s 仍是 `unknown`、20s 变 `unread`、复位后无残留计时器）。
残余风险（20s 窗口）：片头广告或冷启动极慢时，20s 内可能还没枚举出轨道，于是先显示 `unread` 提示；载荷一到，下一次 render 即切到 `none`/`available` 并撤下提示。20s 覆盖了播放器从元素挂载到 `getTimedTextTrackList()` 可枚举的常见耗时并留出余量——宁可晚报「读不到」，也不把「启动慢」误报成「本片没有轨道」。

AI 提示行（subtitle position）:
`providerReadiness` 由 content 在页面加载（boot）、AI 相关设置变更（`providers` / `aiProviderId`）与 settings 既有状态轮询时向 background 重取（`BILAYER_AI_READINESS`），失败保留上一次已知快照，不新增轮询与权限。AI 模式下 `renderForCurrentTime()` 把 `notice` 交给 `overlay.render({..., notice})`，顺序与 settings 的 `writeAvailabilityNotice()` 完全一致——**硬性不可用 > 可操作提示 > 等待态软提示**：

| 优先级 | 条件 | 结果 |
|---|---|---|
| 1 | `subtitleAvailability === "none"` 且后台给了 `tracksNotice` | `{ text: tracksNotice, kind: "warning" }` |
| 2 | provider 未配置（`configured === false`）且后台给了 `notice` | `{ text: notice, kind: "warning" }` |
| 3 | `subtitleAvailability === "unread"` 且后台给了 `unreadNotice` | `{ text: unreadNotice, kind: "warning" }` |
| 4 | 其余情况（含文案缺失） | `null` |

为何是这个顺序：`none` 排在最先是因为它硬性阻断 AI（双原生与 AI 行都无从显示，只能换集换片）；provider 未配置与轨道读没读到毫无关系、且用户随时可修（设置窗口在该分支还会显示配置入口），所以它是可操作提示，优先于 `unread`；`unread` 只是「还在等播放器载荷」的观察态，一旦 provider 配置好、或载荷到达，它自己就会在下一帧出现或消失，无需任何交互。settings 用同一顺序、同一组证据（`subtitleAvailability` + `providerReadiness`），因此两处不会对同一页面状态给出互相矛盾的结论。

原生模式（`aiRole === "off"`）恒为 `notice: null`。三条文案都由 background 本地化，content 不携带 UI 字符串；条件消失（轨道出现 / 载荷到达 / provider 变为已配置）后下一次 render 即不再带 `notice`，无需刷新页面。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md