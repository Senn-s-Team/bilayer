#!/usr/bin/env bash
# [INPUT]: 依赖 macOS sips 与 extension/icons/icon-source.png 这一唯一手工源（1024² 方形、轮廓外全透明的 RGBA PNG）
# [OUTPUT]: 派生 16/32/48/96/128/256/512 全套 PNG，供 manifest 与 Safari converter 消费
# [POS]: scripts 的图标派生入口，被 npm run icons 调用；保证 PNG 单一真理与 manifest 引用同构
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON_DIR="$ROOT_DIR/extension/icons"
SOURCE="$ICON_DIR/icon-source.png"

# 与 manifest.json 的 icons 键保持一致；改这里必须同步改 manifest。
# 这里刻意不含 1024：manifest 的 1024 条目直接指向源图本身，因此不需要也没有派生副本。
# Safari converter 按 manifest 图标表取最接近理想尺寸的条目来画 App 图标，宿主 App 的
# 1024 槽位（614 px 图形盒）要的是原生 1024，而不是 icon-512 放大 1.199 倍的结果。
SIZES=(16 32 48 96 128 256 512)

if [[ ! -f "$SOURCE" ]]; then
  echo "错误: 未找到图标源文件 $SOURCE"
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "错误: 未找到 sips（需要 macOS）。"
  exit 1
fi

# 源图的轮廓透明度是产品约束（不允许出现不透明白角），被压平或裁成非方形都会静默污染全部派生尺寸
read -r SOURCE_W SOURCE_H SOURCE_ALPHA <<<"$(/usr/bin/sips -g pixelWidth -g pixelHeight -g hasAlpha "$SOURCE" |
  awk '/pixelWidth:/{w=$2} /pixelHeight:/{h=$2} /hasAlpha:/{a=$2} END{print w, h, a}')"

if [[ "$SOURCE_ALPHA" != "yes" ]]; then
  echo "错误: 图标源必须保留 alpha 通道，否则圆角轮廓外会出现不透明白角: $SOURCE"
  exit 1
fi

if [[ "$SOURCE_W" != "$SOURCE_H" ]]; then
  echo "错误: 图标源必须是方形，当前为 ${SOURCE_W}x${SOURCE_H}: $SOURCE"
  exit 1
fi

echo "==> 从 icon-source.png (${SOURCE_W}x${SOURCE_H}) 派生 ${#SIZES[@]} 个尺寸..."
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
