# Bilayer

[English](README.md) · 简体中文

macOS Safari Web Extension：在流媒体网页上同时显示两行字幕，并可选通过 OpenAI 或任何兼容 Chat Completions 的服务进行 AI 翻译。

## 状态

这是一个无需构建的 WebExtension 源码项目。`scripts/create-safari-project.sh` 会自动探测 `/Applications` 下已安装的 Xcode。

## 目录结构

- `extension/`：浏览器扩展源码，交给 Safari 的 converter 使用。
- `extension/icons/`：`icon.svg` 是唯一手工维护的图标源；`npm run icons` 派生全部 PNG 尺寸。
- `extension/src/page/`：页面主世界桥接层，观察 Netflix 播放器元数据与字幕请求。
- `extension/src/content/`：隔离世界内容脚本，负责字幕加载、解析、时间轴与覆盖层渲染。
- `extension/src/popup/`：扩展弹窗，管理语言与显示设置。
- `scripts/`：本地校验、图标派生与 Safari 工程转换脚本。

## 环境要求

- Node.js >= 22，用于 `npm run check` 与 `npm test`（无需安装任何依赖）。
- 完整 Xcode，用于 `npm run safari:project` 及构建/安装脚本。`npm run icons` 依赖 macOS 的 `sips`。

## 开发

```bash
npm run check        # manifest 与 JavaScript 语法
npm test             # 内容脚本、调度器、字幕存储与后台 worker 的行为回归
npm run icons        # 从 icon.svg 重新生成 16/32/48/96/128/256/512 PNG
npm run install:app  # 编译 Release、签名并覆盖安装到 /Applications/Bilayer.app
```

## 生成 Safari 工程

使用本机已安装的 Xcode：

```bash
npm run safari:project
```

如需全局切换 Xcode：

```bash
sudo xcode-select -s /Applications/Xcode-26.5.0.app/Contents/Developer
```

打开 `SafariApp/` 下生成的 Xcode 工程，在 Safari 设置中启用扩展，然后在 `https://www.netflix.com/watch/...` 上测试。

如果使用 Netflix 的 Mac 桌面应用（PWA），需在 **Netflix → 设置 → 扩展** 中单独启用；Web App 的扩展设置与 Safari 相互独立。若弹窗提示找不到或无法连接到 Netflix 页面，请先确认 Web App 中的网站访问权限，然后重新加载视频页。弹窗会先检查活动窗口与可访问的 Netflix 标签页，之后才报告连接失败。

## AI 翻译（自带密钥）

1. 在 Netflix 播放页选择 **双原生字幕** 以显示两条 Netflix 轨道，或选择 **AI 翻译字幕** 显示一条 Netflix 原生行加一条译文行。用 **交换两行字幕及样式** 把译文移到原生行上方或下方。切回原生模式会停止翻译，但不会删除已保存的轨道或 AI 设置。
2. 在 **AI 翻译** 标签页中，独立于当前显示的轨道选择 AI 源轨道（允许来自第三条轨道）、目标语言与全局提示词。将 **预翻译字幕句组** 设为 0–50（默认 10），**前后文各取字幕条数** 设为 0–4（默认 2）。当前字幕始终优先翻译；预取同时受所选条数与前方 60 秒时窗限制（高倍速下放宽至 120 秒）。设为 0 只关闭未来预取，不影响当前行翻译。
3. 在 **翻译服务** 中添加或选择 provider。每个 provider 各自持久化名称、模型 ID、兼容 Base URL 与 API 密钥；提示词与预取参数不属于 provider。URL 留空即使用 OpenAI；填写 `https://host` 或 `https://host/v1` 会被规范化为 `/v1/chat/completions`，也接受完整的 `/chat/completions` 地址。自定义 provider 需要一次性域名授权；本地开发允许 localhost 的 HTTP。
4. 使用 **测试连通性** 或 **获取模型** 前请先保存 API 密钥。连通性测试发送一次最小 Chat Completions 请求；模型发现读取所选 provider 的 `/models` 响应。**删除密钥** 只影响该 provider。
5. 在 **诊断** 中打开 **完整翻译日志** 查看生命周期摘要。**打开原始报文面板** 会显示最近若干次请求的模型、状态与耗时。请求与响应 JSON 可按树状展开/折叠，包括嵌套的 Chat Completions content；方向键在节点间移动，路径栏显示当前聚焦字段。点击长字符串可展开，或用 **查看原文** 查看未改动的原始报文。最近 20 条记录保存在扩展内存中，包含字幕文本，不得对外分享。API 凭证始终不会离开 background 上下文。

只有被选中的字幕文本及前后各若干条相邻字幕会发送到端点。密钥保存在扩展的 local storage 中，**未加密**，且绝不会返回给 Netflix 页面或弹窗的状态查询。默认提示词保留原意、角色语气、人名、术语与格式，不添加解释。默认 OpenAI 端点使用严格 JSON Schema；兼容端点则被要求返回 `{items:[{id,text}]}`。对于兼容端点，裸的 `{id,text}` 或逗号分隔的多个 `{id,text}` 对象会先被规范化，再做严格的数量、字段与 ID 校验；不完整的批次会被拒绝。单次观看会话的输入上限为 80 次请求或 40,000 个发送字符（含上下文）；这不是价格上限，也不统计输出 token。译文在本次观看会话期间仅存于内存。

## 当前范围

- 在互斥的「双原生」与「原生 + AI」两种模式间切换；可独立选择 AI 源轨道，包括第三条 Netflix 轨道。
- 优先翻译当前字幕，然后在 60 秒时窗内预取至多设定的未来句组（默认 10 组，高倍速下放宽至 120 秒）；seek 与切集/切轨都会使过期结果失效。
- 提示词、语言、上下文与预取参数保持全局；provider 只拥有自己的名称、端点、模型与凭证。无关的 storage 键与 API 密钥不属于页面状态。
- 字幕选择、显示设置与 provider 配置全局持久化；译文仅存于内存。

## 隐私

扩展只读取 Netflix 播放器本身已经在请求的字幕轨道，并且只把选中的字幕文本及设定数量的相邻字幕发送到**你自己配置的**端点。API 密钥存放在扩展的 local storage 中，**未加密**，且只在 background service worker 内读取。需显式开启的诊断面板在扩展内存中保留最近 20 组请求/响应，包含字幕文本，但从不捕获 `Authorization`。完整边界说明与漏洞上报方式见 [SECURITY.md](SECURITY.md)。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。`npm run check && npm test` 就是全部门禁，CI 会在 Node 22 与 24 上分别运行。几条关键不变量：保持 `extension/manifest.json` 与 `package.json` 版本一致；不要随意更改 bundle identifier；产品名、图标与元数据中不得出现第三方商标。

## 许可证

[MIT](LICENSE)。
