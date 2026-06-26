// src/skills/skill-flow-checkpoint-store.ts
// SkillFlow 任务中断恢复（Phase 49 Task 1.8 — 来自 SDD 规格驱动）
//
// 知识库原文（主题-AI项目长期迭代 延伸阅读）：
//   "SDD 规格驱动：Plan 与 Design 合并——分开有两个坏处
//    （plan 依赖 design 内容、纯 design 无法从中断恢复），
//    合并后 plan 标注完成/未完成状态，支持任务中断恢复。"
//
// RouteDev 的 SkillFlow 在长流水线（如部署、重构）中可能因会话切换、
// 用户中断、模型超时而中止。必须支持断点续跑：
//   1. 每个节点完成（passed）后，把 FlowExecutionContext 持久化到
//      .routedev/skill-flow/<flow-id>.json
//   2. 重启时检测未完成的 flow，提示用户"是否从断点继续"
//   3. 恢复时校验已通过节点输出的哈希——若被外部篡改（陷阱 152），
//      标记为 stale，该节点及其下游全部重跑
//
// 重要约束（陷阱 152）：
//   恢复时必须显式询问用户"是否从断点继续"，不能静默恢复。
//   本模块只负责存储和校验，"询问用户"由调用方处理。

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { FlowExecutionContext, FlowNodeStatus } from './skill-flow-types.js';

/** 持久化存储格式 */
interface CheckpointFile {
  /** flow ID（文件名主干） */
  flowId: string;
  /** 是否已完成（到达 exitNodeId） */
  completed: boolean;
  /** 保存时间（ISO 字符串） */
  savedAt: string;
  /** 终止节点 ID（用于 detectInterrupted 判断是否完成） */
  exitNodeId: string;
  /** 执行上下文（Map 已转为 entries 数组） */
  ctx: SerializedExecutionContext;
  /** 每个 passed 节点的输出哈希（用于 stale 校验） */
  outputHashes: Array<[string, string]>;
}

/** 序列化后的执行上下文（Map 转为数组） */
interface SerializedExecutionContext {
  currentNodeId: string;
  nodeStates: Array<[string, FlowNodeStatus]>;
  nodeOutputs: Array<[string, string]>;
  totalIterations: number;
  loopCounters: Array<[string, number]>;
  handoffArtifacts: Array<[string, unknown]>;
}

/**
 * SkillFlow 任务中断恢复——持久化执行上下文
 *
 * 用法：
 *   const store = new SkillFlowCheckpointStore(projectRoot);
 *   await store.save('deploy-2026xxxx', ctx, flow.exitNodeId);
 *   const restored = await store.load('deploy-2026xxxx');
 *   const interrupted = await store.detectInterrupted();
 *   const stale = await store.validateCheckpoint('deploy-2026xxxx', restored!);
 */
export class SkillFlowCheckpointStore {
  /** checkpoint 存储目录（.routedev/skill-flow/） */
  private readonly storeDir: string;

  /**
   * @param basePath 项目根目录（默认 process.cwd()）
   */
  constructor(basePath: string = process.cwd()) {
    this.storeDir = path.join(basePath, '.routedev', 'skill-flow');
  }

  /**
   * 持久化执行上下文
   *
   * @param flowId flow 唯一标识（用作文件名主干）
   * @param ctx 当前执行上下文
   * @param exitNodeId 终止节点 ID（用于 detectInterrupted 判断是否完成）
   * @param completed 是否已完成（到达 exitNodeId）
   */
  async save(
    flowId: string,
    ctx: FlowExecutionContext,
    exitNodeId: string,
    completed: boolean = false,
  ): Promise<void> {
    await this.ensureStoreDir();
    const filePath = this.getFilePath(flowId);

    const serialized: CheckpointFile = {
      flowId,
      completed,
      savedAt: new Date().toISOString(),
      exitNodeId,
      ctx: this.serializeCtx(ctx),
      outputHashes: this.computeHashes(ctx),
    };

    try {
      await fs.writeFile(filePath, JSON.stringify(serialized, null, 2), 'utf-8');
      logger.debug('SkillFlowCheckpointStore.save: ok', { flowId, filePath });
    } catch (err) {
      logger.warn('SkillFlowCheckpointStore.save: failed', {
        flowId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * 加载已保存的上下文
   *
   * @param flowId flow 唯一标识
   * @returns 反序列化后的执行上下文；文件不存在时返回 null
   */
  async load(flowId: string): Promise<FlowExecutionContext | null> {
    const filePath = this.getFilePath(flowId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as CheckpointFile;
      return this.deserializeCtx(parsed.ctx);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return null;
      }
      logger.warn('SkillFlowCheckpointStore.load: failed', {
        flowId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * 检测中断的 flow
   *
   * 扫描存储目录下所有 .json 文件，返回 completed=false 的 flowId 列表。
   * 文件损坏或解析失败时跳过（不抛异常）。
   */
  async detectInterrupted(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.storeDir);
      const interrupted: string[] = [];

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const flowId = entry.slice(0, -5); // 去掉 .json
        const filePath = path.join(this.storeDir, entry);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const parsed = JSON.parse(content) as CheckpointFile;
          if (!parsed.completed) {
            interrupted.push(flowId);
          }
        } catch {
          // 文件损坏跳过，不影响其他 flow 检测
          logger.warn('SkillFlowCheckpointStore.detectInterrupted: skip corrupt file', { entry });
        }
      }

      return interrupted;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 存储目录不存在 = 没有中断的 flow
        return [];
      }
      logger.warn('SkillFlowCheckpointStore.detectInterrupted: failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * 校验已通过节点的输出是否仍然有效
   *
   * 知识库要求（陷阱 152）："10 万行项目防回归——上下文管理 + 记忆系统 + 幻觉应对"
   * 若中断期间 ctx 文件被外部修改，重跑该节点而非用过期输出继续。
   *
   * 校验逻辑：
   *   1. 重新加载保存时的 outputHashes
   *   2. 对每个 passed 节点，重新计算当前 ctx.nodeOutputs 的 hash
   *   3. hash 不一致 → 加入 stale 集合
   *   4. passed 节点缺少 output（数据不完整）→ 也加入 stale 集合
   *
   * @param flowId flow 唯一标识
   * @param ctx 当前执行上下文（通常由 load 返回）
   * @returns stale 节点 ID 集合（空集合 = 全部有效，可安全续跑）
   */
  async validateCheckpoint(
    flowId: string,
    ctx: FlowExecutionContext,
  ): Promise<Set<string>> {
    const stale = new Set<string>();
    const filePath = this.getFilePath(flowId);

    let parsed: CheckpointFile;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      parsed = JSON.parse(content) as CheckpointFile;
    } catch {
      // 文件不存在或损坏 → 所有 passed 节点都视为 stale（无法校验）
      logger.warn('SkillFlowCheckpointStore.validateCheckpoint: file unreadable, all passed nodes stale', { flowId });
      for (const [nodeId, status] of ctx.nodeStates) {
        if (status === 'passed') stale.add(nodeId);
      }
      return stale;
    }

    const savedHashes = new Map(parsed.outputHashes);

    for (const [nodeId, status] of ctx.nodeStates) {
      if (status !== 'passed') continue;

      const currentOutput = ctx.nodeOutputs.get(nodeId);
      if (currentOutput === undefined) {
        // passed 节点缺少 output → 数据不完整，标记 stale
        stale.add(nodeId);
        continue;
      }

      const savedHash = savedHashes.get(nodeId);
      if (savedHash === undefined) {
        // 保存时没有该节点的 hash（不应该发生，但兜底）→ 标记 stale
        stale.add(nodeId);
        continue;
      }

      const currentHash = SkillFlowCheckpointStore.hashString(currentOutput);
      if (currentHash !== savedHash) {
        // hash 不一致 → 节点输出被外部修改，标记 stale
        stale.add(nodeId);
      }
    }

    return stale;
  }

  /** 删除指定 flow 的 checkpoint 文件（flow 完成后调用） */
  async delete(flowId: string): Promise<void> {
    const filePath = this.getFilePath(flowId);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn('SkillFlowCheckpointStore.delete: failed', {
          flowId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 获取 flow 对应的存储文件路径 */
  private getFilePath(flowId: string): string {
    // 防止路径遍历：只保留文件名部分
    const safeId = path.basename(flowId);
    return path.join(this.storeDir, `${safeId}.json`);
  }

  /** 确保存储目录存在 */
  private async ensureStoreDir(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
  }

  /** 序列化执行上下文（Map → entries 数组） */
  private serializeCtx(ctx: FlowExecutionContext): SerializedExecutionContext {
    return {
      currentNodeId: ctx.currentNodeId,
      nodeStates: Array.from(ctx.nodeStates.entries()),
      nodeOutputs: Array.from(ctx.nodeOutputs.entries()),
      totalIterations: ctx.totalIterations,
      loopCounters: Array.from(ctx.loopCounters.entries()),
      handoffArtifacts: Array.from(ctx.handoffArtifacts.entries()),
    };
  }

  /** 反序列化执行上下文（entries 数组 → Map） */
  private deserializeCtx(serialized: SerializedExecutionContext): FlowExecutionContext {
    return {
      currentNodeId: serialized.currentNodeId,
      nodeStates: new Map(serialized.nodeStates),
      nodeOutputs: new Map(serialized.nodeOutputs),
      totalIterations: serialized.totalIterations,
      loopCounters: new Map(serialized.loopCounters),
      handoffArtifacts: new Map(
        serialized.handoffArtifacts as Array<[string, import('../agent/multi/handoff.js').HandoffArtifact]>,
      ),
    };
  }

  /** 计算每个 passed 节点的输出哈希 */
  private computeHashes(ctx: FlowExecutionContext): Array<[string, string]> {
    const hashes: Array<[string, string]> = [];
    for (const [nodeId, status] of ctx.nodeStates) {
      if (status !== 'passed') continue;
      const output = ctx.nodeOutputs.get(nodeId) ?? '';
      hashes.push([nodeId, SkillFlowCheckpointStore.hashString(output)]);
    }
    return hashes;
  }

  /** 简单字符串哈希（SHA-256 截断，非密码学用途） */
  private static hashString(str: string): string {
    return createHash('sha256').update(str, 'utf-8').digest('hex').slice(0, 16);
  }
}
