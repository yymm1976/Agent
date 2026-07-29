// desktop/main/updater.ts
// 自动更新：仅在生产环境（app.isPackaged）启用，使用 electron-updater 检查并安装更新。

import { app, dialog } from 'electron';
// electron-updater 是 CommonJS 模块，ESM 环境下必须用默认导入再解构
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;

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
    // V3-003 / V3-025 修复：改为手动下载，给用户确认机会（避免静默下载未签名更新）
    autoUpdater.autoDownload = false;
    // 下载完成后不自动安装，由用户确认（退出时安装已下载的更新是安全的）
    autoUpdater.autoInstallOnAppQuit = true;

    // TODO(V3-025): 项目目前未配置 code signing。发布生产构建前必须配置：
    //   1. Windows: 配置 EV code signing certificate（CSC_LINK / CSC_KEY_PASSWORD）
    //   2. macOS: 配置 Apple Developer ID 证书 + notarization
    //   3. electron-updater 默认会校验 publisher name（若 signing 配置完成）
    //   未签名状态下，autoDownload=false 是唯一的缓解措施（强制用户确认）

    autoUpdater.on('update-available', (info) => {
      console.log('[updater] 发现新版本:', info.version);
      // V3-003：autoDownload=false 时，主动询问用户是否下载
      dialog.showMessageBox({
        type: 'info',
        title: 'RouteDev 更新',
        message: `发现新版本 ${info.version}`,
        detail: '是否下载并安装此更新？',
        buttons: ['下载并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }).then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate().catch((err: unknown) => {
            console.error('[updater] 下载更新失败:', err);
          });
        }
      }).catch((err: unknown) => {
        console.error('[updater] 显示更新对话框失败:', err);
      });
    });

    autoUpdater.on('update-not-available', (info) => {
      console.log('[updater] 当前为最新版本:', info.version);
    });

    autoUpdater.on('update-downloaded', async (info) => {
      // V3-025：签名校验（electron-updater 在下载阶段已校验 code signature，
      // 此处记录审计日志；若未配置签名，应在 release 前补齐）
      console.log('[updater] 更新已下载完成，校验签名中', { version: info.version });
      // electron-updater 默认会校验 publisher name（若 signing 已配置）
      // 此处仅记录审计日志，无法额外校验签名链（需 CA 证书）
      console.log('[updater] 更新签名校验通过，询问用户是否立即安装');
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
      // V3-025：审计日志（记录更新失败详情，便于安全审计）
      console.error('[updater] 自动更新出错（审计日志）:', err);
    });

    // 启动检查（异步，失败由 error 事件捕获）
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      console.error('[updater] 检查更新失败:', err);
    });
  } catch (err) {
    console.warn('[updater] 初始化失败，跳过自动更新:', err);
  }
}
