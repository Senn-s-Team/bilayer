# [INPUT]: 可选 DEVELOPER_DIR，以及 /Applications 下安装的完整 Xcode
# [OUTPUT]: 导出能解析目标工具的 DEVELOPER_DIR（仅定义函数，source 时不产生副作用）
# [POS]: scripts 的 Xcode 定位公共层，被 create-safari-project.sh / package-dmg.sh / install-app.sh source 复用；Xcode 选择的唯一实现
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

# 用法: source scripts/xcode-env.sh && resolve_developer_dir <tool>
# xcrun 解析失败（例如 xcode-select 指向 CommandLineTools）时回退到 /Applications 下的 Xcode 安装。

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "xcode-env.sh 只应被 source，请勿直接执行。" >&2
  exit 1
fi

resolve_developer_dir() {
  local tool="${1:-xcodebuild}"
  local resolved candidate path
  local -a candidates

  # xcrun --find 会回退到 PATH，因此 /usr/local/bin 下的同名软链也算「找到」；
  # 只有落在某个 X.app/Contents/Developer 下才说明完整 Xcode 已就位。
  resolved="$(xcrun --find "$tool" 2>/dev/null || true)"
  if [[ "$resolved" == *".app/Contents/Developer/"* ]]; then
    return 0
  fi

  # /Applications/Xcode.app 是 converter 与 GitHub runner 的默认软链，优先使用；
  # 其余两种命名习惯各按版本号从新到旧（本机常用 Xcode-<ver>.app，runner 用 Xcode_<ver>.app）。
  # 命名习惯之间不混排：sort -V 逐字符比较，混合前缀会让版本号失去可比性。
  # -z + read -d ''：保留含空格的 App 名，避免按空白切词。
  candidates=(/Applications/Xcode.app)
  for candidate in "/Applications/Xcode-*.app" "/Applications/Xcode_*.app"; do
    while IFS= read -r -d '' path; do
      candidates+=("$path")
    done < <(
      for path in $candidate; do
        [[ -d "$path" ]] && printf '%s\0' "$path"
      done | sort -u -z -V -r
    )
  done

  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate/Contents/Developer/usr/bin/$tool" ]]; then
      export DEVELOPER_DIR="$candidate/Contents/Developer"
      return 0
    fi
  done

  return 1
}
