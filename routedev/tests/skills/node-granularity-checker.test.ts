// tests/skills/node-granularity-checker.test.ts
// 节点粒度检查器单元测试（Phase 49 Task 1.9）
//
// 测试策略：
//   - 构造 step 节点（含/不含粒度问题关键词）
//   - 验证 too-coarse / too-fine 警告被正确触发
//   - 验证正常节点不报警
//   - 验证非 step 节点不检查

import { describe, it, expect } from 'vitest';
import { NodeGranularityChecker } from '../../src/skills/node-granularity-checker.js';
import type { FlowNode } from '../../src/skills/skill-flow-types.js';

describe('NodeGranularityChecker（Phase 49 Task 1.9）', () => {
  describe('too-coarse 检测', () => {
    it('prompt 含"重构整个"时报警 too-coarse', () => {
      const node: FlowNode = {
        id: 'step1',
        type: 'step',
        title: '重构',
        prompt: '重构整个认证模块，确保所有边界情况都处理',
        onFailure: 'abort',
      };

      const warnings = NodeGranularityChecker.check(node);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].level).toBe('too-coarse');
      expect(warnings[0].nodeId).toBe('step1');
      expect(warnings[0].message).toContain('过粗');
    });

    it('prompt 含"重写所有"时报警 too-coarse', () => {
      const node: FlowNode = {
        id: 'step1',
        type: 'step',
        title: '重写',
        prompt: '重写所有 API 接口',
        onFailure: 'abort',
      };

      const warnings = NodeGranularityChecker.check(node);

      expect(warnings.some((w) => w.level === 'too-coarse')).toBe(true);
    });

    it('prompt 含"全面"时报警 too-coarse', () => {
      const node: FlowNode = {
        id: 'step1',
        type: 'step',
        title: '全面改造',
        prompt: '全面改造数据库层',
        onFailure: 'abort',
      };

      const warnings = NodeGranularityChecker.check(node);

      expect(warnings.some((w) => w.level === 'too-coarse')).toBe(true);
    });
  });

  describe('too-fine 检测', () => {
    it('prompt 含"运行命令"且无 allowedTools 时报警 too-fine', () => {
      const node: FlowNode = {
        id: 'step1',
        type: 'step',
        title: '运行命令',
        prompt: '运行构建命令并检查输出',
        onFailure: 'abort',
        // 注意：无 allowedTools
      };

      const warnings = NodeGranularityChecker.check(node);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].level).toBe('too-fine');
      expect(warnings[0].nodeId).toBe('step1');
      expect(warnings[0].message).toContain('过细');
    });

    it('prompt 含"执行脚本"且无 allowedTools 时报警 too-fine', () => {
      const node: FlowNode = {
        id: 'step1',
        type: 'step',
        title: '执行脚本',
        prompt: '执行部署脚本',
        onFailure: 'abort',
      };

      const warnings = NodeGranularityChecker.check(node);

      expect(warnings.some((w) => w.level === 'too-fine')).toBe(true);
    });

    it('prompt 含"运行命令"但配置了 allowedTools 时不报警 too-fine', () => {
      const node: FlowNode = {
        id: 'step1',
        type: 'step',
        title: '运行命令',
        prompt: '运行构建命令',
        onFailure: 'abort',
        allowedTools: ['shell_exec'],
      };

      const warnings = NodeGranularityChecker.check(node);

      expect(warnings.some((w) => w.level === 'too-fine')).toBe(false);
    });
  });

  describe('正常节点', () => {
    it('粒度合理的 step 节点不报警', () => {
      const node: FlowNode = {
        id: 'step1',
        type: 'step',
        title: '实现登录',
        prompt: '实现用户登录功能，包含表单验证和错误处理',
        onFailure: 'abort',
        allowedTools: ['file_write', 'file_edit'],
      };

      const warnings = NodeGranularityChecker.check(node);

      expect(warnings).toHaveLength(0);
    });
  });

  describe('非 step 节点', () => {
    it('checkpoint 节点不检查粒度', () => {
      const node: FlowNode = {
        id: 'check1',
        type: 'checkpoint',
        title: '检查',
        prompt: '重构整个模块', // 即使含粗粒度关键词也不检查
        onFailure: 'abort',
        checkCondition: { kind: 'regex-match', pattern: 'success' },
      };

      const warnings = NodeGranularityChecker.check(node);

      expect(warnings).toHaveLength(0);
    });

    it('user-gate 节点不检查粒度', () => {
      const node: FlowNode = {
        id: 'gate1',
        type: 'user-gate',
        title: '确认',
        prompt: '运行命令', // 即使含细粒度关键词也不检查
        onFailure: 'abort',
        gateMessage: '确认继续？',
      };

      const warnings = NodeGranularityChecker.check(node);

      expect(warnings).toHaveLength(0);
    });
  });

  describe('checkAll 批量检查', () => {
    it('批量检查多个节点汇总警告', () => {
      const nodes: FlowNode[] = [
        {
          id: 'step1',
          type: 'step',
          title: '粗粒度步骤',
          prompt: '重构整个系统',
          onFailure: 'abort',
        },
        {
          id: 'step2',
          type: 'step',
          title: '正常步骤',
          prompt: '实现具体功能',
          onFailure: 'abort',
          allowedTools: ['file_write'],
        },
        {
          id: 'step3',
          type: 'step',
          title: '细粒度步骤',
          prompt: '运行测试命令',
          onFailure: 'abort',
        },
      ];

      const warnings = NodeGranularityChecker.checkAll(nodes);

      expect(warnings).toHaveLength(2);
      expect(warnings.some((w) => w.nodeId === 'step1' && w.level === 'too-coarse')).toBe(true);
      expect(warnings.some((w) => w.nodeId === 'step3' && w.level === 'too-fine')).toBe(true);
    });
  });
});
