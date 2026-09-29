# src/
> L2 | 父级: ../CLAUDE.md

成员清单
i18n.js: 扩展页共享的国际化薄封装，提供 t/apply/uiLanguage/availableLanguages/setLanguage/mountLanguageSwitcher 冻结 API，偏好存于 storage.local.uiLanguage 并从 _locales/<code>/messages.json 同步解析（同步读取被拒时异步补取），自动挂载 [data-i18n-language] 选择器
background/: 扩展后台上下文，负责安装默认设置、旧键迁移、字幕下载兜底及多 provider BYOK 翻译请求
content/: Netflix 页面隔离上下文，负责双原生/原生加 AI 互斥渲染、独立 AI 源轨道、可调前瞻、首句等待、按可配置窗口（session/hour/day）执行并持久化的翻译输入额度与 overlay
diagnostics/: 独立扩展诊断页，开启后台原始报文采集并在宽屏面板查看完整请求体、响应体与请求头
onboarding/: 独立引导与首次安装落地页，负责环境检测、模式分流、AI 端点录入与实机预览
page/: Netflix 页面主世界桥接，负责观察私有播放器请求与元数据
popup/: 四页签弹窗，负责字幕模式切换、全局翻译设置与额度上限/统计窗口及用量读数、provider 增删与独立凭证、AI 页当前翻译服务选择（写 aiProviderId，与翻译服务页签主列表双向同步）、AI 不可用提示（页面状态报告无字幕轨道、读不到轨道或未配置服务时）、兼容域名授权及原始诊断入口

设计边界:
page 只采集 Netflix 页面事实;content 维护模式和字幕播放状态、据页面事实判定字幕可用性与服务就绪、按所选窗口执行并持久化输入额度且回报用量与有效窗口且不读取密钥;popup 分离全局翻译配置、额度上限与统计窗口、服务凭证并提供诊断入口，用量、字幕可用性与服务就绪一律只读页面状态（不自行探测、不代读凭证），仅在弹窗内呈现并引导（无字幕轨道为硬提示并阻止新选中 AI，读不到轨道为软提示且不阻止，未配置服务为可操作提示），AI 页的当前翻译服务选择器与翻译服务页签共用同一份 provider 列表与同一个 aiProviderId（无第二数据源、双向同步，只显示服务名与模型，不读取或显示凭证）;diagnostics 仅在用户显式开启时读取 background 内存中的原始报文;background 隔离凭证并请求上游。uiLanguage 偏好由 i18n.js 独占读写，页面只声明 `[data-i18n-language]` 标记，任何设置保存都不得写入或清空该键。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

