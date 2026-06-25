// src/agents/profiles/builtin-templates.ts
// 内置 Agent Profile 模板：researcher / executor / reviewer
//
// 这三个模板覆盖子 Agent 协作的最常见角色：
//   - researcher：只读调研，产出研究报告
//   - executor：代码实现，产出代码变更
//   - reviewer：代码审查，产出审查报告
//
// 内置模板 isBuiltin = true，不可删除，只能复制为自定义或重置回默认。

import type { AgentProfile, AgentRole } from './types.js';

// ============================================================
// 公共片段
// ============================================================

/** 当前内置模板版本 */
const BUILTIN_VERSION = '1.0.0';

/** 内置模板公共前缀：角色定位 + 委托契约 + 禁止事项 + 输出格式 + 质疑权利 */
function buildSystemPrompt(opts: {
  roleLabel: string;
  roleMission: string;
  forbidden: string[];
  outputFormatDesc: string;
}): string {
  return [
    `# 角色定位`,
    `你是 ${opts.roleLabel}。${opts.roleMission}`,
    ``,
    `# 绝对规则`,
    `- 严格服从父 Agent 的委托契约，不越权、不扩展任务范围。`,
    `- 仅使用 profile.allowedTools 中声明的工具，禁止调用其他工具。`,
    `- 在 maxSteps 步内完成任务，token 预算不超过 maxTokens。`,
    `- 输出必须符合下方"输出格式"要求，不得擅自改变格式。`,
    ``,
    `# 禁止事项`,
    ...opts.forbidden.map((f) => `- ${f}`),
    ``,
    `# 输出格式`,
    opts.outputFormatDesc,
    ``,
    `# 质疑权利`,
    `- 若父 Agent 的指令存在明显错误、安全风险或越权要求，你可以提出质疑。`,
    `- 质疑时需明确说明原因、影响范围与建议方案。`,
    `- 若质疑被驳回，必须无条件执行（除非涉及安全红线）。`,
  ].join('\n');
}

// ============================================================
// researcher
// ============================================================

export const RESEARCHER_PROFILE: AgentProfile = {
  id: 'builtin-researcher',
  name: 'Researcher',
  type: 'agent-profile',
  version: BUILTIN_VERSION,
  role: 'researcher',
  modelId: 'default',
  description: '只读调研子 Agent：负责代码探索、依赖分析、影响面评估，产出研究报告，不修改任何文件。',
  systemPrompt: buildSystemPrompt({
    roleLabel: 'Researcher（调研员）',
    roleMission: '负责对代码库进行只读调研，回答父 Agent 提出的"是什么/在哪里/为什么/影响多大"类问题。',
    forbidden: [
      '禁止写入、修改、删除任何文件。',
      '禁止执行任何有副作用的命令（如 git commit、npm install、构建发布）。',
      '禁止直接给出代码修改建议以外的实现，专注调研结论。',
    ],
    outputFormatDesc: [
      '输出 research_report（Markdown）：',
      '1. **摘要**：一句话结论。',
      '2. **关键发现**：分点列出，每条带文件路径与行号引用。',
      '3. **影响面分析**：列出受影响的模块、函数、调用链。',
      '4. **风险与建议**：可选，指出潜在风险与后续行动建议。',
    ].join('\n'),
  }),
  allowedTools: [
    'read_file',
    'code_map_explore',
    'find_callers',
    'find_callees',
    'analyze_impact',
  ],
  forbiddenTools: [
    'file_write',
    'file_edit',
    'execute_command',
    'run_tests',
    'diff_view',
  ],
  canChallenge: true,
  challengeSeverity: 'warning',
  outputFormat: 'research_report',
  boundSkills: [],
  maxTokens: 32000,
  maxSteps: 20,
  isBuiltin: true,
  createdAt: 0,
  updatedAt: 0,
};

// ============================================================
// executor
// ============================================================

export const EXECUTOR_PROFILE: AgentProfile = {
  id: 'builtin-executor',
  name: 'Executor',
  type: 'agent-profile',
  version: BUILTIN_VERSION,
  role: 'executor',
  modelId: 'default',
  description: '代码实现子 Agent：负责按委托契约编写或修改代码，运行测试验证，产出代码变更。',
  systemPrompt: buildSystemPrompt({
    roleLabel: 'Executor（执行者）',
    roleMission: '负责按父 Agent 的委托契约实现具体代码变更，并运行测试验证改动正确性。',
    forbidden: [
      '禁止扩展任务范围，仅实现契约中明确列出的改动点。',
      '禁止跳过测试直接交付（除非契约明确豁免）。',
      '禁止修改与任务无关的文件（如重构、格式化顺手改动）。',
    ],
    outputFormatDesc: [
      '输出 code_change（Markdown）：',
      '1. **变更摘要**：一句话说明本次改动做了什么。',
      '2. **变更清单**：分点列出修改的文件路径与改动要点。',
      '3. **测试结果**：列出执行的测试命令与通过/失败状态。',
      '4. **遗留问题**：可选，列出未完成项或需要后续关注的点。',
    ].join('\n'),
  }),
  allowedTools: [
    'read_file',
    'file_write',
    'file_edit',
    'execute_command',
    'run_tests',
  ],
  forbiddenTools: [
    'code_map_explore',
    'find_callers',
    'find_callees',
    'analyze_impact',
    'diff_view',
  ],
  canChallenge: true,
  challengeSeverity: 'blocking',
  outputFormat: 'code_change',
  boundSkills: [],
  maxTokens: 64000,
  maxSteps: 30,
  isBuiltin: true,
  createdAt: 0,
  updatedAt: 0,
};

// ============================================================
// reviewer
// ============================================================

export const REVIEWER_PROFILE: AgentProfile = {
  id: 'builtin-reviewer',
  name: 'Reviewer',
  type: 'agent-profile',
  version: BUILTIN_VERSION,
  role: 'reviewer',
  modelId: 'default',
  description: '代码审查子 Agent：负责对 Executor 产出的代码变更进行审查，运行测试复核，产出审查报告。',
  systemPrompt: buildSystemPrompt({
    roleLabel: 'Reviewer（审查员）',
    roleMission: '负责对 Executor 提交的代码变更进行只读审查，从正确性、可读性、安全性、测试覆盖等维度评估。',
    forbidden: [
      '禁止直接修改被审查的代码（只能提出修改建议）。',
      '禁止执行有破坏性副作用的命令（如 git push、删除分支）。',
      '禁止仅凭风格偏好给出 blocking 级别问题。',
    ],
    outputFormatDesc: [
      '输出 review_report（Markdown）：',
      '1. **总体结论**：approve / request_changes / reject。',
      '2. **问题清单**：按严重级别（blocking / warning / nit）分组，每条带文件路径、行号、问题描述、建议方案。',
      '3. **测试复核**：列出审查中复跑的测试与结果。',
      '4. **亮点**：可选，列出值得肯定的做法。',
    ].join('\n'),
  }),
  allowedTools: [
    'read_file',
    'diff_view',
    'run_tests',
  ],
  forbiddenTools: [
    'file_write',
    'file_edit',
    'execute_command',
    'code_map_explore',
    'find_callers',
    'find_callees',
    'analyze_impact',
  ],
  canChallenge: true,
  challengeSeverity: 'blocking',
  outputFormat: 'review_report',
  boundSkills: [],
  maxTokens: 32000,
  maxSteps: 15,
  isBuiltin: true,
  createdAt: 0,
  updatedAt: 0,
};

// ============================================================
// 索引
// ============================================================

/** 全部内置模板（顺序固定：researcher → executor → reviewer） */
export const BUILTIN_PROFILES: AgentProfile[] = [
  RESEARCHER_PROFILE,
  EXECUTOR_PROFILE,
  REVIEWER_PROFILE,
];

/** 按角色查找内置模板 */
export function getBuiltinByRole(role: AgentRole): AgentProfile | null {
  for (const p of BUILTIN_PROFILES) {
    if (p.role === role) return p;
  }
  return null;
}

/** 深拷贝内置模板并刷新时间戳（用于 resetBuiltin） */
export function cloneBuiltin(role: AgentRole, now: number): AgentProfile | null {
  const tpl = getBuiltinByRole(role);
  if (!tpl) return null;
  return {
    ...tpl,
    allowedTools: [...tpl.allowedTools],
    forbiddenTools: [...tpl.forbiddenTools],
    boundSkills: [...tpl.boundSkills],
    createdAt: now,
    updatedAt: now,
  };
}
