# Bilayer - 流媒体双语字幕与 AI 翻译 Safari 扩展
WebExtension + macOS Safari Extension Packager + 原生浏览器字幕覆盖层

<directory>
extension/ - 浏览器扩展源码 (manifest.json + _locales/ + icons/ + src/ 五个运行上下文)
</directory>

<directory>
SafariApp/ - Apple converter 生成的 macOS Safari App Extension 工程（.gitignore 忽略，不进版本库与分发包）
</directory>

<directory>
scripts/ - 本地检查、图标派生、签名与 Safari 工程生成脚本（不进入扩展运行时）
</directory>

<directory>
cases/ - 真实 provider 畸形回包的解析回归夹具，被 translation-worker.test.mjs 全量校验；字幕文本为合成内容
</directory>

<directory>
.github/ - CI 与发布工作流：CI 在 Node 22/24 上跑 check 与 test，Release 在 v* tag 推送时构建 DMG 并发布
</directory>

<config>
package.json - 项目命令入口，保持零依赖检查链路；版本必须与 extension/manifest.json 一致
</config>

<config>
README.md - 安装、开发、转换 Safari 工程的操作地图（英文主版）
</config>

<config>
README_cn.md - README 的简体中文版，两版章节结构必须逐节对应
</config>

<config>
LICENSE - MIT；CONTRIBUTING.md / SECURITY.md / CODE_OF_CONDUCT.md / CHANGELOG.md - 社区与合规文件
</config>

<config>
.editorconfig - 跨编辑器缩进/换行约定
</config>

<config>
.github/workflows/release.yml - tag 发布流水线，需要 contents: write；tag 推送构建 DMG 并发布 Release，workflow_dispatch 干跑只上传 artifact
</config>

架构决策:
Safari 工程由 `scripts/create-safari-project.sh` 从 WebExtension 源码生成，源码保持跨浏览器格式；Netflix 私有页面状态集中在 page/content 桥接层，字幕解析与 overlay 渲染保持平台无关。aiRole 单一状态在双原生与原生加 AI 之间互斥切换，AI 源轨道可独立于显示的原生行；provider 的名称、端点、模型和凭证作为同一数组条目持久化，全局提示词与预翻译参数不属于 provider，background 只在 worker 内读取凭证。

品牌与身份约束:
产品名、图标与 UI 强调色不得包含第三方商标（App Review 5.2.1 / 2.3.x 拒审风险）。宿主 bundle id 是安装身份的锚点，改名只动显示名不动 bundle id，否则已安装用户的存储、provider 凭证与 Safari 站点授权全部丢失。`netflix-page-bridge.js`、`netflix-track:` scheme 与 Netflix host 权限命名的是目标站点而非品牌，保持原名。

分发包边界:
`extension/` 下的目录树会被 converter 整棵引用进 appex，因此 `scripts/patch-safari-project.mjs` 在生成工程后剥离 `CLAUDE.md` 与测试文件，并只对 Extension target 关闭脚本沙盒（沙盒会以 Operation not permitted 拦截该阶段）。内部文档不得随分发进入用户载荷。

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
2026-09-27: 字幕解析与调度器支持单句硬换行语言感知折叠（保留双人对话破折号）；提示词设置卡片增设日文原字幕注音（振假名）开关，AI 模式协同生成 ruby 注音并回填原声字幕行安全渲染，强化说话人保真约束并清洗孤立花括号；诊断报文默认常态化捕获最近 20 条请求。
2026-09-27: 向导第三步实机视效校准与弹窗「外观」全量设置对齐（字号、自由位置、文字颜色/透明度、背景颜色/透明度、描边颜色/宽度、字体字重），支持第一/第二字幕切换、重置与实时同步。
2026-09-27: 日语注音开关仅在源或目标语言为日文时动态显隐并关闭无关语言注音；支持目标语言为日文时为 AI 译文注音；提示词注入高泛用性片假名/外来语翻译准则，杜绝如「ウルトラ」机械音译为「奥特」。
2026-09-27: 兼容端点解析支持自动容错 Gemini 等模型产生的属性名 typo（如 id/、id\）与行首带符号的 Markdown 代码块；报文面板默认全展开格式化报文、新增一键复制按钮与字幕视效 UI 渲染画板。
2026-09-27: 废弃打补丁式正则与特化举例提示词，采用方案 A 读音映射字典（Reading Map）架构；正文 100% 锚定 Netflix 官方权威字幕无损输出，大模型仅返回 readings 读音字典键值对并由 overlay 精准对齐渲染。

2026-09-27: 原始报文导出改在独立同源框架中触发文件下载，避免 Safari 将 blob 当页面导航；服务模型改用只读选择按钮，展开菜单顶部独立搜索框过滤已获取模型。
2026-09-27: 恢复兼容服务日文注音响应的字符串处理；已保存服务展开模型菜单时按服务发现完整模型目录，顶部搜索过滤且保留当前选择。
2026-09-27: 修复日文注音请求：旧 readings 任意键对象 Schema 允许模型返回 `{}`；现改为固定字段 `[{surface,reading}]` 数组请求契约，后台转换为 overlay 使用的读音映射字典，兼容旧响应格式；提示词明确按同条日文原文或日文译文生成读音，纯假名字幕允许空数组。不保证模型始终生成非空读音。
2026-09-27: 发布 0.2.2 补丁版，同步 WebExtension 与 Safari 工程版本；包含兼容服务日文注音响应修复、模型目录下拉发现及诊断报文导出修复。
2026-09-27: 品牌更名为 Bilayer（原 Netflix Dual Subtitles Safari），移除 Netflix 商标与品牌红以免 App Review 5.2.1/2.3.x 拒审；协议常量改名 bilayer-bridge/bilayer-host/BILAYER_*/window.Bilayer，bundle id 保持不变以保留已安装用户数据；图标改为双层语义（蓝 #4C8DFF 原文层 + 琥珀 #FFB020 译文层），新增 scripts/build-icons.sh 派生 16/32/48/96/128/256/512 全套并接入 npm run icons；版本 0.3.0。
2026-09-27: 开源化加固：新增 MIT LICENSE、CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/CHANGELOG、.editorconfig 与 GitHub Actions CI（Node 22/24）；package.json 补齐 license/engines/repository/keywords；check.mjs 改用 fileURLToPath 修正含空格路径并对 manifest↔package 版本做一致性断言；抽取 scripts/sign-app.sh 统一签名与注册，消除 install-app.sh 内联重复的签名块并移除其中的个人证书、邮箱与绝对路径；新增 scripts/patch-safari-project.mjs 在生成后剥离 appex 内的内部文档与测试文件（含 Extension target 脚本沙盒关闭）；cases/ 与 translation-worker.test.mjs 中的真实影视对白替换为合成内容并保留原有结构畸形；删除未使用的 .env。
2026-09-27: 新增 README_cn.md 作为 README 的简体中文版，两版顶部互加语言切换链接，章节结构逐节对应。
2026-09-27: 新增 WebExtension i18n：manifest 声明 default_locale=en 并把 name/description/action.default_title 改用 __MSG_* 占位符，新增 extension/_locales/{en,zh_CN}/messages.json（各 356 键、键集一致）与 extension/src/i18n.js（暴露 globalThis.i18n.t/apply/uiLanguage，驱动 data-i18n 及 -placeholder/-title/-aria-label 并把 documentElement.lang 同步为 runtime.i18n.getUILanguage()）；popup/onboarding/diagnostics/export 四个页面在自身脚本前加载该模块并统一 lang="en"；内容脚本与页面桥接刻意不本地化，因为它们渲染的是字幕文本而非 UI。converter 已为 _locales 生成 folder reference（Resources 阶段的 "_locales in Resources"），appex 内实测存在 Contents/Resources/_locales/{en,zh_CN}/messages.json，无需补丁。
2026-09-27: 新增 tag 发布流水线 .github/workflows/release.yml：push v* 时在 macos-latest 上校验 tag 与 manifest 版本（scripts/assert-release-version.sh）、生成 Safari 工程、构建 dist/Bilayer-<version>.dmg 并创建或更新 GitHub Release（--notes 的 Gatekeeper 提示由服务端前置到自动 notes，创建后断言存在），workflow_dispatch 只上传 workflow artifact，单一 concurrency 组串行化发布；实测无证书时 xcodebuild 自动使用 ad-hoc「Sign to Run Locally」，产物未公证（spctl 拒绝），两版 README 记录该 Gatekeeper 边界；create-safari-project.sh 将 converter 写入的构建机 SDK 版 MACOSX_DEPLOYMENT_TARGET 统一钉到 12.4（manifest 最高要求为 optional_host_permissions 的 Safari 15.5），宿主 App 与 appex 因此不再随构建机漂移；Xcode 定位收敛到 scripts/xcode-env.sh，覆盖 runner 的 Xcode_<ver>.app 命名与 xcrun 经 PATH 回退的陷阱。
2026-09-27: 删除已安装包重签名脚本及其 npm 命令，并同步清理 package.json、两份 README、scripts/CLAUDE.md 与 CHANGELOG 中的全部引用：安装与更新统一走 npm run install:app（编译 Release → 覆盖 /Applications/Bilayer.app → sign-app.sh 签名 → 打开宿主 App），签名与注册的唯一实现仍是 sign-app.sh；不再保留独立的重签名/扩展注册校验入口，也不再有任何重启流媒体桌面应用的开关。
法则: 极简·稳定·导航·版本精确
