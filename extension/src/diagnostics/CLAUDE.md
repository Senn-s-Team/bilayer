# diagnostics/
> L2 | 父级: ../CLAUDE.md

成员清单
diagnostics.html: 请求检查器结构，含请求体/响应体/渲染为 UI 页签、一键复制报文与树形折叠切换
diagnostics.js: 轮询后台记录、解析内嵌 JSON；列表与详情只在已知非负整数条数不等时报告条数不符，其余 items_mismatch 报通用翻译校验失败；UI 复制复用预览的字幕载荷归一化；导出优先使用下载 API，Safari 委托同源独立框架触发
diagnostics.css: 双栏检查器与树形语法视图，包含字幕视效 UI 卡片、假名注音排版、请求列表与报文阅读区独立滚动
export.html: Safari 下载框架的独立文档壳，避免 blob 页面替换诊断页
export.js: 同步接收导出文本并在框架内触发文件下载，不传送凭证

设计边界:
原始报文常态在 background 内存中保留最近 20 次请求/响应，并且只允许该扩展页向 background 请求；请求体、响应体、URL 与非敏感头部按原文保留在 background 内存中，Authorization 永不进入 diagnostics、popup 或 Netflix page state。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
