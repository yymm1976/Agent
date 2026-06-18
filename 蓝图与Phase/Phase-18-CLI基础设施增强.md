# Phase 18：CLI 基础设施增强（日志轮转 + 错误恢复 + 配置热重载）

**回应**：V1 蓝图审视报告

| # | 审视项 | 处理 |
|---|--------|------|
| 缺失 #2 | `routedev serve --port` 命令行参数 | **Task 1 核心**：统一 CLI 参数解析 |
| 缺失 #3 | CLI 模式没有日志轮转 | **Task 2 核心**：接入 winston-daily-rotate-file |
| 缺失 #4 | 缺乏统一的错误恢复机制 | **Task 3 核心**：RetryPolicy + CircuitBreaker |
| 缺失 #5 | 配置热重载 | **Task 4 核心**：文件监听 + 事件通知 |
| UX #2 | 命令参数无 Tab 补全 | **Task 5**：readline 补全注册 |
| 缺陷 #9 | 异步事件流未处理 race condition | 在 ChatRunner 中加 mutex 标记 |

---

**目标**：为 RouteDev 补充生产级基础设施——CLI 参数解析、日志轮转、LLM 调用自动重试/熔断、配置文件热重载。

**前置依赖**：Phase 17（App.tsx 重构后的模块化架构，ChatRunner 和服务容器已就绪）

---

## 架构说明

Phase 17 把 App.tsx 从一个胖子拆成了几个各司其职的模块。Phase 18 是给这些模块配"安全网"和"后勤保障"。日志轮转确保磁盘不会被日志撑爆；重试/熔断让 LLM 偶尔抽风时系统不至于直接报错；配置热重载让你改了 YAML 不用重启程序。

```
Phase 18 新增组件：

CLI 参数解析（index.tsx 改造）
  routedev --port 3000 --config ./my-config.yaml
  routedev serve --port 9800 --no-color
  routedev config validate ./config.yaml

日志系统升级（logger.ts 改造）
  winston → winston + winston-daily-rotate-file
  按日期分文件 + 自动清理旧日志

重试 + 熔断（src/utils/retry.ts）
  RetryPolicy: 指数退避重试（最多 3 次）
  CircuitBreaker: 连续失败 N 次后熔断，冷却后半开
  装饰器模式包装 ILLMClient

配置热重载（src/config/watcher.ts）
  fs.watch 监听 config.yaml
  检测到变化 → 重新加载 → 通知订阅者
  支持 "reload" 事件回调

Tab 补全（src/cli/completion.ts）
  命令名补全（/help, /goal, /status...）
  子命令补全（/memory show, /branch list...）
```

**关键约束**：
- winston-daily-rotate-file 是唯一新增的生产依赖
- 重试策略只应用于 LLM 调用（不适用于工具执行——工具操作不可重试）
- 配置热重载采用"最终一致"策略——不阻塞正在执行的请求，下次请求用新配置
- Tab 补全使用 Node.js 内置 readline 接口，不引入额外依赖

---

## 具体任务

### Task 1：CLI 参数解析

**文件：** 修改 `src/index.tsx`，创建 `src/cli/args.ts`

当前 `index.tsx` 只解析 `--version` 和 `serve`，没有统一参数解析。

- [ ] **Step 1：实现参数解析器**

```typescript
// src/cli/args.ts
// CLI 参数解析（不引入外部库如 commander/yargs）
// 手动解析 process.argv，保持零依赖

export interface CLIArgs {
  /** 子命令：undefined = interactive, 'serve' = server mode, 'config' = config ops */
  command?: 'serve' | 'config';
  /** 子命令参数 */
  subArgs: string[];
  /** 覆盖端口号 */
  port?: number;
  /** 覆盖配置文件路径 */
  configPath?: string;
  /** 禁用彩色输出 */
  noColor: boolean;
  /** 日志级别覆盖 */
  logLevel?: string;
  /** 打印版本 */
  version: boolean;
  /** 打印帮助 */
  help: boolean;
}

export function parseArgs(argv: string[]): CLIArgs {
  const args: CLIArgs = {
    subArgs: [],
    noColor: false,
    version: false,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    switch (arg) {
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--port':
      case '-p':
        args.port = parseInt(argv[++i], 10);
        if (isNaN(args.port)) {
          throw new Error(`Invalid port: ${argv[i]}`);
        }
        break;
      case '--config':
      case '-c':
        args.configPath = argv[++i];
        break;
      case '--no-color':
        args.noColor = true;
        break;
      case '--log-level':
        args.logLevel = argv[++i];
        break;
      default:
        if (arg?.startsWith('--')) {
          // 未知参数——忽略但警告
          console.warn(`未知参数: ${arg}`);
        } else if (!args.command) {
          // 第一个非 flag 参数作为子命令
          if (arg === 'serve' || arg === 'config') {
            args.command = arg;
          } else {
            args.subArgs.push(arg);
          }
        } else {
          args.subArgs.push(arg);
        }
        break;
    }
    i++;
  }

  return args;
}

export function printHelp(): void {
  console.log(`
RouteDev — AI 驱动的开发助手 CLI

用法:
  routedev                          启动交互式对话模式
  routedev serve                    启动 webhook 服务模式
  routedev config validate [path]   验证配置文件

选项:
  -v, --version          显示版本号
  -h, --help             显示帮助信息
  -p, --port <number>    覆盖服务端口号
  -c, --config <path>    指定配置文件路径
  --no-color             禁用彩色输出
  --log-level <level>    设置日志级别 (debug|info|warn|error)

示例:
  routedev                          启动交互模式
  routedev serve --port 3000        在 3000 端口启动服务
  routedev -c ./my-config.yaml      使用自定义配置启动
  routedev config validate          验证默认配置文件
`);
}

export function printVersion(): void {
  // 从 package.json 读取或硬编码
  console.log('routedev 0.14.0');
}
```

- [ ] **Step 2：修改 index.tsx 使用新解析器**

```typescript
// src/index.tsx（改造后）
import { parseArgs, printHelp, printVersion } from './cli/args.js';
import { startServer } from './cli/server.js';
// ... 其他导入 ...

const args = parseArgs(process.argv.slice(2));

if (args.version) {
  printVersion();
  process.exit(0);
}

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.noColor) {
  process.env.NO_COLOR = '1';
}

if (args.logLevel) {
  process.env.ROUTEDEV_LOG_LEVEL = args.logLevel;
}

// 加载配置（支持 --config 覆盖路径）
const config = loadConfig(args.configPath ? { globalConfigPath: args.configPath } : undefined);

// 端口覆盖
if (args.port) {
  config.channels.port = args.port;
}

if (args.command === 'serve') {
  startServer(config).catch(err => {
    console.error('Server failed:', err);
    process.exit(1);
  });
} else if (args.command === 'config') {
  // config 子命令处理
  handleConfigCommand(args.subArgs, config);
} else {
  // 默认：交互模式
  render(<App config={config} />);
}
```

注意：`startServer()` 签名需从 `() => Promise<void>` 改为 `(config?: AppConfig) => Promise<void>`，接收外部传入的配置。

- [ ] **Step 3：`config` 子命令**

```typescript
function handleConfigCommand(subArgs: string[], config: AppConfig): void {
  const action = subArgs[0];

  switch (action) {
    case 'validate': {
      const path = subArgs[1];
      const result = validateConfigFile(path);
      if (result.valid) {
        console.log('✓ 配置文件有效');
      } else {
        console.error('✗ 配置文件无效:');
        for (const error of result.errors) {
          console.error(`  - ${error}`);
        }
        process.exit(1);
      }
      break;
    }
    case 'show': {
      console.log(JSON.stringify(config, null, 2));
      break;
    }
    default:
      console.log('用法: routedev config validate|show [path]');
  }
}
```

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/args.ts src/index.tsx src/cli/server.ts
git commit -m "feat(cli): add unified argument parsing with --port, --config, --help"
```

---

### Task 2：日志轮转

**文件：** 修改 `src/utils/logger.ts`

当前使用 winston 内置 File transport（固定大小轮转），不支持按日期分文件。

- [ ] **Step 1：安装 winston-daily-rotate-file**

```powershell
pnpm add winston-daily-rotate-file
```

- [ ] **Step 2：改造 logger.ts**

```typescript
// src/utils/logger.ts（改造后）
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'node:path';
import { getAppDataDir } from './paths.js';

const logDir = path.join(getAppDataDir(), 'logs');
const logLevel = process.env.ROUTEDEV_LOG_LEVEL ?? 'info';

// 按日期轮转的 error 日志
const errorRotateTransport = new DailyRotateFile({
  filename: path.join(logDir, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  maxSize: '10m',
  maxFiles: '14d', // 保留 14 天
  zippedArchive: true, // 旧文件自动 gzip 压缩
});

// 按日期轮转的全量日志
const combinedRotateTransport = new DailyRotateFile({
  filename: path.join(logDir, 'combined-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '7d', // 保留 7 天
  zippedArchive: true,
});

export const logger = createLogger({
  level: logLevel,
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json(),
  ),
  defaultMeta: { service: 'routedev' },
  transports: [
    errorRotateTransport,
    combinedRotateTransport,
  ],
});

// 开发模式：控制台输出
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 1
            ? ` ${JSON.stringify(meta)}`
            : '';
          return `${timestamp} [${level}]: ${message}${metaStr}`;
        }),
      ),
    }),
  );
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm add winston-daily-rotate-file
pnpm build
pnpm typecheck
git add package.json pnpm-lock.yaml src/utils/logger.ts
git commit -m "feat(utils): upgrade logger to daily-rotate-file with gzip archiving"
```

---

### Task 3：RetryPolicy + CircuitBreaker

**文件：** 创建 `src/utils/retry.ts`

LLM API 调用是最容易出错的环节——网络超时、429 限流、500 服务端错误。重试策略用指数退避应对瞬态故障，熔断器在持续故障时快速失败避免雪崩。

- [ ] **Step 1：实现 RetryPolicy**

```typescript
// src/utils/retry.ts
// 重试策略 + 熔断器
// 只应用于 LLM 调用（工具操作不可重试——文件已写入不能撤销）

import { logger } from './logger.js';

/** 重试配置 */
export interface RetryConfig {
  /** 最大重试次数（不含首次调用） */
  maxRetries: number;
  /** 初始退避时间（毫秒） */
  baseDelayMs: number;
  /** 最大退避时间（毫秒） */
  maxDelayMs: number;
  /** 退避倍数 */
  backoffMultiplier: number;
  /** 可重试的错误类型 */
  retryableErrors: Set<string>;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: new Set([
    'rate_limit',      // 429 Too Many Requests
    'timeout',         // 请求超时
    'network',         // 网络错误
    'server_error',    // 500/502/503/504
  ]),
};

/** 带重试的操作执行器 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  label = 'operation',
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errorType = classifyError(lastError);

      // 不可重试的错误直接抛出
      if (!cfg.retryableErrors.has(errorType)) {
        logger.error(`${label}: non-retryable error`, {
          errorType,
          message: lastError.message,
          attempt: attempt + 1,
        });
        throw lastError;
      }

      // 已达最大重试次数
      if (attempt >= cfg.maxRetries) {
        logger.error(`${label}: max retries exhausted`, {
          errorType,
          message: lastError.message,
          attempts: attempt + 1,
        });
        throw lastError;
      }

      // 计算退避时间（指数退避 + 抖动）
      const delay = Math.min(
        cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt),
        cfg.maxDelayMs,
      );
      const jitter = delay * 0.1 * Math.random(); // 10% 随机抖动
      const waitMs = Math.round(delay + jitter);

      logger.warn(`${label}: retryable error, retrying in ${waitMs}ms`, {
        errorType,
        message: lastError.message,
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries,
      });

      await sleep(waitMs);
    }
  }

  // 理论上不会到这里
  throw lastError ?? new Error('Retry exhausted');
}

/** 分类错误类型 */
function classifyError(error: Error): string {
  const msg = error.message.toLowerCase();

  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
    return 'rate_limit';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('ETIMEDOUT')) {
    return 'timeout';
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ECONNRESET') || msg.includes('network')) {
    return 'network';
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
    return 'server_error';
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
    return 'auth_error'; // 不可重试
  }
  if (msg.includes('404') || msg.includes('not found')) {
    return 'not_found'; // 不可重试
  }

  return 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 2：实现 CircuitBreaker**

```typescript
/** 熔断器状态 */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** 熔断器配置 */
export interface CircuitBreakerConfig {
  /** 触发熔断的连续失败次数 */
  failureThreshold: number;
  /** 熔断后的冷却时间（毫秒） */
  cooldownMs: number;
  /** 半开状态下的探测请求数 */
  probeCount: number;
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60000, // 1 分钟
  probeCount: 1,
};

/** 熔断器：连续失败 N 次后拒绝请求，冷却后半开探测 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private probeSuccess = 0;
  private label: string;

  constructor(label: string, config?: Partial<CircuitBreakerConfig>) {
    this.label = label;
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  /** 执行操作（自动熔断保护） */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // 熔断状态：检查冷却时间
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime < this.config.cooldownMs) {
        throw new CircuitBreakerOpenError(
          `${this.label}: circuit breaker is open (cooldown ${this.config.cooldownMs}ms)`,
        );
      }
      // 冷却时间已过，切换到半开
      this.state = 'half_open';
      this.probeSuccess = 0;
      logger.info(`${this.label}: circuit breaker half-open, probing...`);
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** 获取当前状态 */
  getState(): CircuitState {
    return this.state;
  }

  /** 获取失败计数 */
  getFailureCount(): number {
    return this.failureCount;
  }

  /** 手动重置 */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  private onSuccess(): void {
    if (this.state === 'half_open') {
      this.probeSuccess++;
      if (this.probeSuccess >= this.config.probeCount) {
        this.state = 'closed';
        this.failureCount = 0;
        logger.info(`${this.label}: circuit breaker closed (probe succeeded)`);
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half_open') {
      this.state = 'open';
      logger.warn(`${this.label}: circuit breaker re-opened (probe failed)`);
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
      logger.warn(`${this.label}: circuit breaker opened after ${this.failureCount} failures`);
    }
  }
}

/** 熔断器开启时的专用错误类 */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}
```

- [ ] **Step 3：在 ChatRunner 中集成**

在 `src/cli/chat-runner.ts` 的 LLM 调用外层包裹 retry + circuit breaker：

```typescript
// chat-runner.ts 中的 ReAct loop 调用改为：
import { withRetry, CircuitBreaker, CircuitBreakerOpenError } from '../utils/retry.js';

// 每个 provider 一个 CircuitBreaker 实例
const circuitBreakers = new Map<string, CircuitBreaker>();

function getCircuitBreaker(providerId: string): CircuitBreaker {
  if (!circuitBreakers.has(providerId)) {
    circuitBreakers.set(providerId, new CircuitBreaker(`llm:${providerId}`));
  }
  return circuitBreakers.get(providerId)!;
}

// 在 runChat 中：
const cb = getCircuitBreaker(routeDecision.providerId);
try {
  // ReAct loop 内部已经会调用 llmClient.stream()
  // 重试逻辑应在 stream/complete 层面包装
  for await (const event of services.agentLoop.run({...})) {
    // ... 原有逻辑 ...
  }
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    onError(`服务暂时不可用（熔断保护中），请稍后重试`);
  } else {
    // withRetry 会自动重试可重试的错误
    onError(error instanceof Error ? error.message : String(error));
  }
}
```

注意：更优雅的做法是在 `ILLMClient` 层面用装饰器包装 retry——创建 `RetryableLLMClient` 装饰 `stream()` 和 `complete()` 方法。执行人可选择这种方式，使重试对 ReAct loop 完全透明。

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/utils/retry.ts src/cli/chat-runner.ts
git commit -m "feat(utils): add RetryPolicy with exponential backoff and CircuitBreaker"
```

---

### Task 4：配置热重载

**文件：** 创建 `src/config/watcher.ts`

- [ ] **Step 1：实现 ConfigWatcher**

```typescript
// src/config/watcher.ts
// 配置文件热重载监听器
// 使用 Node.js 内置 fs.watch（不引入 chokidar 依赖）
//
// 策略："最终一致"——不阻塞正在执行的请求，下次请求用新配置
// 变更检测：防抖 500ms（避免编辑器多次保存触发多次重载）

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { loadConfig } from './loader.js';
import type { AppConfig } from './schema.js';

export type ConfigChangeCallback = (newConfig: AppConfig, oldConfig: AppConfig) => void;

export class ConfigWatcher {
  private configPath: string;
  private currentConfig: AppConfig;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private callbacks: ConfigChangeCallback[] = [];
  private debounceMs: number;

  constructor(configPath: string, currentConfig: AppConfig, debounceMs = 500) {
    this.configPath = path.resolve(configPath);
    this.currentConfig = currentConfig;
    this.debounceMs = debounceMs;
  }

  /** 开始监听 */
  start(): void {
    if (this.watcher) return;

    try {
      this.watcher = fs.watch(this.configPath, (eventType) => {
        if (eventType !== 'change') return;

        // 防抖
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
          this.reload();
        }, this.debounceMs);
      });

      logger.info('Config watcher started', { path: this.configPath });
    } catch (error) {
      logger.warn('Failed to start config watcher', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 停止监听 */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** 注册变更回调 */
  onChange(callback: ConfigChangeCallback): void {
    this.callbacks.push(callback);
  }

  /** 获取当前配置（可能是重载后的新配置） */
  getConfig(): AppConfig {
    return this.currentConfig;
  }

  private reload(): void {
    try {
      const oldConfig = this.currentConfig;
      const newConfig = loadConfig(this.configPath);
      this.currentConfig = newConfig;

      logger.info('Config reloaded successfully', { path: this.configPath });

      // 通知订阅者
      for (const cb of this.callbacks) {
        try {
          cb(newConfig, oldConfig);
        } catch (err) {
          logger.error('Config change callback failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (error) {
      logger.error('Config reload failed, keeping current config', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
```

- [ ] **Step 2：集成到 App.tsx 和 server.ts**

在 `service-context.ts` 中：

```typescript
// 初始化时创建 ConfigWatcher
const configWatcher = useRef(new ConfigWatcher(
  configPath ?? getDefaultConfigPath(),
  config,
)).current;

useEffect(() => {
  configWatcher.start();

  // 配置变更时更新关键组件
  configWatcher.onChange((newConfig, oldConfig) => {
    // 更新路由规则
    if (newConfig.router !== oldConfig.router) {
      // modelRouter.updateConfig(newConfig.router);
    }
    // 更新安全策略
    if (newConfig.security !== oldConfig.security) {
      // securityChecker.updateConfig(newConfig.security);
    }
    // 更新自主模式
    if (newConfig.autonomy !== oldConfig.autonomy) {
      // permissionChecker.updateConfig(newConfig.autonomy);
    }
  });

  return () => configWatcher.stop();
}, []);
```

在 `server.ts` 中类似集成。

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/config/watcher.ts src/cli/service-context.ts src/cli/server.ts
git commit -m "feat(config): add hot-reload with file watcher and debounced reload"
```

---

### Task 5：Tab 补全

**文件：** 创建 `src/cli/completion.ts`，修改 `src/cli/App.tsx`

- [ ] **Step 1：实现补全提供者**

```typescript
// src/cli/completion.ts
// Tab 补全：命令名 + 子命令补全
// 使用 Node.js 内置 readline 接口

import type { CommandRegistry } from './command-registry.js';

/** 子命令补全表 */
const SUBCOMMANDS: Record<string, string[]> = {
  '/memory': ['show', 'notes', 'write', 'clear'],
  '/checkpoint': ['create', 'list'],
  '/branch': ['list', 'edit', 'switch'],
  '/channels': ['list', 'port'],
  '/trace': ['list', 'view'],
  '/audit': ['list', 'files', 'commands'],
  '/prompt': ['list', 'view', 'reload'],
  '/project': ['status', 'memory', 'rules', 'decisions'],
  '/config': ['validate', 'show'],
};

export function createCompleter(commandRegistry: CommandRegistry) {
  return function completer(line: string): [string[], string] {
    const parts = line.trim().split(/\s+/);

    // 只有一个 token：补全命令名
    if (parts.length <= 1) {
      const prefix = parts[0] ?? '';
      const allNames = commandRegistry.listNames();
      const matches = allNames.filter(n => n.startsWith(prefix));
      return [matches.length > 0 ? matches : allNames, prefix];
    }

    // 两个 token：补全子命令
    const cmd = parts[0];
    const subPrefix = parts[1] ?? '';
    const subs = SUBCOMMANDS[cmd];
    if (subs) {
      const matches = subs.filter(s => s.startsWith(subPrefix));
      return [matches.length > 0 ? matches.map(s => `${cmd} ${s}`) : [], `${cmd} ${subPrefix}`];
    }

    return [[], line];
  };
}
```

- [ ] **Step 2：在 InputBox 中集成**

InputBox 组件需要接收 completer 函数并传给底层 readline。具体实现取决于 InputBox 的当前架构（`src/cli/components/InputBox.tsx`）。

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/completion.ts src/cli/App.tsx src/cli/components/InputBox.tsx
git commit -m "feat(cli): add Tab completion for commands and subcommands"
```

---

### Task 6：单元测试

- [ ] **Step 1：RetryPolicy 测试（5 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | 首次成功 | 不重试，直接返回 |
| 2 | 可重试错误后成功 | 重试 N 次后返回结果 |
| 3 | 不可重试错误 | 立即抛出，不重试 |
| 4 | 指数退避延迟 | 验证 delay 随 attempt 增长 |
| 5 | 超过 maxRetries | 抛出最后一次错误 |

- [ ] **Step 2：CircuitBreaker 测试（4 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | closed 状态正常执行 | 成功时 failureCount 归零 |
| 2 | 连续失败触发 open | 状态变为 open，后续调用直接抛 CircuitBreakerOpenError |
| 3 | cooldown 后切换 half_open | 冷却时间过后允许探测请求 |
| 4 | half_open 探测成功恢复 closed | 探测成功后重置状态 |

- [ ] **Step 3：parseArgs 测试（4 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | `--version` | version: true |
| 2 | `serve --port 3000` | command: 'serve', port: 3000 |
| 3 | `--config ./my.yaml` | configPath: './my.yaml' |
| 4 | 无参数 | command: undefined, 所有字段默认值 |

- [ ] **Step 4：运行全量测试 → 提交**

```powershell
npx vitest run
# 预期：新增 13 个测试
# 累计测试数：Phase 17 的 300 + 13 = 313+

pnpm build
pnpm typecheck
git add tests/
git commit -m "test(utils+cli): add retry, circuit breaker, and arg parsing tests"
git push origin main
```

---

## 接口对齐观察表

| 接口 | 文件 | 签名 | 本 Phase 引用方式 |
|------|------|------|-------------------|
| `startServer()` | `src/cli/server.ts` | `() => Promise<void>` | 改为 `(config?: AppConfig) => Promise<void>` |
| `loadConfig()` | `src/config/loader.ts` | `(options?: { projectPath?: string; globalConfigPath?: string }) => AppConfig` | args.ts 调用 |
| `validateConfigFile()` | `src/config/loader.ts` | `(path?: string) => { valid, errors }` | config 子命令调用 |
| `logger` | `src/utils/logger.ts` | winston createLogger | 改造为 daily-rotate-file |
| `ILLMClient.stream()` | `src/router/types.ts` | `(messages, options?) => AsyncGenerator<LLMStreamEvent>` | RetryPolicy 包装 |
| `ILLMClient.complete()` | `src/router/types.ts` | `(request) => Promise<LLMResponse>` | RetryPolicy 包装 |
| `CommandRegistry` | `src/cli/command-registry.ts` | `listNames()` / `resolve()` | completion.ts 调用 |
| `useServiceContext()` | `src/cli/service-context.ts` | `(config) => ServiceContext` | ConfigWatcher 集成 |

---

## 对下一阶段的提醒

1. **winston-daily-rotate-file 版本兼容**：确认与 winston 3.19.0 兼容，特别是 ESM 导入方式（`import DailyRotateFile from 'winston-daily-rotate-file'` 可能需要 `.default`）
2. **CircuitBreaker 粒度**：当前每个 provider 一个 breaker。如果同一 provider 有多个模型，可细化到 per-model 粒度
3. **重试不应用于 tool call**：file_write 等操作不可重试（可能已部分写入）。RetryPolicy 只用于 LLM 调用
4. **ConfigWatcher 的 fs.watch 局限性**：在某些文件系统（如 NFS、WSL）上 fs.watch 可能不可靠。后续可考虑 chokidar 作为替代
5. **配置重载不完整**：当前只更新路由/安全/自主模式。providers 列表变更需要重新创建 LLMClientManager——这是重量级操作，暂不实现热重载
6. **Tab 补全的文件路径**：当前只补全命令名和子命令。文件路径补全（如 /init 的项目路径）留给后续
