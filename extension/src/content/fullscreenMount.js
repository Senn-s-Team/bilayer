/**
 * [INPUT]: 依赖已挂载的字幕 host 元素与 document/webkitFullscreenElement 状态
 * [OUTPUT]: 对 window.NetflixDualSubtitles 提供 pickMountTarget/installFullscreenHostManagement/bindVideoFullscreen
 * [POS]: content 的全屏挂载管理，跨 WebKit 视频级与文档级 fullscreen 事件 reparent host
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

(function installFullscreenMountModule() {
  const ns = window.NetflixDualSubtitles ?? (window.NetflixDualSubtitles = {});

  function pickMountTarget() {
    try {
      const fromWebkit = document.webkitFullscreenElement ?? null;
      if (fromWebkit) return fromWebkit;
      const fromStandard = document.fullscreenElement ?? null;
      if (fromStandard) return fromStandard;
    } catch (_) {
      // Some embedder contexts throw on document.fullscreenElement access; fall through.
    }
    return document.documentElement;
  }

  function reparentHost(host, target) {
    if (!host || !target) return;
    if (host.parentNode === target) return;
    target.append(host);
  }

  function reparentHostToTarget(host, resolver) {
    if (!host) return;
    if (!host.isConnected && host.parentNode === null) {
      // Host was detached externally; skip until caller remounts.
      return;
    }
    const target = resolver();
    if (!target) return;
    if (host.__netflixDualSubtitles_mountedKey === target) return;
    reparentHost(host, target);
    host.__netflixDualSubtitles_mountedKey = target;
  }

  function installFullscreenHostManagement(host) {
    if (!host) return;
    if (host.__fullscreenInstalled) return;
    host.__fullscreenInstalled = true;

    const handler = () => {
      // Run synchronously in capture phase at document level so we reparent
      // before Netflix's own listener fires and avoid a one-frame flicker.
      reparentHostToTarget(host, pickMountTarget);
    };

    document.addEventListener("fullscreenchange", handler, { capture: true });
  }

  function bindVideoFullscreen(video, onChange) {
    if (!video || typeof onChange !== "function") return () => {};

    const handler = () => {
      // Run synchronously; handler already fires once per fullscreen transition,
      // and we no longer queue because the duplicate webkitbegin/webkitend path
      // was removed (those events don't fire on macOS).
      onChange();
    };

    video.addEventListener("fullscreenchange", handler);

    return function unbindVideoFullscreen() {
      video.removeEventListener("fullscreenchange", handler);
    };
  }

  ns.pickMountTarget = pickMountTarget;
  ns.installFullscreenHostManagement = installFullscreenHostManagement;
  ns.bindVideoFullscreen = bindVideoFullscreen;
})();