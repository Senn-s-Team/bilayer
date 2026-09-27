# .github/
> L2 | 父级: ../CLAUDE.md

成员清单
workflows/ci.yml: push 与 PR 到 main 时在 Node 22/24 上运行 npm run check 与 npm test；无依赖安装步骤，因为项目刻意保持零运行时依赖

设计边界:
CI 只做静态检查与行为回归，不构建 Safari 工程——那需要完整 Xcode 与 macOS runner。工作流声明的 Node 版本矩阵必须在真实运行时验证过：测试输出格式随 Node 版本变化（Node 22 为 TAP 风格 `# tests`，Node 26 为 `ℹ tests`），断言应从退出码判断而非匹配输出文本。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
