// src/cli/commands/clear.ts

import type { CommandDefinition } from '../command-registry.js';

export const clearCommand: CommandDefinition = {
  name: 'clear',
  description: '清屏',
  handler: async () => ({ type: 'handled', messages: ['__CLEAR__'] }),
};
