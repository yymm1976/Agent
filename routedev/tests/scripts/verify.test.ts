// tests/scripts/verify.test.ts
// 验证 Phase 17b 验收门脚本 verify.ts 的正确性

import { describe, it, expect } from 'vitest';
import {
  formatReport,
  runAllChecks,
  checkAppLineCount,
  checkNoSwitchBlock,
  checkCommandFiles,
  checkPhase17bModules,
  type CheckResult,
  type VerifyReport,
} from '../../scripts/verify.js';

describe('verify.ts 模块', () => {
  it('能被正常 import（导出成员可访问）', () => {
    // 验证导出的函数和类型存在
    expect(typeof formatReport).toBe('function');
    expect(typeof runAllChecks).toBe('function');
    expect(typeof checkAppLineCount).toBe('function');
  });

  describe('formatReport 输出格式', () => {
    it('通过的检查输出 ✅', () => {
      const report: VerifyReport = {
        results: [
          { index: 1, name: '测试项', passed: true, detail: '通过' },
        ],
        passed: 1,
        total: 1,
        allPassed: true,
      };
      const output = formatReport(report);
      expect(output).toContain('✅');
      expect(output).not.toContain('❌');
    });

    it('失败的检查输出 ❌', () => {
      const report: VerifyReport = {
        results: [
          { index: 1, name: '测试项', passed: false, detail: '失败' },
        ],
        passed: 0,
        total: 1,
        allPassed: false,
      };
      const output = formatReport(report);
      expect(output).toContain('❌');
    });

    it('包含汇总行', () => {
      const report: VerifyReport = {
        results: [
          { index: 1, name: '测试项', passed: true, detail: '通过' },
          { index: 2, name: '测试项2', passed: false, detail: '失败' },
        ],
        passed: 1,
        total: 2,
        allPassed: false,
      };
      const output = formatReport(report);
      expect(output).toContain('汇总: 1/2 通过');
    });
  });

  describe('单项检查函数返回正确结构', () => {
    it('checkAppLineCount 返回 CheckResult 结构', async () => {
      const result = await checkAppLineCount();
      // 验证结构字段
      expect(result).toHaveProperty('index');
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('detail');
      // 验证字段类型
      expect(typeof result.index).toBe('number');
      expect(typeof result.name).toBe('string');
      expect(typeof result.passed).toBe('boolean');
      expect(typeof result.detail).toBe('string');
      // 验证内容
      expect(result.index).toBe(1);
      expect(result.name).toContain('App.tsx');
    });

    it('checkNoSwitchBlock 返回 CheckResult 结构', async () => {
      const result = await checkNoSwitchBlock();
      expect(result.index).toBe(2);
      expect(typeof result.passed).toBe('boolean');
      expect(result.detail.length).toBeGreaterThan(0);
    });

    it('checkCommandFiles 返回 CheckResult 结构', async () => {
      const result = await checkCommandFiles();
      expect(result.index).toBe(3);
      expect(typeof result.passed).toBe('boolean');
    });

    it('checkPhase17bModules 返回 CheckResult 结构', async () => {
      const result = await checkPhase17bModules();
      expect(result.index).toBe(8);
      expect(typeof result.passed).toBe('boolean');
    });
  });

  describe('runAllChecks（跳过测试套件）', () => {
    it('返回包含 9 项检查的 VerifyReport', async () => {
      const report = await runAllChecks({ skipTestSuite: true });
      expect(report.results).toHaveLength(9);
      expect(report.total).toBe(9);
      expect(report.passed).toBeGreaterThanOrEqual(0);
      expect(report.passed).toBeLessThanOrEqual(9);
      expect(report.allPassed).toBe(report.passed === report.total);
    });

    it('每项结果都有正确的 CheckResult 结构', async () => {
      const report = await runAllChecks({ skipTestSuite: true });
      for (const result of report.results) {
        expect(result).toHaveProperty('index');
        expect(result).toHaveProperty('name');
        expect(result).toHaveProperty('passed');
        expect(result).toHaveProperty('detail');
        expect(typeof result.passed).toBe('boolean');
      }
    });

    it('序号从 1 到 8 连续（含 10 = description lint）', async () => {
      const report = await runAllChecks({ skipTestSuite: true });
      const indices = report.results.map((r) => r.index);
      // Phase 47 Task 2 新增 checkDescriptionLint（index=10），插入到 checkTestSuite 之前
      expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10]);
    });
  });
});
