# content/
> L2 | 父级: ../CLAUDE.md

成员清单
content.js: 内容脚本入口，连接 page bridge、全局偏好白名单、独立双轨加载与过期结果隔离、播放器同步及 popup 查询/重载
netflixAdapter.js: Netflix 字幕轨道归一化器，把私有响应折叠成稳定 Track
overlay.js: Shadow DOM 字幕层，负责自动上下布局、独立样式变量与视觉渲染，并通过 mount() 接入 fullscreenMount
fullscreenMount.js: 全屏挂载管理，在 document capture 阶段同步 reparent host 到 fullscreen element，仅监听标准 fullscreenchange（SPA 切换剧集通过 clearSubtitleState 复位 host 标记，syncWatchState 调 overlay.mount() 重新挂载）
subtitleParser.js: 字幕格式解析层，把文本解析为带原始时间轴的 cue
subtitleStore.js: 字幕轨道与 cue 缓存，合并同轨并发加载并隔离切集后的过期下载

设计边界:
Netflix 私有变化只进入 adapter；字幕格式变化只进入 parser；DOM 视觉变化只进入 overlay。content 只向 popup 返回已知设置字段，其他 storage 键不得进入页面状态。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
