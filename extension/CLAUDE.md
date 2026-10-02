# extension/
> L2 | 父级: ../CLAUDE.md

成员清单
_locales/: WebExtension 国际化文案目录，en 为 default_locale，zh_CN 提供简体中文，两份 messages.json 键集必须完全一致
icons/: 图标资源单一手工源 icon-source.png（1024² 方形、带 alpha）与派生 PNG 全套（16/32/48/96/128/256/512）；manifest 的 1024 图标条目直接指向源图本身，供 manifest 各尺寸与 Safari converter 生成 App 图标
manifest.json: WebExtension 清单，声明 Netflix、默认 OpenAI 与可选兼容服务 host 权限，以及 content/settings/page 加载点；action 只保留 default_title（刻意不写 default_popup，工具栏点击因此由 background 的 action.onClicked 打开设置窗口）；default_locale 为 en，name/description/action.default_title 使用 __MSG_ 占位符，当前版本 0.3.5
src/: 扩展运行时代码，按浏览器上下文拆成 background/content/page/settings，另有 diagnostics/onboarding 两个扩展页与共享的 styles/ 设计层

设计边界:
`manifest.json` 只描述能力和加载点；业务逻辑全部放入 `src/`，provider 配置由 settings 写入统一数组后交给 background 使用，便于 Safari converter 直接消费。图标只从 `icon-source.png` 派生，禁止直接编辑 PNG。扩展 UI 文案只存在于 `_locales/`，页面以 classic script 前置加载 `src/i18n.js` 并通过 `data-i18n*` 或 `i18n.t()` 取词；content/page 渲染字幕而非 UI，不接入 i18n。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
