// desktop/main/splash.ts
// Splash 启动画面：在主窗口创建前显示一个无边框置顶小窗口，主窗口 ready-to-show 后关闭。

import { BrowserWindow } from 'electron';

/** Splash 窗口加载的 HTML 内容（深色背景 + 蓝色品牌色 + CSS spinner） */
function buildSplashHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    background: #0a0e14;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    overflow: hidden;
    -webkit-user-select: none;
    user-select: none;
  }
  .wrap {
    width: 100%; height: 100%;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 18px;
    border-radius: 12px;
  }
  .logo {
    font-size: 38px;
    font-weight: 700;
    letter-spacing: 1px;
    color: #3b82f6;
    text-shadow: 0 0 18px rgba(59, 130, 246, 0.45);
  }
  .logo .dot { color: #e6edf3; }
  .spinner {
    width: 34px; height: 34px;
    border: 3px solid rgba(59, 130, 246, 0.2);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tip {
    font-size: 13px;
    color: #8b949e;
    letter-spacing: 0.5px;
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="logo">RouteDev<span class="dot">.</span></div>
    <div class="spinner"></div>
    <div class="tip">正在初始化...</div>
  </div>
</body>
</html>`;
}

/**
 * 创建并显示 Splash 窗口
 * @returns Splash 窗口实例，供调用方在主窗口 ready-to-show 后关闭
 */
export function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 通过 data URL 加载内嵌 HTML，无需额外文件
  const html = buildSplashHtml();
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  return splash;
}
