# src/
> L2 | 父级: ../CLAUDE.md

成员清单
background/: 扩展后台上下文，负责安装默认设置、旧键迁移、字幕下载兜底及多 provider BYOK 翻译请求
content/: Netflix 页面隔离上下文，负责双原生/原生加 AI 互斥渲染、独立 AI 源轨道、可调前瞻、首句等待和 overlay
diagnostics/: 独立扩展诊断页，开启后台原始报文采集并在宽屏面板查看完整请求体、响应体与请求头
page/: Netflix 页面主世界桥接，负责观察私有播放器请求与元数据
popup/: 三页签弹窗，负责字幕模式切换、全局翻译设置、provider 增删与独立凭证、兼容域名授权及原始诊断入口

设计边界:
page 只采集 Netflix 页面事实;content 维护模式和字幕播放状态且不读取密钥;popup 分离全局翻译配置与服务凭证并提供诊断入口;diagnostics 仅在用户显式开启时读取 background 内存中的原始报文;background 隔离凭证并请求上游。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

