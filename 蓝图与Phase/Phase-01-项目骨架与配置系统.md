# Phase 1：项目骨架 + 配置系统

**回应**：无（首个 Phase）

**目标**：初始化 TypeScript 项目，实现 YAML 配置加载、schema 验证、环境变量替换、全局+项目级配置合并，搭建 CLI 入口。

**蓝图参考**：第三节（技术栈）、第四节（文件结构）、第十四节（配置设计）

---

## 具体任务

### Task 1：项目初始化

- [ ] **Step 1：创建项目目录并初始化 pnpm 项目**

```powershell
mkdir routedev && cd routedev
pnpm init
```

- [ ] **Step 2：安装核心依赖**

```powershell
# 生产依赖
pnpm add yaml zod winston simple-git chalk

# 开发依赖
pnpm add -D typescript @types/node tsup vitest
```

依赖说明：
- `yaml`：YAML 解析和序列化
- `zod`：配置 schema 验证（类型安全）
- `winston`：日志库（调试日志写到文件）
- `simple-git`：Git 操作封装（Phase 1 先引入，后续 Phase 10 用）
- `chalk`：终端颜色输出（Ink 之前的基础阶段用）
- `tsup`：打包工具
- `vitest`：测试框架

- [ ] **Step 3：创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4：创建 tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: true,
});
```

- [ ] **Step 5：创建 vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
```

- [ ] **Step 6：更新 package.json 的 scripts**

```json
{
  "name": "routedev",
  "version": "0.1.0",
  "description": "按任务复杂度自动路由模型的开发助手",
  "license": "AGPL-3.0",
  "type": "module",
  "bin": {
    "routedev": "./dist/index.js"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 7：构建验证**

```powershell
pnpm build
```

预期：BUILD SUCCESSFUL，`dist/` 目录下生成 `index.js`

- [ ] **Step 8：提交**

```powershell
git init
git add .
git commit -m "chore: initialize routedev project with TypeScript, tsup, vitest"
```

---

### Task 2：配置类型定义（Zod Schema）

**文件：**
- 创建：`src/config/schema.ts`

- [ ] **Step 1：创建配置 schema**

用 Zod 定义配置的类型安全 schema。这个文件是整个配置系统的核心——后续所有模块都从这里获取类型。

```typescript
// src/config/schema.ts
import { z } from 'zod';

// --- 基础枚举 ---

export const ScenarioTierSchema = z.enum(['simple', 'medium', 'complex', 'reasoning']);
export type ScenarioTier = z.infer<typeof ScenarioTierSchema>;

export const ProtocolSchema = z.enum(['openai', 'anthropic']);
export type Protocol = z.infer<typeof ProtocolSchema>;

export const BudgetModeSchema = z.enum(['track_only', 'enforce']);
export type BudgetMode = z.infer<typeof BudgetModeSchema>;

export const AutonomyModeSchema = z.enum(['auto', 'semi', 'manual']);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

export const SensitiveFilePolicySchema = z.enum(['readonly', 'deny']);
export type SensitiveFilePolicy = z.infer<typeof SensitiveFilePolicySchema>;

export const UserPreferenceSchema = z.enum(['saving', 'balanced', 'premium']);
export type UserPreference = z.infer<typeof UserPreferenceSchema>;

export const ThemeSchema = z.enum(['dark', 'light']);
export type Theme = z.infer<typeof ThemeSchema>;

export const LanguageSchema = z.enum(['zh-CN', 'en-US']);
export type Language = z.infer<typeof LanguageSchema>;

// --- 提供商与模型配置 ---

export const ModelCapabilitySchema = z.enum([
  'reasoning', 'code', 'multimodal', 'fast', 'cheap',
]);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const ModelConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  tier: ScenarioTierSchema,
  contextWindow: z.number().positive().int(),
  capabilities: z.array(ModelCapabilitySchema).default([]),
  latencyMs: z.number().nonnegative().default(0),
  available: z.boolean().default(true),
  fallbackModelId: z.string().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: ProtocolSchema,
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  models: z.array(ModelConfigSchema).default([]),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// --- 路由配置 ---

export const RouterRuleSchema = z.object({
  tier: ScenarioTierSchema,
  modelId: z.string().min(1),
  fallbackModelId: z.string().optional(),
  maxTokensPerRequest: z.number().positive().int().optional(),
});
export type RouterRule = z.infer<typeof RouterRuleSchema>;

export const TokenBudgetSchema = z.object({
  mode: BudgetModeSchema.default('track_only'),
  dailyLimit: z.number().positive().int().default(500000),
  perRequestLimit: z.number().positive().int().optional(),
  degradationThreshold: z.number().min(0).max(1).default(0.8),
});
export type TokenBudget = z.infer<typeof TokenBudgetSchema>;

export const RouterConfigSchema = z.object({
  rules: z.array(RouterRuleSchema).default([]),
  budget: TokenBudgetSchema.default({}),
  classifierModel: z.string().min(1).default('deepseek-v4-flash'),
  userPreference: UserPreferenceSchema.default('balanced'),
});
export type RouterConfig = z.infer<typeof RouterConfigSchema>;

// --- Checkpoint 配置 ---

export const CheckpointTriggerSchema = z.object({
  level: z.number().min(1).max(100),
  action: z.enum(['initial', 'incremental', 'compress']),
});

export const CheckpointConfigSchema = z.object({
  enabled: z.boolean().default(true),
  triggers: z.array(CheckpointTriggerSchema).default([
    { level: 20, action: 'initial' },
    { level: 45, action: 'incremental' },
    { level: 70, action: 'compress' },
  ]),
  modelId: z.string().default('deepseek-v4-flash'),
  maxTokensPerCheckpoint: z.number().positive().int().default(500),
});
export type CheckpointConfig = z.infer<typeof CheckpointConfigSchema>;

// --- GoalVerifier 配置 ---

export const GoalVerifierConfigSchema = z.object({
  enabled: z.boolean().default(true),
  modelId: z.string().default('kimi-k2.7'),
  maxTokensPerVerification: z.number().positive().int().default(1000),
  autoVerify: z.boolean().default(true),
});
export type GoalVerifierConfig = z.infer<typeof GoalVerifierConfigSchema>;

// --- 安全配置 ---

export const SecurityConfigSchema = z.object({
  directoryBoundary: z.boolean().default(true),
  commandBlacklist: z.array(z.string()).default(['rm -rf', 'format', 'del /s']),
  commandWhitelist: z.array(z.string()).default([]),
  sensitiveFiles: z.array(z.string()).default(['.env', 'credentials.json', '*.key']),
  sensitiveFilePolicy: SensitiveFilePolicySchema.default('readonly'),
  networkConfirm: z.boolean().default(true),
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

// --- 自主度配置 ---

export const AutonomyConfigSchema = z.object({
  defaultMode: AutonomyModeSchema.default('semi'),
});
export type AutonomyConfig = z.infer<typeof AutonomyConfigSchema>;

// --- 提示音配置 ---

export const SoundsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  completion: z.string().default('default'),
  error: z.string().default('warning'),
  approval: z.string().default('notification'),
});
export type SoundsConfig = z.infer<typeof SoundsConfigSchema>;

// --- 更新配置 ---

export const UpdatesConfigSchema = z.object({
  checkOnStartup: z.boolean().default(true),
  autoUpdate: z.boolean().default(false),
});
export type UpdatesConfig = z.infer<typeof UpdatesConfigSchema>;

// --- 通用配置 ---

export const GeneralConfigSchema = z.object({
  language: LanguageSchema.default('zh-CN'),
  theme: ThemeSchema.default('dark'),
  startupBehavior: z.enum(['restore', 'project_select']).default('restore'),
});
export type GeneralConfig = z.infer<typeof GeneralConfigSchema>;

// --- 全局配置（完整 schema） ---

export const AppConfigSchema = z.object({
  version: z.number().int().default(1),
  general: GeneralConfigSchema.default({}),
  providers: z.array(ProviderConfigSchema).default([]),
  router: RouterConfigSchema.default({}),
  checkpoint: CheckpointConfigSchema.default({}),
  goalVerifier: GoalVerifierConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  autonomy: AutonomyConfigSchema.default({}),
  sounds: SoundsConfigSchema.default({}),
  updates: UpdatesConfigSchema.default({}),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
```

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL，无类型错误

- [ ] **Step 3：提交**

```powershell
git add src/config/schema.ts
git commit -m "feat(config): define Zod schemas for all configuration types"
```

---

### Task 3：配置加载器（YAML 解析 + 环境变量替换 + 配置合并）

**文件：**
- 创建：`src/config/loader.ts`
- 创建：`src/config/defaults.ts`
- 创建：`src/utils/paths.ts`

- [ ] **Step 1：创建路径工具模块**

```typescript
// src/utils/paths.ts
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
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
```

- [ ] **Step 2：创建默认配置模块**

```typescript
// src/config/defaults.ts
import type { AppConfig } from './schema.js';

/**
 * 默认配置值
 * 当配置文件缺少某些字段时，用这些值填充
 */
export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  general: {
    language: 'zh-CN',
    theme: 'dark',
    startupBehavior: 'restore',
  },
  providers: [],
  router: {
    rules: [
      { tier: 'simple', modelId: 'deepseek-v4-flash' },
      { tier: 'medium', modelId: 'minimax-m3' },
      { tier: 'complex', modelId: 'qwen3.7-plus' },
      { tier: 'reasoning', modelId: 'kimi-k2.7', fallbackModelId: 'deepseek-v4-pro' },
    ],
    budget: {
      mode: 'track_only',
      dailyLimit: 500000,
      degradationThreshold: 0.8,
    },
    classifierModel: 'deepseek-v4-flash',
    userPreference: 'balanced',
  },
  checkpoint: {
    enabled: true,
    triggers: [
      { level: 20, action: 'initial' },
      { level: 45, action: 'incremental' },
      { level: 70, action: 'compress' },
    ],
    modelId: 'deepseek-v4-flash',
    maxTokensPerCheckpoint: 500,
  },
  goalVerifier: {
    enabled: true,
    modelId: 'kimi-k2.7',
    maxTokensPerVerification: 1000,
    autoVerify: true,
  },
  security: {
    directoryBoundary: true,
    commandBlacklist: ['rm -rf', 'format', 'del /s'],
    commandWhitelist: [],
    sensitiveFiles: ['.env', 'credentials.json', '*.key'],
    sensitiveFilePolicy: 'readonly',
    networkConfirm: true,
  },
  autonomy: {
    defaultMode: 'semi',
  },
  sounds: {
    enabled: true,
    completion: 'default',
    error: 'warning',
    approval: 'notification',
  },
  updates: {
    checkOnStartup: true,
    autoUpdate: false,
  },
};
```

- [ ] **Step 3：创建配置加载器**

```typescript
// src/config/loader.ts
import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema, type AppConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { getGlobalConfigPath, getProjectConfigPath } from '../utils/paths.js';

/**
 * 替换配置字符串中的环境变量引用
 * 格式：${ENV_VAR_NAME}
 * 如果环境变量不存在，保留原始字符串并打印警告
 */
function replaceEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      console.warn(`[config] Warning: environment variable ${varName} is not set, keeping placeholder`);
      return match;
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
 * 数组不合并，直接替换
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
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (sourceVal !== undefined) {
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
 * 优先级：项目级覆盖 > 全局配置 > 默认值
 */
export function loadConfig(options?: {
  projectPath?: string;
  globalConfigPath?: string;
}): AppConfig {
  const globalPath = options?.globalConfigPath ?? getGlobalConfigPath();

  // 1. 从默认值开始
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

  // 4. 环境变量替换
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
 * 验证配置文件是否存在且格式正确（不加载环境变量）
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

    // 检查环境变量引用是否存在
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
```

- [ ] **Step 4：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL，无类型错误

- [ ] **Step 5：提交**

```powershell
git add src/config/ src/utils/paths.ts
git commit -m "feat(config): implement YAML config loader with env var substitution and merge"
```

---

### Task 4：日志系统

**文件：**
- 创建：`src/utils/logger.ts`

- [ ] **Step 1：创建日志模块**

```typescript
// src/utils/logger.ts
import { createLogger, format, transports } from 'winston';
import { getAppDataDir, ensureDir } from './paths.js';
import { join } from 'path';

const LOG_DIR = join(getAppDataDir(), 'logs');
ensureDir(LOG_DIR);

export const logger = createLogger({
  level: process.env.ROUTEDEV_LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json(),
  ),
  defaultMeta: { service: 'routedev' },
  transports: [
    // 文件日志：所有级别
    new transports.File({
      filename: join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 3,
    }),
    new transports.File({
      filename: join(LOG_DIR, 'combined.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
  ],
});

// 开发模式下也输出到控制台
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 1 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        }),
      ),
    })
  );
}
```

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL

- [ ] **Step 3：提交**

```powershell
git add src/utils/logger.ts
git commit -m "feat(utils): add winston logger with file and console transports"
```

---

### Task 5：CLI 入口 + 配置示例文件

**文件：**
- 创建：`src/index.ts`
- 创建：`config.example.yaml`

- [ ] **Step 1：创建 CLI 入口**

```typescript
// src/index.ts
#!/usr/bin/env node

import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  console.log(`RouteDev v${VERSION}`);
  console.log('---');

  try {
    // 尝试加载配置
    const config = loadConfig();

    console.log(`Language:   ${config.general.language}`);
    console.log(`Theme:      ${config.general.theme}`);
    console.log(`Providers:  ${config.providers.length} configured`);
    console.log(`Router:     ${config.router.rules.length} rules, preference=${config.router.userPreference}`);
    console.log(`Security:   directoryBoundary=${config.security.directoryBoundary}`);
    console.log(`Autonomy:   default=${config.autonomy.defaultMode}`);
    console.log('---');
    console.log('Configuration loaded successfully.');
    console.log('(CLI interface coming in Phase 4)');

    logger.info('RouteDev started', {
      version: VERSION,
      providers: config.providers.length,
      routerRules: config.router.rules.length,
    });
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
      logger.error('Startup failed', { error: err.message, stack: err.stack });
    }
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2：创建配置示例文件**

```yaml
# config.example.yaml
# RouteDev 全局配置模板
# 复制此文件到以下位置之一：
#   Windows: %APPDATA%\RouteDev\config.yaml
#   macOS:   ~/Library/Application Support/RouteDev/config.yaml
#   Linux:   ~/.config/routedev/config.yaml

version: 1

general:
  language: zh-CN                # zh-CN / en-US
  theme: dark                    # dark / light
  startupBehavior: restore       # restore / project_select

# API 提供商配置
# 支持 OpenAI 和 Anthropic 两种协议
# apiKey 支持环境变量引用：${ENV_VAR_NAME}
providers:
  - id: opencode-go
    name: OpenCode Go
    protocol: openai
    baseUrl: https://opencode.ai/zen/go/v1
    apiKey: ${OPENCODE_API_KEY}

  # 如需 Anthropic 协议：
  # - id: opencode-go-anthropic
  #   name: OpenCode Go (Anthropic)
  #   protocol: anthropic
  #   baseUrl: https://opencode.ai/zen/go/v1
  #   apiKey: ${OPENCODE_API_KEY}

# 路由配置
router:
  # 四级分类路由规则
  rules:
    - tier: simple
      modelId: deepseek-v4-flash
    - tier: medium
      modelId: minimax-m3
    - tier: complex
      modelId: qwen3.7-plus
    - tier: reasoning
      modelId: kimi-k2.7
      fallbackModelId: deepseek-v4-pro

  # Token 预算
  budget:
    mode: track_only             # track_only / enforce
    dailyLimit: 500000           # 日 token 上限

  # 分类器使用的模型（应选最便宜的）
  classifierModel: deepseek-v4-flash

  # 用户偏好级别
  # saving: 优先省钱，倾向使用便宜模型
  # balanced: 平衡成本和质量
  # premium: 优先质量，倾向使用强模型
  userPreference: balanced

# 增量 Checkpoint 配置
checkpoint:
  enabled: true
  triggers:
    - level: 20
      action: initial
    - level: 45
      action: incremental
    - level: 70
      action: compress
  modelId: deepseek-v4-flash
  maxTokensPerCheckpoint: 500

# Goal 验证配置
goalVerifier:
  enabled: true
  modelId: kimi-k2.7
  maxTokensPerVerification: 1000
  autoVerify: true

# 安全配置
security:
  directoryBoundary: true
  commandBlacklist: ["rm -rf", "format", "del /s"]
  commandWhitelist: []
  sensitiveFiles: [".env", "credentials.json", "*.key"]
  sensitiveFilePolicy: readonly    # readonly / deny
  networkConfirm: true

# 自主度默认值
autonomy:
  defaultMode: semi                # auto / semi / manual

# 提示音
sounds:
  enabled: true
  completion: default
  error: warning
  approval: notification

# 更新
updates:
  checkOnStartup: true
  autoUpdate: false
```

- [ ] **Step 3：构建并运行验证**

```powershell
pnpm build
pnpm start
```

预期输出：
```
RouteDev v0.1.0
---
Language:   zh-CN
Theme:      dark
Providers:  0 configured
Router:     4 rules, preference=balanced
Security:   directoryBoundary=true
Autonomy:   default=semi
---
Configuration loaded successfully.
(CLI interface coming in Phase 4)
```

注意：如果没有创建 config.yaml 文件，程序会使用默认配置正常运行。

- [ ] **Step 4：提交**

```powershell
git add src/index.ts config.example.yaml
git commit -m "feat(cli): add entry point and example configuration file"
```

---

### Task 6：配置加载单元测试

**文件：**
- 创建：`tests/config/loader.test.ts`

- [ ] **Step 1：编写测试**

```typescript
// tests/config/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, validateConfigFile } from '../../src/config/loader.js';

describe('Config Loader', () => {
  const testDir = join(tmpdir(), `routedev-test-${Date.now()}`);
  const configPath = join(testDir, 'config.yaml');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load default config when no file exists', () => {
    const config = loadConfig({ globalConfigPath: configPath });
    expect(config.version).toBe(1);
    expect(config.general.language).toBe('zh-CN');
    expect(config.router.rules).toHaveLength(4);
    expect(config.autonomy.defaultMode).toBe('semi');
  });

  it('should load and parse YAML config file', () => {
    writeFileSync(configPath, `
version: 1
general:
  language: en-US
  theme: light
router:
  userPreference: premium
`);

    const config = loadConfig({ globalConfigPath: configPath });
    expect(config.general.language).toBe('en-US');
    expect(config.general.theme).toBe('light');
    expect(config.router.userPreference).toBe('premium');
  });

  it('should replace environment variables', () => {
    process.env.TEST_API_KEY = 'sk-test-12345';
    writeFileSync(configPath, `
version: 1
providers:
  - id: test
    name: Test Provider
    protocol: openai
    baseUrl: https://api.test.com/v1
    apiKey: \${TEST_API_KEY}
`);

    const config = loadConfig({ globalConfigPath: configPath });
    expect(config.providers[0].apiKey).toBe('sk-test-12345');
    delete process.env.TEST_API_KEY;
  });

  it('should merge project config over global config', () => {
    writeFileSync(configPath, `
version: 1
router:
  userPreference: saving
`);

    const projectDir = join(testDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, '.routedev.yaml'), `
version: 1
router:
  userPreference: premium
`);

    const config = loadConfig({
      globalConfigPath: configPath,
      projectPath: projectDir,
    });
    expect(config.router.userPreference).toBe('premium');
  });

  it('should throw on invalid config', () => {
    writeFileSync(configPath, `
version: "not-a-number"
`);

    expect(() => loadConfig({ globalConfigPath: configPath })).toThrow('Configuration validation failed');
  });

  it('should validate config file and return errors', () => {
    writeFileSync(configPath, `
version: 1
providers:
  - id: test
    name: Test
    protocol: invalid-protocol
    baseUrl: not-a-url
    apiKey: key
`);

    const result = validateConfigFile(configPath);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2：运行测试**

```powershell
pnpm test
```

预期：所有测试通过

- [ ] **Step 3：提交**

```powershell
git add tests/
git commit -m "test(config): add unit tests for config loader, env vars, and merge"
```

---

### Task 7：.gitignore + README

- [ ] **Step 1：创建 .gitignore**

```
node_modules/
dist/
*.log
.env
.DS_Store
Thumbs.db
```

- [ ] **Step 2：创建简要 README.md**

```markdown
# RouteDev

按任务复杂度自动路由模型的 CLI 开发助手。

## 快速开始

```powershell
pnpm install
cp config.example.yaml %APPDATA%\RouteDev\config.yaml
# 编辑 config.yaml 填入你的 API Key
pnpm build
pnpm start
```

## 开发

```powershell
pnpm dev      # 监听模式
pnpm test     # 运行测试
pnpm typecheck # 类型检查
```

## 许可证

AGPL-3.0
```

- [ ] **Step 3：最终构建验证**

```powershell
pnpm build
pnpm typecheck
pnpm test
```

预期：全部通过

- [ ] **Step 4：提交**

```powershell
git add .gitignore README.md
git commit -m "docs: add .gitignore and README"
```

---

## 完成标准

1. `pnpm build` 成功，`dist/index.js` 可执行
2. `pnpm typecheck` 无错误
3. `pnpm test` 所有测试通过（至少 5 个测试用例）
4. `pnpm start` 能正确加载默认配置并输出信息
5. 配置文件支持 `${ENV_VAR}` 环境变量替换
6. 项目级 `.routedev.yaml` 能正确覆盖全局配置
7. 无效配置抛出带路径信息的错误
8. 所有代码无 `any` 类型（zod 推断的类型除外）

## 注意事项

- 这是整个项目的第一个 Phase，后续所有模块都依赖这里建立的类型定义和配置系统
- `src/config/schema.ts` 中的类型是全局共享的，命名要规范、注释要充分
- 环境变量替换只处理字符串值，不处理数字或布尔值
- 配置合并是深度合并但数组不合并（项目级数组直接替换全局数组）

---

*Phase 1 | 蓝图 V1.0 | 预估文件数：~12 个新增文件*
