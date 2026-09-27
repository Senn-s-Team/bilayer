# onboarding/
> L2 | 父级: ../CLAUDE.md

成员清单
onboarding.html: 新手引导骨架落地页，承载三步环境检测、模式分流与实机视效 DOM 结构
onboarding.css: 新手引导样式表，基于 macOS 磨砂质感与 Apple Fluid 动效实现自适应窗口与抽屉排版
onboarding.js: 新手引导控制器，驱动步骤切换、Safari 权限探测、模式切换、AI 端点测试与配置持久化
设计边界:
作为独立全屏标签页运行，负责首次安装时引导用户完成 Safari 扩展授权认知、字幕模式（双原生 / AI 翻译）选型、AI 端点连通性测试以及实机叠放预览；不直接持有私有密钥逻辑，配置通过 background 既有接口回写。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
