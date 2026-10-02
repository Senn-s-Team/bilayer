# diagnostics/
> L2 | 父级: ../CLAUDE.md

成员清单
diagnostics.html: 请求检查器结构，在本页样式表之前依次加载共享层 styles/tokens.css 与 styles/controls.css，再依次加载本模块 diagnostics.css（外壳/列表/详情）与 diagnostics-payload.css（报文区/JSON 树/视效预览），含请求体/响应体/渲染为 UI 页签、一键复制报文与树形折叠切换，以及头部导出结果状态行 #exportStatus（默认无文案，导出显隐由 diagnostics.js 的 writeExportStatus 控制）
diagnostics.js: 轮询后台记录、解析内嵌 JSON；列表与详情只在已知非负整数条数不等时报告条数不符，其余 items_mismatch 报通用翻译校验失败；UI 复制复用预览的字幕载荷归一化；导出无记录/失败/框架未就绪时就地把文案写进 #exportStatus（data-state=error）而非阻塞式 alert，导出优先使用下载 API，Safari 委托同源独立框架触发
diagnostics.css: 只提供本页外壳与请求检查器布局（扁平发丝线分层的主面板与左列、请求列表行、详情头部与连接信息抽屉、列表/详情空态构图、窄视口单栏退化），颜色/明暗/控件外观取自共享层——表面只靠 1px var(--border) 与 --surface/-soft/-card-bg 的色差分层，圆角只用 --radius-tag/-control/-surface，不含光泽层、渐变高光、模糊与阴影；头部无类名按钮按第二档几何在此落一次并用 :where() 保持零特异性，使 .quiet-button 的第三档颜色仍由共享层决定
diagnostics-payload.css: 只提供报文区布局与形态（扁平工具条与页签、JSON 搜索与路径栏、贴面色的报文阅读区、等宽字符的 JSON 折叠树、字幕视效 UI 卡片），颜色/明暗/控件外观取自共享层，同样不用光泽层/模糊/阴影；语法着色借用语义令牌（键=accent-deep、字符串=warning、数值=syntax-number、布尔=success、参考线=border-strong），仅空态象形用 linear-gradient 画 1px 描边（形状而非高光）
export.html: Safari 下载框架的独立文档壳，避免 blob 页面替换诊断页
export.js: 同步接收导出文本并在框架内触发文件下载，不传送凭证

设计边界:
原始报文常态在 background 内存中保留最近 20 次请求/响应，并且只允许该扩展页向 background 请求；请求体、响应体、URL 与非敏感头部按原文保留在 background 内存中，Authorization 永不进入 diagnostics、设置窗口（settings）或 Netflix page state。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
