# extension/
> L2 | 父级: ../CLAUDE.md

成员清单
icons/: 图标资源单一手工源 icon.svg 与派生 PNG 全套（16/32/48/96/128/256/512），供 manifest 与 Safari converter 生成 App 图标
manifest.json: WebExtension 清单，声明 Netflix、默认 OpenAI 与可选兼容服务 host 权限，以及 content/popup/page 加载点，当前版本 0.3.0
src/: 扩展运行时代码，按浏览器上下文拆成 background/content/page/popup，另有 diagnostics/onboarding 两个扩展页

设计边界:
`manifest.json` 只描述能力和加载点；业务逻辑全部放入 `src/`，provider 配置由 popup 写入统一数组后交给 background 使用，便于 Safari converter 直接消费。图标只从 `icon.svg` 派生，禁止直接编辑 PNG。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
