# diagnostics/
> L2 | 父级: ../CLAUDE.md

成员清单
diagnostics.js: 通过 globalThis.BilayerDiagnostics.mount(root) 懒挂载设置窗口诊断面板；刷新更新摘要、采集状态和全局计数，保留分页锚点、焦点与滚动；generation 变化清除旧详情，详情 await 后再次隔离隐藏或迟到响应；提供筛选/搜索、JSON raw/formatted/tree、复制、全快照同源 iframe 导出和确认清空；采集保存失败保留提示，清空失败恢复轮询，双日语只注音译文
diagnostics.css: 规则限定于 .dc-root，定义紧凑工具栏、五列请求表、详情面板与窄视口布局，共享 settings design tokens
diagnostics-payload.css: 规则限定于 .dc-root，定义 JSON 树导航、搜索匹配、长字符串展开及安全字幕注音预览
export.html: runtime.getURL 加载的隐藏同源下载文档，不展示诊断历史
export.js: 在隔离同源文档内触发 JSON Blob 下载，不访问后台、不接收凭证

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

设计边界:
请求/响应正文由 background 持久化；设置页只读取选中详情并按统一快照分页导出。诊断控制器只允许精确 settings 页面 sender 访问后台协议；Authorization 不得进入摘要、详情报文或导出。
