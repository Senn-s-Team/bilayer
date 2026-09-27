# diagnostics/
> L2 | 父级: ../CLAUDE.md

成员清单
diagnostics.html: 请求检查器结构，含请求体/响应体/渲染为 UI 页签、一键复制报文与树形折叠切换
diagnostics.js: 轮询后台记录，默认展示全展开格式化 JSON 并解析内嵌对象、支持一键复制，提供双语字幕视效 UI 画板与折叠树切换
diagnostics.css: 双栏检查器与树形语法视图，包含字幕视效 UI 卡片、假名注音排版、请求列表与报文阅读区独立滚动

设计边界:
原始报文常态在 background 内存中保留最近 20 次请求/响应，并且只允许该扩展页向 background 请求；请求体、响应体、URL 与非敏感头部按原文保留在 background 内存中，Authorization 永不进入 diagnostics、popup 或 Netflix page state。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
