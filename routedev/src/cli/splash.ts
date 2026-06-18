// src/cli/splash.ts
// CLI 启动画面

import chalk from 'chalk';

export interface SplashInfo {
  version: string;
  modelCount: number;
  readyModels: number;
  channelsEnabled: string[];
  projectPath?: string;
}

/** 从 package.json 读取版本号（避免硬编码） */
export function getVersion(): string {
  try {
    const mod = require('node:module') as { createRequire: (url: string) => NodeRequire };
    const req = mod.createRequire(import.meta.url);
    return (req('../../package.json') as { version: string }).version;
  } catch {
    return '1.0.0';
  }
}

export function renderSplash(info: SplashInfo): string {
  const lines = [
    '',
    chalk.cyan('  ╔═══════════════════════════════════╗'),
    chalk.cyan('  ║') + chalk.bold.white('        RouteDev CLI') + chalk.cyan('                ║'),
    chalk.cyan('  ║') + chalk.gray(`          v${info.version}`) + chalk.cyan('                 ║'),
    chalk.cyan('  ╚═══════════════════════════════════╝'),
    '',
    `  模型: ${info.readyModels}/${info.modelCount} 就绪`,
    info.channelsEnabled.length > 0
      ? `  渠道: ${info.channelsEnabled.join(', ')}`
      : '  渠道: 无',
    info.projectPath ? `  项目: ${info.projectPath}` : '',
    '',
    chalk.gray('  输入 /help 查看可用命令'),
    '',
  ];
  return lines.filter(l => l !== '').join('\n');
}
