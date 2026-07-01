// src/config/loader.ts
// 配置加载器：YAML 解析 + 环境变量替换 + 全局/项目级配置合并 + Schema 验证
// 加载优先级：项目级 .routedev.yaml > 全局 config.yaml > Schema 默认值

import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema, type AppConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { getGlobalConfigPath, getProjectConfigPath } from '../utils/paths.js';
import { ConfigValidationError } from '../utils/errors.js';

/**
 * 替换配置字符串中的环境变量引用
 * 格式：${ENV_VAR_NAME}
 * 安全策略：环境变量未设置时抛出 ConfigValidationError（fail-fast），
 * 避免运行时用字面量 ${VAR} 调用 API 导致 401 等模糊错误
 */
function replaceEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      // fail-fast：未设置的环境变量直接抛错，启动时给出明确错误信息
      throw new ConfigValidationError(
        varName,
        `环境变量 ${varName} 未设置。请在 .env 文件或系统环境变量中配置。`,
      );
    }
    return envValue;
  });
}

/**
 * 深度遍历对象，对所有字符串值执行环境变量替换
 */
function processEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return replaceEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(processEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = processEnvVars(value);
    }
    return result;
  }
  return obj;
}

/**
 * 深度合并两个对象（source 覆盖 target）
 * I5 修复：数组改为替换语义（source 直接覆盖 target），而非合并去重。
 *   原因：安全字段（toolBlacklist、commandBlacklist、channels.entries 等）需要
 *   项目级配置能完全覆盖全局配置。合并去重会导致用户以为已禁用的项仍被继承。
 *   需要合并的字段请在 MERGE_ARRAY_KEYS 白名单中显式声明。
 */
const MERGE_ARRAY_KEYS = new Set<string>([
  // 暂无需要合并的数组字段；如未来需要，在此添加
]);

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      // 双方都是纯对象：递归合并
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (Array.isArray(sourceVal) && Array.isArray(targetVal)) {
      // I5 修复：默认数组替换语义；白名单字段才合并
      if (MERGE_ARRAY_KEYS.has(String(key))) {
        const merged = mergeArraysUnique(targetVal as unknown[], sourceVal as unknown[]);
        result[key] = merged as T[keyof T];
      } else {
        // 默认替换：source 覆盖 target
        result[key] = sourceVal as T[keyof T];
      }
    } else if (sourceVal !== undefined) {
      // 其它情况（基本类型、null、一方为数组另一方不是）：直接用 source 的值
      result[key] = sourceVal as T[keyof T];
    }
  }
  return result;
}

/**
 * I11 修复：合并两个数组并去重
 * - 基本类型（string/number/boolean/null/undefined）：按值去重
 * - 对象/数组：按 JSON 序列化去重
 */
function mergeArraysUnique(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  const addItem = (item: unknown): void => {
    let key: string;
    if (item === null || typeof item !== 'object') {
      // 基本类型直接用值作为 key
      key = `${typeof item}:${String(item)}`;
    } else {
      // 对象/数组用 JSON 序列化作为 key
      key = JSON.stringify(item);
    }
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  };
  for (const item of a) addItem(item);
  for (const item of b) addItem(item);
  return result;
}

/**
 * 加载并解析 YAML 配置文件
 * 如果文件不存在，返回 null
 */
function loadYamlFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const content = readFileSync(filePath, 'utf-8');

  // 文件为空或只有空白：返回空对象，让 loadConfig 使用默认值
  if (!content.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    // YAML 解析失败（文件损坏）：返回空对象，避免启动崩溃
    console.warn(`[config] 配置文件解析失败，使用默认配置: ${filePath}`, err);
    return {};
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    // 格式无效但不崩溃：返回空对象，让 loadConfig 使用默认值
    console.warn(`[config] 配置文件格式无效，使用默认配置: ${filePath}`);
    return {};
  }

  return parsed as Record<string, unknown>;
}

/**
 * 尝试从 .bak 备份文件恢复全局配置
 * 当主配置文件 Zod 验证失败时调用，重新走一遍合并+验证流程
 * 返回验证通过的完整配置，或 null 表示无可用备份
 */
function tryLoadBackup(globalPath: string, projectPath?: string): AppConfig | null {
  const backupPath = `${globalPath}.bak`;
  if (!existsSync(backupPath)) {
    return null;
  }

  try {
    const content = readFileSync(backupPath, 'utf-8');
    if (!content.trim()) return null;

    const parsed = parseYaml(content);
    if (parsed === null || parsed === undefined) return null;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    // 重新走合并流程：默认值 + 备份全局配置 + 项目级配置
    let backupConfig: Record<string, unknown> = { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>;
    backupConfig = deepMerge(backupConfig, parsed as Record<string, unknown>);

    if (projectPath) {
      const projectConfigPath = getProjectConfigPath(projectPath);
      const projectConfig = loadYamlFile(projectConfigPath);
      if (projectConfig) {
        backupConfig = deepMerge(backupConfig, projectConfig);
      }
    }

    backupConfig = processEnvVars(backupConfig) as Record<string, unknown>;
    // 空字符串处理已移至 schema 层的 preprocess，不再全局 sanitize

    const backupResult = AppConfigSchema.safeParse(backupConfig);
    if (backupResult.success) {
      console.warn('[config] 主配置验证失败，已从 .bak 备份恢复配置');
      return backupResult.data;
    }
  } catch {
    // 备份恢复失败，返回 null 让调用方抛出原始错误
  }
  return null;
}

/**
 * 配置迁移：对旧版本默认值的破坏性变更做自动修正。
 * 注意：仅当旧值等于旧默认值时才覆盖，避免覆盖用户显式设置。
 */
function migrateConfig(config: Record<string, unknown>): Record<string, unknown> {
  // v3.0.0 修复：security.networkConfirm 旧默认值为 true，导致 web_search/web_fetch
  // 每次都需要用户确认。新版默认 false，对旧配置做一次性迁移。
  const security = config.security as Record<string, unknown> | undefined;
  if (security && security.networkConfirm === true) {
    // 安全默认值变更：自动关闭全局网络确认，避免基础网络工具无法使用
    security.networkConfirm = false;
    console.warn('[config] 自动迁移：security.networkConfirm 由 true 调整为 false（v3.0.0 默认策略变更）');
  }

  // v3.0.0 修复：agent.maxConcurrentSubAgents 旧默认值为 3，改为 5
  const agent = config.agent as Record<string, unknown> | undefined;
  if (agent && agent.maxConcurrentSubAgents === 3) {
    agent.maxConcurrentSubAgents = 5;
    console.warn('[config] 自动迁移：agent.maxConcurrentSubAgents 由 3 调整为 5（v3.0.0 默认策略变更）');
  }

  return config;
}

/**
 * 加载完整配置
 * 优先级：项目级覆盖 > 全局配置 > Schema 默认值
 */
export function loadConfig(options?: {
  projectPath?: string;
  globalConfigPath?: string;
}): AppConfig {
  const globalPath = options?.globalConfigPath ?? getGlobalConfigPath();

  // 1. 从默认值开始（作为合并基底）
  let config: Record<string, unknown> = { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>;

  // 2. 合并全局配置
  const globalConfig = loadYamlFile(globalPath);
  if (globalConfig) {
    config = deepMerge(config, globalConfig);
  }

  // 3. 配置迁移（旧版本默认值的一次性修正）
  // 注意：迁移只在全局配置层面执行，项目级配置的显式设置优先级更高，不应被迁移覆盖
  config = migrateConfig(config);

  // 4. 合并项目级配置（如果有）——优先级高于全局配置和迁移结果
  if (options?.projectPath) {
    const projectPath = getProjectConfigPath(options.projectPath);
    const projectConfig = loadYamlFile(projectPath);
    if (projectConfig) {
      config = deepMerge(config, projectConfig);
    }
  }

  // 5. 环境变量替换（仅处理字符串值）
  config = processEnvVars(config) as Record<string, unknown>;

  // 6. Zod schema 验证（空字符串处理已移至 schema 层的 preprocess，避免全局 sanitize 导致必需字段误转 undefined）
  const result = AppConfigSchema.safeParse(config);

  if (!result.success) {
    // 验证失败：尝试从 .bak 备份恢复，避免配置丢失导致应用不可用
    const recovered = tryLoadBackup(globalPath, options?.projectPath);
    if (recovered) {
      return recovered;
    }
    const errors = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`
    ).join('\n');
    throw new Error(`[config] Configuration validation failed:\n${errors}`);
  }

  return result.data;
}

/**
 * 加载合并后的配置（公共 API）
 * 三层合并：default → global → project
 * @param projectPath 项目路径(可选)
 */
export async function loadMergedConfig(projectPath?: string): Promise<AppConfig> {
  return loadConfig({ projectPath });
}

/**
 * 深度合并多个配置对象(公共 API)
 * 借鉴 ohmypi deepMerge 语义:
 *   - 对象:递归合并
 *   - 数组:按 arrayMergeStrategy 处理('replace' 覆盖,'merge' 去重拼接)
 *   - 原始值:后者覆盖前者
 */
export function deepMergeConfig<T>(...configs: Partial<T>[]): T {
  // 复用现有私有 deepMerge,但需支持 arrayMergeStrategy 参数
  // 简化实现:默认 'replace' 语义
  if (configs.length === 0) return {} as T;
  return configs.reduce<T>(
    (acc, curr) => deepMerge(
      acc as Record<string, unknown>,
      curr as Record<string, unknown>,
    ) as T,
    {} as T,
  );
}

/**
 * 验证配置文件是否存在且格式正确（不执行环境变量替换）
 * 用于 CLI 的"config validate"命令
 */
export function validateConfigFile(filePath: string): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const raw = loadYamlFile(filePath);
    if (!raw) {
      return { valid: false, errors: [`File not found: ${filePath}`], warnings };
    }

    // 修复：校验前先替换环境变量，避免误判含 ${VAR} 的合法配置
    const processed = processEnvVars(raw);
    const result = AppConfigSchema.safeParse(processed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`${issue.path.join('.')}: ${issue.message}`);
      }
    }

    // 检查环境变量引用是否存在（仅警告，不阻断）
    const content = readFileSync(filePath, 'utf-8');
    const envRefs = content.match(/\$\{([^}]+)\}/g) || [];
    for (const ref of envRefs) {
      const varName = ref.slice(2, -1);
      if (!process.env[varName]) {
        warnings.push(`Environment variable ${varName} is not set`);
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { valid: errors.length === 0, errors, warnings };
}
