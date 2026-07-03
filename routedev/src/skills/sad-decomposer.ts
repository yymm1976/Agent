// src/skills/sad-decomposer.ts
// SAD（Skill-Aware Decomposition）不动点迭代分解
//
// 论文借鉴：arXiv:2606.18051 Algorithm 1（input-side feedback）
// 核心创新：检索到的候选技能作为 hints 反馈到分解器输入（input-side），
// 区别于现有 decomposeWithSkillAwareness 的 output-side 重分解。
// 收敛判定：Jaccard(Hⁱ, Hⁱ⁻¹) > τ=0.6（不动点）

import { logger } from '../utils/logger.js';
import { jaccardSimilarity } from './compositional-router.js';
import type { AtomicSubTask, SkillMatch } from './compositional-router.js';

export type { AtomicSubTask, SkillMatch };

export interface SADConfig {
  maxIterations: number;
  convergenceTau: number;
  inputSideFeedback: boolean;
}

export interface SADResult {
  subTasks: AtomicSubTask[];
  iterations: number;
  converged: boolean;
  hintJaccard: number[];
}

export async function decomposeWithSAD(
  task: string,
  availableSkills: Array<{ id: string; name: string; description: string; category: string }>,
  config: SADConfig,
  decomposeFn: (task: string, hints?: string[]) => Promise<AtomicSubTask[]>,
  retrieveFn: (subTask: AtomicSubTask, skills: typeof availableSkills) => SkillMatch | null,
): Promise<SADResult> {
  if (!config.inputSideFeedback) {
    const subTasks = await decomposeFn(task);
    return { subTasks, iterations: 1, converged: true, hintJaccard: [] };
  }

  const maxIter = Math.max(1, config.maxIterations);
  const tau = config.convergenceTau;

  let currentSubTasks = await decomposeFn(task);
  if (currentSubTasks.length === 0) {
    return { subTasks: [], iterations: 0, converged: true, hintJaccard: [] };
  }

  let prevHintSet = new Set<string>();
  const hintJaccardHistory: number[] = [];

  for (let iter = 0; iter < maxIter; iter++) {
    const currentHintSet = new Set<string>();
    for (const sub of currentSubTasks) {
      const match = retrieveFn(sub, availableSkills);
      if (match && match.confidence > 0) {
        currentHintSet.add(`${match.skillName}:${match.category}`);
      }
    }

    const jac = jaccardSimilarity(currentHintSet, prevHintSet);
    hintJaccardHistory.push(jac);

    if (iter > 0 && jac > tau) {
      return {
        subTasks: currentSubTasks,
        iterations: iter + 1,
        converged: true,
        hintJaccard: hintJaccardHistory,
      };
    }

    if (iter + 1 < maxIter) {
      const hints = Array.from(currentHintSet);
      try {
        const refined = await decomposeFn(task, hints);
        if (refined.length > 0) {
          currentSubTasks = refined;
        }
      } catch (err) {
        logger.warn('SAD: 带 hint 重分解失败，终止迭代', {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          subTasks: currentSubTasks,
          iterations: iter + 1,
          converged: false,
          hintJaccard: hintJaccardHistory,
        };
      }
    }

    prevHintSet = currentHintSet;
  }

  return {
    subTasks: currentSubTasks,
    iterations: maxIter,
    converged: false,
    hintJaccard: hintJaccardHistory,
  };
}
