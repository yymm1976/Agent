// src/config/loader.ts
// 配置加载器：YAML 解析 + 环境变量替换 + 全局/项目级配置合并 + Schema 验证
// 加载优先级：项目级 .routedev.yaml > 全局 config.yaml > Schema 内部默认值

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
 * 数组不合并，直接替换——避免"全局黑名单 + 项目黑名单合并"的歧义
 */
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
    } else if (sourceVal !== undefined) {
      // 其它情况（基本类型、数组、null）：直接用 source 的值
      result[key] = sourceVal as T[keyof T];
    }
  }
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
  const parsed = parseYaml(content);

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[config] Invalid config file format: ${filePath}`);
  }

  return parsed as Record<string, unknown>;
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

  // 3. 合并项目级配置（如果有）
  if (options?.projectPath) {
    const projectPath = getProjectConfigPath(options.projectPath);
    const projectConfig = loadYamlFile(projectPath);
    if (projectConfig) {
      config = deepMerge(config, projectConfig);
    }
  }

  // 4. 环境变量替换（仅处理字符串值）
  config = processEnvVars(config) as Record<string, unknown>;

  // 5. Zod schema 验证
  const result = AppConfigSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`
    ).join('\n');
    throw new Error(`[config] Configuration validation failed:\n${errors}`);
  }

  return result.data;
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

    const result = AppConfigSchema.safeParse(raw);
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
