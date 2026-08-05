import { app, dialog } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import electronUpdater from 'electron-updater';
import { logger } from '../../src/utils/logger.js';

const { autoUpdater } = electronUpdater;

/** Only packages explicitly marked by the release build may consume updates. */
function isTrustedSignedBuild(): boolean {
  try {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'),
    ) as { routedevSignedRelease?: boolean; routedevTrustedUpdateSource?: boolean };
    return metadata.routedevSignedRelease === true
      && metadata.routedevTrustedUpdateSource === true;
  } catch {
    return false;
  }
}

async function verifyDownloadedChecksum(
  downloadedFile: string,
  info: { files?: Array<{ url: string; sha512: string }>; sha512?: string },
): Promise<boolean> {
  const filename = path.basename(downloadedFile);
  const expected = info.files?.find((file) =>
    path.basename(file.url.split('?')[0]) === filename)?.sha512 ?? info.sha512;
  if (!expected) return false;
  const actual = createHash('sha512')
    .update(await fs.promises.readFile(downloadedFile))
    .digest('base64');
  return actual === expected;
}

export function initUpdater(): void {
  if (!app.isPackaged || process.env.NODE_ENV === 'development' || !isTrustedSignedBuild()) {
    logger.info('[updater] unsigned, untrusted, or development build; automatic updates disabled');
    return;
  }

  try {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      logger.info('[updater] update available', { version: info.version });
      void dialog.showMessageBox({
        type: 'info',
        title: 'RouteDev 更新',
        message: `发现新版本 ${info.version}`,
        detail: '是否下载并安装此更新？',
        buttons: ['下载并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }).then((result) => {
        if (result.response === 0) {
          return autoUpdater.downloadUpdate().catch((error: unknown) => {
            logger.error('[updater] update download failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return undefined;
      }).catch((error: unknown) => {
        logger.error('[updater] update dialog failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    autoUpdater.on('update-not-available', (info) => {
      logger.info('[updater] already up to date', { version: info.version });
    });

    autoUpdater.on('update-downloaded', async (info) => {
      const checksumValid = await verifyDownloadedChecksum(info.downloadedFile, info);
      if (!checksumValid) {
        logger.error('[updater] downloaded update checksum mismatch; installation blocked', {
          version: info.version,
          file: path.basename(info.downloadedFile),
        });
        await dialog.showMessageBox({
          type: 'error',
          title: 'RouteDev 更新失败',
          message: '更新包校验失败，已保留当前版本。',
          detail: '请稍后重试或从可信发布页重新下载。',
        });
        return;
      }
      logger.info('[updater] downloaded update checksum verified; asking before installation', {
        version: info.version,
      });
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'RouteDev 更新',
        message: '新版本已下载完成',
        detail: '是否立即重启并安装新版本？',
        buttons: ['立即重启安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response === 0) autoUpdater.quitAndInstall();
    });

    autoUpdater.on('error', (error) => {
      logger.error('[updater] update error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    void autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      logger.error('[updater] update check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn('[updater] initialization failed; automatic updates disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
