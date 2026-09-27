#!/usr/bin/env bash
# [INPUT]: SafariApp Xcode 工程、本机 Apple 开发者证书（可选 CERT_NAME 与 NETFLIX_APP_PATH 覆盖）
# [OUTPUT]: 对已安装宿主 App 重新签名、刷新扩展注册并重启流媒体桌面应用
# [POS]: scripts 的已安装包重签名入口，被 npm run update:app 调用；签名与注册逻辑委托 sign-app.sh
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-Bilayer}"
APP_PATH="${APP_PATH:-/Applications/$APP_NAME.app}"

# 流媒体桌面应用（PWA）路径因机器而异，默认走系统 Applications，可用 NETFLIX_APP_PATH 覆盖
STREAMING_APP_PATH="${NETFLIX_APP_PATH:-/Applications/Netflix.app}"

if [[ ! -d "$APP_PATH" ]]; then
  echo "错误: 未找到 $APP_PATH，请先运行 npm run install:app 安装。" >&2
  exit 1
fi

echo "==> 1. 重新签名并注册扩展..."
"$ROOT_DIR/scripts/sign-app.sh" "$APP_PATH"

echo "==> 2. 激活宿主 App..."
open "$APP_PATH"

if [[ -d "$STREAMING_APP_PATH" ]]; then
  echo "==> 3. 重启桌面流媒体应用 ($STREAMING_APP_PATH)..."
  /usr/bin/pkill -f "$(basename "$STREAMING_APP_PATH" .app)" 2>/dev/null || true
  sleep 1
  open "$STREAMING_APP_PATH"
else
  echo "==> 3. 未找到 $STREAMING_APP_PATH，跳过重启（可用 NETFLIX_APP_PATH 指定）。"
fi

echo "==> 🎉 完成！扩展已重新签名并生效。"
