// src/cli/args.ts
// CLI 参数解析（不引入外部库如 commander/yargs）
// 手动解析 process.argv，保持零依赖

interface CLIArgs {
  /** 子命令：undefined = interactive, 'serve' = server mode, 'config' = config ops, 'exec' = 非交互执行 */
  command?: 'serve' | 'config' | 'exec';
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
  // ===== exec 子命令专用参数 =====
  /** exec 模式：JSONL 事件流输出 */
  execJson?: boolean;
  /** exec 模式：输出 JSON Schema（强制最终答案匹配此 Schema） */
  execOutputSchema?: string;
  /** exec 模式：超时秒数 */
  execTimeout?: number;
  /** exec 模式：任务描述（命令行传入的第一个非 flag 参数） */
  execTask?: string;
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
      case '-p': {
        const next = argv[++i];
        args.port = parseInt(next, 10);
        if (isNaN(args.port)) {
          throw new Error(`Invalid port: ${next}`);
        }
        break;
      }
      case '--config':
      case '-c': {
        args.configPath = argv[++i];
        break;
      }
      case '--no-color':
        args.noColor = true;
        break;
      case '--log-level': {
        args.logLevel = argv[++i];
        break;
      }
      // ===== exec 子命令专用参数 =====
      case '--json': {
        args.execJson = true;
        break;
      }
      case '--output-schema': {
        args.execOutputSchema = argv[++i];
        break;
      }
      case '--timeout': {
        const next = argv[++i];
        args.execTimeout = parseInt(next, 10);
        if (isNaN(args.execTimeout) || args.execTimeout <= 0) {
          throw new Error(`Invalid timeout: ${next}`);
        }
        break;
      }
      default: {
        if (arg?.startsWith('--')) {
          // 未知参数——忽略但警告
          console.warn(`未知参数: ${arg}`);
        } else if (!args.command) {
          // 第一个非 flag 参数作为子命令
          if (arg === 'serve' || arg === 'config' || arg === 'exec') {
            args.command = arg;
          } else {
            args.subArgs.push(arg);
          }
        } else {
          args.subArgs.push(arg);
        }
        break;
      }
    }
    i++;
  }

  // exec 子命令：第一个 subArg 作为任务描述
  if (args.command === 'exec' && args.subArgs.length > 0) {
    args.execTask = args.subArgs[0];
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
  routedev exec [task]              非交互执行任务（适用于 CI 集成和批处理）

选项:
  -v, --version          显示版本号
  -h, --help             显示帮助信息
  -p, --port <number>    覆盖服务端口号
  -c, --config <path>    指定配置文件路径
  --no-color             禁用彩色输出
  --log-level <level>    设置日志级别 (debug|info|warn|error)

exec 子命令选项:
  --json                 输出 JSONL 事件流到 stdout（适用于 CI 解析）
  --output-schema <json> 指定输出 JSON Schema，最终答案必须匹配此 Schema
  --timeout <seconds>    超时秒数（超时后退出码为 2）

exec 退出码:
  0 = 成功
  1 = 执行失败
  2 = 超时

示例:
  routedev                          启动交互模式
  routedev serve --port 3000        在 3000 端口启动服务
  routedev -c ./my-config.yaml      使用自定义配置启动
  routedev config validate          验证默认配置文件
  routedev exec "重构 utils.ts"     非交互执行任务，输出纯文本
  routedev exec "生成 API 文档" --json    输出 JSONL 事件流
  echo "修复 bug" | routedev exec --json  从 stdin 读取任务
  routedev exec "提取数据" --output-schema '{"type":"object","required":["result"]}'
  routedev exec "分析代码" --timeout 120  120 秒超时
`);
}

export function printVersion(): void {
  // 读取 package.json 的 version 字段，避免硬编码
  // 使用 createRequire 支持 ESM 下读取 CommonJS package.json
  try {
    const mod = require('node:module') as { createRequire: (url: string) => NodeRequire };
    const req = mod.createRequire(import.meta.url);
    const pkg = req('../../package.json') as { version: string };
    console.log(`routedev ${pkg.version}`);
  } catch {
    // 降级：如果无法读取 package.json，使用硬编码版本
    console.log('routedev 1.0.0');
  }
}

// ============================================================
// Phase 47 Task 3：exec 子命令扩展参数（工具白名单 + 工作模式 + 总超时）
// ============================================================

/** exec 子命令的工作模式（沙箱级） */
export type ExecWorkMode = 'read-only' | 'workspace-write' | 'full-access';

/** exec 子命令的扩展参数（Phase 47 Task 3） */
export interface ExecArgs {
  /** 任务提示词（命令行传入的第一个非 flag 参数） */
  prompt: string;
  /** 工具白名单（逗号分隔的工具名列表）；为空表示不限制 */
  allowedTools?: string[];
  /** 输出格式：text 纯文本 / json 结构化 */
  outputFormat: 'text' | 'json';
  /** 输出文件路径（可选，将结果写入文件而非 stdout） */
  outputFile?: string;
  /** 最大执行步数（防止死循环） */
  maxSteps: number;
  /** 总超时（毫秒），超时返回退出码 2 */
  timeout: number;
  /** 工作模式（沙箱级），控制工具能做多少 */
  workMode: ExecWorkMode;
}

/** parseExecArgs 的默认值 */
const EXEC_DEFAULTS = {
  maxSteps: 50,
  timeout: 300000, // 5 分钟
  workMode: 'workspace-write' as ExecWorkMode,
};

/**
 * 解析 exec 子命令参数
 *
 * 用法：
 *   routedev exec "prompt" --allowedTools file_read,file_search --json \
 *     --timeout 300000 --workMode read-only --maxSteps 50 --output result.json
 *
 * @param argv process.argv.slice(2) 后的参数数组
 * @returns ExecArgs 对象；如果不是 exec 子命令或缺少 prompt 则返回 null
 */
export function parseExecArgs(argv: string[]): ExecArgs | null {
  // 第一个参数必须是 'exec' 子命令
  if (argv[0] !== 'exec') {
    return null;
  }

  const rest = argv.slice(1);

  let prompt = '';
  let allowedTools: string[] | undefined;
  let outputFormat: 'text' | 'json' = 'text';
  let outputFile: string | undefined;
  let maxSteps = EXEC_DEFAULTS.maxSteps;
  let timeout = EXEC_DEFAULTS.timeout;
  let workMode: ExecWorkMode = EXEC_DEFAULTS.workMode;

  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    switch (arg) {
      case '--json':
        outputFormat = 'json';
        break;
      case '--allowedTools': {
        const next = rest[++i];
        if (next) {
          allowedTools = next
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        break;
      }
      case '--timeout': {
        const next = rest[++i];
        const val = parseInt(next, 10);
        if (isNaN(val) || val <= 0) {
          throw new Error(`Invalid timeout: ${next}`);
        }
        timeout = val;
        break;
      }
      case '--workMode': {
        const next = rest[++i];
        if (next !== 'read-only' && next !== 'workspace-write' && next !== 'full-access') {
          throw new Error(`Invalid workMode: ${next}`);
        }
        workMode = next;
        break;
      }
      case '--maxSteps': {
        const next = rest[++i];
        const val = parseInt(next, 10);
        if (isNaN(val) || val <= 0) {
          throw new Error(`Invalid maxSteps: ${next}`);
        }
        maxSteps = val;
        break;
      }
      case '--output': {
        outputFile = rest[++i];
        break;
      }
      default: {
        // 非 flag 参数作为 prompt（第一个非 flag 参数）
        if (arg && !arg.startsWith('--') && !prompt) {
          prompt = arg;
        }
        break;
      }
    }
    i++;
  }

  // 缺少 prompt 不是有效的 exec 调用
  if (!prompt) {
    return null;
  }

  return {
    prompt,
    allowedTools,
    outputFormat,
    outputFile,
    maxSteps,
    timeout,
    workMode,
  };
}
