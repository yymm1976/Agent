// tests/agent/handoff.test.ts
// Handoff 文件生成与保存单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { renderHandoff, saveHandoff, type HandoffData } from '../../src/agent/handoff.js';

function makeData(overrides: Partial<HandoffData> = {}): HandoffData {
  return {
    currentGoal: '完成 Phase 17b',
    completedSteps: ['Task 8 中间件', 'Task 9 工具响应'],
    nextAction: '运行 typecheck',
    constraints: ['不修改 loop.ts', '注释用中文'],
    workingFiles: ['src/agent/middleware.ts', 'src/tools/executor.ts'],
    openQuestions: ['是否需要集成到 loop？'],
    timestamp: 1718664000000,
    ...overrides,
  };
}

describe('renderHandoff', () => {
  it('输出包含所有章节标题', () => {
    const out = renderHandoff(makeData());
    expect(out).toContain('# Handoff —');
    expect(out).toContain('## 当前目标');
    expect(out).toContain('## 已完成');
    expect(out).toContain('## 下一步');
    expect(out).toContain('## 约束与发现');
    expect(out).toContain('## 工作文件');
    expect(out).toContain('## 未解决问题');
  });

  it('输出包含时间戳（ISO 格式）', () => {
    const ts = 1718664000000;
    const out = renderHandoff(makeData({ timestamp: ts }));
    expect(out).toContain(new Date(ts).toISOString());
  });

  it('输出包含各字段内容', () => {
    const out = renderHandoff(makeData());
    expect(out).toContain('完成 Phase 17b');
    expect(out).toContain('- Task 8 中间件');
    expect(out).toContain('- Task 9 工具响应');
    expect(out).toContain('运行 typecheck');
    expect(out).toContain('- 不修改 loop.ts');
    expect(out).toContain('- src/agent/middleware.ts');
    expect(out).toContain('- 是否需要集成到 loop？');
  });

  it('空数组时章节为空但仍显示标题', () => {
    const out = renderHandoff(
      makeData({
        completedSteps: [],
        constraints: [],
        workingFiles: [],
        openQuestions: [],
      }),
    );
    // 标题仍存在
    expect(out).toContain('## 已完成');
    expect(out).toContain('## 约束与发现');
    expect(out).toContain('## 工作文件');
    expect(out).toContain('## 未解决问题');
    // 不应包含列表项前缀（在对应章节内）
    // 通过检查章节标题后到下一个标题之间没有 "- " 列表项
    const completedSection = out.split('## 已完成')[1].split('##')[0];
    expect(completedSection.trim()).toBe('');
  });

  it('空数组时所有章节标题仍然存在', () => {
    const out = renderHandoff(
      makeData({
        completedSteps: [],
        constraints: [],
        workingFiles: [],
        openQuestions: [],
      }),
    );
    const sections = [
      '## 当前目标',
      '## 已完成',
      '## 下一步',
      '## 约束与发现',
      '## 工作文件',
      '## 未解决问题',
    ];
    for (const s of sections) {
      expect(out).toContain(s);
    }
  });
});

describe('saveHandoff', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-handoff-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('写入 HANDOFF.md 文件成功', async () => {
    const data = makeData();
    const filePath = await saveHandoff(data, tempDir);

    expect(filePath).toBe(path.join(tempDir, 'HANDOFF.md'));

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('# Handoff —');
    expect(content).toContain('## 当前目标');
    expect(content).toContain('完成 Phase 17b');
  });

  it('返回正确的文件路径', async () => {
    const filePath = await saveHandoff(makeData(), tempDir);
    expect(filePath.endsWith('HANDOFF.md')).toBe(true);
  });

  it('文件内容与 renderHandoff 输出一致', async () => {
    const data = makeData();
    const expected = renderHandoff(data);
    const filePath = await saveHandoff(data, tempDir);
    const actual = await fs.readFile(filePath, 'utf-8');
    expect(actual).toBe(expected);
  });
});
