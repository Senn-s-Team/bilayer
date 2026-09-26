# background/
> L2 | 父级: ../CLAUDE.md

成员清单
service_worker.js: 初始化全局翻译默认值并迁移旧键；字幕下载、多 provider 翻译和连通性测试，配置/授权/HTTP/ID 阶段诊断不含凭证及正文

设计边界:
后台不保存页面级字幕状态；翻译时才读取所选 provider 的本地凭证。官方 OpenAI 使用固定 host 与严格 JSON Schema；兼容端点必须是 HTTPS `/chat/completions`（localhost/127.0.0.1 可用 HTTP），且必须拥有运行时授权。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
