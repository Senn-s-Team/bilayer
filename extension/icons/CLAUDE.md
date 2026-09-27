# icons/
> L2 | 父级: ../CLAUDE.md

成员清单
icon.svg: 图标唯一手工维护源，表达双层字幕（原文蓝 #4C8DFF / 译文琥珀 #FFB020）于深色圆角底
icon-16.png ~ icon-512.png: 由 `npm run icons` 经 sips 从 icon.svg 派生的全套 PNG，供 manifest 各尺寸与 Safari converter 生成 App 图标

设计边界:
SVG 是唯一手工维护源，PNG 由 `scripts/build-icons.sh` 派生生成，manifest 只引用 PNG。禁止直接编辑 PNG；尺寸清单必须与 manifest.json 的 icons 键保持一致。sips 对 SVG 的栅格化保真度经实测优于 magick（magick 的 SVG delegate 未安装时静默产出空白图）。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

