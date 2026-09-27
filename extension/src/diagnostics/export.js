/*
 * [INPUT]: 依赖同源 diagnostics.js 同步调用传入的文件名与 JSON 文本
 * [OUTPUT]: 在独立文档内利用用户点击触发文件下载
 * [POS]: diagnostics 的隔离下载上下文，避免 blob 导航覆盖报文页
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
window.downloadCases = function downloadCases(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
