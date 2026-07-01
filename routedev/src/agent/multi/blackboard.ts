// src/agent/multi/blackboard.ts
// 公共黑板：Worker 之间共享的任务共识信息
// 蓝图 10.2：currentGoal + completedSteps + projectFacts + version（乐观锁）

import type {
  BlackboardEntry,
  BlackboardSnapshot,
  WorkerRole,
} from './types.js';
import { logger } from '../../utils/logger.js';

export class Blackboard {
  private currentGoal: { description: string; status: string } | null = null;
  private completedSteps: BlackboardEntry[] = [];
  private projectFacts: BlackboardEntry[] = [];
  /** 乐观锁版本号 */
  private version = 0;

  /** 清空当前目标相关状态 */
  reset(): void {
    this.currentGoal = null;
    this.completedSteps = [];
    this.projectFacts = [];
    this.version++;
  }

  /** 设置当前目标 */
  setGoal(description: string, status: string): void {
    this.currentGoal = { description, status };
    this.version++;
  }

  /** 更新目标状态 */
  updateGoalStatus(status: string): void {
    if (this.currentGoal) {
      this.currentGoal.status = status;
      this.version++;
    }
  }

  /** Worker 写入完成结论 */
  addCompletedStep(
    stepId: number,
    role: WorkerRole,
    conclusion: string,
    confidence: number = 0.8,
  ): void {
    this.completedSteps.push({
      key: `step-${stepId}`,
      value: conclusion,
      source: { role, stepId },
      timestamp: Date.now(),
      confidence,
    });
    this.version++;
    logger.debug('Blackboard: step completed', { stepId, role });
  }

  /** 添加项目共识（不变的事实） */
  addProjectFact(key: string, value: string, confidence: number = 0.9): void {
    const existing = this.projectFacts.findIndex(f => f.key === key);
    if (existing >= 0) {
      this.projectFacts[existing].value = value;
      this.projectFacts[existing].confidence = confidence;
    } else {
      this.projectFacts.push({
        key,
        value,
        source: { role: 'coder', stepId: -1 },
        timestamp: Date.now(),
        confidence,
      });
    }
    this.version++;
  }

  /** 获取当前快照（给 Worker 读的只读副本） */
  getSnapshot(): BlackboardSnapshot {
    return {
      currentGoal: this.currentGoal ? { ...this.currentGoal } : null,
      // 深拷贝元素，避免 worker 篡改黑板内部状态
      completedSteps: this.completedSteps.map(e => ({ ...e, source: { ...e.source } })),
      projectFacts: this.projectFacts.map(e => ({ ...e, source: { ...e.source } })),
    };
  }

  /** 格式化为文本（注入到 Worker 的 system prompt 中） */
  formatForPrompt(): string {
    const parts: string[] = [];

    if (this.currentGoal) {
      parts.push(`当前目标: ${this.currentGoal.description} (${this.currentGoal.status})`);
    }

    if (this.completedSteps.length > 0) {
      parts.push('已完成步骤:');
      for (const step of this.completedSteps) {
        parts.push(`  - [步骤 ${step.source.stepId}] ${step.value}`);
      }
    }

    if (this.projectFacts.length > 0) {
      parts.push('项目共识:');
      for (const fact of this.projectFacts) {
        parts.push(`  - ${fact.key}: ${fact.value}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : '（黑板为空）';
  }
}
