# content/
> L2 | 父级: ../CLAUDE.md

成员清单
content.js: 内容脚本入口，连接 page bridge、已知设置白名单、三轨加载与翻译调度；向后台请求脱敏诊断并区分消息传输失败，播放器首句等待限时
netflixAdapter.js: Netflix 字幕轨道归一化器，把私有响应折叠成稳定 Track
overlay.js: Shadow DOM 字幕层，负责布局与独立样式；只在文本变化时替换节点以维持逐帧视觉稳定，通过 mount() 接入 fullscreenMount
fullscreenMount.js: 全屏挂载管理，在 document capture 阶段同步 reparent host 到 fullscreen element，仅监听标准 fullscreenchange（SPA 切换剧集通过 clearSubtitleState 复位 host 标记，syncWatchState 调 overlay.mount() 重新挂载）
subtitleParser.js: 字幕格式解析层，把文本解析为带原始时间轴的 cue
subtitleStore.js: 字幕轨道与 cue 缓存，合并同轨并发加载并隔离切集后的过期下载
translationScheduler.js: 当前句优先、60 秒预取、失败续调、句组对齐与会话预算；关联后台阶段到请求编号，同一剧集切换 provider 保留日志，不持有密钥

设计边界:
Netflix 私有变化只进入 adapter；字幕格式变化只进入 parser；AI 翻译的纯时间轴调度留在 scheduler，网络凭证只在 background 读取；DOM 视觉变化只进入 overlay。content 只向 popup 返回已知设置字段，不泄露 storage 的其他键。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
