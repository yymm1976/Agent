// tests/skills/model-drift-detector.test.ts
// 模型漂移检测器单元测试（Phase 49 Task 3.6）
//
// 测试策略：
//   - 构造 ParsedSkill（metadata 含 lastValidatedModel 扩展字段）
//   - 验证模型版本变更时标记 Skill 为待重新校验
//   - 验证跨主版本升级标记为 high 严重度
//   - 验证同主版本小升级标记为 low 严重度
//   - 验证未记录 lastValidatedModel 时标记为 high

import { describe, it, expect } from 'vitest';
import { ModelDriftDetector } from '../../src/skills/model-drift-detector.js';
import type { ParsedSkill } from '../../src/skills/skill-md-parser.js';
import type { SkillMetadataWithDrift } from '../../src/skills/skill-metadata-extension.js';

/** 构造 Skill（含 lastValidatedModel 扩展字段） */
function makeSkill(name: string, lastValidatedModel?: string): ParsedSkill {
  const metadata: SkillMetadataWithDrift = {
    name,
    description: 'a skill for drift detection testing',
    version: '1.0.0',
    author: 't',
    tags: [],
    lastValidatedModel,
  };
  return { metadata, content: '', format: 'skill-md' };
}

describe('ModelDriftDetector (Phase 49 Task 3.6)', () => {
  it('模型版本变更时标记 Skill 为待重新校验', () => {
    const detector = new ModelDriftDetector();
    const skills = [
      makeSkill('skill-a', 'gpt-4-0613'), // 匹配当前版本，不漂移
      makeSkill('skill-b', 'gpt-4-1106'), // 版本不一致，漂移
    ];
    const drifts = detector.detectDrift(skills, 'gpt-4-0613');

    expect(drifts).toHaveLength(1);
    expect(drifts[0].skillName).toBe('skill-b');
    expect(drifts[0].lastValidatedModel).toBe('gpt-4-1106');
    expect(drifts[0].currentModelVersion).toBe('gpt-4-0613');
  });

  it('跨主版本升级标记为 high 严重度', () => {
    // 使用 X.Y.Z 语义化版本格式（assessDriftSeverity 按 '.' 分割提取主版本号）
    const detector = new ModelDriftDetector();
    const skills = [makeSkill('skill-a', '3.5.0')];
    const drifts = detector.detectDrift(skills, '4.0.0');

    expect(drifts).toHaveLength(1);
    expect(drifts[0].severity).toBe('high');
  });

  it('同主版本小升级标记为 low 严重度', () => {
    // 使用 X.Y.Z 语义化版本格式（同主版本号 4 → low）
    const detector = new ModelDriftDetector();
    const skills = [makeSkill('skill-a', '4.0.0')];
    const drifts = detector.detectDrift(skills, '4.1.0');

    expect(drifts).toHaveLength(1);
    expect(drifts[0].severity).toBe('low');
  });

  it('未记录 lastValidatedModel 时标记为 high', () => {
    const detector = new ModelDriftDetector();
    const skills = [makeSkill('skill-a')]; // 不传 lastValidatedModel
    const drifts = detector.detectDrift(skills, 'gpt-4-0613');

    expect(drifts).toHaveLength(1);
    expect(drifts[0].severity).toBe('high');
    expect(drifts[0].lastValidatedModel).toBe('unknown');
  });

  it('所有 Skill 模型版本匹配时返回空数组', () => {
    const detector = new ModelDriftDetector();
    const skills = [
      makeSkill('skill-a', 'gpt-4-0613'),
      makeSkill('skill-b', 'gpt-4-0613'),
    ];
    const drifts = detector.detectDrift(skills, 'gpt-4-0613');

    expect(drifts).toHaveLength(0);
  });
});
