// src/utils/paths.ts
// 路径工具：管理 RouteDev 全局/项目级数据目录

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';

/**
 * 探测目录是否可写
 */
function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, '');
    try { unlinkSync(probe); } catch { /* 忽略 */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * 构建平台对应的候选数据目录链（按优先级排序）
 * Windows 上某些安全软件/受控文件夹访问会按"可执行文件"拦截写入，
 * 导致未签名的 Electron 进程无法写入 %APPDATA%，即便普通 node 进程可写。
 * 因此提供多个候选，在进程内逐一探测，挑第一个真正可写的目录，保证落地成功。
 */
function getCandidateDirs(): string[] {
  const platform = process.platform;
  if (platform === 'win32') {
    const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const temp = process.env.TEMP || process.env.TMP || join(local, 'Temp');
    return [
      join(roaming, 'RouteDev'),
      join(local, 'RouteDev'),
      join(temp, 'RouteDev'),
      join(homedir(), '.routedev'),
    ];
  }
  if (platform === 'darwin') {
    return [
      join(homedir(), 'Library', 'Application Support', 'RouteDev'),
      join(homedir(), '.routedev'),
    ];
  }
  return [
    join(homedir(), '.config', 'routedev'),
    join(homedir(), '.routedev'),
  ];
}

/**
 * RouteDev 全局数据目录
 * 在当前进程内逐一探测候选目录，返回第一个可写的目录。
 * 探测在调用进程（Electron 主进程）内执行，因此结果准确反映该进程的真实写权限。
 */
let cachedAppDataDir: string | null = null;

export function getAppDataDir(): string {
  if (cachedAppDataDir) return cachedAppDataDir;
  const candidates = getCandidateDirs();
  let chosen: string | null = null;
  for (const candidate of candidates) {
    if (isWritable(candidate)) {
      chosen = candidate;
      break;
    }
  }
  // 全部不可写时退回第一个候选（让后续写入抛出明确错误）
  const dir = chosen ?? candidates[0];
  if (chosen && chosen !== candidates[0]) {
    console.warn(`[paths] 首选数据目录不可写，已回落到: ${dir}`);
  }
  cachedAppDataDir = dir;
  return dir;
}

/**
 * 确保目录存在，不存在则创建
 */
export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 全局配置文件路径
 */
export function getGlobalConfigPath(): string {
  return join(getAppDataDir(), 'config.yaml');
}

/**
 * 项目级配置文件路径
 */
export function getProjectConfigPath(projectPath: string): string {
  return join(projectPath, '.routedev.yaml');
}

/**
 * 项目数据目录
 */
export function getProjectDataDir(projectPath: string): string {
  const hash = simpleHash(projectPath);
  return join(getAppDataDir(), 'projects', hash);
}

/**
 * 简单字符串哈希（用于项目目录命名）
 * 注：djb2 变种，不用于密码学；32位有符号溢出是预期行为
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // 转 32 位有符号整数
  }
  return Math.abs(hash).toString(36);
}
