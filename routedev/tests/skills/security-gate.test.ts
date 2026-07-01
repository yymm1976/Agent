// tests/skills/security-gate.test.ts
// 技能安全扫描门控单元测试（Phase 53 Task 6）
//
// 测试策略：
//   - 17 类漏洞规则至少测 3 类（command_injection / path_traversal / xss）
//   - 风险评分递减（同规则多次匹配 0.5x → 0.25x → 0.1x）
//   - 自动安装阈值（score <= autoInstallThreshold）
//   - 基线抑制（命中基线的发现 severity 降一级）
//   - 诚实记账字段（scanMode / llm* 永远为 static-only / false）

import { describe, it, expect } from 'vitest';
import {
  SkillSecurityGate,
} from '../../src/skills/security-gate.js';
import type {
  SkillSecurityFinding,
} from '../../src/skills/security-gate.js';

describe('SkillSecurityGate (Phase 53 Task 6)', () => {
  // ----------------------------------------------------------
  // 测试 1：漏洞规则覆盖（至少 3 类）
  // ----------------------------------------------------------
  it('应正确检测命令注入（critical）、路径穿越（high）、XSS（high）三类漏洞', () => {
    const gate = new SkillSecurityGate();
    const content = [
      'const data = eval(input);',
      "const path = '../../etc/passwd';",
      "const html = '<script>alert(1)</script>';",
    ].join('\n');
    const result = gate.scan('test-skill', content);

    const rules = new Set(result.findings.map((f) => f.rule));
    expect(rules.has('command_injection')).toBe(true);
    expect(rules.has('path_traversal')).toBe(true);
    expect(rules.has('xss')).toBe(true);

    const cmd = result.findings.find((f) => f.rule === 'command_injection');
    expect(cmd?.severity).toBe('critical');
    const path = result.findings.find((f) => f.rule === 'path_traversal');
    expect(path?.severity).toBe('high');
    const xss = result.findings.find((f) => f.rule === 'xss');
    expect(xss?.severity).toBe('high');
  });

  // ----------------------------------------------------------
  // 测试 2：风险评分递减（同规则多次匹配）
  // ----------------------------------------------------------
  it('同规则多次匹配应按 1.0 → 0.5 → 0.25 → 0.1 递减', () => {
    const gate = new SkillSecurityGate();
    // command_injection (critical, base=50) 匹配 4 次：
    //   第 1 次：50 * 1.0  = 50
    //   第 2 次：50 * 0.5  = 25
    //   第 3 次：50 * 0.25 = 12.5
    //   第 4 次：50 * 0.1  = 5
    //   合计：92.5 → 四舍五入 93
    const content = 'eval(x) exec(y) system(z) eval(w)';
    const result = gate.scan('test-skill', content);

    const cmdFindings = result.findings.filter((f) => f.rule === 'command_injection');
    expect(cmdFindings.length).toBe(4);
    expect(result.score).toBe(93);
  });

  // ----------------------------------------------------------
  // 测试 3：自动安装阈值
  // ----------------------------------------------------------
  it('canAutoInstall 应在 score <= 阈值时返回 true', () => {
    // 阈值 30：1 个 medium (10) + 1 个 low (5) = 15 → 允许
    const gate = new SkillSecurityGate({ autoInstallThreshold: 30 });
    const safeContent = 'console.log("debug") Math.random()';
    const safeResult = gate.scan('test-skill', safeContent);
    expect(safeResult.score).toBeLessThanOrEqual(30);
    expect(gate.canAutoInstall(safeResult)).toBe(true);

    // 阈值 30：1 个 critical (50) → 50 > 30 → 不允许
    const dangerContent = 'eval(input)';
    const dangerResult = gate.scan('test-skill', dangerContent);
    expect(dangerResult.score).toBe(50);
    expect(gate.canAutoInstall(dangerResult)).toBe(false);
  });

  // ----------------------------------------------------------
  // 测试 4：基线抑制
  // ----------------------------------------------------------
  it('基线命中的发现 severity 应降一级（critical → high）', () => {
    const content = 'eval(input)';

    // 先用普通 gate 扫描，获取实际的 evidence（保证基线 key 完全匹配）
    const plainGate = new SkillSecurityGate();
    const plainResult = plainGate.scan('test-skill', content);
    const plainFinding = plainResult.findings.find((f) => f.rule === 'command_injection');
    expect(plainFinding).toBeDefined();
    expect(plainFinding?.severity).toBe('critical');

    // 用同样的 evidence 构造基线
    const baseline: SkillSecurityFinding[] = [
      {
        rule: 'command_injection',
        severity: 'critical',
        evidence: plainFinding!.evidence,
      },
    ];
    const gate = new SkillSecurityGate({ baselineFindings: baseline });
    const result = gate.scan('test-skill', content);

    const cmd = result.findings.find((f) => f.rule === 'command_injection');
    expect(cmd).toBeDefined();
    // 命中基线 → critical 降为 high
    expect(cmd?.severity).toBe('high');
  });

  // ----------------------------------------------------------
  // 测试 5：诚实记账字段
  // ----------------------------------------------------------
  it('诚实记账字段应永远为 static-only / false', () => {
    const gate = new SkillSecurityGate();
    const result = gate.scan('test-skill', 'eval(input)');
    expect(result.scanMode).toBe('static-only');
    expect(result.llmRequested).toBe(false);
    expect(result.llmAvailable).toBe(false);
    expect(result.llmUsed).toBe(false);
  });

  // ----------------------------------------------------------
  // 测试 6：可执行文件 1.3x 乘数
  // ----------------------------------------------------------
  it('可执行文件 skillId 应触发 1.3x 乘数', () => {
    const gate = new SkillSecurityGate();
    // 1 个 critical = 50 * 1.3 = 65 → 四舍五入 65
    const result = gate.scan('malicious.sh', 'eval(input)');
    expect(result.score).toBe(65);
  });

  // ----------------------------------------------------------
  // 测试 7：行号字段正确
  // ----------------------------------------------------------
  it('发现应包含正确的行号（1-based）', () => {
    const gate = new SkillSecurityGate();
    const content = 'line1\nline2\neval(input)\nline4';
    const result = gate.scan('test-skill', content);
    const cmd = result.findings.find((f) => f.rule === 'command_injection');
    expect(cmd?.line).toBe(3);
  });

  // ----------------------------------------------------------
  // 测试 8：封顶 100 分
  // ----------------------------------------------------------
  it('风险评分应封顶 100 分', () => {
    const gate = new SkillSecurityGate();
    // 构造大量 critical 命中，确保分数 > 100
    // command_injection 第 1-4 次：50+25+12.5+5 = 92.5
    // unsafe_deserialization 第 1-4 次：50+25+12.5+5 = 92.5
    // 合计：185 → 封顶 100
    const content = [
      'eval(a) exec(b) system(c) eval(d)',
      'unserialize(x) pickle.loads(y) unserialize(z) pickle.loads(w)',
    ].join('\n');
    const result = gate.scan('test-skill', content);
    expect(result.score).toBe(100);
  });

  // ----------------------------------------------------------
  // 测试 9：基线未命中的发现 severity 不变
  // ----------------------------------------------------------
  it('基线未命中的发现 severity 应保持不变', () => {
    const baseline: SkillSecurityFinding[] = [
      {
        rule: 'command_injection',
        severity: 'critical',
        evidence: '...other content...', // 不匹配实际证据
      },
    ];
    const gate = new SkillSecurityGate({ baselineFindings: baseline });
    const result = gate.scan('test-skill', 'eval(input)');
    const cmd = result.findings.find((f) => f.rule === 'command_injection');
    expect(cmd).toBeDefined();
    // 基线未命中 → severity 不变
    expect(cmd?.severity).toBe('critical');
  });

  // ----------------------------------------------------------
  // 测试 10：基线命中 low severity 应被跳过
  // ----------------------------------------------------------
  it('基线命中 low severity 的发现应被跳过', () => {
    const content = 'console.log("debug")';

    // 先获取实际证据
    const plainGate = new SkillSecurityGate();
    const plainResult = plainGate.scan('test-skill', content);
    const plainFinding = plainResult.findings.find((f) => f.rule === 'debug_code');
    expect(plainFinding).toBeDefined();
    expect(plainFinding?.severity).toBe('low');

    // 用同样的证据作为基线
    const baseline: SkillSecurityFinding[] = [
      {
        rule: 'debug_code',
        severity: 'low',
        evidence: plainFinding!.evidence,
      },
    ];
    const gate = new SkillSecurityGate({ baselineFindings: baseline });
    const result = gate.scan('test-skill', content);
    const debug = result.findings.find((f) => f.rule === 'debug_code');
    // low → null → 跳过
    expect(debug).toBeUndefined();
  });
});
