#!/usr/bin/env bash
# [INPUT]: 依赖 xcode-env.sh 定位到的完整 Xcode 及其 xcrun safari-web-extension-converter
# [OUTPUT]: 对外生成 SafariApp Xcode 工程，同步 WebExtension 版本并钉住 MACOSX_DEPLOYMENT_TARGET
# [POS]: scripts 的 Safari 打包入口，被 npm run safari:project 调用
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_DIR="$ROOT_DIR/extension"
PROJECT_DIR="$ROOT_DIR/SafariApp"
APP_NAME="Bilayer"
BUNDLE_ID="${BUNDLE_ID:-com.chinnsenn.netflix-dual-subtitles-safari}"
DEBUG_BUNDLE_ID="${DEBUG_BUNDLE_ID:-$BUNDLE_ID.dev}"
PBXPROJ="$PROJECT_DIR/$APP_NAME/$APP_NAME.xcodeproj/project.pbxproj"
VIEW_CONTROLLER="$PROJECT_DIR/$APP_NAME/$APP_NAME/ViewController.swift"
APP_INFO_PLIST="$PROJECT_DIR/$APP_NAME/$APP_NAME/Info.plist"
VERSION="$(/usr/bin/plutil -extract version raw "$EXTENSION_DIR/manifest.json")"
IFS=. read -r VERSION_MAJOR VERSION_MINOR VERSION_PATCH <<< "$VERSION"
BUILD_VERSION="$((10#$VERSION_MAJOR * 10000 + 10#$VERSION_MINOR * 100 + 10#$VERSION_PATCH))"

# converter 把构建机的 SDK 版本写进工程级 MACOSX_DEPLOYMENT_TARGET（随构建机 SDK 变化），宿主 App 继承后
# LSMinimumSystemVersion 就等于该 SDK 版本：产物只能在构建机同版本 macOS 上安装，且跨机器不可复现。
# 这里显式钉住下限。manifest 的最高要求键是 optional_host_permissions（Safari 15.5 起支持），
# 其余（manifest_version 3 / action / host_permissions / web_accessible_resources）为 Safari 15.4；
# Safari 15.5 随 macOS 12.4 发布，故宿主 App 与 appex 统一要求 macOS 12.4。改这个值前先核对 manifest。
MACOS_MIN_VERSION="12.4"

source "$ROOT_DIR/scripts/xcode-env.sh"

if ! resolve_developer_dir safari-web-extension-converter; then
  echo "safari-web-extension-converter is unavailable."
  echo "Install full Xcode, then run:"
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  echo "Or set DEVELOPER_DIR to an installed Xcode:"
  echo "  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer"
  exit 1
fi

xcrun safari-web-extension-converter "$EXTENSION_DIR" \
  --project-location "$PROJECT_DIR" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only \
  --force

if [[ -f "$PBXPROJ" ]]; then
  export BUNDLE_ID DEBUG_BUNDLE_ID VERSION BUILD_VERSION MACOS_MIN_VERSION
  /usr/bin/perl -0pi -e '
    s/MARKETING_VERSION = [^;]+;/MARKETING_VERSION = $ENV{VERSION};/g;
    s/CURRENT_PROJECT_VERSION = [^;]+;/CURRENT_PROJECT_VERSION = $ENV{BUILD_VERSION};/g;
    s/MACOSX_DEPLOYMENT_TARGET = [^;]+;/MACOSX_DEPLOYMENT_TARGET = $ENV{MACOS_MIN_VERSION};/g;
  ' "$PBXPROJ"
  /usr/bin/perl -0pi -e '
    sub fallback { defined $_[0] ? $_[0] : $_[1] }
    my @bundle_ids = (
      "$ENV{DEBUG_BUNDLE_ID}.Extension",
      "$ENV{BUNDLE_ID}.Extension",
      $ENV{DEBUG_BUNDLE_ID},
      $ENV{BUNDLE_ID},
    );
    my $bundle_id_index = 0;
    # converter 仅在含空格/连字符时才给值加引号；必须匹配可选的引号形式，
    # 否则单词型 App 名会让宿主 bundle id 逃过重写，破坏 Extension 前缀约束。
    s/PRODUCT_BUNDLE_IDENTIFIER = "?[^";]+"?;/"PRODUCT_BUNDLE_IDENTIFIER = \"" . fallback($bundle_ids[$bundle_id_index++], $ENV{BUNDLE_ID}) . "\";"/ge;
  ' "$PBXPROJ"
  /usr/bin/perl -0pi -e '
    sub fallback { defined $_[0] ? $_[0] : $_[1] }
    s/\n\s+SAFARI_EXTENSION_BUNDLE_IDENTIFIER = "[^"]+";//g;
    my @extension_ids = (
      "$ENV{DEBUG_BUNDLE_ID}.Extension",
      "$ENV{BUNDLE_ID}.Extension",
    );
    my $extension_id_index = 0;
    s/(PRODUCT_NAME = "\$\(TARGET_NAME\)";\n\s+REGISTER_APP_GROUPS = YES;\n)/$1 . "\t\t\t\tSAFARI_EXTENSION_BUNDLE_IDENTIFIER = \"" . fallback($extension_ids[$extension_id_index++], "$ENV{BUNDLE_ID}.Extension") . "\";\n"/ge;
  ' "$PBXPROJ"
fi

# converter 会把 extension/ 整棵树引为 appex 资源；剥离内部文档，避免随分发泄漏到用户载荷
if [[ -f "$PBXPROJ" ]]; then
  node "$ROOT_DIR/scripts/patch-safari-project.mjs" "$PBXPROJ"
fi

if [[ -f "$APP_INFO_PLIST" ]] && ! /usr/libexec/PlistBuddy -c "Print :SafariExtensionBundleIdentifier" "$APP_INFO_PLIST" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Add :SafariExtensionBundleIdentifier string \$(SAFARI_EXTENSION_BUNDLE_IDENTIFIER)" "$APP_INFO_PLIST"
fi

if [[ -f "$VIEW_CONTROLLER" ]]; then
  export BUNDLE_ID
  /usr/bin/perl -0pi -e '
    s|let extensionBundleIdentifier = "[^"]+"|let extensionBundleIdentifier =\n    Bundle.main.object(forInfoDictionaryKey: "SafariExtensionBundleIdentifier") as? String ??\n    "$ENV{BUNDLE_ID}.Extension"|g
  ' "$VIEW_CONTROLLER"
fi

echo "Safari project generated at $PROJECT_DIR"
