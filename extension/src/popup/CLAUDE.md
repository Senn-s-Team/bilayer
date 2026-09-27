# popup/
> L2 | 父级: ../CLAUDE.md

成员清单
popup.html: 字幕/AI 翻译/外观/服务分栏；服务模型采用只读触发按钮和下拉顶部过滤框，另含向导与诊断入口
popup.css: 固定 420x600 的 Neumorphism 基础样式与三页签布局，字幕行状态可完整换行
popup-ai.css: 模式单选与 AI 翻译页局部样式，包含模型下拉菜单与过滤输入框
popup.js: 管理字幕模式、AI/provider、只读模型选择与按服务缓存的模型发现/菜单过滤、日文注音开关、授权及诊断入口；跨窗口探测 Netflix 页面

popup 只管理全局显示/AI 配置、逐行来源和可选域名授权；按剧集字幕内容与播放状态留在 content，凭证读取与上游请求留在 background。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
