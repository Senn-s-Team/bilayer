# onboarding/
> L2 | 父级: ../CLAUDE.md

成员清单
onboarding.html: 新手引导骨架落地页，承载头部界面语言切换、三步环境检测、模式分流与实机视效（字号/自由位置/行高/最大宽度/文字颜色透明度/背景颜色透明度/描边/字体字重全量对齐 popup 外观面板）DOM 结构与页内完成态出口
onboarding.css: 新手引导样式表，基于 macOS 磨砂质感与 Apple Fluid 动效实现自适应窗口与全量外观微调网格排版；预览几何令牌（--preview-gap/--preview-primary-bottom）与 popup 预览同构
onboarding.js: 新手引导控制器，驱动步骤切换、Safari 权限探测、模式切换、AI 端点测试与模型发现（复用 background 的 BILAYER_LIST_MODELS，先落盘临时 provider 再请求）、双字幕全量外观实时校准与配置持久化，并保证最后一步在标签页 API 失效时仍确定性进入可交互完成态
设计边界:
作为独立全屏标签页运行，负责首次安装时引导用户完成 Safari 扩展授权认知、字幕模式（双原生 / AI 翻译）选型、AI 服务与模型选择、连通性测试以及实机叠放预览；不直接持有私有密钥逻辑，模型目录与连通性均通过 background 既有接口获得，配置通过 background 既有接口回写。界面语言切换只消费 i18n.js 的 [data-i18n-language] 挂载契约，本目录不定义文案键。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
