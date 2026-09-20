# netflix-dual-subtitles-safari - Netflix Safari 双字幕扩展
WebExtension + macOS Safari Extension Packager + 原生浏览器字幕覆盖层

<directory>
extension/ - 浏览器扩展源码 (1子目录: src...)
</directory>

<directory>
SafariApp/ - Apple converter 生成的 macOS Safari App Extension 工程
</directory>

<directory>
scripts/ - 本地检查与 Safari 工程生成脚本
</directory>

<config>
package.json - 项目命令入口，保持零依赖检查链路
</config>

<config>
README.md - 安装、开发、转换 Safari 工程的操作地图
</config>

架构决策:
Safari 工程由 `scripts/create-safari-project.sh` 从 WebExtension 源码生成，源码保持跨浏览器格式；Netflix 私有页面状态集中在 page/content 桥接层，字幕解析与 overlay 渲染保持平台无关。

变更日志:
2026-07-25: 创建 Safari WebExtension 源码项目，加入 Netflix 双字幕 MVP 架构。
2026-07-25: 发现本机 Xcode 26.5，生成 SafariApp 工程并补充图标管线。
2026-09-20: 修复 Safari 全屏模式下双字幕不显示，新增 fullscreenMount 模块并接入 overlay.mount()，版本 0.1.3。

法则: 极简·稳定·导航·版本精确
