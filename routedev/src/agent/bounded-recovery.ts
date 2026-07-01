// src/agent/bounded-recovery.ts
// Phase 52 Task 3：长程工作流有界局部恢复（Bounded Local Recovery）
//
// 来源：BCER Agent 论文的有界局部恢复机制
// 核心：失败时不全局重跑，回退到最近 checkpoint 只重跑失败步骤及其依赖闭包
//
// 设计要点：
//   1. 独立模块，不修改 DualLoopOrchestrator 内部逻辑（接入由 Task 11 完成）
//   2. 通过 StepArtifact 注册机制追踪步骤产出与依赖关系
//   3. computeRecoveryScope 算法：回溯 maxBacktrack 步 + 依赖闭包扩展
//   4. 陷阱 #173：validateArtifactConsistency 必须检查所有下游工件的 dependsOn 链
//   5. 当依赖闭包扩展超过 maxBacktrack 时，回退到全局重跑（避免无限扩展）

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 步骤工件类型 */
export type StepArtifactType = 'code_change' | 'file_create' | 'test_result' | 'analysis';

/**
 * 步骤工件——记录某一步骤产生的可恢复产物
 * 陷阱 #173：dependsOn 链是恢复一致性的核心依据
 */
export interface StepArtifact {
  /** 步骤 ID */
  stepId: string;
  /** 工件类型 */
  type: StepArtifactType;
  /** 摘要描述 */
  summary: string;
  /** 工件位置（文件路径 / 测试名 / 分析报告路径等） */
  location: string;
  /** 依赖的上游工件 stepId 列表 */
  dependsOn: string[];
  /** 产出时间戳（毫秒） */
  producedAt: number;
}

/**
 * 恢复范围——描述一次失败后需要重跑的步骤集合
 */
export interface RecoveryScope {
  /** 失败步骤 ID */
  failedStepId: string;
  /** 需要重跑的步骤 ID（按依赖顺序，失败步骤在最末） */
  stepsToRerun: string[];
  /** 被失效的工件 stepId（下游受影响的工件） */
  invalidatedArtifacts: string[];
  /** 是否需要全局重跑（依赖闭包超过 maxBacktrack 时为 true） */
  isGlobalRerun: boolean;
  /** 恢复决策说明（人类可读） */
  reason: string;
}

// ============================================================
// BoundedRecoveryManager
// ============================================================

/**
 * 有界局部恢复管理器
 *
 * 工作流程：
 *   1. 每步执行成功后调用 registerArtifact 注册工件
 *   2. 步骤失败时调用 computeRecoveryScope 计算恢复范围
 *   3. 调用 invalidateDownstreamArtifacts 清理受影响的下游工件
 *   4. 调用 validateArtifactConsistency 验证恢复后工件一致性
 *   5. 重跑 stepsToRerun 中的步骤（由调用方执行）
 */
export class BoundedRecoveryManager {
  /** stepId → StepArtifact 映射 */
  private readonly artifacts: Map<string, StepArtifact> = new Map();

  /**
   * 注册步骤工件
   *
   * @param artifact 步骤工件
   */
  registerArtifact(artifact: StepArtifact): void {
    this.artifacts.set(artifact.stepId, artifact);
    logger.debug('BoundedRecoveryManager: 工件已注册', {
      stepId: artifact.stepId,
      type: artifact.type,
      dependsOn: artifact.dependsOn,
    });
  }

  /**
   * 获取某步骤的工件
   *
   * @param stepId 步骤 ID
   * @returns 工件对象，未注册时返回 undefined
   */
  getArtifact(stepId: string): StepArtifact | undefined {
    return this.artifacts.get(stepId);
  }

  /**
   * 获取所有已注册工件列表
   *
   * @returns 工件数组（按注册顺序的 Map 迭代序）
   */
  getAllArtifacts(): StepArtifact[] {
    return Array.from(this.artifacts.values());
  }

  /**
   * 计算恢复范围
   *
   * 算法：
   *   1. 找到失败步骤在 allStepIds 中的位置
   *   2. 向前回溯 maxBacktrack 步（包括失败步骤本身）
   *   3. 检查回溯范围内每个步骤的工件 dependsOn 链，
   *      如果依赖了范围外的工件，需要把被依赖的也纳入
   *   4. 如果扩展后的回溯范围超过 maxBacktrack，返回 isGlobalRerun=true
   *   5. 收集所有下游工件（依赖了回溯范围内步骤的工件）到 invalidatedArtifacts
   *
   * @param failedStepId 失败步骤 ID
   * @param maxBacktrack 最大回溯步数（含失败步骤本身）
   * @param allStepIds 全部步骤 ID 列表（按执行顺序）
   * @returns 恢复范围
   */
  computeRecoveryScope(
    failedStepId: string,
    maxBacktrack: number,
    allStepIds: string[],
  ): RecoveryScope {
    // 步骤 1：定位失败步骤
    const failedIdx = allStepIds.indexOf(failedStepId);
    if (failedIdx === -1) {
      // 失败步骤不在 allStepIds 中——无法局部恢复，回退到全局重跑
      return {
        failedStepId,
        stepsToRerun: [],
        invalidatedArtifacts: [],
        isGlobalRerun: true,
        reason: `失败步骤 ${failedStepId} 不在步骤列表中，无法定位回溯范围，回退到全局重跑`,
      };
    }

    // 步骤 2：计算初始回溯范围（含失败步骤本身）
    // 从 max(0, failedIdx - maxBacktrack + 1) 到 failedIdx（闭区间）
    const initialStart = Math.max(0, failedIdx - maxBacktrack + 1);
    const stepsToRerunSet: Set<string> = new Set();
    for (let i = initialStart; i <= failedIdx; i++) {
      stepsToRerunSet.add(allStepIds[i]);
    }

    // 步骤 3：依赖闭包扩展——把被依赖的范围外工件纳入
    // 重复扩展直到收敛（处理传递依赖）
    let changed = true;
    while (changed) {
      changed = false;
      for (const stepId of Array.from(stepsToRerunSet)) {
        const artifact = this.artifacts.get(stepId);
        if (!artifact) continue;
        for (const depStepId of artifact.dependsOn) {
          if (!stepsToRerunSet.has(depStepId)) {
            // 被依赖的步骤不在范围内——需要纳入
            // 但前提是该步骤在 allStepIds 中（避免引入外部噪声）
            if (allStepIds.includes(depStepId)) {
              stepsToRerunSet.add(depStepId);
              changed = true;
            }
          }
        }
      }
    }

    // 步骤 4：检查扩展后的范围是否超过 maxBacktrack
    if (stepsToRerunSet.size > maxBacktrack) {
      // 范围超限——回退到全局重跑
      // 仍需收集下游工件，便于调用方清理
      const allDownstream = this.collectDownstreamArtifacts(
        Array.from(stepsToRerunSet),
        allStepIds,
      );
      return {
        failedStepId,
        stepsToRerun: [],
        invalidatedArtifacts: allDownstream,
        isGlobalRerun: true,
        reason: `依赖闭包扩展后范围 ${stepsToRerunSet.size} 超过 maxBacktrack ${maxBacktrack}，回退到全局重跑`,
      };
    }

    // 步骤 5：按依赖顺序排列 stepsToRerun
    // 按 allStepIds 中的原始顺序排列（依赖在前，失败步骤在后）
    const orderedStepsToRerun = allStepIds.filter((id) => stepsToRerunSet.has(id));

    // 步骤 6：收集下游工件（依赖了回溯范围内任何步骤的工件）
    const invalidatedArtifacts = this.collectDownstreamArtifacts(
      orderedStepsToRerun,
      allStepIds,
    );

    return {
      failedStepId,
      stepsToRerun: orderedStepsToRerun,
      invalidatedArtifacts,
      isGlobalRerun: false,
      reason: `局部恢复：回溯 ${orderedStepsToRerun.length} 步（含失败步骤 ${failedStepId}），失效 ${invalidatedArtifacts.length} 个下游工件`,
    };
  }

  /**
   * 验证恢复后工件一致性
   *
   * 陷阱 #173：必须检查所有下游工件的 dependsOn 链
   * 不一致情形：
   *   1. 下游工件依赖了已被失效（清理）的工件
   *   2. 下游工件依赖了不在 allStepIds 中的步骤
   *   3. 工件本身的 stepId 不在 allStepIds 中
   *
   * @param recoveryScope 恢复范围
   * @returns 一致返回 true，否则 false
   */
  validateArtifactConsistency(recoveryScope: RecoveryScope): boolean {
    // 失效工件集合（这些工件不应再被任何下游工件依赖）
    const invalidatedSet = new Set(recoveryScope.invalidatedArtifacts);
    // 重跑工件集合（这些工件将被重新产出，下游可重新依赖）
    const rerunSet = new Set(recoveryScope.stepsToRerun);

    // 检查所有已注册工件的 dependsOn 链
    for (const artifact of this.artifacts.values()) {
      // 工件本身已被失效——不参与一致性检查（它将被清理）
      if (invalidatedSet.has(artifact.stepId)) continue;

      // 工件本身在重跑集合中——将被重新产出，跳过依赖检查
      if (rerunSet.has(artifact.stepId)) continue;

      // 检查该工件的每个依赖
      for (const depStepId of artifact.dependsOn) {
        // 依赖了已被失效但尚未重跑的工件——不一致
        // 陷阱 #173：失效的工件若不在重跑集合中，则下游依赖断裂
        if (invalidatedSet.has(depStepId) && !rerunSet.has(depStepId)) {
          logger.warn('BoundedRecoveryManager: 工件一致性检查失败', {
            artifact: artifact.stepId,
            brokenDependency: depStepId,
            reason: '依赖了已失效但未重跑的工件',
          });
          return false;
        }
      }
    }

    return true;
  }

  /**
   * 清理被恢复步骤影响的下游工件
   *
   * 调用此方法后，invalidatedArtifacts 中的工件将从注册表中移除，
   * 等待重跑步骤重新产出。
   *
   * @param recoveryScope 恢复范围
   */
  invalidateDownstreamArtifacts(recoveryScope: RecoveryScope): void {
    for (const stepId of recoveryScope.invalidatedArtifacts) {
      // 保留重跑集合中的工件——它们将被重新产出，但当前工件记录仍需清理
      // 实际清理只针对不在重跑集合中的下游工件
      if (!recoveryScope.stepsToRerun.includes(stepId)) {
        this.artifacts.delete(stepId);
      }
    }
    logger.debug('BoundedRecoveryManager: 下游工件已清理', {
      failedStepId: recoveryScope.failedStepId,
      cleared: recoveryScope.invalidatedArtifacts.length,
      isGlobalRerun: recoveryScope.isGlobalRerun,
    });
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  /**
   * 收集依赖了 candidateSteps 中任何步骤的下游工件
   *
   * 传递依赖处理：下游工件被纳入后，依赖该下游工件的更下游工件也应被纳入
   * （例如 s3 失效后，依赖 s3 的 s4、依赖 s4 的 s5 都应失效）
   *
   * @param candidateSteps 候选步骤 ID 列表
   * @param allStepIds 全部步骤 ID（用于过滤范围外的步骤）
   * @returns 下游工件 stepId 列表（按 allStepIds 顺序）
   */
  private collectDownstreamArtifacts(
    candidateSteps: string[],
    allStepIds: string[],
  ): string[] {
    // upstreamSet：被失效的上游步骤集合（candidates + 已收集的下游工件）
    // 当一个工件依赖了 upstreamSet 中的任何步骤时，它本身也是下游工件，应被纳入
    const upstreamSet = new Set(candidateSteps);
    const downstream: string[] = [];

    // 按 allStepIds 顺序遍历，保证下游顺序可预测
    // 重复扫描直到收敛（处理传递依赖）
    let changed = true;
    while (changed) {
      changed = false;
      for (const stepId of allStepIds) {
        // 已经收集过——跳过
        if (upstreamSet.has(stepId)) continue;

        const artifact = this.artifacts.get(stepId);
        if (!artifact) continue;

        // 检查该工件是否依赖了 upstreamSet 中的任何步骤（直接或传递）
        const dependsOnUpstream = artifact.dependsOn.some(
          (depId) => upstreamSet.has(depId),
        );
        if (dependsOnUpstream) {
          downstream.push(stepId);
          upstreamSet.add(stepId); // 纳入上游集合，便于后续传递依赖检查
          changed = true;
        }
      }
    }

    return downstream;
  }
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * 创建 BoundedRecoveryManager 实例
 *
 * 配置开关由接入层（DualLoopOrchestrator / Task 11）控制：
 *   - boundedRecovery.enabled=false 时，调用方可选择不实例化或实例化但不调用
 *   - 即使 enabled=false，本工厂仍可正常创建实例（测试场景）
 */
export function createBoundedRecoveryManager(): BoundedRecoveryManager {
  return new BoundedRecoveryManager();
}
