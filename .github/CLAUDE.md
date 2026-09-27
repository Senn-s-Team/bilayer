# .github/
> L2 | 父级: ../CLAUDE.md

成员清单
workflows/ci.yml: push 与 PR 到 main 时在 Node 22/24 上运行 npm run check 与 npm test；无依赖安装步骤，因为项目刻意保持零运行时依赖
workflows/release.yml: push v* tag（或 workflow_dispatch 干跑）时在 macos-latest 上运行 check/test、校验 tag 版本、生成 Safari 工程并构建 dist/Bilayer-<version>.dmg；tag 推送创建或更新对应 GitHub Release 并附上 DMG，手动触发只上传 workflow artifact；单一 concurrency 组串行化发布

设计边界:
CI 只做静态检查与行为回归，不构建 Safari 工程——那需要完整 Xcode 与 macOS runner。工作流声明的 Node 版本矩阵必须在真实运行时验证过：测试输出格式随 Node 版本变化（Node 22 为 TAP 风格 `# tests`，Node 26 为 `ℹ tests`），断言应从退出码判断而非匹配输出文本。

发布流水线需要 GITHUB_TOKEN 的 `contents: write` 才能 gh release create/upload；workflow_dispatch 干跑只上传 artifact，绝不写 Release。Release 正文里的 Gatekeeper 安装提示依赖 `gh release create --notes` 与 `--generate-notes` 的合并：gh 把 notes 作为 body 连同 generate_release_notes=true 提交，合并发生在服务端（REST API「If body is specified, the body will be pre-pended to the automatically generated notes」），创建后仍断言正文含提示，防止 gh 行为漂移后警告静默消失。macOS runner 没有签名证书，实测 xcodebuild 自动落到 CODE_SIGN_IDENTITY=-（Sign to Run Locally），不需要 DEVELOPMENT_TEAM 与描述文件，产物仅 ad-hoc 签名且未公证：spctl -a -t exec 拒绝它，当前 DMG 只适合本地验证，不能作为可信下载。Xcode 目录命名在 runner 与本机不同（runner 用 /Applications/Xcode_<ver>.app 并把 /Applications/Xcode.app 作为默认软链，本机常见 /Applications/Xcode-<ver>.app），统一交给 scripts/xcode-env.sh 解析，工作流不再自行探测。产物最低系统版本由 create-safari-project.sh 钉在 macOS 12.4，不随 runner SDK 漂移。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
