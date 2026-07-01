// src/cli/doctor.ts
// Doctor 探测器：运行环境健康检查
// 探测本地工具、LLM Provider、MCP Server、目录权限、配置完整性
// 不直接 import 共享配置(Zod schema)以避免循环依赖

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

// --- 类型定义 ---

export type ProbeStatus = 'ok' | 'missing' | 'broken' | 'timeout';

export interface ProbeResult {
  component: string;
  status: ProbeStatus;
  version?: string;
  latencyMs?: number;
  message: string;
  suggestion?: string;
}

export interface DoctorConfig {
  /** 单次探测超时(毫秒),默认 10000 */
  probeTimeout: number;
  /** 是否在启动时自动运行,默认 false */
  runOnStartup: boolean;
}

export interface DoctorProbeContext {
  /** 待探测的 LLM Provider 列表(简化:仅 baseUrl) */
  providers?: Array<{ id: string; baseUrl: string }>;
  /** 待探测的 MCP Server 列表(简化:仅检查 command 字段) */
  mcpServers?: Array<{ id: string; command: string }>;
  /** 工作目录(用于权限检查) */
  cwd?: string;
}

// --- 默认配置 ---

const DEFAULT_CONFIG: DoctorConfig = {
  probeTimeout: 10000,
  runOnStartup: false,
};

/** 默认探测的本地工具(node/pnpm/git) */
const DEFAULT_TOOLS: ReadonlyArray<{ name: string; args: string[] }> = [
  { name: 'node', args: ['--version'] },
  { name: 'pnpm', args: ['--version'] },
  { name: 'git', args: ['--version'] },
];

/** 状态符号映射 */
const STATUS_SYMBOLS: Record<ProbeStatus, string> = {
  ok: '✓',
  missing: '✗',
  broken: '!',
  timeout: '⏱',
};

/** 状态文案映射 */
const STATUS_TEXT: Record<ProbeStatus, string> = {
  ok: 'OK',
  missing: 'missing',
  broken: 'broken',
  timeout: 'timeout',
};

/**
 * Doctor 探测器：运行环境健康检查
 *
 * 使用方法:
 *   const doctor = new Doctor({ probeTimeout: 5000 });
 *   const results = await doctor.runAllChecks();
 *   const report = doctor.formatReport(results);
 */
export class Doctor {
  private readonly config: DoctorConfig;
  private readonly context: DoctorProbeContext;

  constructor(config?: Partial<DoctorConfig>, context?: DoctorProbeContext) {
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    this.context = context ?? {};
  }

  /** 运行所有探测,返回结果列表(顺序:工具→Provider→MCP→目录→配置完整性) */
  async runAllChecks(): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];

    // 1. 本地工具版本探测(spawnSync)
    for (const tool of DEFAULT_TOOLS) {
      results.push(this.probeToolVersion(tool.name, tool.args));
    }

    // 2. LLM Provider 连通性探测(fetch HEAD)
    if (this.context.providers) {
      for (const provider of this.context.providers) {
        results.push(await this.probeProvider(provider));
      }
    }

    // 3. MCP Server 检查(简化:仅检查 command 字段非空)
    if (this.context.mcpServers) {
      for (const server of this.context.mcpServers) {
        results.push(this.probeMcpServer(server));
      }
    }

    // 4. 目录权限检查
    if (this.context.cwd) {
      results.push(this.probeDirectory(this.context.cwd));
    }

    // 5. 配置文件完整性(简化:占位,不 import Zod schema)
    results.push({
      component: 'config-integrity',
      status: 'ok',
      message: '配置完整性检查已跳过(简化实现)',
    });

    return results;
  }

  /**
   * 探测本地工具版本(spawnSync 同步调用)
   * - ENOENT → missing
   * - status null(超时) → timeout
   * - 退出码非0 → broken
   * - 成功 → ok, version=stdout.trim()
   */
  probeToolVersion(name: string, args: string[]): ProbeResult {
    const start = Date.now();
    let result;
    try {
      result = spawnSync(name, args, {
        timeout: this.config.probeTimeout,
        encoding: 'utf-8',
        shell: process.platform === 'win32', // Windows 需要 shell
      });
    } catch (error) {
      // 同步抛出异常(极少见,通常是配置错误)
      return {
        component: name,
        status: 'broken',
        latencyMs: Date.now() - start,
        message: `执行异常: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const latencyMs = Date.now() - start;

    // 命令不存在检测(双重判定,避免误判合法错误输出为 missing):
    // - 无 shell 时 error.code === 'ENOENT'
    // - shell 模式下:退出码 ∈ {1, 127, 9009} 且 stderr 匹配 shell 的 "命令未找到" 文案
    //   * Windows cmd.exe: "'X' is not recognized as an internal or external command"
    //   * Unix sh: "X: command not found" / "X: not found"
    //   * 中文 Windows cmd: "不是内部或外部命令"
    const isENOENT =
      !!result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    const stderrText = (result.stderr || '').toString();
    const isShellCmdNotFound =
      !isENOENT &&
      (result.status === 1 || result.status === 127 || result.status === 9009) &&
      /is not recognized as|command not found|: not found|不是内部或外部命令|系统找不到指定的文件/i.test(
        stderrText,
      );
    if (isENOENT || isShellCmdNotFound) {
      return {
        component: name,
        status: 'missing',
        latencyMs,
        message: `命令未找到: ${name}`,
        suggestion: `请安装 ${name}`,
      };
    }

    // 超时(status null,通常 signal 为 SIGTERM)
    if (result.status === null) {
      return {
        component: name,
        status: 'timeout',
        latencyMs,
        message: `命令超时(>${this.config.probeTimeout}ms)`,
        suggestion: `检查 ${name} 是否可正常执行,或增大 probeTimeout`,
      };
    }

    // 退出码非0
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim().slice(0, 100);
      return {
        component: name,
        status: 'broken',
        latencyMs,
        message: `退出码 ${result.status}${stderr ? ': ' + stderr : ''}`,
      };
    }

    // 成功
    return {
      component: name,
      status: 'ok',
      version: (result.stdout || '').trim(),
      latencyMs,
      message: 'OK',
    };
  }

  /**
   * 探测 LLM Provider 连通性(fetch HEAD 请求)
   * - fetch 失败 → broken
   * - 超时(AbortError) → timeout
   * - 任何 HTTP 响应 → ok
   */
  async probeProvider(provider: { id: string; baseUrl: string }): Promise<ProbeResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.probeTimeout);

    try {
      const response = await fetch(provider.baseUrl, {
        method: 'HEAD',
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      // 任何 HTTP 响应都算连通成功
      return {
        component: `provider:${provider.id}`,
        status: 'ok',
        latencyMs,
        message: `HTTP ${response.status}`,
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      // 超时(AbortError)
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          component: `provider:${provider.id}`,
          status: 'timeout',
          latencyMs,
          message: `请求超时(>${this.config.probeTimeout}ms)`,
          suggestion: `检查 ${provider.baseUrl} 是否可访问,或增大 probeTimeout`,
        };
      }
      return {
        component: `provider:${provider.id}`,
        status: 'broken',
        latencyMs,
        message: `连接失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 探测 MCP Server(简化:仅检查 command 字段非空)
   * - command 空 → missing
   * - command 非空 → ok
   */
  probeMcpServer(server: { id: string; command: string }): ProbeResult {
    if (!server.command || server.command.trim() === '') {
      return {
        component: `mcp:${server.id}`,
        status: 'missing',
        message: 'command 字段为空',
        suggestion: `请配置 MCP Server ${server.id} 的 command`,
      };
    }
    return {
      component: `mcp:${server.id}`,
      status: 'ok',
      message: `command: ${server.command}`,
    };
  }

  /**
   * 探测目录权限(fs.accessSync 检查可读写)
   * - 不可访问 → broken
   * - 可访问 → ok
   */
  probeDirectory(cwd: string): ProbeResult {
    const start = Date.now();
    try {
      accessSync(cwd, constants.R_OK | constants.W_OK);
      return {
        component: `dir:${cwd}`,
        status: 'ok',
        latencyMs: Date.now() - start,
        message: '可读写',
      };
    } catch (error) {
      return {
        component: `dir:${cwd}`,
        status: 'broken',
        latencyMs: Date.now() - start,
        message: `不可访问: ${error instanceof Error ? error.message : String(error)}`,
        suggestion: '检查目录权限或路径是否存在',
      };
    }
  }

  /** 格式化报告(CLI 表格字符串) */
  formatReport(results: ProbeResult[]): string {
    const lines: string[] = [];
    lines.push('=== RouteDev 健康检查报告 ===');

    // 表头(列宽:组件24 / 状态8 / 版本15 / 延迟10 / 诊断自适应)
    const header =
      '组件'.padEnd(24) +
      '状态'.padEnd(8) +
      '版本'.padEnd(15) +
      '延迟'.padEnd(10) +
      '诊断';
    lines.push(header);
    lines.push('-'.repeat(72));

    let okCount = 0;
    let abnormalCount = 0;

    for (const r of results) {
      const symbol = STATUS_SYMBOLS[r.status];
      const version = r.version ?? '-';
      const latency = r.latencyMs !== undefined ? `${r.latencyMs}ms` : '-';
      const message = r.message || STATUS_TEXT[r.status];

      lines.push(
        r.component.padEnd(24) +
        symbol.padEnd(8) +
        version.padEnd(15) +
        latency.padEnd(10) +
        message,
      );

      if (r.status === 'ok') {
        okCount++;
      } else {
        abnormalCount++;
      }
    }

    lines.push('-'.repeat(72));
    lines.push(`总计: ${results.length} 项, OK: ${okCount}, 异常: ${abnormalCount}`);

    return lines.join('\n');
  }
}
