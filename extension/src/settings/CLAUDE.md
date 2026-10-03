# settings/
> L2 | 父级: ../CLAUDE.md

成员清单
settings.html: 五页签设置壳；AI 页调度/语境卡后有跨列缓存卡，含 session/local、prefer/only（only 未命中不请求网络）、仅 local 显示的折叠保留天数/MiB 设置（0 表示不限）、用量/命中/缺注音/存储错误、重译/清理按钮和 scope 确认；诊断页为空 root，诊断样式/controller 先于 settings.js 加载
settings.css: 1240×940 独立设置窗口的五页签侧栏、≤820px 顶部 tab bar 与 .tab-panel 唯一滚动源；宽视口 AI 双列、缓存卡跨整行
settings-ai.css: AI 缓存 retention disclosure、统计与确认操作的响应式布局，及既有字幕模式/provider/AI 组件样式
settings.js: 管理字幕、AI/provider/cache preference 归一化和 changed-key 持久化；storage 读取含四个缓存键，切剧集保留未回传的偏好；后台 clear 事务成功后才向每个可达对应 watch 页广播，all 省略 episodeId；stats 按请求序号和 episode 丢弃迟到回包，页面 hits、缺注音和 storageError 从 BILAYER_GET_STATE.translationCache 读取；cache_miss 保持 warning；diagnostics 仅 selected+visible 时懒挂载并通过 setActive(boolean) 停启，状态复用原有 hidden-gated poll
五页签 ARIA 由现有 tab buttons 控制；诊断 controller 挂载一次，selectTab/visibilitychange 使用 setActive(boolean)，离开或隐藏停止 controller 活动，隐藏时 settings 不访问 tabs
缓存错误分别持有后台统计错误与播放页持久化错误，统一渲染到同一状态行；页面正常状态不能隐藏后台存储失败，统计恢复也不能隐藏播放页写入失败。清理失败只报真实错误，不广播会话清理。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
