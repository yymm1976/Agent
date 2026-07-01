// src/cli/commands/doctor.ts
// /doctor 命令：运行环境健康检查
// 接线修复：原版本仅导出 handleDoctorCommand 函数，无 CommandDefinition，
// 未在 commands/index.ts 导出，也未在 App.tsx 注册，导致 /doctor 命令实际不可用。
// 现改为标准 CommandDefinition，从 ctx.config + ctx.cwd 构造 Doctor 探测上下文。

import type { CommandDefinition } from '../command-registry.js';
import { Doctor } from '../doctor.js';

export const doctorCommand: CommandDefinition = {
  name: 'doctor',
  description: '运行环境健康检查（探测本地工具 / LLM Provider / MCP Server / 目录权限 / 配置完整性）',
  usage: '/doctor',
  handler: async (_args, ctx) => {
    // 从 ctx.config 提取 Provider 与 MCP Server 元信息（doctor 不直接依赖完整 config）
    const providers = ctx.config.providers.map((p) => ({
      id: p.id,
      baseUrl: p.baseUrl,
    }));
    const mcpServers = ctx.config.mcp.servers
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        command: s.config.transport === 'stdio' ? s.config.command : '',
      }));

    const doctor = new Doctor(
      { probeTimeout: 10000, runOnStartup: false },
      { providers, mcpServers, cwd: ctx.cwd },
    );
    const results = await doctor.runAllChecks();
    const report = doctor.formatReport(results);
    return { type: 'handled', messages: [report] };
  },
};

// 保留原导出函数，便于外部测试或脚本直接调用
export async function handleDoctorCommand(doctor: Doctor): Promise<string> {
  const results = await doctor.runAllChecks();
  return doctor.formatReport(results);
}
