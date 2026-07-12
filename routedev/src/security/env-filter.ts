// src/security/env-filter.ts
// 统一的环境变量过滤工具：替代散布在多处的 process.env 透传逻辑
// 提供：敏感 key 识别、白名单过滤、全量脱敏、API Key 掩码

/**
 * 敏感环境变量匹配模式（大小写不敏感，contains 语义）
 * - 前缀类：AWS_ / AZURE_ / GCP_ / DATABASE_ / ROUTEDEV_CONFIG / GITLAB_ / DIAGNOSTIC_
 * - 包含类：SECRET / TOKEN / PASSWORD / KEY / AUTH / CRED / PRIVATE
 * - 精确类：GITHUB_TOKEN / NPM_TOKEN / GH_TOKEN / GL_TOKEN / DEBUG / TRACE / VERBOSE
 */
export const SENSITIVE_ENV_PREFIXES: readonly string[] = [
  'AWS_',
  'AZURE_',
  'GCP_',
  'DATABASE_',
  'ROUTEDEV_CONFIG',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'KEY',
  'AUTH',
  'CRED',
  'PRIVATE',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'GITLAB_',
  'GH_TOKEN',
  'GL_TOKEN',
  'DEBUG',
  'TRACE',
  'VERBOSE',
  'DIAGNOSTIC_',
];

/**
 * 子进程可继承的安全环境变量白名单
 * 复制自 src/tools/builtin/shell-exec.ts:36（F-N004 修复）
 * 包含 Windows 平台必需变量（SYSTEMROOT/USERPROFILE/APPDATA/LOCALAPPDATA），
 * 缺失 SYSTEMROOT 会导致 Windows 上 spawn 失败。
 */
export const INHERITED_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL',
  'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'NODE_ENV', 'EDITOR', 'PAGER',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]);

/**
 * 判断环境变量 key 是否敏感（大小写不敏感，contains 语义）
 * 匹配 SENSITIVE_ENV_PREFIXES 中任意一个模式即视为敏感
 */
export function isSensitiveEnvKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return SENSITIVE_ENV_PREFIXES.some((pattern) => upperKey.includes(pattern.toUpperCase()));
}

/**
 * 按白名单过滤 process.env：仅保留 INHERITED_ENV_KEYS 中的 key
 * 并显式排除敏感 key（双保险，防止白名单被污染）
 * 适用于工具执行环境等只需最小 env 子集的场景
 */
export function filterProcessEnvByWhitelist(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && !isSensitiveEnvKey(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 全量脱敏 process.env：移除所有敏感 key，保留其余
 * 适用于需要完整 env 但要剔除敏感信息的场景（如 IPC 工具调用）
 */
export function sanitizeProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isSensitiveEnvKey(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 掩码 API Key：长度 > 8 时保留前 4 + *** + 后 4，否则返回 ***
 * 用于日志输出中隐藏完整密钥
 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length > 8) {
    return `${key.slice(0, 4)}***${key.slice(-4)}`;
  }
  return '***';
}
