# Bilayer - 流媒体双语字幕与 AI 翻译 Safari 扩展
WebExtension + macOS Safari Extension Packager + 原生浏览器字幕覆盖层

<directory>
extension/ - 浏览器扩展源码 (manifest.json + _locales/ + icons/ + src/：background/content/page/settings 运行上下文、diagnostics/onboarding 两个扩展页与共享 styles/ 设计层)
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
2026-07-25: 发现可用的 Xcode，生成 SafariApp 工程并补充图标管线。
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
2026-09-27: 扩展新增界面语言切换器：偏好键 runtime.storage.local.uiLanguage（auto 默认跟随 Safari，可选 en、zh_CN），extension/src/i18n.js 统一挂载 [data-i18n-language]（弹窗侧栏与新手引导头部各一个），切换即持久化并重载页面；_locales/{en,zh_CN} 同步扩到各 361 键、键集一致。
2026-09-27: 新手引导 AI 步骤新增获取模型能力，与 popup 的「获取模型」共用 background 的 BILAYER_LIST_MODELS 协议。
2026-09-27: 向导视效步骤与弹窗「外观」对齐，补上行高/最大宽度滑杆、与 popup 一致的预览计算与可用的文字/背景/描边取色块，并定义此前缺失的 --accent-deep 变量。
2026-09-27: 修复向导第三步终止于无效按钮的死路，最后一步改为页内完成态（保存就绪 ✓）并保留关闭出口。
2026-09-27: 修复 preset-chip 共用处理器误绑角色/重置/排版 chip 导致其失效，现仅绑定带 data-preset 的 chip。
2026-09-27: 向导临时 onboarding-test provider 在写入 provider 列表前剔除，不再落盘。
2026-09-27: 两份 README 的 UI 位置名称按各自语言与 locale 对齐：英文版引用 en 文案、中文版引用 zh_CN 文案，行文与结构保持逐节对应。
2026-09-27: 去除文档与脚本注释中的本机专属信息：两份 README 的「全局切换 Xcode」示例不再写死本机版本目录名，改用通用 /Applications/Xcode.app 并注明目录名不同时需替换、create-safari-project.sh 与 xcode-env.sh 已自动探测 Xcode.app / Xcode-<version>.app / Xcode_<version>.app；scripts/create-safari-project.sh 与 scripts/xcode-env.sh 中把写死的开发机 Xcode 版本与常用目录等措辞改为通用示例。
2026-09-28: 图标换用维护者提供的字形本体：extension/icons/icon-source.png（1024² 方形 RGBA，两条圆角字幕气泡夹播放三角的 B 形标记，无外层方形底板）取代 icon.svg 成为唯一手工维护源，icon.svg 删除；制作规则写进 extension/icons/CLAUDE.md（以 alpha>=8 的 4-邻接连通域剔面积 < 最大连通域 0.5% 的分离颗粒，裁到内容包围盒 901x921，盒内与整幅 alpha<8 归零，sips -Z 900 得 880x900 后居中放入 1024²，上下留白 62 px、左右 72 px），换图沿用同一步骤；build-icons.sh 改用该源并在派生前列为错误拒收被压平或缺 alpha、非方形的源图，重派生 16/32/48/96/128/256/512 全套；manifest 图标表新增 1024 条目直接指向源图本身（不产生派生副本、SIZES 不变），Safari converter 因而改用原生 1024 绘制宿主 App 的 1024 槽位，取代此前 icon-512 放大 1.199 倍的结果（614 px 图形盒上与原生下采样的最大偏差由 142 降到 3 个 RGB 单位）；版本号与 UI 强调色 token 未改动。
2026-09-28: 两份 README 新增「Credits / 致谢与非原创内容」与「Roadmap / 路线图」两节，章节与行结构逐节对应。致谢节按仓库证据记录非原创与借鉴部分：变更日志已记的影视字幕约束（沉浸式翻译 / Immersive Translate，保留 ID 与上下文边界）、诊断页 JSON 查看器交互（记为「借鉴 fx」，仓库未指明上游项目故按交互风格参考致谢）、弹窗 Neumorphism 与扩展页面的 macOS/Apple 材质动效语言（字体栈、backdrop-filter、弹簧缓动，属样式非代码）、按可观察行为重新实现的 Netflix 字幕轨道观察与自有 `netflix-track:` 方案（不含 Netflix 源码或素材）、OpenAI 兼容 Chat Completions 契约（严格 json_schema 与 cases/ 脱敏畸形回包容错解析）、Apple 工具链（safari-web-extension-converter / sips / plutil / PlistBuddy）、无任何第三方内置源码或授权素材（package.json 无依赖、无 lockfile/node_modules、无外置字体）、图标美术由维护者提供、以及既有的商标边界。路线图节只作计划不作承诺，且按引擎分开给结论：Chromium 经真实加载验证（Chrome for Testing 153.0.8010.12 解包加载未修改的 extension/，无 manifest/控制台报错，弹窗四页签与已存设置正常、后台消息往返成功、Netflix 播放页内容脚本启动且主世界桥接经 web_accessible_resources 注入成功、_locales 同步 XHR 返回 200），无需任何代码或 manifest 改动，品牌版 Chrome 已移除 --load-extension 属测试路径限制而非移植问题；Firefox 属小到中等移植（MV3 无 background.service_worker 需事件页且会改变 Safari 后台上下文偏好、需 gecko.id 与商店数据收集声明、host 权限安装时可拒绝需 permissions.contains/request 恢复路径、window.Bilayer 跨内容脚本共享未验证）。读码确认项：manifest 仅 MV3 service_worker 且无 browser_specific_settings、optional_host_permissions 与 permissions.request 调用点均同步位于点击处理器内（用户手势要求已满足）、诊断缓冲及版本/序号镜像 storage.local 而 rawCaptureEnabled 是唯一未持久化的模块级标志（用户关闭采集后 worker 被回收会静默重开，用户可见，一行可修）、worker 无 setInterval/保活/alarm 仅单次请求 fetch 中止、web_accessible_resources 为对象形式、_locales 键集一致且 i18n 经 runtime.getURL 读包内文案。仍属假设：Firefox 全程未实测（本机无 Firefox 二进制）、手势授权弹窗/已登录播放页/worker 回收/商店审核均未跑到。初稿曾误判 Chromium 难度高并误称 permissions.request 调用点位于 await 之后，已按真实加载与读码结果更正；另列更多视频站点（桥接与适配器仅 Netflix，工作量最大）与文档截图（暂无 docs/，需维护者提供素材）两项中性候选。同步在 CHANGELOG 的 Unreleased/Added 记一条。
2026-09-28: 修复原始报文采集开关不持久化的隐私缺陷：rawCaptureEnabled 此前只存在于模块级变量，用户在诊断页关闭采集后，后台 service worker 被回收重启即静默恢复为开启（诊断页会重新渲染 enabled: true）；现按既有命名新增 `__raw_capture_enabled__` 存储键，随诊断缓冲、版本号、序号一起经 persistRawDiagnostics() 落盘、经 loadRawDiagnosticsIfNeeded() 读回（未设置默认 true），BILAYER_SET_RAW_DIAGNOSTICS 先 await 加载再写入并回写存储；翻译路径在采集判断前新增 `await loadRawDiagnosticsIfNeeded()`，保证重启后首个翻译请求也不会用陈旧的默认开启做采集决策。translation-worker.test.mjs 新增重启回归（关闭开关、重启后首个翻译请求不采集、第三次重启仍为关闭、未设置默认开启），并让假存储真正共享写入以支持重启模拟；版本号未改动。
2026-09-28: 加固原始报文采集开关的读取语义（承接同日持久化修复暴露的两处残留风险）。其一，读取失败此前 fail-open 并自我闩锁：storage.local.get 抛错时 catch 只置“已加载”而不读键，`rawCaptureEnabled` 保持模块默认 true，且闩锁使该 worker 此后永不重试，用户持久化的关闭被静默忽略，而采集载荷含字幕文本。现改为“未读取即未知”：`rawCaptureEnabled` 初值 false（未知一律 fail-closed，模块初值绝不表示开启）；读取失败（抛错或 runtime.runtime.lastError）不置采集值、不缓存失败，模块级 promise 清空使下一次调用重试，重试成功前保持不采集；读取成功才采用持久化值，键缺失时仍为文档默认 true；用户显式切换仍立即生效且在其 worker 生命周期内权威。其二，BILAYER_SET_RAW_DIAGNOSTICS 此前先 await 加载再赋值落盘，与竞态的翻译请求交错不可局部证明；现改为单飞加载 promise + `capturePreferenceSetByUser` 标志：SET 同步赋值并立即落盘，不等待仍未完成的读取；读取随后落地时若用户已切换则跳过赋值。SET 只单独写 `__raw_capture_enabled__`，避免缓冲尚未读回时用空 `__raw_diagnostics__` 覆盖已存记录；GET 与 translate 仍 await 同一加载 promise，故永不读到模块初值。规格写入 extension/src/background/CLAUDE.md 与 service_worker.js 的 L3 头部。translation-worker.test.mjs 新增 4 个可观察行为回归：读取抛错时翻译成功但不采集且 GET 报 enabled:false、后续请求重试并在读回持久化值后恢复采集（同时断言读取次数证明未闩锁）；读取挂起时用户切换立即落盘且迟到的相反值不得覆盖、并发翻译不采集；翻译先于切换时不崩溃且落盘为用户值、用户开启后恢复采集；翻译先于读取落地时仍等待读取并以缺失键默认开启采集。harness 的假存储新增可注入 get 行为以模拟抛错/挂起读取，并支持带覆盖的回退读取。同轮评审又发现同类的写入侧漏洞并一并修复：persistRawDiagnostics() 此前无条件写 `__raw_capture_enabled__`，而 CLEAR 处理器不等待加载，fresh worker 上首条 CLEAR 会把 fail-closed 的 false 占位值写进存储、静默翻转用户从未读到的偏好；现引入 rawCapturePreferenceKnown（读取成功或用户切换过才为真），仅在该值为真时才随缓冲落盘开关键（缓冲/版本/序号三键照常写入），并让 BILAYER_CLEAR_RAW_DIAGNOSTICS 与 GET 一致先 await 单飞读取再清空落盘，因此其写的是用户实际持有的值；translation-worker.test.mjs 再增 3 个 CLEAR 回归（首条消息清理不得写入 false 占位值、清理与在途读取竞争后写入读回值、读取失败后清理完全不写开关键且不闩锁）。`npm run check` 通过，translation-worker.test.mjs 37/37 通过；版本号未改动。
2026-09-28: 会话翻译输入护栏改为可配置：新增 `aiRequestBudget`（默认 80，0–1000）与 `aiCharacterBudget`（默认 40000，0–1000000）两个存储键，0 表示该项不限，缺失或非法值回落默认；content 侧按 `watchId:subtitleEpoch` 会话执行并在 `BILAYER_GET_STATE` 顶层返回 `translationBudget{requestsUsed,charactersUsed,requestLimit,characterLimit,exhausted}`（不限侧为 null，exhausted 为 null|requests|characters），弹窗 AI 页在预翻译/前后文字段旁新增两个输入框与随既有状态轮询刷新的用量读数（缺页面时显示 0 用量与配置上限，`budget_exceeded` 时状态行点名是哪一项上限并带出数字），会话中途提高上限即恢复翻译、降低到已用量以下立即停发；`_locales` 双语各扩到 368 键、键集一致，两份 README 的 AI 段落与 CHANGELOG 同步，版本号未改动。
2026-09-28: 修复会话额度以页面/字幕世代记账、刷新即清零导致上限形同虚设的设计缺陷，改为可配置窗口并持久化：新增 `aiBudgetWindow`（`session`|`hour`|`day`，默认 `session`，缺省或非法回落 `session`），`session` 为当前观看页/剧集并跨刷新同一剧集继续累计，`hour`/`day` 为本机时间分桶且同样跨重载；用量按窗口键（`session:<watchId>`/`hour:<YYYY-MM-DDTHH>`/`day:<YYYY-MM-DD>`）落在 `runtime.storage.local.__ai_budget_usage__`，派发前与其它同窗口标签页对齐（不再仅存内容页内存，刷新页面与重开弹窗都接着累计），`BILAYER_GET_STATE.translationBudget` 增加可选 `window`（生效窗口 id）与 `windowKey`（具体锚点）字段；弹窗 AI 页「调度与语境」卡片在两项上限旁新增 `select#aiBudgetWindow`（跨列独占一行、与相邻 select 同套样式），随其他 AI 设置一并持久化并经 normalizeSettings 归一化，读数改为「<窗口>：请求 x / y · 字符 x / y」并按页面状态的 `window` 标明计量窗口（字段缺失时回落存储设置，无连接页面仍显示 0 用量与配置上限）；两项上限文案去掉「单次观看」字样以匹配可配置窗口，`_locales` 双语各扩到 373 键且键集一致，两份 README 的额度段落与 CHANGELOG 的 [Unreleased] 同步，版本号未改动。
2026-09-28: 弹窗新增 AI 不可用呈现（承接「无字幕轨道则 AI 不可用」与「未配置服务需就地提示」两项要求）：只读页面状态新增的 subtitleAvailability（unknown|none|available）与 providerReadiness({configured, notice})，字段缺失一律按旧行为不警告、unknown 也绝不提示（轨道可能仍在加载）；字幕页模式卡片下与 AI 页顶部共用同一提示块，该影片无轨道时显示 aiUnavailableNoTracks 与解释、把 AI 模式卡片标记 aria-disabled 并褪色、禁用 AI 源轨道选择，并阻止在该状态下新选中 AI 模式——已保存的 AI 选择刻意保留（不静默改回原生，切到有轨道的影片即恢复生效），点击该卡片不做静默失败，而是切到 AI 页并把焦点交给解释块；已选 AI 模式但服务未配置时显示 aiUnavailableNoProvider 与指向「翻译服务」页签的解释及按钮（复用既有 aiConfigureProviders 文案）。两处提示由 writeAvailabilityNotice() 单点写出、随既有状态轮询在条件消失后自动清除，popup 不新增轮询/消息协议，也不自行探测轨道或代读凭证。_locales 双语各扩到 379 键且键集一致（新增 noticeProviderMissing、noticeSubtitleTracksMissing、aiUnavailableNoTracks(+Hint)、aiUnavailableNoProvider(+Hint)，前两者供后台/overlay 字幕位置提示复用），两份 README 的 AI 段落与 CHANGELOG 的 [Unreleased]、extension/src/CLAUDE.md 与 popup/CLAUDE.md 同步，版本号未改动。
2026-09-29: 新增第四个字幕可用性状态 `unread`（承接「读不到播放器轨道列表」的停顿场景）：等待播放上下文约 20 秒后仍读不到轨道时，页面状态不再停留于 unknown 而报 unread；弹窗把它渲染为更柔和的提示——明说「未能读取」而非「没有字幕」，建议刷新页面或改播其他影片，且 AI 模式卡片保持可选（不置 `aria-disabled`、不加 `is-unavailable`，源轨道选择也不因该状态新增禁用理由），只有明确的 none 才照旧阻止新选中 AI；`BILAYER_AI_READINESS` 载荷新增 `unreadNotice` 供 overlay 在字幕位置提示（文案键 noticeSubtitleTracksUnread）；_locales 双语各扩到 382 键且键集与顺序一致（新增 noticeSubtitleTracksUnread、aiUnavailableTracksUnread(+Hint)），两份 README 的 AI 段落与 CHANGELOG 的 [Unreleased] 同步，版本号未改动。
2026-09-29: 弹窗 AI 页新增「当前翻译服务」选择器（`select#aiProviderSelect`，位于 AI 页顶部新的「翻译服务」卡片），选项来自 currentProviders（名称 + 模型）、值为生效的 aiProviderId，改动即写入与「翻译服务」页签相同的 `{aiProviderId}` 键并立即重渲染选择器自身、页签主列表选中态与 AI 页就绪提示，再经既有 `scheduleStatePoll(0)` 让 content 侧的 readiness/翻译跟上（不新增协议）；与「翻译服务」页签双向一致——在页签改选经 writeProviderControls() 回流到此，删除当前服务沿用既有归一化回退到首个服务；选择器始终至少列出默认服务（storage 驱动路径在列表为空时回落 DEFAULT_PROVIDERS，不会为空），「未配置服务」由就绪警告呈现而非选择器禁用，仅当 provider 列表真为空时（storage 路径外）才渲染禁用的占位项并以 title/aria 说明，所选服务缺凭证时复用既有就绪警告（不新增第二条提示），且绝不读取或显示凭证。`_locales` 双语各扩到 387 键、键集与顺序一致（新增 aiProviderSection/aiProviderSelect/aiProviderNone/aiProviderEmptyHint/aiProviderHelp），两份 README 的 AI 段落、CHANGELOG 的 [Unreleased]、extension/src/CLAUDE.md 与 popup/CLAUDE.md 同步，版本号未改动。
2026-09-29: 发布 0.3.5：extension/manifest.json 与 package.json 版本同步升至 0.3.5，CHANGELOG 的 [Unreleased] 整节折叠为 `## [0.3.5] - 2026-09-29`（Added/Changed/Fixed 分组与措辞原样保留）并在底部链接块补上 `[0.3.5]: compare/v0.3.0...v0.3.5`、[Unreleased] 改为从 v0.3.5 起算，extension/CLAUDE.md 的「当前版本」与两份 README 的发布 tag 示例同步到 0.3.5。本版内容：图标换用维护者提供的 icon-source.png 字形本体（1024² 单一手工源取代 icon.svg，manifest 新增 1024 条目直指源图，七张派生图重生成）；新增界面语言切换器（uiLanguage：auto/en/zh_CN，i18n.js 自动挂载 data-i18n-language）与新手引导获取模型、末步完成态、外观校准对齐及 preset-chip 误绑等修复；会话翻译输入护栏可配置并改为窗口化持久化（aiRequestBudget/aiCharacterBudget/aiBudgetWindow，弹窗 AI 页带实时用量读数，session 跨刷新继续累计）；修复原始报文采集开关重启后静默复活及其读取 fail-open 自我闩锁两处隐私缺陷（`__raw_capture_enabled__` 落盘、未读取即 fail-closed 且失败可重试）；新增 AI 可用性/就绪提示（subtitleAvailability 的 none 与 unread 停顿态、providerReadiness 未配置提示）与弹窗 AI 页「当前翻译服务」选择器；两份 README 新增 Credits/Roadmap 节；_locales 双语各扩到 387 键且键集与顺序一致；test 脚本扩充并新增 scripts/i18n.test.mjs 与 scripts/onboarding.test.mjs。
2026-09-29: 设置界面从工具栏弹窗改为独立常驻窗口，并把跨页样式收敛成共享设计层。extension/manifest.json 删除 action.default_popup（action 只剩 default_title）：只要该键还在，浏览器就自己开弹窗并吞掉 action.onClicked，故必须删键才能拿回工具栏点击（service_worker.js:177 的注释即此理由）。service_worker.js 新增常量 SETTINGS_PAGE = "src/settings/settings.html"（:34）、runtime.action.onClicked（:178）、runtime.runtime.onStartup（:180）与 BILAYER_OPEN_SETTINGS 消息（:203），三者共用 openSettingsWindow()（:902）：先 windows.getAll({populate:true}) 按 URL 命中即 windows.update({focused:true}) 聚焦（重复点击不叠窗），否则用记住的窗口 id（SETTINGS_WINDOW_KEY = "__settings_window_id__"，:867）经 windows.get 校验后聚焦，否则 windows.create({type:"popup", width:1240, height:940, url})（:932）建窗，windows API 缺失或调用失败时回落 runtime.tabs.create；窗口 id 优先记在 storage.session（会话结束即失效），不支持时退 storage.local 并由 onStartup 作废，避免跨会话拿旧 id 去聚焦无关窗口（:870 注释）。为什么旧授权谓词必须改：isAllowedTestSender()（:951）原先靠「URL 匹配且 !sender.tab」识别弹窗，而独立窗口里的文档与标签页文档一样都带 sender.tab，旧写法会让「测试连通性」「获取模型」「AI 就绪度」在新形态下被静默判成 configuration；现改为 sender.id === runtime.runtime.id 且 URL 命中 settings.html 或 onboarding.html 白名单（:955），身份仍是必过项，不放宽到任意扩展页或网页。常驻窗口带来两处工程加固（settings.js）：scheduleStatePoll()（:1504）在 setTimeout 回调首行按 document.hidden 早退（:1511）——窗口在后台停留时不得发起任何 tabs.query/sendMessage，隐藏期间到期的轮次直接作废，链本身由 visibilitychange（:306-307）在重新可见时经 scheduleStatePoll(0) 立刻接上；provider 的三处整数组写入（updateProviderField :1168、saveNewDraftProvider :1050、deleteProvider :1112）改用 readLatestProviders()（:1619）先读回存储里的最新 providers 再按 id 合并——providers 是整数组键、新手向导同样整组写，陈旧快照会整体抹掉向导期间新增的服务（剔除后为空则回落 DEFAULT_PROVIDERS 的克隆）。模块改名：extension/src/popup/ → extension/src/settings/，popup.html/css/popup-ai.css/popup.js → settings.html/settings.css/settings-ai.css/settings.js，scripts/popup.test.mjs → scripts/settings.test.mjs，_locales 中 10 个 popup* 键 → settings* 键（两份报文仍键集一致）。新增共享设计层 extension/src/styles/：tokens.css（:4）只声明自定义属性、不产生选择器副作用，primitives 与 semantic 两层令牌并存，:root 是浅色分支、@media (prefers-color-scheme: dark) 用同一组变量名覆盖同名令牌，color-scheme 因此只声明一次；controls.css 是控件唯一基线（开关/range/color/select/文本类输入/按钮三档，各含 hover/active/focus-visible/disabled 四态与同一枚 focus ring），settings.html/onboarding.html/diagnostics.html 三个页面都在自身组件样式表之前以 <link> 依次加载这两层，并各自删掉本地调色板与重复控件实现（页面样式表只保留布局与变体覆盖）。布局：设置窗口默认 1240×940、可缩放（有头 Chrome 实测该高度是窗口外高，标题栏约吃掉 88px，内高约 852；1180×860 会让内容约 749 的 AI 页重新出现面板内滚动，故抬高到 940 让四个页签都不滚动），html,body 填满视口且禁止页面级滚动，.tab-panel 是唯一滚动源；≥900px 字幕页两列、AI 页四张卡片 2×2、翻译服务页主/详分栏，≤820px 左侧栏退化为顶部 tab bar，外观页不再有第二层嵌套滚动。用户可见变化：明暗改为跟随系统——此前 :root 固定深色属历史写法，现在浅色是默认分支、深色由 prefers-color-scheme 覆盖。extension/CLAUDE.md、extension/src/CLAUDE.md（新增 styles/ 条目）、settings/CLAUDE.md、background/CLAUDE.md（新增开窗与授权段）、content/CLAUDE.md、onboarding/CLAUDE.md、diagnostics/CLAUDE.md 与 scripts/CLAUDE.md 同步，两份 README 的设置界面称谓与 CHANGELOG 的 [Unreleased] 同步，版本号未改动。同日续（侧栏加宽）：.app-shell 首列由固定 168px 改为 clamp(180px, 17.5%, 224px)（1240 宽约 217px、1000 宽约 180px），并删除为挤进 168px 而留的补丁——.sidebar-language-label 与 .sidebar-language-select 的负外边距、width: calc(100% + 12px) 补偿与 letter-spacing: -0.02em 一并去掉，下拉返回 controls.css 基线自绘箭头；.tab-button 横向内边距加大一档（--bl-space-6）、行高提到 38px（扁平选中态与焦点环不变）；翻译服务页宽视口主列 --split-master 200px→240px（settings-ai.css）。openSettingsWindow() 窗口宽度 1180→1240（height 940 不变）以在侧栏变宽后保持内容列宽度，四页签仍不出现面板内滚动；实测 1240×852 下侧栏 217px、内容列 1023px、四页签 scrollHeight=clientHeight=780、页面级 852=852，1000 宽下侧栏 180px、≤820px 仍退化为顶部 tab bar，翻译服务页主列 240px/详情 733px 且无嵌套滚动，.app-shell 计算列宽与 216/216 测试均通过；settings/CLAUDE.md、background/CLAUDE.md、CHANGELOG 与两份 README 同步，版本号未改动。
2026-09-29: 设计方向由「玻璃双层壳（Doppelrand）」整体切换为「扁平工程风」，并修复 i18n auto 分支的占位符缺陷。(1) 用户要求去掉圆润的仿玻璃质感，产品由「透明边框 + background-clip 分层（外托/内芯）+ 顶部高光 + 侧栏磨砂 + 铝托反光 + 大圆角 + 多层漫射阴影」改为「一层不透明表面 + 1px --border 发丝外框 + 圆角阶梯 + 仅浮层一枚收敛阴影」，层级只靠发丝线与表面色差表达。(2) tokens.css：圆角阶梯收为 `--bl-radius-2xs/-xs/-sm/-md/-lg/-xl` = 2/3/4/6/8/10px（无胶囊档，:97-102）并新增三枚角色别名 `--radius-tag`(2px 徽标/标签/进度条/字幕行)/`--radius-control`(4px 按钮/输入/分段/列表行)/`--radius-surface`(6px 面板/卡片/浮层，窗口级外壳取 `--bl-radius-xl`)(:104-107)；删除 35+ 个玻璃令牌（`--bl-bezel*`、`--bl-radius-shell*/core*/2xl/pill/circle`、`--shell-ring*`、`--shell-tray`、`--core-base`、`--core-sheen*`、`--core-ring`、`--rail-sheen`、`--groove-ring`、`--groove-inset`、`--switch-inset`、`--thumb-shadow`、`--shadow-soft*`、`--shadow-card`、`--shadow-header`、`--shadow-accent`、`--accent-glow`、`--stage-frame*`、`--stage-sheen`、`--stage-inset`、`--surface-blur`、`--bl-shadow-lg` 等），保留并作为扁平契约骨架的只有内凹槽底色 `--groove`、唯一浮层阴影 `--shadow-popover` 与浅色下 JSON 数值对比度用的 `--syntax-number`；字体栈去 `"Helvetica Neue"`、`--bl-ease-standard` 由 `ease` 改 `cubic-bezier(0.32,0.72,0,1)`，两处对比度修正（`--bl-blue-600 #2f6fe4→#2b66da`、`--bl-green-700 #14883f→#0f7a38`）与明暗单一事实来源（:root 浅色 / prefers-color-scheme 覆盖）不变。(3) settings.css：卡片（`.settings-list/.track-grid/.style-section/.ai-section`）= 一层 `--surface` 底 + 1px `var(--border)` + `--radius-surface`(6px)，无透明边框/无 background-clip/无顶部高光/不投影（:40 起注释），hover 只把外框提到 `--border-strong`；内凹槽组（`.ai-toggle-list/.provider-editor/.ai-credential/.preset-list/.role-selector` 与分段底槽）= `--groove` 底 + 1px 发丝边 + `--radius-control`(4px)；settings-ai.css 用同一构造做翻译服务主/详分栏与模型菜单浮层（唯一 `--shadow-popover`）；侧栏「向导/诊断」的 `↗` 由玻璃期 20px 小圆改为 20px 方形小件（`--bl-radius-2xs` + `--groove`，settings.css:294-303），仍 hover 斜向位移并放大；动效基元 `@keyframes bl-rise/bl-breathe/bl-pop`（只动 transform/opacity）与 controls.css 末尾三页共享的 `prefers-reduced-motion` 兜底保留不变。(4) diagnostics.css 由 960 行按语义拆为 diagnostics.css（外壳/列表/详情）+ diagnostics-payload.css（报文区/JSON 树/视效预览），diagnostics.html 的 link 顺序为 tokens→controls→diagnostics→payload，两者各自 <800 行；并删除 CSS `content:` 里硬编码的中文 `" · 已折叠"`，折叠标记改由几何 chevron（border + 旋转）表达，语言中立。(5) onboarding.css：窗口 `100vh/92vh→100dvh/92dvh`、`.step-viewport` 成唯一滚动源（底栏不再被内容压住）、7 处内联样式归位为类（.is-hidden/.is-invisible/.select-card.is-static）、emoji `👁` 换成同规格内联 SVG、假交互卡片改用 `.is-static` 区分、`transition: all` 与宽度过渡清零、加入行长上限与 `text-wrap: balance`。(6) 阻断式弹窗就地化：`window.alert` 共 8 处（settings.js 5 处、diagnostics.js 3 处）改为就地状态行——新增 `#newDraftStatus`(settings.html:359) 与 `#exportStatus`(diagnostics.html:31) 两个 `role="status" aria-live="polite"` 节点（data-state=error，空文案由 `.live-status:empty` 收起），文案全部复用既有 i18n 键（**未新增键**），控制流（原 alert 后 return）不变。(7) 修复 diagnostics.js 的 `renderRubyTextTo` 中 `rubyPattern` 未声明的 `ReferenceError`（用户可达：旧式 ruby 回包 + 「渲染为 UI」→ 报文区空白且无提示）：正则改为函数内局部构造，与 overlay.js 的 renderRubyText 同构，避免共享带 `g` 正则残留 lastIndex 截断后续渲染（diagnostics.js:618）。(8) 修复 extension/src/i18n.js 的 auto 分支占位符缺陷：`fromBrowser` 原先只调 `runtime.i18n.getMessage(key)` 不传 substitutions，浏览器把未提供的 `$1…$9` 抹成空串，31 个带 `$n` 的键在默认 auto 下全渲染成半句话；现下传参数并以字面 `$n` 补位（`browserArguments()`），使 auto 与包内统一为「按顺序替换、未提供参数保留原占位符」。scripts/i18n.test.mjs 新增 4 条回归，全仓 `npm test` 202→206。(9) 测试：新增 scripts/diagnostics.test.mjs（导出状态行 4 条 + ruby UI 路径），settings.test.mjs 新增 5 条（草案端点/模型拉取失败就地报错、不弹窗），`npm test` 206→216、`npm run check` 通过；tokens.css/controls.css 为 settings/onboarding/diagnostics 三页共用，另两页实测无外观崩坏。(10) **未修的潜在同类风险（如实记录，非已修）**：service_worker.js:822 的 `localizedMessage(key, uiLanguage)` 回落分支同样不传 substitutions，因当前只取 noticeProviderMissing/noticeSubtitleTracksMissing/noticeSubtitleTracksUnread 三个不含 `$n` 的键而不可达；将来给后台投递的文案加 `$n` 即会复现，约束写入 extension/src/background/CLAUDE.md。(11) 两份 README 的「致谢」节去掉被扁平化推翻的描述——去掉 Neumorphism 条目、删除 macOS/Apple 条目里「半透明 backdrop-filter 表面」的表述，只保留字体栈与弹簧缓动并更新到现有行号，两版逐节对应。版本号未改动。
法则: 极简·稳定·导航·版本精确
