/**
 * [INPUT]: 依赖 Node.js fs/child_process/url/path 模块、extension 源码树与 package.json
 * [OUTPUT]: 对外提供 manifest 校验、版本一致性断言与 JavaScript 语法检查
 * [POS]: scripts 的质量入口，被 npm run check 与 CI 调用；是 manifest 与 package.json 版本同构的唯一断言点
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// fileURLToPath 而非 URL.pathname：后者保留 %20 等转义，路径含空格时 readFileSync 直接失败
const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}

if (manifest.version !== pkg.version) {
  throw new Error(
    `version mismatch: extension/manifest.json is ${manifest.version}, package.json is ${pkg.version}`,
  );
}

for (const [size, resource] of Object.entries(manifest.icons ?? {})) {
  const iconPath = join(root, "extension", resource);
  if (!statSync(iconPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`manifest icon ${size} points at a missing file: ${resource}`);
  }
}

for (const file of listFiles(join(root, "extension/src"), ".js")) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Project check passed (version ${manifest.version}).`);

function listFiles(directory, extension) {
  const result = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) result.push(...listFiles(path, extension));
    if (stat.isFile() && path.endsWith(extension)) result.push(path);
  }

  return result;
}
