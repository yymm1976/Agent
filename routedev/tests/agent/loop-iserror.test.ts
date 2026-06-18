// tests/agent/loop-iserror.test.ts
// Phase 29 Task 6：ReActAgentLoop isError 结构化判断测试

import { describe, it, expect } from 'vitest';

describe('ReActAgentLoop Phase 29 isError 结构化判断', () => {
  // 测试 isError 判断正则的逻辑
  // 原逻辑：includes('错误') 会误判"修复了3个错误"
  // 新逻辑：/\[工具错误\]|\[被拦截\]|\[error\]|Error:|failed to|无法|失败/

  const isErrorRegex = /\[工具错误\]|\[被拦截\]|\[error\]|Error:|failed to|无法|失败/;

  it('应识别 [工具错误] 标记', () => {
    expect(isErrorRegex.test('[工具错误] file_read: 文件不存在')).toBe(true);
  });

  it('应识别 [被拦截] 标记', () => {
    expect(isErrorRegex.test('[被拦截] 命令在黑名单中')).toBe(true);
  });

  it('应识别 Error: 前缀', () => {
    expect(isErrorRegex.test('Error: something went wrong')).toBe(true);
  });

  it('应识别 failed to 模式', () => {
    expect(isErrorRegex.test('failed to execute command')).toBe(true);
  });

  it('应识别"无法"关键词', () => {
    expect(isErrorRegex.test('无法读取文件')).toBe(true);
  });

  it('应识别"失败"关键词', () => {
    expect(isErrorRegex.test('操作失败')).toBe(true);
  });

  it('不应误判"修复了3个错误"（原 bug）', () => {
    expect(isErrorRegex.test('修复了3个错误')).toBe(false);
  });

  it('不应误判正常输出', () => {
    expect(isErrorRegex.test('文件内容如下：\nhello world')).toBe(false);
    expect(isErrorRegex.test('命令执行成功，退出码 0')).toBe(false);
  });

  it('不应误判包含"错误"但非错误的输出', () => {
    // "错误处理"是正常描述，不是错误
    expect(isErrorRegex.test('已添加错误处理逻辑')).toBe(false);
  });
});
