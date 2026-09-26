# src/
> L2 | 父级: ../CLAUDE.md

成员清单
background/: 扩展后台上下文，负责安装默认设置、旧键迁移、字幕下载兜底及多 provider BYOK 翻译请求
content/: Netflix 页面隔离上下文，负责逐行字幕来源、独立 AI 源轨道、时间轴翻译调度、首句等待和 overlay 渲染
page/: Netflix 页面主世界桥接，负责观察私有播放器请求与元数据
popup/: 扩展弹窗，负责逐行来源切换、provider 增删切换、显示/AI 配置、兼容域名授权和密钥保存

设计边界:
page 只采集 Netflix 页面事实；content 只维护字幕/翻译播放状态且不读取密钥；popup 管理逐行来源与服务配置并申请可选域名权限；background 隔离凭证并请求上游。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

