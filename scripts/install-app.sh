#!/usr/bin/env bash
# [INPUT]: Xcode 工程、xcode-env.sh 定位到的 xcodebuild、本地编译产物及本机 Apple 开发者证书
# [OUTPUT]: 编译 Release 版本，自动覆盖到 /Applications/Bilayer.app 并完成重签名与 pluginkit 注册
# [POS]: scripts 的一键构建与本地安装部署入口，被 npm run install:app 调用
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Bilayer"
PROJECT_DIR="$ROOT_DIR/SafariApp/$APP_NAME"
PROJECT_FILE="$PROJECT_DIR/$APP_NAME.xcodeproj"
BUILD_DIR="$ROOT_DIR/build"
DERIVED_DATA="$BUILD_DIR/DerivedData"
CONFIGURATION="${CONFIGURATION:-Release}"

DEST_APP="/Applications/$APP_NAME.app"
DEST_APPEX="$DEST_APP/Contents/PlugIns/$APP_NAME Extension.appex"

if [[ ! -d "$PROJECT_FILE" ]]; then
  echo "==> Xcode 工程不存在，正在生成..."
  "$ROOT_DIR/scripts/create-safari-project.sh"
fi

source "$ROOT_DIR/scripts/xcode-env.sh"

if ! resolve_developer_dir xcodebuild; then
  echo "错误: 未找到 xcodebuild，请确保安装了 Xcode 并设置了 xcode-select。"
  exit 1
fi

echo "==> 1. 正在编译 $CONFIGURATION 版本..."
mkdir -p "$BUILD_DIR"
xcodebuild \
  -project "$PROJECT_FILE" \
  -scheme "$APP_NAME" \
  -configuration "$CONFIGURATION" \
  -derivedDataPath "$DERIVED_DATA" \
  -destination "platform=macOS" \
  -quiet \
  build

BUILT_APP="$DERIVED_DATA/Build/Products/$CONFIGURATION/$APP_NAME.app"
if [[ ! -d "$BUILT_APP" ]]; then
  echo "错误: 编译产物不存在: $BUILT_APP"
  exit 1
fi

echo "==> 2. 正在覆盖安装到 $DEST_APP..."
rm -rf "$DEST_APP"
/usr/bin/ditto "$BUILT_APP" "$DEST_APP"

echo "==> 3. 签名、清除隔离属性并刷新 pluginkit 注册..."
"$ROOT_DIR/scripts/sign-app.sh" "$DEST_APP"

echo "==> 4. 激活宿主 App 以同步 LaunchServices..."
open "$DEST_APP"

echo "==> 🎉 搞定！最新扩展已成功覆盖至 $DEST_APP"
