// src/agent/handoff.ts
// 结构化交接文件（借鉴 architect-loop HANDOFF.md 模式）

import fs from 'node:fs/promises';
import path from 'node:path';

export interface HandoffData {
  /** 当前目标 */
  currentGoal: string;
  /** 已完成的步骤 */
  completedSteps: string[];
  /** 下一步行动 */
  nextAction: string;
  /** 关键约束/发现 */
  constraints: string[];
  /** 当前工作文件列表 */
  workingFiles: string[];
  /** 未解决的问题 */
  openQuestions: string[];
  /** 时间戳 */
  timestamp: number;
}

/** 生成交接文件 */
export function renderHandoff(data: HandoffData): string {
  const lines = [
    `# Handoff — ${new Date(data.timestamp).toISOString()}`,
    '',
    `## 当前目标`,
    data.currentGoal,
    '',
    `## 已完成`,
    ...data.completedSteps.map(s => `- ${s}`),
    '',
    `## 下一步`,
    data.nextAction,
    '',
    `## 约束与发现`,
    ...data.constraints.map(c => `- ${c}`),
    '',
    `## 工作文件`,
    ...data.workingFiles.map(f => `- ${f}`),
    '',
    `## 未解决问题`,
    ...data.openQuestions.map(q => `- ${q}`),
  ];
  return lines.join('\n');
}

/** 保存交接文件 */
export async function saveHandoff(data: HandoffData, dir: string): Promise<string> {
  const filePath = path.join(dir, 'HANDOFF.md');
  await fs.writeFile(filePath, renderHandoff(data), 'utf-8');
  return filePath;
}
