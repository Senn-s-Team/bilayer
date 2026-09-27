#!/usr/bin/env bash
# [INPUT]: 已生成的 SafariApp Xcode 工程，以及 xcodebuild/hdiutil
# [OUTPUT]: dist/Bilayer-<version>.dmg
# [POS]: scripts 的本地 macOS 分发打包入口，被 npm run package:dmg 调用
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Bilayer"
PROJECT_DIR="$ROOT_DIR/SafariApp/$APP_NAME"
PROJECT_FILE="$PROJECT_DIR/$APP_NAME.xcodeproj"
MANIFEST="$ROOT_DIR/extension/manifest.json"
BUILD_DIR="$ROOT_DIR/build"
DERIVED_DATA="$BUILD_DIR/DerivedData"
DIST_DIR="$ROOT_DIR/dist"
STAGING_DIR="$BUILD_DIR/dmg-staging"
CONFIGURATION="${CONFIGURATION:-Release}"
DMG_FORMAT="${DMG_FORMAT:-UDZO}"

if [[ ! -d "$PROJECT_FILE" ]]; then
  "$ROOT_DIR/scripts/create-safari-project.sh"
fi

if ! xcrun --find xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild is unavailable. Install full Xcode and select it with xcode-select."
  exit 1
fi

if ! command -v hdiutil >/dev/null 2>&1; then
  echo "hdiutil is unavailable."
  exit 1
fi

VERSION="$(/usr/bin/plutil -extract version raw "$MANIFEST" 2>/dev/null || echo "0.0.0")"
APP_PATH="$DERIVED_DATA/Build/Products/$CONFIGURATION/$APP_NAME.app"
DMG_PATH="$DIST_DIR/$APP_NAME-$VERSION.dmg"

mkdir -p "$BUILD_DIR" "$DIST_DIR"

xcodebuild \
  -project "$PROJECT_FILE" \
  -scheme "$APP_NAME" \
  -configuration "$CONFIGURATION" \
  -derivedDataPath "$DERIVED_DATA" \
  -destination "platform=macOS" \
  -quiet \
  build

if [[ ! -d "$APP_PATH" ]]; then
  echo "Built app was not found at: $APP_PATH"
  exit 1
fi

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
/usr/bin/ditto "$APP_PATH" "$STAGING_DIR/$APP_NAME.app"
ln -s /Applications "$STAGING_DIR/Applications"

rm -f "$DMG_PATH"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format "$DMG_FORMAT" \
  "$DMG_PATH"

echo "DMG created at $DMG_PATH"
