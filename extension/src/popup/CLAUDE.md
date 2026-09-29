# popup/
> L2 | 父级: ../CLAUDE.md

成员清单
popup.html: 字幕/AI 翻译/外观/服务分栏，侧栏含界面语言切换 `select[data-i18n-language]`；服务模型采用只读触发按钮和下拉顶部过滤框，AI 页含两个额度输入、额度统计窗口选择器 `select#aiBudgetWindow`（session/hour/day）与用量读数，以及顶部「翻译服务」卡片中的当前翻译服务选择器 `select#aiProviderSelect`（选项由 popup.js 依 currentProviders 写入），字幕页模式卡片下与 AI 页顶部各有一个 `#modeAvailability`/`#aiAvailability` 提示块，另含向导与诊断入口
popup.css: 固定 420x600 的 Neumorphism 基础样式与四页签布局，含侧栏界面语言切换控件样式，字幕行状态可完整换行
popup-ai.css: 模式单选与 AI 翻译页局部样式，包含模型下拉菜单、过滤输入框、跨列独占一行的统计窗口字段、会话额度用量读数与 `.availability` 提示（硬提示 warning 描边、读不到轨道时 `.is-soft` 软提示，以及褪色的 `.select-card.is-unavailable`）
popup.js: 管理字幕模式、AI/provider（含 AI 页当前翻译服务选择，与翻译服务页签主列表双向同步）、会话额度（上限与计量窗口）设置与用量读数、只读模型选择与按服务缓存的模型发现/菜单过滤、日文注音开关、AI 不可用提示（无轨道/读不到轨道/未配置服务）、授权及诊断入口；跨窗口探测 Netflix 页面

popup 只管理全局显示/AI 配置、逐行来源和可选域名授权；按剧集字幕内容与播放状态留在 content，凭证读取与上游请求留在 background。界面语言偏好 uiLanguage 归 i18n.js 独占，popup.js 的 writeSettings 只提交显式改动键，不得写入或清空该键（写整对象或清空 storage 会丢失用户语言选择）。会话额度是全局翻译参数：上限与统计窗口（aiBudgetWindow，默认 session，0 表示该项不限）由 popup 写存储、由 content 按窗口执行；用量只读自 BILAYER_GET_STATE 的 translationBudget 并随既有状态轮询刷新，窗口前缀取该对象的 window 字段（缺失或非法时回落存储设置），popup 不自行计数、不推导时间桶，也不新增轮询或权限。AI 页的当前翻译服务选择器与「翻译服务」页签共用同一份 currentProviders 与同一个 aiProviderId（无第二数据源）：页签改选经 writeProviderControls() 回流刷新选择器，选择器改选即写同一 `{aiProviderId}` 键并立即重渲染选择器自身、页签主列表选中态与就绪提示，随后复用既有状态轮询；删除当前服务沿用既有归一化回退到首个服务，选择器始终至少列出默认服务（storage 驱动路径在列表为空时回落到 DEFAULT_PROVIDERS，不会渲染空选择器），「未配置服务」由上方的就绪警告呈现而非选择器禁用，仅当 provider 列表真为空时（storage 路径外）才渲染禁用的占位项并以 title/aria 说明；它只显示服务名与模型，绝不读取或显示凭证。AI 不可用提示同样只读页面状态：subtitleAvailability 只有明确的 none 才提示该影片无轨道并阻止新选中 AI（unknown/字段缺失一律不警告，轨道可能仍在加载），unread 表示等待后仍读不到轨道列表、只出更柔和的 `.is-soft` 提示（明说「未能读取」而非「没有字幕」，不置 aria-disabled、不禁用源轨道选择，AI 仍可选），providerReadiness.configured === false 仅在已选 AI 模式（aiRole ≠ off）时提示未配置服务，三者优先级 none > 未配置服务 > unread；两处提示由 writeAvailabilityNotice() 单点写出并随既有轮询清除，popup 不自行探测 Netflix 轨道、不代读凭证，也不新增消息协议——不可用只降噪（AI 模式卡片用 aria-disabled 而非原生 disabled，点击改为呈现原因），且不静默改写用户已保存的模式：无轨道只阻止新选中 AI，已保存的 aiRole 保留并在有轨道的影片上恢复，凭证与权限边界不变。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
