#!/usr/bin/env bash
# [INPUT]: 依赖 macOS sips 与 extension/icons/icon.svg 唯一手工源
# [OUTPUT]: 派生 16/32/48/96/128/256/512 全套 PNG，供 manifest 与 Safari converter 消费
# [POS]: scripts 的图标派生入口，被 npm run icons 调用；保证 SVG 单一真理与 manifest 引用同构
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON_DIR="$ROOT_DIR/extension/icons"
SOURCE="$ICON_DIR/icon.svg"

# 与 manifest.json 的 icons 键保持一致；改这里必须同步改 manifest
SIZES=(16 32 48 96 128 256 512)

if [[ ! -f "$SOURCE" ]]; then
  echo "错误: 未找到图标源文件 $SOURCE"
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "错误: 未找到 sips（需要 macOS）。"
  exit 1
fi

echo "==> 从 icon.svg 派生 ${#SIZES[@]} 个尺寸..."
for size in "${SIZES[@]}"; do
  target="$ICON_DIR/icon-$size.png"
  sips -s format png -z "$size" "$size" "$SOURCE" --out "$target" >/dev/null
  echo "    icon-$size.png"
done

echo "==> 校验 manifest 引用与产物一致..."
node --input-type=module -e '
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const iconDir = process.argv[1];
const manifest = JSON.parse(readFileSync(join(iconDir, "..", "manifest.json"), "utf8"));
const missing = Object.entries(manifest.icons ?? {})
  .filter(([, rel]) => !existsSync(join(iconDir, "..", rel)))
  .map(([size, rel]) => `${size} -> ${rel}`);

if (missing.length > 0) {
  console.error("manifest 引用了不存在的图标:");
  for (const entry of missing) console.error("  " + entry);
  process.exit(1);
}
console.log("    manifest 图标引用全部存在。");
' "$ICON_DIR"

echo "图标已生成于 $ICON_DIR"
