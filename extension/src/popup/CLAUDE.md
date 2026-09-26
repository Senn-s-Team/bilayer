# popup/
> L2 | 父级: ../CLAUDE.md

成员清单
popup.html: 字幕/AI 翻译/样式三页签；双原生/AI 模式选择、独立翻译设置、provider 配置、摘要日志与原始报文面板入口
popup.css: 固定 420x600 的 Neumorphism 基础样式与三页签布局，字幕行状态可完整换行
popup-ai.css: 模式单选与 AI 翻译页局部样式，分隔全局翻译设置和服务凭证表单
popup.js: 管理字幕模式、AI/provider、授权与诊断入口；跨窗口逐一探测 Netflix 播放页，将重载指令固定发给已响应页面，断连时提示 Web App 权限

popup 只管理全局显示/AI 配置、逐行来源和可选域名授权；按剧集字幕内容与播放状态留在 content，凭证读取与上游请求留在 background。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
