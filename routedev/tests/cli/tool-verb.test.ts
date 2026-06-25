// tests/cli/tool-verb.test.ts
// Phase 34 Task 3：动作动词体系测试

import { describe, it, expect } from 'vitest';
import {
  formatToolFeedback,
  getToolRunningMessageId,
  TOOL_RUNNING_PREFIX,
} from '../../src/cli/tool-verb.js';

describe('formatToolFeedback', () => {
  it('file_read 执行中显示进行时', () => {
    const text = formatToolFeedback('file_read', 'running', { path: 'config.json' });
    expect(text).toContain('读取');
    expect(text).toContain('config.json');
    expect(text).toContain('...');
  });

  it('file_read 完成后显示过去时', () => {
    const text = formatToolFeedback('file_read', 'completed', { path: 'config.json' }, 'content');
    expect(text).toContain('已读取');
    expect(text).toContain('config.json');
  });

  it('file_read 失败后显示错误过去时', () => {
    const text = formatToolFeedback('file_read', 'completed', { path: 'secret.txt' }, '权限不足', true);
    expect(text).toContain('读取失败');
    expect(text).toContain('权限不足');
  });

  it('file_edit 显示 +n/-n 外的基本信息', () => {
    const text = formatToolFeedback('file_edit', 'completed', { path: 'utils.py' }, '完成');
    expect(text).toContain('已修改');
    expect(text).toContain('utils.py');
  });

  it('shell_exec 执行中显示运行命令', () => {
    const text = formatToolFeedback('shell_exec', 'running', { command: 'npm test' });
    expect(text).toContain('运行');
    expect(text).toContain('npm test');
  });

  it('未知工具使用兜底动词', () => {
    const text = formatToolFeedback('mcp:custom_tool', 'running', { foo: 'bar' });
    expect(text).toContain('调用');
    expect(text).toContain('...');
  });

  it('minimal 模式下完成后不展示结果后缀', () => {
    const text = formatToolFeedback('file_search', 'completed', { query: 'auth' }, '找到 5 个结果', false, 'minimal');
    expect(text).not.toContain('找到 5 个结果');
  });

  it('standard 模式下展示一行结果摘要', () => {
    const text = formatToolFeedback('code_search', 'completed', { pattern: 'class' }, '找到 3 处匹配\nline1\nline2', false, 'standard');
    expect(text).toContain('找到 3 处匹配');
  });

  it('completed + isError 自动映射到 failed 状态', () => {
    const text = formatToolFeedback('file_write', 'completed', { path: 'x.ts' }, '磁盘满', true);
    expect(text).toContain('写入失败');
  });

  it('路径参数过长时自动截断', () => {
    const longPath = 'a/'.repeat(50) + 'file.ts';
    const text = formatToolFeedback('file_read', 'running', { path: longPath });
    expect(text.length).toBeLessThan(longPath.length + 10);
    expect(text).toContain('...');
  });
});

describe('工具运行消息 ID', () => {
  it('getToolRunningMessageId 生成固定前缀', () => {
    expect(getToolRunningMessageId('call-123')).toBe(`${TOOL_RUNNING_PREFIX}call-123`);
  });
});
