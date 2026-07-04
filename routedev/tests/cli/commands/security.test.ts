// tests/cli/commands/security.test.ts
// /security 命令测试

import { describe, it, expect, beforeEach } from 'vitest';
import { securityCommand } from '../../../src/cli/commands/security.js';
import { auditPanel } from '../../../src/security/audit-panel.js';

describe('/security 命令', () => {
  beforeEach(() => {
    auditPanel.clear();
  });

  // ----------------------------------------------------------
  // /security（默认：显示摘要 + 最近事件）
  // ----------------------------------------------------------
  it('/security 默认显示摘要与最近事件', async () => {
    auditPanel.log({
      level: 'warn',
      source: 'sandbox',
      action: 'blocked',
      target: 'rm -rf /',
      reason: '危险命令',
    });

    const result = await securityCommand.handler('', {} as any);
    expect(result.type).toBe('handled');
    const msg = result.messages![0];
    expect(msg).toContain('安全审计摘要');
    expect(msg).toContain('总事件: 1');
    expect(msg).toContain('拦截: 1');
    expect(msg).toContain('sandbox=1');
    expect(msg).toContain('rm -rf /');
    expect(msg).toContain('sandbox/blocked');
    expect(msg).toContain('提示: /security clear');
  });

  it('/security 空面板也应返回结构化输出', async () => {
    const result = await securityCommand.handler('', {} as any);
    expect(result.type).toBe('handled');
    const msg = result.messages![0];
    expect(msg).toContain('总事件: 0');
    expect(msg).toContain('(暂无事件)');
  });

  it('/security 最多展示 20 条最近事件', async () => {
    for (let i = 0; i < 25; i++) {
      auditPanel.log({
        level: 'info',
        source: 'test',
        action: 'logged',
        target: `event-${i}`,
      });
    }
    const result = await securityCommand.handler('', {} as any);
    const msg = result.messages![0];
    expect(msg).toContain('总事件: 25');
    // event-0 ~ event-4 应被截断
    expect(msg).not.toContain('event-0');
    expect(msg).toContain('event-5');
    expect(msg).toContain('event-24');
  });

  // ----------------------------------------------------------
  // /security clear
  // ----------------------------------------------------------
  it('/security clear 清空所有事件', async () => {
    auditPanel.log({
      level: 'warn',
      source: 'sandbox',
      action: 'blocked',
      target: 'rm -rf /',
    });
    expect(auditPanel.getEvents().length).toBe(1);

    const result = await securityCommand.handler('clear', {} as any);
    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('已清空');
    expect(auditPanel.getEvents().length).toBe(0);
  });

  // ----------------------------------------------------------
  // /security report
  // ----------------------------------------------------------
  it('/security report 导出完整文本报告', async () => {
    auditPanel.log({
      level: 'critical',
      source: 'mcp-scanner',
      action: 'blocked',
      target: 'evil_tool',
      reason: 'poisoning',
    });

    const result = await securityCommand.handler('report', {} as any);
    expect(result.type).toBe('handled');
    const msg = result.messages![0];
    expect(msg).toContain('安全审计报告');
    expect(msg).toContain('总事件: 1');
    expect(msg).toContain('拦截: 1');
    expect(msg).toContain('mcp-scanner=1');
    expect(msg).toContain('critical=1');
    expect(msg).toContain('evil_tool');
    expect(msg).toContain('mcp-scanner/blocked');
  });

  // ----------------------------------------------------------
  // 子命令参数容错
  // ----------------------------------------------------------
  it('子命令大小写不敏感（CLEAR 等价于 clear）', async () => {
    auditPanel.log({
      level: 'info',
      source: 'a',
      action: 'logged',
      target: 't1',
    });
    const result = await securityCommand.handler('CLEAR', {} as any);
    expect(result.messages![0]).toContain('已清空');
    expect(auditPanel.getEvents().length).toBe(0);
  });

  it('未知子命令回退到默认摘要展示', async () => {
    auditPanel.log({
      level: 'info',
      source: 'a',
      action: 'logged',
      target: 't1',
    });
    const result = await securityCommand.handler('unknown-subcommand', {} as any);
    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('安全审计摘要');
    expect(result.messages![0]).toContain('总事件: 1');
  });

  // ----------------------------------------------------------
  // 命令元数据
  // ----------------------------------------------------------
  it('命令名应为 security', () => {
    expect(securityCommand.name).toBe('security');
  });

  it('命令应有描述', () => {
    expect(securityCommand.description.length).toBeGreaterThan(0);
  });
});
