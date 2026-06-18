// src/cli/commands/channels.ts

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';

export const channelsCommand: CommandDefinition = {
  name: 'channels',
  description: '查看渠道服务器状态',
  usage: '/channels [list|port]',
  handler: async (args) => {
    const sub = args.trim().toLowerCase();
    switch (sub) {
      case 'list': {
        return { type: 'handled', messages: ['渠道列表需通过服务器模式查看：routedev serve'] };
      }
      case 'port': {
        return { type: 'handled', messages: ['渠道服务器端口在 routedev.yaml 的 channels.port 中配置'] };
      }
      default:
        return { type: 'handled', messages: ['用法: /channels [list|port]'] };
    }
  },
};
