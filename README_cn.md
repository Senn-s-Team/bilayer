# Bilayer

[English](README.md) · 简体中文

macOS Safari Web Extension：在流媒体网页上同时显示两行字幕，并可选通过 OpenAI 或任何兼容 Chat Completions 的服务进行 AI 翻译。

## 状态

这是一个无需构建的 WebExtension 源码项目。`scripts/create-safari-project.sh` 会自动探测 `/Applications` 下已安装的 Xcode。

## 目录结构

- `extension/`：浏览器扩展源码，交给 Safari 的 converter 使用。
- `extension/icons/`：`icon-source.png`（1024²、方形、带 alpha）是唯一手工维护的图标源——`manifest.json` 的 `1024` 条目就指向该文件本身；`npm run icons` 派生其余全部 PNG 尺寸。
- `extension/src/page/`：页面主世界桥接层，观察 Netflix 播放器元数据与字幕请求。
- `extension/src/content/`：隔离世界内容脚本，负责字幕加载、解析、时间轴与覆盖层渲染。
- `extension/src/settings/`：设置窗口，管理字幕、AI 翻译、外观与翻译服务设置；点击工具栏图标时以独立、可缩放的窗口打开（默认 1240×940）。
- `extension/src/styles/`：共享设计令牌（`tokens.css`）与唯一控件基线（`controls.css`），由设置窗口、新手引导与诊断页在各自样式表之前加载。
- `extension/src/i18n.js`：扩展页面共享的界面本地化。设置窗口侧栏与向导头部的语言切换器持久化 `uiLanguage` 偏好（默认 `auto` 跟随 Safari，另可选 `en`、`zh_CN`），切换后重新加载页面。
- `scripts/`：本地校验、图标派生、Safari 转换、签名与发布辅助脚本。

## 环境要求

- Node.js >= 22，用于 `npm run check` 与 `npm test`（无需安装任何依赖）。
- 完整 Xcode，用于 `npm run safari:project` 及构建/安装脚本。`npm run icons` 依赖 macOS 的 `sips`。

## 开发

```bash
npm run check        # manifest 与 JavaScript 语法
npm test             # 内容脚本、调度器、字幕存储与后台 worker 的行为回归
npm run icons        # 从 icon-source.png 重新生成 16/32/48/96/128/256/512 PNG
npm run install:app  # 编译 Release、签名并覆盖安装到 /Applications/Bilayer.app
```

## 生成 Safari 工程

使用本机已安装的 Xcode：

```bash
npm run safari:project
```

如需全局切换 Xcode：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

如果你的 Xcode 应用目录名不同——例如带版本号的 `Xcode-<version>.app` 或 beta 安装——请把路径中的目录替换为实际名称。`scripts/create-safari-project.sh` 与 `scripts/xcode-env.sh` 已会自动探测 `Xcode.app`、`Xcode-<version>.app` 以及 CI runner 的 `Xcode_<version>.app`，因此只有当希望所有工具都使用该选择时，才需要执行全局 `xcode-select` 切换。

打开 `SafariApp/` 下生成的 Xcode 工程，在 Safari 设置中启用扩展，然后在 `https://www.netflix.com/watch/...` 上测试。

如果使用 Netflix 的 Mac 桌面应用（PWA），需在 **Netflix → 设置 → 扩展** 中单独启用；Web App 的扩展设置与 Safari 相互独立。若设置窗口提示找不到或无法连接到 Netflix 页面，请先确认 Web App 中的网站访问权限，然后重新加载视频页。设置窗口会先检查活动窗口与可访问的 Netflix 标签页，之后才报告连接失败。

## 发布

推送 `v*` tag 会在 `macos-latest` 上触发 **Release** 工作流：校验版本、构建 Safari App 与 DMG，然后发布到 GitHub Releases。

1. 提升 `extension/manifest.json` 的 `version`，同步 `package.json`，合入 `main`。
2. 打 tag 并推送：`git tag -a v0.4.0 -m "Bilayer 0.4.0" && git push origin v0.4.0`。
3. 工作流依次运行 `npm run check`、`npm test`，然后执行 `bash scripts/assert-release-version.sh`；tag 去掉前导 `v` 后与 `extension/manifest.json` 不一致时构建直接失败。
4. 随后运行 `npm run safari:project` 与 `npm run package:dmg`，为该 tag 创建（或更新）GitHub Release，并附带 `dist/Bilayer-<version>.dmg`。手动触发 `workflow_dispatch` 不发布 Release，只把 DMG 作为 workflow artifact 上传。
5. `build/` 与 `dist/` 都在 gitignore 中，DMG 只存在于 GitHub Release 或 workflow artifact，不进入版本库。两次 tag 构建不会并行（单一 `concurrency` 组）。

**Gatekeeper：** Release 产物使用 ad-hoc「Sign to Run Locally」签名且**未公证**——运行方式与本地自签名流程见下文 **签名与 Gatekeeper**。App 要求 **macOS 12.4 或更高版本**：`scripts/create-safari-project.sh` 为宿主 App 与扩展统一钉住 `MACOSX_DEPLOYMENT_TARGET`——本项目的 MV3 manifest 需要 Safari 15.4+，其中 `optional_host_permissions` 需要 Safari 15.5，而 Safari 15.5 随 macOS 12.4 发布。

## 签名与 Gatekeeper

CI 没有 Developer ID 证书，因此从 GitHub Release 下载的 DMG 只带 ad-hoc「Sign to Run Locally」签名，也没有公证票据。把它拿到其他 Mac 上首次打开时，Gatekeeper 会拦截（「不明开发者」/「已损坏」）。

**运行下载到的 App。** macOS 允许你在自己的机器上放行：

1. 在 Finder 中右键点击 `Bilayer.app`，选择 **打开**，然后在弹窗中确认。
2. 或先清除隔离属性，再正常打开：`xattr -dr com.apple.quarantine /Applications/Bilayer.app`

**自己构建并签名。** 这是受支持的一等路径：本地构建会用你自己的 Apple 证书签名，根本不会被隔离。

1. `security find-identity -v -p codesigning` 列出可用于签名的身份；本机若没有任何身份，`scripts/sign-app.sh` 会退回 ad-hoc `-`，也就是回到下载 DMG 的处境。
2. 一条命令完成构建、签名与安装——`scripts/sign-app.sh` 会自动选用本机第一个 `Apple Development` 身份：`npm run install:app`
3. 用显式证书覆盖自动选择：`CERT_NAME="Apple Development: you@example.com (XXXXXXXXXX)" npm run install:app`

**确认实际得到的签名。** 两条命令都随 macOS 提供：

1. `codesign -dv --verbose=4 /Applications/Bilayer.app`——用你自己的证书签名时会列出 `Authority=Apple Development: you@example.com (XXXXXXXXXX)` 以及你自己的 `TeamIdentifier`；CI 下载的版本则显示 `Signature=adhoc` 与 `TeamIdentifier=not set`。
2. `spctl -a -vvv -t exec /Applications/Bilayer.app`——两者都会输出 `rejected`，因为 ad-hoc 与 `Apple Development` 签名都不是可分发（已公证）的签名；用你自己的证书签名时会额外输出 `origin=Apple Development: you@example.com (XXXXXXXXXX)`，而 ad-hoc 下载只有一行 `rejected`。本地签名的版本因为从未被隔离，仍能正常打开；只有已公证的 Developer ID 构建才会输出 `accepted` 以及 `source=` 行。

要产出在别人 Mac 上不会被 Gatekeeper 拦截的下载，需要同时具备三样：**Developer ID Application** 证书、`xcrun notarytool submit` 提交公证，以及 `xcrun stapler staple`。本仓库不执行其中任何一步，也没有在 CI 中保存证书密钥，因此 GitHub Release 产物始终是 ad-hoc 签名。

## AI 翻译（自带密钥）

1. 在 Netflix 播放页选择 **双原生字幕** 以显示两条 Netflix 轨道，或选择 **AI 智能翻译** 显示一条 Netflix 原生行加一条译文行。用 **交换两行字幕及样式** 把译文移到原生行上方或下方。切回原生模式会停止翻译，但不会删除已保存的轨道或 AI 设置。
2. AI 翻译需要同时具备 Netflix 字幕轨道与已配置的翻译服务。若 Netflix 没有为该影片发布任何字幕轨道，双原生字幕与 AI 译文都无从显示：设置窗口会把 **AI 智能翻译** 卡片标为不可用，在模式卡片下方与 **AI 翻译** 页顶部说明原因，并禁用 AI 源轨道选择，点击该卡片即打开这段解释而不是毫无反应；字幕位置也会显示同样的提示。此时无法新选中 AI 模式，但已保存的 AI 选择不会被改回原生，会在有字幕的影片上继续生效——请改播这类影片或剧集。若已选中 AI 模式但尚未配置服务，设置窗口显示 **AI 翻译需要先配置翻译服务** 并给出直达 **翻译服务** 的链接（字幕位置同样提示）：在那里填写端点与 API 密钥即可。两处提示都跟随设置窗口既有的状态轮询，配置好服务或切到有轨道的影片后会立即消失；轨道状态未知时不做任何断言。若扩展短暂等待后仍读不到播放器的轨道列表，状态变为 **暂未能读取轨道**：设置窗口改为一条更柔和的提示，说明「未能读取」而非「没有字幕」，并指向刷新页面或改播其他影片，同时保留 **AI 智能翻译** 可选；只有明确的 **无字幕轨道** 才会阻止 AI。
3. 在 **AI 翻译** 标签页中，独立于当前显示的轨道选择 AI 源轨道（允许来自第三条轨道）、目标语言与全局提示词；页首的 **当前翻译服务** 选择器用于挑选已添加服务中哪一个参与翻译，并与 **翻译服务** 页签双向保持同步。将 **预翻译字幕句组** 设为 0–50（默认 10），**前后文各取字幕条数** 设为 0–4（默认 2）。当前字幕始终优先翻译；预取同时受所选条数与前方 60 秒时窗限制（高倍速下放宽至 120 秒）。设为 0 只关闭未来预取，不影响当前行翻译。紧挨这些字段的 **请求上限**（默认 80）与 **字符上限**（默认 40,000）限制能发送多少输入，**额度统计窗口** 选择两项上限的计量周期（**本次观看**、**本小时** 或 **本日**），字段下方的读数会标明所统计的窗口并显示至今已用的请求数与字符数；任一项设为 `0` 即表示该项不限。
4. 在 **翻译服务** 中添加或选择 provider——与 AI 页的 **当前翻译服务** 选择器是同一选择。每个 provider 各自持久化名称、模型 ID、兼容 Base URL 与 API 密钥；提示词与预取参数不属于 provider。URL 留空即使用 OpenAI；填写 `https://host` 或 `https://host/v1` 会被规范化为 `/v1/chat/completions`，也接受完整的 `/chat/completions` 地址。自定义 provider 需要一次性域名授权；本地开发允许 localhost 的 HTTP。
5. 使用 **测试连通性** 或 **获取模型** 前请先保存 API 密钥。连通性测试发送一次最小 Chat Completions 请求；模型发现读取所选 provider 的 `/models` 响应。**删除密钥** 只影响该 provider。
6. 在设置窗口中打开 **诊断**，**原始翻译报文** 页面列出最近若干次请求的模型、状态与耗时。请求与响应 JSON 可按树状展开/折叠，包括嵌套的 Chat Completions content；方向键在节点间移动，路径栏显示当前聚焦字段。点击长字符串可展开，或用 **切换折叠树** 在解析树与未改动的原始报文之间切换。最近 20 条记录保存在扩展内存中，包含字幕文本，不得对外分享。API 凭证始终不会离开 background 上下文。

只有被选中的字幕文本及前后各若干条相邻字幕会发送到端点。密钥保存在扩展的 local storage 中，**未加密**，且绝不会返回给 Netflix 页面或设置窗口的状态查询。默认提示词保留原意、角色语气、人名、术语与格式，不添加解释。默认 OpenAI 端点使用严格 JSON Schema；兼容端点则被要求返回 `{items:[{id,text}]}`。对于兼容端点，裸的 `{id,text}` 或逗号分隔的多个 `{id,text}` 对象会先被规范化，再做严格的数量、字段与 ID 校验；不完整的批次会被拒绝。输入护栏在 **请求上限**（默认 80 次请求）或 **字符上限**（默认 40,000 个发送字符，含相邻上下文，因此 **前后文各取字幕条数** 越大字符上限消耗越快）处停止；设为 `0` 即取消该项上限，两项各自独立生效，设置窗口显示两项上限的实时用量、指出是哪一项触发了停止，并标明计数覆盖哪个窗口。**额度统计窗口** 默认为 **本次观看**：即当前播放页，刷新同一剧集页面后继续累计；**本小时** 与 **本日** 则按本机时间分桶。用量按窗口键持久化在扩展存储中，不再只存于内存，因此重新加载页面或重新打开设置窗口都会接着累计。会话中途修改上限或窗口立即生效——调高上限即恢复翻译且不丢弃已翻译的行，调低到已用量以下则立刻停止新请求。这是输入护栏而非价格上限：它既不统计输出 token，也不做任何计价；真正的成本预算还需要响应的 `usage` 与按模型的价格表。译文在本次观看会话期间仅存于内存。

## 当前范围

- 在互斥的「双原生」与「原生 + AI」两种模式间切换；可独立选择 AI 源轨道，包括第三条 Netflix 轨道。
- 优先翻译当前字幕，然后在 60 秒时窗内预取至多设定的未来句组（默认 10 组，高倍速下放宽至 120 秒）；seek 与切集/切轨都会使过期结果失效。
- 提示词、语言、上下文、预取与会话额度参数保持全局；provider 只拥有自己的名称、端点、模型与凭证。无关的 storage 键与 API 密钥不属于页面状态。
- 字幕选择、显示设置、provider 配置与额度用量全局持久化；译文仅存于内存。

## 隐私

扩展只读取 Netflix 播放器本身已经在请求的字幕轨道，并且只把选中的字幕文本及设定数量的相邻字幕发送到**你自己配置的**端点。API 密钥存放在扩展的 local storage 中，**未加密**，且只在 background service worker 内读取。需显式开启的诊断面板在扩展内存中保留最近 20 组请求/响应，包含字幕文本，但从不捕获 `Authorization`。完整边界说明与漏洞上报方式见 [SECURITY.md](SECURITY.md)。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。`npm run check && npm test` 就是全部门禁，CI 会在 Node 22 与 24 上分别运行。几条关键不变量：保持 `extension/manifest.json` 与 `package.json` 版本一致；不要随意更改 bundle identifier；产品名、图标与元数据中不得出现第三方商标。

## 致谢与非原创内容

本项目的部分设计刻意沿用了外部做法。本节只记录仓库自身有据可查的引用，以及那些「重新实现而非拷贝」的部分。

### 设计参考

- 影视字幕约束——翻译时保持每条字幕的 ID 与上下文边界不变——在项目变更日志中记为借鉴自 沉浸式翻译 / Immersive Translate（`CLAUDE.md` 变更日志 `2026-09-26`）。本项目不包含该项目的任何代码或字幕文本。
- 诊断页 JSON 查看器的交互方式——可折叠树、键盘路径导航、长字符串展开——记为「借鉴 fx」（`CLAUDE.md` 变更日志 `2026-09-26`）。变更日志只给出了一种交互风格，未指明上游项目或版本，因此这里按「交互风格参考」致谢，而不是当作代码依赖。
- 扩展页面把 macOS/Apple 的排版与动效语言当作通用设计语言使用：`-apple-system`/`SF Pro` 字体栈（共享令牌 `--bl-font-sans` 见 `extension/src/styles/tokens.css` 第 110 行）与弹簧缓动（`--bl-ease-spring`、`--bl-ease-springy` 见同文件第 149、152 行，例如 `extension/src/settings/settings.css` 第 303、399 行与 `extension/src/onboarding/onboarding.css` 第 109 行）。这些只是样式，不是 Apple 的代码。
- Netflix 播放器集成是依据可观察行为重新实现的：页面桥接层钩住播放页自身的 `JSON.parse`、`fetch`、`XMLHttpRequest` 与资源计时，以观察播放器本就在请求的字幕轨道；内容侧则用自己定义的 `netflix-track:` URL 方案解析这些轨道（`extension/src/page/netflix-page-bridge.js`、`extension/src/content/netflixAdapter.js`、`extension/src/content/subtitleStore.js`）。项目中不含任何 Netflix 源码、字幕或美术资源。
- Chat Completions 契约按公开 API 形状实现：默认 OpenAI 端点使用严格 `json_schema` 请求（`subtitle_translations`），并对兼容 provider 的畸形回包做容错归一化。驱动该解析的 `cases/` 夹具是经脱敏的抓包——结构性畸形保留，字幕文本全部替换为合成内容（`cases/CLAUDE.md`）。

### 工具与平台

- `xcrun safari-web-extension-converter` 从本 WebExtension 源码生成 Xcode 工程。
- `sips` 从 `icon-source.png` 派生全部非源图 PNG。
- `plutil` 在打包与发布脚本中读取 manifest 版本。
- `/usr/libexec/PlistBuddy` 为生成的宿主 App 写入 `SafariExtensionBundleIdentifier` 键。

### 第三方代码

- 未内置任何第三方源码。`package.json` 没有 `dependencies`、`devDependencies` 或 `optionalDependencies`；仓库没有 lockfile、没有 `node_modules/`，`extension/` 下也没有任何文件引入被打包进来的库。
- 扩展不携带第三方字体或图片：`extension/` 内没有 `.woff2`、`.ttf`、`.otf` 文件，唯一的图片是本项目自己的图标。
- `LICENSE` 是覆盖本项目自身源码的纯 MIT 文本，无需转载任何第三方许可声明。
- 商标边界是刻意维持的：产品名、图标与元数据中不出现第三方商标；而 `netflix-page-bridge.js`、`netflix-track:` 方案与 Netflix host 权限命名的是目标站点，而非品牌。

### 素材

- 图标美术由维护者提供。`extension/icons/icon-source.png` 是唯一手工维护的图像，其余 PNG 全部由 `scripts/build-icons.sh` 从它派生；其中不涉及任何上游美术或许可。

## 路线图

这是计划，不是承诺：以下内容没有排期，也不绑定任何版本。

### Chromium 与 Firefox

结论按引擎分开：当前 Chromium 无需改动即可运行本扩展，Firefox 则是一项小到中等规模的移植工作，而不是重写。

真实加载验证（Chrome for Testing 153.0.8010.12，以未修改的 `extension/` 解包加载，经 CDP 驱动）：

- 未修改的 `extension/` 加载成功，没有 manifest 或控制台报错；设置页正常渲染出四个页签、本地化文案与已保存的设置（`enabled` 为开、界面语言为 `auto`）。
- 设置页发出的后台消息往返成功：空批次的 `BILAYER_TRANSLATE_BATCH` 返回 `{ok:false,errorCode:"configuration"}`。
- 内容脚本在 Netflix 播放页正常启动：覆盖层宿主与原生字幕隐藏样式均已挂载，主世界桥接通过 web_accessible_resources 脚本注入成功。
- `i18n.js` 使用的 `_locales` 读取路径可用：同步 XHR 读取 `runtime.getURL('_locales/zh_CN/messages.json')` 返回 200。
- Chromium 不需要任何代码或 manifest 改动。品牌版 Chrome 已不再接受 `--load-extension` 测试参数——Bilayer 在其中根本不会加载——因此测试需使用 Chrome for Testing 或「加载已解压的扩展程序」；这是测试路径的限制，不是移植问题。

读码确认：

- `extension/manifest.json` 只声明 MV3 的 `background.service_worker`，没有其它后台声明形式；仓库中不存在 `browser_specific_settings`（或 `gecko.id`）。
- manifest 声明了 `optional_host_permissions`，且扩展页面的授权请求 `runtime.permissions.request` 都同步位于各自的点击处理器内，因此按现状已经满足用户手势要求。
- 诊断缓冲及其版本号、序号计数都会镜像进 `storage.local`，记录与 ID 可跨 service worker 重启保留；采集开关（`__raw_capture_enabled__`）与这些键一同持久化，worker 在任何采集判断前都会先重新读回该值，因此用户关闭原始报文采集后，跨 worker 重启依然保持关闭。该偏好“未读回即视为未知”：读取失败时保持关闭，且下一次请求会重试，存储错误绝不会把采集静默重新打开。
- worker 内没有 `setInterval`、保活或 alarm，仅有的定时器是单次请求的 fetch 中止，因此没有其它逻辑依赖 worker 常驻。
- `web_accessible_resources` 已经使用 MV3 的对象形式；文案包 `_locales/en`（声明为 `default_locale`）与 `_locales/zh_CN` 键集一致。

未验证——仍属假设与尚未跑到的路径：

- Firefox 从未启动过：本机没有 Firefox 二进制，因此下面每一条 Firefox 相关内容都来自 manifest、代码与公开的引擎行为，而非实测结果。
- Firefox 的 MV3 不实现 `background.service_worker`，需要改用事件页（`background.scripts`）；同时声明两个键还会改变 Safari 选用的后台上下文，这让「共用一份 manifest 还是按引擎转换」成为一个必须做的决定。
- Firefox 的 manifest host 权限在安装时可选、也可被用户撤销，一旦被拒绝内容脚本会静默停止运行；现有代码只用 `tabs.query` 探测可达性，因此恢复路径属于新增工作。
- Firefox 是否像 Chrome 那样在内容脚本之间共享 `window.Bilayer` 尚未验证；若不共享，就必须改名为 `globalThis.Bilayer`。
- 两个引擎中都未跑到：真实的用户手势授权弹窗、已登录的 Netflix 播放页（覆盖层、全屏、真实 CSP）、持续负载下的 service worker 回收，以及商店审核结果。

由此需要做的工作：

- Firefox：补上 `background.scripts`、`browser_specific_settings.gecko.id` 与扩展商店要求的数据收集声明，然后用真实点击重新验证内容脚本全局量与授权流程。
- Firefox：补上 host 权限恢复路径（`permissions.contains` 加 `permissions.request`），让被拒绝的 Netflix 授权可以重新获取。
- 在「共用一份 manifest」与「按引擎转换」之间做决定，因为上面那条 Safari 后台上下文偏好正取决于该选择。
- Chromium 不需要移植工作；其余事项是可选的加固（声明 `downloads`，诊断导出目前已回退到另一条路径）与商店打包，后者按商店各自独立审核。

### 更多视频站点

- 这是清单上工作量最大的一项。桥接层与适配器都只针对 Netflix：`content_scripts` 仅匹配 `netflix.com`，注入的桥接文件就是 `netflix-page-bridge.js`，私有播放器字段隔离在 `extension/src/content/netflixAdapter.js`。每新增一个站点都需要其专属的观察桥接与适配器；解析、调度与覆盖层已经是平台无关的。

### 文档与截图

- 目前还没有 `docs/` 目录。截图（双原生与 AI 模式的覆盖层、设置窗口外观面板、诊断报文页）需要先有托管位置，并由维护者提供素材，才能从两份 README 链接过去。
- 一段双行覆盖层的短视频，比文字更适合用来说明外观设置。
- `cases/` 夹具可以继续补充经脱敏的畸形回包抓包；脱敏规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)。
