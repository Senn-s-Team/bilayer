# netflix-dual-subtitles-safari - Netflix Safari 双字幕扩展
WebExtension + macOS Safari Extension Packager + 原生浏览器字幕覆盖层

<directory>
extension/ - 浏览器扩展源码 (1子目录: src...)
</directory>

<directory>
SafariApp/ - Apple converter 生成的 macOS Safari App Extension 工程
</directory>

<directory>
scripts/ - 本地检查与 Safari 工程生成脚本
</directory>

<config>
package.json - 项目命令入口，保持零依赖检查链路
</config>

<config>
README.md - 安装、开发、转换 Safari 工程的操作地图
</config>

架构决策:
Safari 工程由 `scripts/create-safari-project.sh` 从 WebExtension 源码生成，源码保持跨浏览器格式；Netflix 私有页面状态集中在 page/content 桥接层，字幕解析与 overlay 渲染保持平台无关。aiRole 单一状态在双原生与原生加 AI 之间互斥切换，AI 源轨道可独立于显示的原生行；provider 的名称、端点、模型和凭证作为同一数组条目持久化，全局提示词与预翻译参数不属于 provider，background 只在 worker 内读取凭证。

变更日志:
2026-07-25: 创建 Safari WebExtension 源码项目，加入 Netflix 双字幕 MVP 架构。
2026-07-25: 发现本机 Xcode 26.5，生成 SafariApp 工程并补充图标管线。
2026-09-20: 修复 Safari 全屏模式下双字幕不显示，新增 fullscreenMount 模块并接入 overlay.mount()，版本 0.1.3。
2026-09-26: 字幕轨道各自就绪即显示，隔离过期加载结果；content 仅接收/返回已知设置，加入内容脚本行为回归测试。
2026-09-26: 增加双字幕可切换 AI 原文/译文位置、OpenAI BYOK 凭证隔离、首句限时等待、播放窗口调度与会话预算；字幕存储合并同轨下载并阻止切集旧缓存污染。
2026-09-26: 重构为逐行字幕来源选择，禁止两行同时依赖 AI；支持用户授权的 OpenAI-compatible Chat Completions 地址与本机 HTTP 开发端点，兼容请求不发送 OpenAI 专属 JSON Schema。
2026-09-26: 目标语言改为固定列表，AI 使用默认可编辑翻译提示词，并在弹窗展示当前会话的完整请求生命周期日志。
2026-09-26: 支持多 provider 增删切换、每 provider 独立端点/模型/凭证、AI 独立源字幕轨道，并移除旧单 provider 键；版本 0.1.4。
2026-09-26: provider 设置新增连通性测试，使用真实 Chat Completions 请求验证当前模型、端点和凭证。
2026-09-26: provider 支持 Base URL 自动规范化、/models 模型列表发现；翻译与连通性测试均使用 Chat Completions API，不使用 Responses API。
2026-09-26: 借鉴沉浸式翻译的影视字幕约束，保留 ID 和上下文边界；调度器将播放前方预取窗口扩大至 60 秒，倍速上限 120 秒。
2026-09-26: 迁移已持久化的旧默认提示词；用户自定义提示词保持不变，后台不再把旧默认文本作为自定义风格重复注入。
2026-09-26: 日志显示累计条数、扩大滚动窗口；单批翻译失败后继续预取后续字幕。
2026-09-26: 翻译请求按编号记录后台配置、域名授权、HTTP 状态/耗时、解析和 ID 校验阶段及脱敏失败原因；同集切换 provider 保留既有链路日志。
2026-09-26: 字幕层逐帧复用未变化的 DOM 节点，避免播放期间重复销毁和重建字幕行。
2026-09-26: 增设 AI 翻译页并把全局提示词、语言、前瞻设置从 provider 表单移出；字幕页以 aiRole 互斥切换双原生与原生加 AI，预翻译默认 10 句组且受 60-120 秒时窗约束，前后文每侧默认 2 条。
2026-09-26: 每次翻译请求成功或失败时记录端到端 durationMs，与后台仅记录 HTTP 响应耗时的 provider_stage 区分。
2026-09-26: 新增独立宽屏原始报文诊断页，显式开启后保留最近 20 次翻译请求/响应，支持查看完整请求体、响应体和非敏感头部；Authorization 只留在 background。
2026-09-26: 修复 popup 新增诊断入口时遗漏 translationLog 元素映射导致初始化异常；活动页面查询增加 Safari PWA 回退。
2026-09-26: 原始报文面板默认格式化请求/响应 JSON 及其内嵌 content JSON，并保留逐字原文切换。
2026-09-26: 修正原始报文页隐藏占位区仍占 570px 的布局错误；请求侧栏按内容收缩，滚动时保持可见。
2026-09-26: 原始报文页改为 Network 风格请求检查器，最新请求优先，状态摘要与 JSON 阅读区分离，避免嵌套卡片和多余滚动。
2026-09-26: 修复兼容 Chat Completions 返回单条 `{id,text}` 时误报 invalid_response；显式约束完整 items 结构，多字幕结果仍严格校验数量及 ID。
2026-09-26: 兼容端点支持解析逗号分隔的多条 `{id,text}` 响应；只在完整匹配请求数量与 ID 后进入字幕缓存。
2026-09-26: 诊断页借鉴 fx 的交互查看方式，增加 JSON 折叠树、键盘路径导航和长字符串展开，原始报文保持可切换。
2026-09-26: 修复弹窗因 Safari 当前窗口含非 Netflix 标签页而停止查找播放页；跨窗口探测可响应的 Netflix 页面并提示 Web App 权限。
2026-09-27: 新增独立新手引导落地页 onboarding.html，首次安装自动唤起三步流程（环境与权限握手、双原生/AI 模式分流与端点连通性测试、实机视效微调）；popup 增加向导复查入口。

法则: 极简·稳定·导航·版本精确
