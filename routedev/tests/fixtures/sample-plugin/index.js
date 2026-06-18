// tests/fixtures/sample-plugin/index.js
// 示例工具插件（用于集成测试）
// 导出一个符合 ToolPlugin 接口的对象，提供 sample_echo 工具

const plugin = {
  id: 'tool-sample',
  name: 'Sample',
  version: '1.0.0',
  type: 'tool',
  enabled: true,
  async init() {
    // 示例插件无需初始化
  },
  async destroy() {
    // 示例插件无需清理
  },
  getTools() {
    return [
      {
        definition: {
          name: 'sample_echo',
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
        async execute(args) {
          return {
            success: true,
            output: String(args.message ?? ''),
            durationMs: 0,
          };
        },
        validateArgs(args) {
          if (typeof args.message !== 'string') {
            return { valid: false, errors: ['message must be a string'] };
          }
          return { valid: true, errors: [] };
        },
      },
    ];
  },
};

export default plugin;
