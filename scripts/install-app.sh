#!/usr/bin/env bash
# [INPUT]: Xcode 工程、本地编译产物及本机 Apple 开发者证书
# [OUTPUT]: 编译 Release 版本，自动覆盖到 /Applications/Netflix Dual Subtitles.app 并完成重签名与 pluginkit 注册
# [POS]: scripts 的一键构建与本地安装部署入口，被 npm run install:app 调用
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Netflix Dual Subtitles"
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

if ! xcrun --find xcodebuild >/dev/null 2>&1; then
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

echo "==> 3. 检测代码签名身份..."
CERT_NAME="$(security find-identity -v -p codesigning 2>/dev/null | grep -o 'Apple Development: [^"]*' | head -n 1 || true)"
SIGN_TARGET="${CERT_NAME:--}"

echo "==> 4. 注入沙盒权限并签名 ($SIGN_TARGET)..."
cat << 'EOF' > /tmp/appex.entitlements
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-only</key>
    <true/>
</dict>
</plist>
EOF

cat << 'EOF' > /tmp/app.entitlements
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-only</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
</dict>
</plist>
EOF

find "${DEST_APP}" -name "*.dylib" -exec codesign -f -s "${SIGN_TARGET}" {} + 2>/dev/null || true
codesign -f -s "${SIGN_TARGET}" --entitlements /tmp/appex.entitlements "${DEST_APPEX}"
codesign -f -s "${SIGN_TARGET}" --entitlements /tmp/app.entitlements "${DEST_APP}"
rm -f /tmp/appex.entitlements /tmp/app.entitlements

echo "==> 5. 清除隔离属性并刷新 pluginkit 插件注册..."
xattr -cr "$DEST_APP"
pluginkit -r "$DEST_APPEX" 2>/dev/null || true
pluginkit -a "$DEST_APPEX"

echo "==> 6. 激活宿主 App 以同步 LaunchServices..."
open "$DEST_APP"

echo "==> 🎉 搞定！最新扩展已成功覆盖至 $DEST_APP"
