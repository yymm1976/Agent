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
      default: {
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
