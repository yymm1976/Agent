// desktop/main/config-store.ts
// 配置持久化：将 AppConfig 写回全局 YAML 文件
// 针对 Windows EPERM 问题的健壮写入策略

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { AppConfig } from '../../src/config/schema.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import { getGlobalConfigPath } from '../../src/utils/paths.js';

/**
 * 获取配置文件路径（与 loadConfig 保持一致）
 * 优先使用 ROUTEDEV_CONFIG_PATH 环境变量，确保读写路径一致
 */
function resolveConfigPath(): string {
  return process.env.ROUTEDEV_CONFIG_PATH || getGlobalConfigPath();
}

/**
 * 清理目录下残留的临时文件（config.yaml.tmp-*）
 * 旧进程异常退出可能残留临时文件，导致新进程写入时被锁定
 */
function cleanupStaleTempFiles(dir: string, baseName: string): void {
  try {
    const entries = fs.readdirSync(dir);
    const prefix = `${baseName}.tmp-`;
    for (const name of entries) {
      if (name.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(dir, name)); } catch { /* 忽略 */ }
      }
    }
  } catch {
    // 目录读取失败，忽略
  }
}

/**
 * 备份当前配置文件到 .bak
 * 在 saveConfig 写入新配置前调用，确保有一份上一版的完整备份可恢复
 * 备份失败不影响保存流程（新配置比旧备份更重要）
 */
function backupConfig(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      const backupPath = `${filePath}.bak`;
      fs.copyFileSync(filePath, backupPath);
    }
  } catch {
    // 备份失败不中断保存流程
  }
}

/**
 * 从 .bak 文件恢复配置
 * 当 loadConfig 因 YAML 损坏/验证失败而抛错时，由 loader 调用此函数尝试恢复
 * 返回恢复的 YAML 字符串，或 null 表示无备份可恢复
 */
export function restoreBackup(filePath: string): string | null {
  try {
    const backupPath = `${filePath}.bak`;
    if (fs.existsSync(backupPath)) {
      return fs.readFileSync(backupPath, 'utf-8');
    }
  } catch {
    // 恢复失败，返回 null
  }
  return null;
}

/**
 * 保存配置到全局配置文件
 * 写入策略（按优先级尝试，全部使用同步 API 避免 Electron 异步 fs 的潜在问题）：
 * 1. 同步原子写入：写临时文件 + rename 覆盖
 * 2. 同步直接写入：fs.writeFileSync 直接写目标文件
 * 3. 删除后写入：先 unlink 再 writeFileSync
 * 4. 如果以上都失败，抛出包含详细诊断信息的错误
 *
 * 安全机制：写入前自动备份上一版配置到 .bak 文件，防止异常情况导致配置丢失
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  // 安全修复：保存前用 Zod schema 校验，防止渲染进程写入畸形/恶意配置
  // 原行为直接序列化写入，XSS 场景下攻击者可修改 provider baseURL 窃取 API key
  const parseResult = AppConfigSchema.safeParse(config);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`配置校验失败: ${issues}`);
  }
  const validatedConfig = parseResult.data;
  const filePath = resolveConfigPath();
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const yaml = stringifyYaml(validatedConfig, { indent: 2, lineWidth: 120 });

  // 确保目录存在
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`无法创建配置目录 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 清理残留临时文件
  cleanupStaleTempFiles(dir, baseName);

  // 备份当前配置（在写入新配置之前）
  // 如果备份失败，仅记录日志不中断保存流程（新配置比旧备份更重要）
  backupConfig(filePath);

  const errors: string[] = [];

  // 策略1：同步原子写入（tmp + rename）
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, yaml, 'utf-8');
    try {
      fs.renameSync(tmpPath, filePath);
      return; // 成功
    } catch (renameErr) {
      try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
      errors.push(`原子写入(rename)失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
    }
  } catch (writeErr) {
    errors.push(`临时文件写入失败: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
  }

  // 策略2：同步直接写入（带重试，应对杀毒软件短暂锁定）
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 使用 fs.openSync 以 'w' 模式打开，确保文件句柄正确获取
      const fd = fs.openSync(filePath, 'w');
      fs.writeSync(fd, yaml, 0, 'utf-8');
      fs.closeSync(fd);
      return; // 成功
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      errors.push(`直接写入(尝试${attempt + 1})失败[${code}]: ${err instanceof Error ? err.message : String(err)}`);
      if (code !== 'EPERM' && code !== 'EBUSY') break;
      // 等待后重试
      const delay = 300 * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // 策略3：删除后重新创建
  try {
    try { fs.unlinkSync(filePath); } catch { /* 文件可能不存在，忽略 */ }
    fs.writeFileSync(filePath, yaml, 'utf-8');
    return; // 成功
  } catch (err) {
    errors.push(`删除后写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 所有策略都失败，抛出详细错误
  throw new Error(
    `配置文件写入失败: ${filePath}\n` +
    `已尝试: 原子写入、直接写入(3次重试)、删除后写入\n` +
    `失败详情:\n${errors.map((e) => `  - ${e}`).join('\n')}\n` +
    `可能原因: 文件被杀毒软件锁定、权限不足、或磁盘错误`
  );
}
