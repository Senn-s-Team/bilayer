# scripts/
> L2 | 父级: ../CLAUDE.md

成员清单
check.mjs: 零依赖项目检查器，验证 manifest 结构、manifest↔package 版本一致、图标引用存在与 JavaScript 语法
build-icons.sh: 图标派生器，从 extension/icons/icon-source.png 唯一手工源经 sips 生成 16/32/48/96/128/256/512 PNG（派生前拒收被压平或缺 alpha、非方形的源图；SIZES 不含 1024，因为 manifest 的 1024 条目本就指向源图），并校验 manifest 引用与产物一致
xcode-env.sh: Xcode 定位公共层，被 source 后提供 resolve_developer_dir；先确认 xcrun 解析结果落在某个 X.app/Contents/Developer 下（xcrun 会回退到 PATH），否则扫描 /Applications/Xcode.app 与按版本号从新到旧的 Xcode-<ver>.app / Xcode_<ver>.app 并导出 DEVELOPER_DIR
sign-app.sh: 签名与注册公共层，注入 entitlements、深层签名 .app 与嵌套 .appex、清除隔离属性并刷新 pluginkit；证书按 CERT_NAME > 本机 Apple Development > ad-hoc 顺序解析
i18n.test.mjs: 驱动真实扩展页 i18n 模块与真实 _locales 报文，验证 uiLanguage 偏好解析、包内文案同步解析与降级、浏览器语言归一、$1 替换及 [data-i18n-language] 切换器的填充/选中/持久化
onboarding.test.mjs: 解析真实 onboarding.html 构造迷你 DOM，验证向导完成态在标签页 API 失效时仍写入配置并进入可交互完成态、外观控件与位置预设语义、预览渲染数学、模型发现 BILAYER_LIST_MODELS 协议与原生/AI 模式 1→2→3 全路径无异常
settings.test.mjs: 解析真实 settings.html 构造迷你 DOM，验证设置页 provider 写入不丢数据（providers 整数组写入的读-改-写合并：改字段/新增/删除都不丢其它表面在此期间新增的服务）与常驻窗口可见性门控（隐藏时不读取标签页、重新可见立即补一轮且链不停摆），以及新增服务草案的端点校验/模型目录拉取失败就地写进 #newDraftStatus 状态行且不再调用 window.alert
diagnostics.test.mjs: 解析真实 diagnostics.html 构造迷你 DOM，验证导出结果就地写进 #exportStatus 状态行（无记录/下载失败/框架未就绪/框架就绪四态都不弹窗，失败置 data-state=error），以及「渲染为 UI」对带 ruby 且无 readings 的响应逐字渲染注音且不抛异常（回归 renderRubyTextTo 的 rubyPattern ReferenceError）
content.test.mjs: 驱动真实内容脚本，验证独立源、日文源字幕 ruby 注音回填、provider 切换、预取热更新、上下文重译与凭证隔离
overlay.test.mjs: 运行真实字幕层并模拟 Shadow DOM，验证相同字幕节点复用（含 ruby 注音）、ruby/rt 元素生成及单行更新、消失状态
subtitle-store.test.mjs: 驱动真实字幕存储，验证同轨并发请求合并、切集后缓存失效以及 subtitleParser 多行字幕单行化折叠
translation.test.mjs: 驱动真实调度器，验证首句优先、默认 10 组和 60-120 秒双上限、邻句、seek、预算、日文源 ruby 注音回填与多行译文单行化折叠
translation-worker.test.mjs: 模拟后台请求，验证 provider 切换、日文源语言 ruby 振假名 Schema/提示词注入与结构校验、权限、阶段诊断与原始报文，以及单字幕/多对象序列兼容和漏译/ID 错配拒绝
create-safari-project.sh: Safari 工程生成器，经 xcode-env.sh 解析 Xcode 后调用 converter、修正宿主 App bundle id 前缀（匹配可选引号形式）、为 Debug/Release 分配 dev/release bundle id，并把 converter 写入的构建机 SDK 版 MACOSX_DEPLOYMENT_TARGET 统一钉到 MACOS_MIN_VERSION（12.4）
patch-safari-project.mjs: 生成后 pbxproj 幂等补丁，移除顶层 CLAUDE.md 引用、注入 Resources 之后的剥离构建阶段（删除 appex 内的 CLAUDE.md 与测试文件），并只为 Extension target 关闭脚本沙盒
package-dmg.sh: Release 构建与 dmg 打包脚本，经 xcode-env.sh 解析 xcodebuild，产物输出到 dist/ 并包含 /Applications 快捷方式
assert-release-version.sh: 发布版本守卫，把 tag 去掉前导 v 后与 extension/manifest.json 的 version 比对，不一致时输出 ::error:: 并以退出码 1 失败，被 release.yml 在 tag 构建中调用
install-app.sh: 一键编译 Release 版本、覆盖安装至 /Applications/、调用 sign-app.sh 签名并刷新系统扩展注册

设计边界:
脚本只服务本地开发和打包，不进入扩展运行时；Xcode 选择收敛在 xcode-env.sh（xcrun 会经 PATH 回退，因此不能只信 xcrun --find），bundle id 后处理收敛 converter 的命名偏差，签名与注册的唯一实现在 sign-app.sh。脚本不得写入个人证书名、邮箱或绝对家目录路径。最低 macOS 版本是 manifest 能力的函数而非构建机状态：converter 默认把工程级 MACOSX_DEPLOYMENT_TARGET 写成构建机 SDK 版本（会让产物只能在构建机同版本上安装且不可复现），create-safari-project.sh 统一改写为 12.4——即 optional_host_permissions 所需的 Safari 15.5 对应的 macOS 版本；改动该值前必须重新核对 manifest 里的最高要求键。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md