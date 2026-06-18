// tests/tools/command-parser.test.ts
// Phase 29 Task 6：command-parser 单元测试
// 覆盖：tokenize 正常、引号、管道、命令替换、重定向

import { describe, it, expect } from 'vitest';
import { parseCommand } from '../../src/tools/command-parser.js';

describe('parseCommand', () => {
  it('应正确解析简单命令', () => {
    const result = parseCommand('rm -rf /');
    expect(result.command).toBe('rm');
    expect(result.args).toEqual(['-rf', '/']);
    expect(result.hasPipe).toBe(false);
    expect(result.hasSubstitution).toBe(false);
    expect(result.hasRedirect).toBe(false);
  });

  it('应正确解析带引号的参数', () => {
    const result = parseCommand('rm -rf "/"');
    expect(result.command).toBe('rm');
    // 引号被去除
    expect(result.args).toEqual(['-rf', '/']);
  });

  it('应正确解析单引号包裹的参数', () => {
    const result = parseCommand("rm -rf '/'");
    expect(result.command).toBe('rm');
    expect(result.args).toEqual(['-rf', '/']);
  });

  it('应检测管道符号', () => {
    const result = parseCommand('ls | grep test');
    expect(result.command).toBe('ls');
    expect(result.hasPipe).toBe(true);
  });

  it('应检测命令替换 $()', () => {
    const result = parseCommand('echo $(whoami)');
    expect(result.command).toBe('echo');
    expect(result.hasSubstitution).toBe(true);
  });

  it('应检测命令替换反引号', () => {
    const result = parseCommand('echo `whoami`');
    expect(result.command).toBe('echo');
    expect(result.hasSubstitution).toBe(true);
  });

  it('应检测重定向', () => {
    const result = parseCommand('echo hello > file.txt');
    expect(result.command).toBe('echo');
    expect(result.hasRedirect).toBe(true);
  });

  it('应检测追加重定向', () => {
    const result = parseCommand('echo hello >> file.txt');
    expect(result.command).toBe('echo');
    expect(result.hasRedirect).toBe(true);
  });

  it('应处理空命令', () => {
    const result = parseCommand('');
    expect(result.command).toBe('');
    expect(result.args).toEqual([]);
  });

  it('应处理只有空格的命令', () => {
    const result = parseCommand('   ');
    expect(result.command).toBe('');
    expect(result.args).toEqual([]);
  });

  it('应保留原始命令字符串', () => {
    const raw = 'rm -rf /';
    const result = parseCommand(raw);
    expect(result.raw).toBe(raw);
  });

  it('引号内的管道不应被标记为 hasPipe', () => {
    const result = parseCommand('echo "a | b"');
    expect(result.hasPipe).toBe(false);
  });

  it('应处理多参数命令', () => {
    const result = parseCommand('git commit -m "fix: update" --no-verify');
    expect(result.command).toBe('git');
    expect(result.args).toEqual(['commit', '-m', 'fix: update', '--no-verify']);
  });
});
