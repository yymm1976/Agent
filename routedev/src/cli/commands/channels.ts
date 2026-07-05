// src/cli/commands/channels.ts
// /channels 命令：显示渠道服务器配置与已配置适配器状态
// 注：CLI 交互模式下 ChannelManager 不运行（仅在 `routedev serve` 时启动），
// 此命令读取 config 展示已配置的渠道入口与端口，便于用户核对配置

import type { CommandDefinition } from '../command-registry.js';

export const channelsCommand: CommandDefinition = {
  name: 'channels',
  description: '查看渠道服务器配置与适配器状态',
  usage: '/channels [list|port]',
  handler: async (args, ctx) => {
    const sub = args.trim().toLowerCase();
    const channelsCfg = ctx.config.channels;
    const port = channelsCfg?.port ?? '未配置';
    const entries = channelsCfg?.entries ?? [];
    // 已启用的适配器
    const enabled = entries.filter(e => e.enabled);

    switch (sub) {
      case 'list': {
        if (entries.length === 0) {
          return { type: 'handled', messages: ['当前未配置任何渠道适配器。在 routedev.yaml 的 channels.entries 中添加。'] };
        }
        const lines = [
          `渠道适配器列表（共 ${entries.length} 个，已启用 ${enabled.length} 个）：`,
          '',
          ...entries.map(e => {
            const status = e.enabled ? '✓ 启用' : '✗ 禁用';
            const hasToken = Boolean(e.options?.token || e.options?.authToken);
            const tokenCfg = hasToken ? '（已配置 Token）' : '（开发模式，无鉴权）';
            return `  [${e.id}] ${e.type} ${status} ${tokenCfg}`;
          }),
          '',
          `服务器端口: ${port}`,
          `启动服务器: routedev serve`,
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }
      case 'port': {
        return { type: 'handled', messages: [`渠道服务器端口: ${port}（在 routedev.yaml 的 channels.port 中配置）`] };
      }
      default:
        return { type: 'handled', messages: [
          '用法: /channels [list|port]',
          '',
          `当前配置: 端口=${port}, 适配器=${entries.length} 个（已启用 ${enabled.length} 个）`,
          '运行 /channels list 查看详情，或 routedev serve 启动服务器',
        ] };
    }
  },
};
