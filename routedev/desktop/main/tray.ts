// desktop/main/tray.ts
// 系统托盘：托盘菜单 + 关闭最小化到托盘（Windows）+ isQuitting 退出控制。

import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 是否正在退出：仅当用户从托盘菜单点击"退出"时置为 true，否则关闭按钮只隐藏到托盘
let isQuitting = false;

/** 解析托盘图标路径：开发环境取 build/icon.png，生产环境取 resourcesPath 下的 icon.png */
function resolveIconPath(): string {
  // electron-vite dev 模式下 app.isPackaged 可能返回 true
  // 用 process.env.NODE_ENV 判断更可靠
  const isDev = !app.isPackaged || process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_RENDERER_URL;
  if (!isDev) {
    return path.join(process.resourcesPath, 'icon.png');
  }
  // 开发环境：__dirname = out/main/，项目根 = 上两级
  return path.resolve(__dirname, '..', '..', 'build', 'icon.png');
}

/**
 * 创建系统托盘
 * @param getMainWindow 获取主窗口的回调（避免直接持有引用导致过期）
 * @returns Tray 实例
 */
export function createTray(getMainWindow: () => BrowserWindow | null): Tray {
  const iconPath = resolveIconPath();
  // 使用 nativeImage 加载图标，加载失败时回退到空图标（依赖系统默认）
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.warn('[tray] 图标加载失败，使用空图标占位:', iconPath);
  }
  // 托盘图标缩放到 16x16（Windows 任务栏托盘标准尺寸）
  const trayIcon = icon.resize({ width: 16, height: 16 });

  const tray = new Tray(trayIcon);
  tray.setToolTip('RouteDev');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        const win = getMainWindow();
        if (win) {
          win.show();
          win.focus();
        }
      },
    },
    {
      label: '隐藏到托盘',
      click: () => {
        getMainWindow()?.hide();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 标记正在退出，使主窗口 close 事件放行
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  // 双击托盘图标显示主窗口
  tray.on('double-click', () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });

  return tray;
}
