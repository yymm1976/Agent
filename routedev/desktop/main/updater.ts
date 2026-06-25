// desktop/main/updater.ts
// 自动更新：仅在生产环境（app.isPackaged）启用，使用 electron-updater 检查并安装更新。

import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * 初始化自动更新
 * - 生产环境：检查更新、监听事件、下载完成后询问用户重启安装
 * - 开发环境：跳过（打印日志）
 */
export function initUpdater(): void {
  // 开发环境或缺少更新配置文件时跳过（避免 ENOENT 错误）
  if (!app.isPackaged || process.env.NODE_ENV === 'development') {
    console.log('[updater] 开发环境，跳过自动更新检查');
    return;
  }

  try {
    // 自动下载更新包
    autoUpdater.autoDownload = true;
    // 下载完成后不自动安装，由用户确认
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      console.log('[updater] 发现新版本:', info.version);
    });

    autoUpdater.on('update-not-available', (info) => {
      console.log('[updater] 当前为最新版本:', info.version);
    });

    autoUpdater.on('update-downloaded', async () => {
      console.log('[updater] 更新已下载完成，询问用户是否立即安装');
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'RouteDev 更新',
        message: '新版本已下载完成',
        detail: '是否立即重启并安装新版本？',
        buttons: ['立即重启安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });

    autoUpdater.on('error', (err) => {
      console.error('[updater] 自动更新出错:', err);
    });

    // 启动检查（异步，失败由 error 事件捕获）
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      console.error('[updater] 检查更新失败:', err);
    });
  } catch (err) {
    console.warn('[updater] 初始化失败，跳过自动更新:', err);
  }
}
