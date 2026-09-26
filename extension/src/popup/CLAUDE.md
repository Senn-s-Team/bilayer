# popup/
> L2 | 父级: ../CLAUDE.md

成员清单
popup.html: 字幕/AI 翻译/样式三页签；双原生/AI 模式选择、独立翻译设置、provider 配置与诊断控件
popup.css: 固定 420x600 的 Neumorphism 基础样式与三页签布局，字幕行状态可完整换行
popup-ai.css: 模式单选与 AI 翻译页局部样式，分隔全局翻译设置和服务凭证表单
popup.js: 以 aiRole 单一状态切换互斥模式；分别管理全局翻译参数和每 provider 配置、授权及日志

popup 只管理全局显示/AI 配置、逐行来源和可选域名授权；按剧集字幕内容与播放状态留在 content，凭证读取与上游请求留在 background。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
