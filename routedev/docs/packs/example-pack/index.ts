// docs/packs/example-pack/index.ts
// 示例 Pack 入口（Phase 82 Task 4）
// 演示三种能力的注册：
//   1. 自定义工具（example_echo）
//   2. 自定义命令（/example.greet）
//   3. 事件钩子（tool_call 审计日志）
//
// 使用方式：将整个 example-pack 目录复制到 .routedev/packs/ 下即可被发现

import type { CapabilityPack, PackContext } from '../../../src/plugins/capability-pack.js';
import type { ITool, ToolResult } from '../../../src/tools/types.js';

// ============================================================
// 1. 自定义工具：example_echo
// 原样返回输入消息，受 PermissionEngine 自动管控
// ============================================================

const echoTool: ITool = {
  definition: {
    name: 'example_echo',
    description: '示例工具：原样返回输入消息',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '要回显的消息' },
      },
      required: ['message'],
    },
    requiresApproval: false,
    category: 'system',
  },

  validateArgs(args: Record<string, unknown>) {
    if (typeof args.message !== 'string') {
      return { valid: false, message: 'message 必须是字符串', errorCode: 1 };
    }
    return { valid: true };
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const message = args.message as string;
    return {
      success: true,
      output: message,
      durationMs: 0,
    };
  },
};

// ============================================================
// 2. 事件钩子处理器：工具调用时记录审计日志
// ============================================================

const toolCallHandler = (payload: unknown): void => {
  // 实际场景可写入审计文件或发送到可观测性系统
  // payload 结构由宿主定义，这里仅做演示
  void payload;
};

// ============================================================
// 3. Pack 定义：register/unregister 管理生命周期
// ============================================================

const examplePack: CapabilityPack = {
  id: 'pack.example',
  configKey: 'example',
  layer: 'extended',
  description: '示例 Pack：演示自定义工具、命令、事件钩子的注册',
  costHint: '启用后注入 1 个工具 + 1 个命令 + 1 个钩子，约增加 300 token',
  defaultEnabled: false,

  /** 启用时调用：通过 PackContext 注册工具、命令、钩子 */
  async register(ctx: PackContext): Promise<void> {
    // 注册自定义工具——自动受 PermissionEngine 管控
    ctx.tools.register(echoTool);

    // 注册斜杠命令：/example.greet <name>
    ctx.commands.register('example.greet', async (args: string) => {
      const name = args?.trim() || 'world';
      ctx.logger.info(`[example-pack] Hello, ${name}!`);
      return `Hello, ${name}!`;
    });

    // 订阅事件钩子：工具调用时记录
    ctx.events.on('tool_call', toolCallHandler);

    ctx.logger.info('[example-pack] 已注册：example_echo 工具 / example.greet 命令 / tool_call 钩子');
  },

  /** 禁用时调用：清理所有注册项 */
  async unregister(ctx: PackContext): Promise<void> {
    ctx.tools.unregister('example_echo');
    ctx.commands.unregister('example.greet');
    ctx.events.off('tool_call', toolCallHandler);

    ctx.logger.info('[example-pack] 已卸载所有注册项');
  },
};

export default examplePack;
