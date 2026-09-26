# content/
> L2 | 父级: ../CLAUDE.md

成员清单
content.js: 内容脚本入口，连接 page bridge、已知设置白名单和三轨加载；aiRole 互斥控制双原生/AI，预取数量调整不清除译文、上下文调整触发重译
netflixAdapter.js: Netflix 字幕轨道归一化器，把私有响应折叠成稳定 Track
overlay.js: Shadow DOM 字幕层，负责布局与独立样式；只在文本变化时替换节点以维持逐帧视觉稳定，通过 mount() 接入 fullscreenMount
fullscreenMount.js: 全屏挂载管理，在 document capture 阶段同步 reparent host 到 fullscreen element，仅监听标准 fullscreenchange（SPA 切换剧集通过 clearSubtitleState 复位 host 标记，syncWatchState 调 overlay.mount() 重新挂载）
subtitleParser.js: 字幕格式解析层，把文本解析为带原始时间轴的 cue
subtitleStore.js: 字幕轨道与 cue 缓存，合并同轨并发加载并隔离切集后的过期下载
translationScheduler.js: 当前句优先、可调未来句组数量（默认 10）与 60-120 秒时窗双上限、前后文每侧 0-4 条；保持预算与请求日志

设计边界:
Netflix 私有变化只进入 adapter；字幕格式变化只进入 parser；AI 翻译的纯时间轴调度留在 scheduler，网络凭证只在 background 读取；DOM 视觉变化只进入 overlay。content 只向 popup 返回已知设置字段，不泄露 storage 的其他键。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
