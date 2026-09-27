#!/usr/bin/env bash
# [INPUT]: 目标 tag（如 v0.3.0）与 extension/manifest.json
# [OUTPUT]: tag 去掉前导 v 后与 manifest version 一致时退出 0，不一致时输出 ::error:: 并退出 1
# [POS]: scripts 的发布版本守卫，被 .github/workflows/release.yml 的 tag 构建调用
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT_DIR/extension/manifest.json"
TAG="${1:-}"

if [[ -z "$TAG" ]]; then
  echo "用法: $(basename "$0") <tag，例如 v0.3.0>" >&2
  exit 1
fi

TAG_VERSION="${TAG#v}"
# plutil 与 create-safari-project.sh / package-dmg.sh 读取版本的方式一致，避免再引入 JSON 解析依赖
MANIFEST_VERSION="$(/usr/bin/plutil -extract version raw "$MANIFEST")"

if [[ "$TAG_VERSION" != "$MANIFEST_VERSION" ]]; then
  echo "::error::tag $TAG 的版本 $TAG_VERSION 与 extension/manifest.json 的 $MANIFEST_VERSION 不一致" >&2
  exit 1
fi

echo "版本一致: tag $TAG == manifest $MANIFEST_VERSION"
