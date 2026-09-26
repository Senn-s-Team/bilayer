# popup/
> L2 | 父级: ../CLAUDE.md

成员清单
popup.html: 逐行原生/AI 来源选择、独立 AI 源语言、固定目标语言列表、多 provider 编辑、连通性测试、/models 模型发现、可编辑默认提示词、完整翻译日志和 BYOK 密钥控件的语义结构
popup.css: 固定 420x600 的 Neumorphism 弹窗样式，轨道错误状态可完整换行，provider 模型列表与样式页预览常驻、设置区独立滚动
popup.js: 逐行来源、provider 配置与迁移、Base URL、/models、连通性测试及带条数的翻译日志展示

popup 只管理全局显示/AI 配置、逐行来源和可选域名授权；按剧集字幕内容与播放状态留在 content，凭证读取与上游请求留在 background。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
