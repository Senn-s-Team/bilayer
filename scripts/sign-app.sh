#!/usr/bin/env bash
# [INPUT]: 已构建的 .app 路径、嵌套 .appex 与本机 Apple 开发者证书（可用 CERT_NAME 覆盖）
# [OUTPUT]: 完成沙盒权限注入、嵌套深层签名、隔离属性清除与 pluginkit 扩展注册
# [POS]: scripts 的签名与注册公共层，被 install-app.sh 复用；entitlements/codesign/pluginkit 的唯一实现
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

set -euo pipefail

APP_PATH="${1:-}"

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "用法: $(basename "$0") <path/to/App.app>" >&2
  exit 1
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "错误: 未找到 codesign，请安装 Xcode 命令行工具。" >&2
  exit 1
fi

# 证书优先级：显式 CERT_NAME > 本机第一个 Apple Development 身份 > ad-hoc 签名（-）
if [[ -z "${CERT_NAME:-}" ]]; then
  CERT_NAME="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -o 'Apple Development: [^"]*' | head -n 1 || true)"
fi
SIGN_TARGET="${CERT_NAME:--}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat << 'EOF' > "$TMP_DIR/appex.entitlements"
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

cat << 'EOF' > "$TMP_DIR/app.entitlements"
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

echo "==> 签名身份: $SIGN_TARGET"

find "$APP_PATH" -name "*.dylib" -exec codesign -f -s "$SIGN_TARGET" {} + 2>/dev/null || true

shopt -s nullglob
APPEX_PATHS=("$APP_PATH/Contents/PlugIns/"*.appex)
if (( ${#APPEX_PATHS[@]} == 0 )); then
  echo "错误: 未在 $APP_PATH/Contents/PlugIns/ 下找到 .appex" >&2
  exit 1
fi

for appex in "${APPEX_PATHS[@]}"; do
  codesign -f -s "$SIGN_TARGET" --entitlements "$TMP_DIR/appex.entitlements" "$appex"
done

codesign -f -s "$SIGN_TARGET" --entitlements "$TMP_DIR/app.entitlements" "$APP_PATH"

echo "==> 清除隔离属性并刷新 pluginkit 注册..."
xattr -cr "$APP_PATH"
for appex in "${APPEX_PATHS[@]}"; do
  pluginkit -r "$appex" 2>/dev/null || true
  pluginkit -a "$appex"
done
