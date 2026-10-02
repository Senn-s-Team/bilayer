# onboarding/
> L2 | 父级: ../CLAUDE.md

成员清单
onboarding.html: 新手引导骨架落地页，在本页样式表之前依次加载共享层 styles/tokens.css 与 styles/controls.css，承载头部界面语言切换、三步环境检测、模式分流与实机视效（字号/自由位置/行高/最大宽度/文字颜色透明度/背景颜色透明度/描边/字体字重全量对齐设置窗口外观面板）DOM 结构与页内完成态出口。页内不写内联样式：初始隐藏/占位全部走类名（.is-hidden / .is-invisible），说明卡与可点模式卡靠 .select-card.is-static 区分，密钥明文开关是内联 SVG（与页内其它图标同描边规格）而非 emoji
onboarding.css: 新手引导样式表，扁平工程感：悬浮窗口是 1px 发丝外框 + 纯色表面（--surface）+ 唯一一枚收敛阴影，内部层级只靠发丝线与表面色差（--surface-soft 分组面板）表达；不用背景模糊、顶部高光、光泽内描边、胶囊圆角与发光阴影（历史玻璃令牌已在令牌层删除，本页不引用）；圆角档位就地写死并注释期望令牌：窗口 10px（期望 --bl-radius-window）、面板/卡片 6px（--bl-radius-sm）、按钮/输入 4px（--bl-radius-xs，基线在 controls.css）、徽标 2px（期望 --bl-radius-badge）。滚动只发生在 .step-viewport（全页唯一滚动源，底栏永不被内容压住）；分步切换与抽屉展开用 --bl-ease-* + 40ms 错峰（pane-enter/pane-rise/drawer-open/dot-pulse，均只动 transform/opacity 且被 controls.css 的 reduced-motion 兜底块清零）。窗口宽度 740px、min-height 640px、max-height 92dvh（dvh 而非 vh），卡片 padding 与预览画板几何保持改造前逐像素不变
onboarding.js: 新手引导控制器，驱动步骤切换、Safari 权限探测、模式切换、AI 端点测试与模型发现（复用 background 的 BILAYER_LIST_MODELS，先落盘临时 provider 再请求）、双字幕全量外观实时校准与配置持久化，并保证最后一步在标签页 API 失效时仍确定性进入可交互完成态
设计边界:
作为独立全屏标签页运行，负责首次安装时引导用户完成 Safari 扩展授权认知、字幕模式（双原生 / AI 翻译）选型、AI 服务与模型选择、连通性测试以及实机叠放预览；不直接持有私有密钥逻辑，模型目录与连通性均通过 background 既有接口获得，配置通过 background 既有接口回写。界面语言切换只消费 i18n.js 的 [data-i18n-language] 挂载契约，本目录不定义文案键。文案一律来自 _locales（本页不新增键），DOM 契约（id/data-i18n*/role/aria-*/脚本顺序/表单 min-max-step-value）不得变更；步骤条三项由本页 JS 绑定 onclick，因此是有交互的进度控件而非纯指示器。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
