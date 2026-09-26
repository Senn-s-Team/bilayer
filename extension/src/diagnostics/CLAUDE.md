# diagnostics/
> L2 | 父级: ../CLAUDE.md

成员清单
diagnostics.html: 请求检查器结构，路径与快捷键提示置于报文阅读区，原文和树形视图共用请求/响应切换
diagnostics.js: 轮询后台记录，显示可折叠 JSON 树与嵌套多对象译文，键盘定位节点路径、展开长字符串，保留逐字原文
diagnostics.css: 双栏检查器与树形语法视图，请求列表、节点阅读区独立滚动，窄屏改为单栏

设计边界:
原始报文只在用户显式打开诊断页后采集，并且只允许该扩展页向 background 请求；请求体、响应体、URL 与非敏感头部按原文保留在 background 内存中，Authorization 永不进入 diagnostics、popup 或 Netflix page state。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
