#!/usr/bin/env bash
# 仅执行重签名、注册系统扩展并启动 Netflix.app
set -e

APP_PATH="/Applications/Bilayer.app"
APPEX_PATH="${APP_PATH}/Contents/PlugIns/Bilayer Extension.appex"
NETFLIX_PWA="/Users/chinnsenn/Applications/Netflix.app"
CERT_NAME="Apple Development: iamchinnsenn@gmail.com (Q7T9A8KJXD)"

if [ ! -d "${APP_PATH}" ]; then
  echo "错误: 未找到 ${APP_PATH}，请先将编译好的 App 拷贝到 /Applications/ 下！"
  exit 1
fi

echo "==> 1. 使用 Apple Developer 证书签名..."
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

find "${APP_PATH}" -name "*.dylib" -exec codesign -f -s "${CERT_NAME}" {} + 2>/dev/null || true
codesign -f -s "${CERT_NAME}" --entitlements /tmp/appex.entitlements "${APPEX_PATH}"
codesign -f -s "${CERT_NAME}" --entitlements /tmp/app.entitlements "${APP_PATH}"
rm -f /tmp/appex.entitlements /tmp/app.entitlements

echo "==> 2. 刷新系统扩展注册..."
pluginkit -r "${APPEX_PATH}" 2>/dev/null || true
pluginkit -a "${APPEX_PATH}"

echo "==> 3. 激活宿主 App 并重启桌面 Netflix.app..."
open "${APP_PATH}"
pkill -x "Netflix" 2>/dev/null || true
sleep 1
open "${NETFLIX_PWA}"

echo "==> 🎉 搞定！双语字幕已就绪！"
