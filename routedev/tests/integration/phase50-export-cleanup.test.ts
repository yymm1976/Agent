// tests/integration/phase50-export-cleanup.test.ts
// Phase 50 Task 9：LOW 级别多余 export 清理验证
//
// 验证内容：
//   1. 清理后的源文件中，特定符号不再以 export 关键字声明
//   2. 清理后的模块公共 API 仍可正常导入（未误删必要的 export）
//
// 设计思路：
//   - 测试 1（spot-check）：读取源文件文本，用正则验证已清理符号的声明行不以 export 开头
//   - 测试 2（公共 API 完整性）：动态导入清理过的模块，验证保留的导出符号仍可访问

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 项目根目录（vitest run 从项目根执行）
const PROJECT_ROOT = process.cwd();

/**
 * 读取源文件内容
 * @param relPath 相对于项目根的路径（如 src/agent/hooks.ts）
 */
function readSourceFile(relPath: string): string {
  const fullPath = path.resolve(PROJECT_ROOT, relPath);
  return fs.readFileSync(fullPath, 'utf-8');
}

// ============================================================
// 测试 1：已清理符号不再以 export 声明（spot-check）
// ============================================================

/** 待验证的文件与符号映射（从全部 40+ 清理文件中抽样） */
const CLEANED_SAMPLES: Array<{ file: string; symbols: string[] }> = [
  // src/agent/memory/
  { file: 'src/agent/memory/graph.ts', symbols: ['ScoredNode', 'RecallResult', 'ForgetResult'] },
  { file: 'src/agent/memory/context-manager.ts', symbols: ['CompressionCallback', 'CompressEnhancedOptions'] },
  // src/agent/multi/
  { file: 'src/agent/multi/orchestrator-strategy.ts', symbols: ['OrchestrationStrategy', 'OrchestratorConfig'] },
  { file: 'src/agent/multi/score-card.ts', symbols: ['UserFeedback', 'AggregateStats'] },
  // src/agents/
  { file: 'src/agents/delegation-gate.ts', symbols: ['ActiveSubAgent', 'GateResult'] },
  { file: 'src/agents/profiles/types.ts', symbols: ['AgentOutputFormat', 'ChallengeSeverity'] },
  { file: 'src/agents/context-packer.ts', symbols: ['RelevantSymbol', 'ContextSection', 'ContextPackage'] },
  // src/skills/
  // E11 移除：skill-flow-types.ts 已整体删除（E3 清理：skill-flow-engine 上位替代已就位）
  // { file: 'src/skills/skill-flow-types.ts', symbols: ['FlowNodeType', 'Attractor', 'RunReactCallback', 'EvaluateBranchCallback'] },
  // src/router/
  { file: 'src/router/cache-optimizer.ts', symbols: ['CompactionAction'] },
  // src/cli/
  { file: 'src/cli/custom-commands.ts', symbols: ['RenderContext'] },
  { file: 'src/cli/tool-verb.ts', symbols: ['ToolFeedbackState'] },
  { file: 'src/cli/args.ts', symbols: ['CLIArgs'] },
  // src/agent/
  { file: 'src/agent/hooks.ts', symbols: ['StepError', 'HookHandler'] },
  { file: 'src/agent/preference-manager.ts', symbols: ['PreferenceCategory', 'UserPreference', 'AuditLogEntry'] },
  { file: 'src/agent/requirements-clarifier.ts', symbols: ['ClarificationQuestion', 'ClarificationResult', 'RequirementsClarifierOptions'] },
  { file: 'src/agent/voice-manager.ts', symbols: ['VoiceProvider', 'TTSProvider', 'TranscriptionResult'] },
  // E11 移除：durable-executor.ts 已整体删除（E1：GoalPersistence + CheckpointManager + HookRunner.fire 替代）
  { file: 'src/agent/goal-types.ts', symbols: ['GoalStepStatus'] },
  { file: 'src/agent/eq-detector.ts', symbols: ['EQState', 'EQAdjustment'] },
  { file: 'src/agent/persona-templates.ts', symbols: ['EmojiUsage', 'ConfirmationStyle'] },
];

describe('Phase 50 Task 9 - export 清理验证', () => {
  describe('已清理符号不再以 export 声明', () => {
    for (const { file, symbols } of CLEANED_SAMPLES) {
      for (const symbol of symbols) {
        it(`${file} 中 ${symbol} 不再以 export 声明`, () => {
          const content = readSourceFile(file);
          // 匹配 `export type X` 或 `export interface X`（行首，允许前面有注释）
          const pattern = new RegExp(`^export\\s+(type|interface)\\s+${symbol}\\b`, 'm');
          expect(content).not.toMatch(pattern);
        });
      }
    }
  });

  describe('公共 API 仍可正常导入', () => {
    it('delegation-gate 仍导出 DelegationGate 类和 DEFAULT_GATE_RULES', async () => {
      const mod = await import('../../src/agents/delegation-gate.js');
      expect(mod.DelegationGate).toBeDefined();
      expect(mod.DEFAULT_GATE_RULES).toBeDefined();
      expect(typeof mod.DelegationGate).toBe('function');
    });

    it('context-packer 仍导出 ContextPacker 类和 ROLE_WEIGHTS', async () => {
      const mod = await import('../../src/agents/context-packer.js');
      expect(mod.ContextPacker).toBeDefined();
      expect(mod.ROLE_WEIGHTS).toBeDefined();
      expect(typeof mod.ContextPacker).toBe('function');
    });

    it('skill-flow-types 模块已删除（不再断言公共 API）', async () => {
      // E11 更新：src/skills/skill-flow-types.ts 已整体删除
      // （E3 清理：skill-flow-engine 上位替代已就位）
      // 验证文件不存在即可，不再断言公共 API
      const fs = await import('node:fs/promises');
      await expect(fs.access('src/skills/skill-flow-types.ts')).rejects.toThrow();
    });

    it('cache-optimizer 仍导出 CompactionThresholds / DEFAULT_COMPACTION_THRESHOLDS / CacheStatsTracker', async () => {
      const mod = await import('../../src/router/cache-optimizer.js');
      expect(mod.DEFAULT_COMPACTION_THRESHOLDS).toBeDefined();
      expect(mod.CacheStatsTracker).toBeDefined();
      expect(typeof mod.CacheStatsTracker).toBe('function');
    });

    it('custom-commands 仍导出 loadCustomCommands / parseMarkdown / renderTemplate', async () => {
      const mod = await import('../../src/cli/custom-commands.js');
      expect(mod.loadCustomCommands).toBeDefined();
      expect(mod.parseMarkdown).toBeDefined();
      expect(mod.renderTemplate).toBeDefined();
      expect(typeof mod.loadCustomCommands).toBe('function');
    });

    it('args 仍导出 parseArgs / parseExecArgs / ExecArgs / ExecWorkMode', async () => {
      const mod = await import('../../src/cli/args.js');
      expect(mod.parseArgs).toBeDefined();
      expect(mod.parseExecArgs).toBeDefined();
      expect(typeof mod.parseArgs).toBe('function');
    });
  });
});
