# background/
> L2 | 父级: ../CLAUDE.md

成员清单
service_worker.js: 初始化全局翻译默认值并迁移旧键，在首次安装时唤起 onboarding 引导页；字幕下载、多 provider 翻译（源或目标语言为日文时协同输出 readings 读音字典键值对、注入纯净契约 Schema/提示词，集成外来语本地化通用准则）、popup 与 onboarding 连通性测试；兼容服务解析单字幕对象及逗号分隔对象序列，再严格校验数量、字段与 ID；默认常态保留最近 20 次原始诊断

设计边界:
后台不保存页面级字幕状态；翻译时才读取所选 provider 的本地凭证。官方 OpenAI 使用固定 host 与严格 JSON Schema；兼容端点必须是 HTTPS `/chat/completions`（localhost/127.0.0.1 可用 HTTP），且必须拥有运行时授权。兼容服务可规范化单个 `{id,text}` 或多个逗号分隔对象，结果必须与请求字幕的数量及 ID 完全匹配。原始报文仅由独立 diagnostics 页显式开启和读取；Authorization 只留在 background。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
