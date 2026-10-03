# src/
> L2 | 父级: ../CLAUDE.md

成员清单
i18n.js: 扩展页共享的国际化薄封装，提供 t/apply/uiLanguage/availableLanguages/setLanguage/mountLanguageSwitcher 冻结 API，偏好存于 storage.local.uiLanguage 并从 _locales/<code>/messages.json 同步解析（同步读取被拒时异步补取），自动挂载 [data-i18n-language] 选择器
background/: 扩展后台上下文，隔离 provider 凭证与上游请求，负责本机译文缓存和原始诊断的独立 IndexedDB 存储、授权、分页及清理写入隔离
content/: Netflix 页面隔离上下文，负责字幕渲染、输入额度、源轨道快照及按 occurrence 的精确缓存复用；session 缓存属于播放页，local 存取由 background 执行
diagnostics/: 设置窗口内按需挂载的诊断控制器，查询摘要后按选中项读取完整报文，提供过滤、搜索、JSON 树、字幕视图与完整历史导出；保留同源 export 框架承接下载
onboarding/: 独立引导与首次安装落地页，负责环境检测、模式分流、AI 端点录入与实机预览
page/: Netflix 页面主世界桥接，负责观察私有播放器请求与元数据
settings/: 五页签设置窗口，统一字幕、AI 翻译、翻译服务、外观和内联诊断；AI 页维护缓存保存方式/策略/保留上限及管理动作，页面状态只提供用量、可用性与命中，不投射凭证
styles/: 扩展页共享的设计令牌（tokens.css）与控件唯一基线（controls.css），由 settings.html 和 onboarding.html 在各自组件样式表之前加载；内联诊断复用 settings 的共享层

设计边界:
page 只采集 Netflix 页面事实；content 负责字幕时间线、按窗口持久化输入额度和会话译文缓存，不读取凭证；background 执行上游请求并报告实际语义元数据，译文缓存与诊断历史使用独立对象存储和清理世代，清理互不影响。settings 从同一份 providers/aiProviderId 设置选择翻译服务，字幕可用性与服务就绪只读页面状态；诊断仅在首次选中时挂载，页签活跃且窗口可见才轮询，历史只对自身 settings URL 授权。缓存复用以剧集、源语言/类型、完整目标语言和有效自定义提示词为硬条件，服务信息只作来源记录，重复句按 occurrence 保存；仅缓存策略由 content 与后台双重阻止未命中请求。uiLanguage 偏好由 i18n.js 独占读写，页面只声明 `[data-i18n-language]` 标记，设置保存不得覆盖该键。styles/ 是明暗令牌和控件基线的唯一来源，页面样式仅保留布局及变体。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

