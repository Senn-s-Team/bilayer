# scripts/
> L2 | 父级: ../CLAUDE.md

成员清单
check.mjs: 零依赖项目检查器，验证 manifest JSON 与 JavaScript 语法
create-safari-project.sh: Safari 工程生成器，自动发现 Xcode、调用 converter、修正宿主 App bundle id 前缀，并为 Debug/Release 分配 dev/release bundle id
package-dmg.sh: Release 构建与 dmg 打包脚本，产物输出到 dist/ 并包含 /Applications 快捷方式

设计边界:
脚本只服务本地开发和打包，不进入扩展运行时；Xcode 选择收敛在脚本内，bundle id 后处理收敛 converter 的命名偏差。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
