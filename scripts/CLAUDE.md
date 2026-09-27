# scripts/
> L2 | 父级: ../CLAUDE.md

成员清单
check.mjs: 零依赖项目检查器，验证 manifest 结构、manifest↔package 版本一致、图标引用存在与 JavaScript 语法
build-icons.sh: 图标派生器，从 extension/icons/icon.svg 唯一手工源经 sips 生成 16/32/48/96/128/256/512 PNG，并校验 manifest 引用与产物一致
sign-app.sh: 签名与注册公共层，注入 entitlements、深层签名 .app 与嵌套 .appex、清除隔离属性并刷新 pluginkit；证书按 CERT_NAME > 本机 Apple Development > ad-hoc 顺序解析
content.test.mjs: 驱动真实内容脚本，验证独立源、日文源字幕 ruby 注音回填、provider 切换、预取热更新、上下文重译与凭证隔离
overlay.test.mjs: 运行真实字幕层并模拟 Shadow DOM，验证相同字幕节点复用（含 ruby 注音）、ruby/rt 元素生成及单行更新、消失状态
subtitle-store.test.mjs: 驱动真实字幕存储，验证同轨并发请求合并、切集后缓存失效以及 subtitleParser 多行字幕单行化折叠
translation.test.mjs: 驱动真实调度器，验证首句优先、默认 10 组和 60-120 秒双上限、邻句、seek、预算、日文源 ruby 注音回填与多行译文单行化折叠
translation-worker.test.mjs: 模拟后台请求，验证 provider 切换、日文源语言 ruby 振假名 Schema/提示词注入与结构校验、权限、阶段诊断与原始报文，以及单字幕/多对象序列兼容和漏译/ID 错配拒绝
create-safari-project.sh: Safari 工程生成器，自动发现 Xcode、调用 converter、修正宿主 App bundle id 前缀（匹配可选引号形式），并为 Debug/Release 分配 dev/release bundle id
patch-safari-project.mjs: 生成后 pbxproj 幂等补丁，移除顶层 CLAUDE.md 引用、注入 Resources 之后的剥离构建阶段（删除 appex 内的 CLAUDE.md 与测试文件），并只为 Extension target 关闭脚本沙盒
package-dmg.sh: Release 构建与 dmg 打包脚本，产物输出到 dist/ 并包含 /Applications 快捷方式
update-app.sh: 对已安装宿主 App 重新签名、刷新扩展注册并重启桌面流媒体应用；应用路径与签名身份可配置
install-app.sh: 一键编译 Release 版本、覆盖安装至 /Applications/、调用 sign-app.sh 签名并刷新系统扩展注册

设计边界:
脚本只服务本地开发和打包，不进入扩展运行时；Xcode 选择收敛在脚本内，bundle id 后处理收敛 converter 的命名偏差，签名与注册的唯一实现在 sign-app.sh。脚本不得写入个人证书名、邮箱或绝对家目录路径。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
