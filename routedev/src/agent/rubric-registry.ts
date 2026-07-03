import type { VerifierRubric } from './adversarial-verifier.js';

export const BUILTIN_RUBRICS: VerifierRubric[] = [
  {
    id: 'security-audit',
    taskType: 'security-audit',
    checks: [
      { description: '是否存在硬编码密钥、API Key 或凭证', severity: 'critical' },
      { description: '是否存在命令注入或 SQL 注入风险', severity: 'critical' },
      { description: '是否存在 SSRF（服务端请求伪造）风险', severity: 'critical' },
      { description: '是否存在权限提升或越权访问风险', severity: 'critical' },
    ],
  },
  {
    id: 'refactor',
    taskType: 'refactor',
    checks: [
      { description: '重构后行为是否与原来保持一致（无功能变更）', severity: 'major' },
      { description: '是否未引入新的公共 API 或破坏性变更', severity: 'major' },
      { description: '现有测试是否仍然通过', severity: 'minor' },
      { description: '命名是否更清晰、代码是否更易读', severity: 'minor' },
    ],
  },
  {
    id: 'new-feature',
    taskType: 'new-feature',
    checks: [
      { description: '是否覆盖了所有验收标准', severity: 'major' },
      { description: '是否处理了边界情况（空值、超长输入、并发等）', severity: 'major' },
      { description: '是否有完善的错误处理', severity: 'major' },
      { description: '是否有对应的测试覆盖', severity: 'major' },
    ],
  },
  {
    id: 'bug-fix',
    taskType: 'bug-fix',
    checks: [
      { description: '是否能复现原始 bug 的路径并验证修复', severity: 'major' },
      { description: '是否找到并修复了根本原因（而非症状）', severity: 'major' },
      { description: '是否有针对该 bug 的回归测试', severity: 'major' },
      { description: '修复是否引入了副作用或破坏其他功能', severity: 'major' },
    ],
  },
];

export class RubricRegistry {
  private readonly rubrics: Map<string, VerifierRubric>;

  constructor(builtins: VerifierRubric[] = BUILTIN_RUBRICS) {
    this.rubrics = new Map(builtins.map((r) => [r.taskType, r]));
  }

  get(taskType: string): VerifierRubric | undefined {
    return this.rubrics.get(taskType);
  }

  register(rubric: VerifierRubric): void {
    this.rubrics.set(rubric.taskType, rubric);
  }

  listTaskTypes(): string[] {
    return Array.from(this.rubrics.keys());
  }
}
