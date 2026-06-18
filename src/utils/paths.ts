// src/utils/paths.ts
// 路径工具：管理 RouteDev 全局/项目级数据目录

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

/**
 * RouteDev 全局数据目录
 * Windows: %APPDATA%/RouteDev
 * macOS:   ~/Library/Application Support/RouteDev
 * Linux:   ~/.config/routedev
 */
export function getAppDataDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'RouteDev');
  } else if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'RouteDev');
  } else {
    return join(homedir(), '.config', 'routedev');
  }
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
