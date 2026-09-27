/**
 * [INPUT]: 依赖 Node.js fs/path 与 create-safari-project.sh 生成的 project.pbxproj
 * [OUTPUT]: 从 appex 资源中剥离 CLAUDE.md 的幂等 pbxproj 补丁（移除引用 + 注入构建阶段）
 * [POS]: scripts 的 Safari 工程后处理步骤，被 create-safari-project.sh 在 converter 之后调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

// converter 把 extension/ 整棵目录树引为 appex 资源（含 folder reference 的递归拷贝），
// 内部文档因此随分发进入用户载荷。此脚本用幂等补丁消除它：
//   1. 删除顶层 CLAUDE.md 的 PBXBuildFile / Resources 条目 / PBXFileReference（拷贝前就不产出）
//   2. 注入 shell 构建阶段，清理 folder reference 递归拷贝进来的嵌套 CLAUDE.md

import { readFileSync, writeFileSync } from "node:fs";

const PHASE_ID = "D46020003069207A00128E67";
const PHASE_NAME = "Strip internal docs";
const MARKER = "/* " + PHASE_NAME + " */";

const [, , pbxprojPath] = process.argv;

if (!pbxprojPath) {
  console.error("用法: node patch-safari-project.mjs <path/to/project.pbxproj>");
  process.exit(1);
}

let contents = readFileSync(pbxprojPath, "utf8");

// 先撤销上一轮注入，保证重复执行不会堆叠
contents = contents
  .replace(new RegExp(`\\n\\t\\t${PHASE_ID} ${escapeRe(MARKER)} = \\{[^}]*?\\n\\t\\t\\};`, "s"), "")
  .replace(new RegExp(`\\n\\t\\t\\t\\t${PHASE_ID} ${escapeRe(MARKER)},`, "g"), "");

const before = contents;
contents = stripClaudeReferences(contents);

const extensionTarget = findExtensionTarget(contents);
if (!extensionTarget) {
  console.error("错误: 未在 pbxproj 中找到 Extension target，无法注入剥离阶段");
  process.exit(1);
}

if (!contents.includes(PHASE_ID)) {
  contents = contents.replace(
    "/* Begin PBXResourcesBuildPhase section */",
    buildPhaseObject() + "\n/* Begin PBXResourcesBuildPhase section */",
  );
  contents = contents.replace(extensionTarget, (block) => {
    if (block.includes(PHASE_ID)) return block;
    // 必须排在 Resources 之后：folder reference 在 Resources 阶段递归拷贝，
    // 阶段排在前面会被随后写入的副本覆盖。
    const phaseLine = `\t\t\t\t${PHASE_ID} ${MARKER},\n`;
    if (/\t\t\t\t[A-F0-9]{24} \/\* Resources \*\/,\n/.test(block)) {
      return block.replace(
        /(\t\t\t\t[A-F0-9]{24} \/\* Resources \*\/,\n)/,
        `$1${phaseLine}`,
      );
    }
    return block.replace(/(buildPhases = \(\n)/, `$1${phaseLine}`);
  });
}

if (contents === before && !contents.includes(PHASE_ID)) {
  console.error("错误: 补丁未生效");
  process.exit(1);
}

contents = relaxScriptSandboxing(contents);

writeFileSync(pbxprojPath, contents);
console.log("已应用内部文档剥离补丁。");

// 构建阶段需要写 appex 资源目录，脚本沙盒会以 "Operation not permitted" 拦截；
// 只为 Extension target 关闭，宿主 target 保持沙盒不变。
function relaxScriptSandboxing(source) {
  return source.replace(
    /(\t\t[A-F0-9]{24} \/\* (?:Debug|Release) \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = \{\n)((?:.*?\n)*?)(\t\t\t\tINFOPLIST_FILE = "?Bilayer Extension\/Info\.plist"?;\n)/g,
    (match, head, middle, infoplistLine) => {
      const cleaned = middle.replace(/\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = YES;\n/g, "");
      return `${head}${cleaned}${infoplistLine}\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;\n`;
    },
  );
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 移除顶层 CLAUDE.md 的三处 pbxproj 引用：构建文件、Resources 阶段成员、文件引用
function stripClaudeReferences(source) {
  return source
    .replace(/\n\t\t[A-F0-9]{24} \/\* CLAUDE\.md in Resources \*\/ = \{isa = PBXBuildFile;.*?\};/gs, "")
    .replace(/\n\t\t\t\t[A-F0-9]{24} \/\* CLAUDE\.md in Resources \*\/,/g, "")
    .replace(/\n\t\t[A-F0-9]{24} \/\* CLAUDE\.md \*\/ = \{isa = PBXFileReference;.*?\};/gs, "")
    .replace(/\n\t\t\t\t[A-F0-9]{24} \/\* CLAUDE\.md \*\/,/g, "");
}

function findExtensionTarget(source) {
  const targets = [...source.matchAll(/\/\* Begin PBXNativeTarget section \*\/(.*?)\/\* End PBXNativeTarget section \*\//gs)];
  for (const [, section] of targets) {
    const blocks = section.split(/\n\t\t(?=[A-F0-9]{24} \/\*)/);
    for (const block of blocks) {
      if (block.includes('productType = "com.apple.product-type.app-extension"')) {
        return block;
      }
    }
  }
  return null;
}

function buildPhaseObject() {
  // pbxproj 字符串内嵌双引号必须转义；JS 用单引号包裹，令 \\" 产出 \" 写入 pbxproj
  const script = [
    'find \\"$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH\\" -name \'CLAUDE.md\' -delete 2>/dev/null || true',
    'find \\"$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH\\" -name \'*.test.mjs\' -delete 2>/dev/null || true',
  ].join("\\n");

  return `/* Begin PBXShellScriptBuildPhase section */
\t\t${PHASE_ID} ${MARKER} = {
\t\t\tisa = PBXShellScriptBuildPhase;
\t\t\talwaysOutOfDate = 1;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\tinputFileListPaths = (
\t\t\t);
\t\t\tinputPaths = (
\t\t\t);
\t\t\tname = "${PHASE_NAME}";
\t\t\toutputFileListPaths = (
\t\t\t);
\t\t\toutputPaths = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t\tshellPath = /bin/sh;
\t\t\tshellScript = "${script}";
\t\t};
/* End PBXShellScriptBuildPhase section */
`;
}
