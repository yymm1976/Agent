// tests/cli/doctor.test.ts
// Doctor 探测器与 /doctor 命令测试
// 测试项:
// 1. node 命令探测返回 ok 且 version 包含 v
// 2. 不存在的命令探测返回 missing
// 3. formatReport 输出包含表格格式与标题
// 4. probeTimeout 超时返回 timeout 状态(用慢 node 命令真实触发)
// 5. handleDoctorCommand 集成测试
// 6. MCP/目录/Provider 探测补充覆盖

import { describe, it, expect } from 'vitest';
import { Doctor } from '../../src/cli/doctor.js';
import type { ProbeResult } from '../../src/cli/doctor.js';
import { handleDoctorCommand } from '../../src/cli/commands/doctor.js';

// ============================================================
// 1. 本地工具探测: node
// ============================================================

describe('Doctor: 本地工具探测', () => {
  it('node 命令探测返回 ok 且 version 包含 v', async () => {
    const doctor = new Doctor();
    const results = await doctor.runAllChecks();
    const nodeResult = results.find((r) => r.component === 'node');
    expect(nodeResult).toBeDefined();
    expect(nodeResult!.status).toBe('ok');
    expect(nodeResult!.version).toBeTruthy();
    expect(nodeResult!.version!).toContain('v');
  });

  it('不存在的命令(nonexistent-cmd-xxx)探测返回 missing', () => {
    const doctor = new Doctor();
    const result = doctor.probeToolVersion('nonexistent-cmd-xxx', ['--version']);
    expect(result.status).toBe('missing');
    expect(result.component).toBe('nonexistent-cmd-xxx');
    expect(result.suggestion).toContain('nonexistent-cmd-xxx');
  });
});

// ============================================================
// 2. formatReport 报告格式
// ============================================================

describe('Doctor: formatReport', () => {
  it('输出包含表格格式与 "=== RouteDev 健康检查报告 ===" 标题', () => {
    const doctor = new Doctor();
    const results: ProbeResult[] = [
      { component: 'node', status: 'ok', version: 'v22.16.0', latencyMs: 12, message: 'OK' },
      { component: 'pnpm', status: 'ok', version: '11.0.0', latencyMs: 15, message: 'OK' },
      {
        component: 'git',
        status: 'missing',
        message: '命令未找到: git',
        suggestion: '请安装 git',
      },
    ];
    const report = doctor.formatReport(results);

    // 标题
    expect(report).toContain('=== RouteDev 健康检查报告 ===');
    // 表头列名
    expect(report).toContain('组件');
    expect(report).toContain('状态');
    expect(report).toContain('版本');
    expect(report).toContain('延迟');
    expect(report).toContain('诊断');
    // 数据行
    expect(report).toContain('node');
    expect(report).toContain('v22.16.0');
    expect(report).toContain('✓');
    expect(report).toContain('✗');
    // 分隔线与汇总
    expect(report).toMatch(/-{10,}/);
    expect(report).toContain('总计: 3 项');
    expect(report).toContain('OK: 2');
    expect(report).toContain('异常: 1');
  });

  it('空结果列表也输出标题与汇总', () => {
    const doctor = new Doctor();
    const report = doctor.formatReport([]);
    expect(report).toContain('=== RouteDev 健康检查报告 ===');
    expect(report).toContain('总计: 0 项');
    expect(report).toContain('OK: 0');
    expect(report).toContain('异常: 0');
  });
});

// ============================================================
// 3. 超时探测
// ============================================================

describe('Doctor: probeTimeout 超时', () => {
  it('设置极短超时探测慢 node 命令返回 timeout 状态', () => {
    // 用 node 执行一个休眠 5 秒的脚本,probeTimeout 设为 50ms 触发超时
    // 测试环境本身有 node,真实触发 spawnSync timeout
    const doctor = new Doctor({ probeTimeout: 50 });
    const result = doctor.probeToolVersion('node', [
      '-e',
      'setTimeout(()=>{}, 5000)',
    ]);
    expect(result.status).toBe('timeout');
    expect(result.component).toBe('node');
    expect(result.message).toContain('超时');
    expect(result.latencyMs).toBeGreaterThanOrEqual(40); // 至少接近 50ms
    expect(result.latencyMs).toBeLessThan(2000); // 不应超过 2 秒
  });
});

// ============================================================
// 4. handleDoctorCommand 集成测试
// ============================================================

describe('handleDoctorCommand', () => {
  it('运行探测并返回包含标题的报告字符串', async () => {
    const doctor = new Doctor();
    const report = await handleDoctorCommand(doctor);
    expect(typeof report).toBe('string');
    expect(report).toContain('=== RouteDev 健康检查报告 ===');
    expect(report).toContain('node');
    // 包含配置完整性占位项
    expect(report).toContain('config-integrity');
    // 包含总计行
    expect(report).toContain('总计:');
  });
});

// ============================================================
// 5. 补充探测:MCP / 目录 / Provider
// ============================================================

describe('Doctor: 补充探测', () => {
  it('MCP Server command 为空返回 missing', () => {
    const doctor = new Doctor();
    const result = doctor.probeMcpServer({ id: 'empty-srv', command: '' });
    expect(result.status).toBe('missing');
    expect(result.component).toBe('mcp:empty-srv');
    expect(result.suggestion).toContain('empty-srv');
  });

  it('MCP Server command 非空返回 ok', () => {
    const doctor = new Doctor();
    const result = doctor.probeMcpServer({ id: 'fs-srv', command: 'npx' });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('npx');
  });

  it('目录可读写返回 ok', () => {
    const doctor = new Doctor();
    // 当前工作目录应该可读写
    const result = doctor.probeDirectory(process.cwd());
    expect(result.status).toBe('ok');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('不存在的目录返回 broken', () => {
    const doctor = new Doctor();
    const result = doctor.probeDirectory('Z:/no/such/dir/exists/__test__');
    expect(result.status).toBe('broken');
    expect(result.message).toContain('不可访问');
  });

  it('runAllChecks 包含 providers/mcpServers/cwd 上下文探测', async () => {
    const doctor = new Doctor(
      { probeTimeout: 1000 },
      {
        providers: [{ id: 'unreachable', baseUrl: 'http://127.0.0.1:1/__nope__' }],
        mcpServers: [
          { id: 'ok-srv', command: 'npx' },
          { id: 'empty-srv', command: '' },
        ],
        cwd: process.cwd(),
      },
    );
    const results = await doctor.runAllChecks();
    const components = results.map((r) => r.component);

    // 默认 3 个工具
    expect(components).toContain('node');
    expect(components).toContain('pnpm');
    expect(components).toContain('git');
    // Provider
    expect(components).toContain('provider:unreachable');
    const providerResult = results.find((r) => r.component === 'provider:unreachable');
    expect(['broken', 'timeout']).toContain(providerResult!.status);
    // MCP
    expect(components).toContain('mcp:ok-srv');
    expect(components).toContain('mcp:empty-srv');
    // 目录
    expect(components).toContain(`dir:${process.cwd()}`);
    // 配置完整性占位
    expect(components).toContain('config-integrity');
  });
});
