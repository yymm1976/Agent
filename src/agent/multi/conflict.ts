// src/agent/multi/conflict.ts
// ConflictDetector：文件访问冲突检测

import type { StepDependency, ConflictResult } from './types.js';
import { logger } from '../../utils/logger.js';

export class ConflictDetector {
  /**
   * 检测并行步骤组中的文件冲突
   */
  detect(
    parallelGroup: number[],
    dependencies: StepDependency[],
  ): ConflictResult {
    if (parallelGroup.length < 2) {
      return {
        hasConflict: false,
        conflictingFiles: [],
        conflictingSteps: [],
        suggestion: '',
      };
    }

    const conflictingFiles: string[] = [];
    const conflictingSteps: Array<[number, number]> = [];

    for (let i = 0; i < parallelGroup.length; i++) {
      for (let j = i + 1; j < parallelGroup.length; j++) {
        const stepA = dependencies.find(d => d.stepId === parallelGroup[i]);
        const stepB = dependencies.find(d => d.stepId === parallelGroup[j]);
        if (!stepA || !stepB) continue;

        const commonFiles = stepA.likelyFiles.filter(f =>
          stepB.likelyFiles.includes(f),
        );
        if (commonFiles.length > 0) {
          conflictingFiles.push(...commonFiles);
          conflictingSteps.push([stepA.stepId, stepB.stepId]);
        }
      }
    }

    const uniqueFiles = [...new Set(conflictingFiles)];
    const hasConflict = uniqueFiles.length > 0;

    let suggestion = '';
    if (hasConflict) {
      const stepPairs = conflictingSteps
        .map(([a, b]) => `步骤 ${a} 和 ${b}`)
        .join('、');
      suggestion = `${stepPairs} 都修改了 ${uniqueFiles.join(', ')}，建议串行执行。`;
      logger.info('Conflict detected', {
        files: uniqueFiles,
        steps: conflictingSteps,
      });
    }

    return {
      hasConflict,
      conflictingFiles: uniqueFiles,
      conflictingSteps,
      suggestion,
    };
  }

  /**
   * 修复冲突：将有冲突的并行组拆分为串行
   */
  resolveConflicts(
    parallelGroups: number[][],
    dependencies: StepDependency[],
  ): number[][] {
    const resolved: number[][] = [];

    for (const group of parallelGroups) {
      const conflict = this.detect(group, dependencies);
      if (!conflict.hasConflict) {
        resolved.push(group);
        continue;
      }

      // 有冲突：保留第一个，其余移到独立组（串行）
      const conflictStepIds = new Set<number>();
      for (const [a, b] of conflict.conflictingSteps) {
        conflictStepIds.add(b); // 保留 a，将 b 串行化
      }

      const safeSteps = group.filter(id => !conflictStepIds.has(id));
      const conflictSteps = group.filter(id => conflictStepIds.has(id));

      if (safeSteps.length > 0) resolved.push(safeSteps);
      for (const stepId of conflictSteps) {
        resolved.push([stepId]); // 每个冲突步骤独立一组
      }
    }

    return resolved;
  }
}