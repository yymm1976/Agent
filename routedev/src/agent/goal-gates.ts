// src/agent/goal-gates.ts
// Goal Gate System（architect-loop 模式）
// Phase 21 Task 2：/goal 分解后冻结验收标准到 .gates.json
//
// 设计原则：
//   1. Gate 冻结后不可变 — 修改验收标准需用户显式确认（调用 modifyGate）
//   2. 持久化到 .routedev/.gates.json — 跨会话恢复
//   3. 与 GoalVerifier 协作 — GoalGateManager 做结构化管理，验证由 GoalVerifier + LLM 完成
//
// 集成点：
//   - /goal 命令分解后调用 freeze()
//   - GoalVerifier.verify() 接收可选 gates 参数比对

import fs from 'node:fs/promises';
import path from 'node:path';

/** 单个 Gate 状态 */
type GateStatus = 'pending' | 'passed' | 'failed' | 'skipped';

/** 验收门控（单条） */
export interface Gate {
  /** Gate ID（如 "step-1"） */
  id: string;
  /** 验收标准（自然语言描述） */
  criteria: string;
  /** 当前状态 */
  status: GateStatus;
  /** 证据（验证时由 LLM 或代码检查提供） */
  evidence?: string;
}

/** 冻结的 Gate 集合（一次 /goal 对应一个 FrozenGates） */
export interface FrozenGates {
  /** 原始目标文本 */
  goalText: string;
  /** 冻结时间戳（ms） */
  frozenAt: number;
  /** Gate 列表 */
  gates: Gate[];
  /**
   * 是否锁定（冻结）。
   * locked=true 表示冻结不可变，modifyGate() 会被拒绝；
   * locked=false 表示已解锁，modifyGate() 允许修改 criteria。
   * 修改流程：freeze() → locked=true → unlock() → locked=false → modifyGate() → lock()
   */
  locked: boolean;
}

/**
 * Goal Gate 管理器
 *
 * 职责：
 *   - freeze：将 GoalPlan 的步骤转为 Gate 并冻结
 *   - load/persist：从 .routedev/.gates.json 读写
 *   - updateGate：更新 Gate 状态（pending → passed/failed/skipped）
 *   - modifyGate：修改 Gate 的 criteria（需 locked=true，调用方需保证已获得用户确认）
 */
export class GoalGateManager {
  private gates: FrozenGates | null = null;
  private gatesDir: string;
  private gatesFile: string;

  constructor(projectRoot: string) {
    this.gatesDir = path.join(projectRoot, '.routedev');
    this.gatesFile = path.join(this.gatesDir, '.gates.json');
  }

  /**
   * 冻结目标 + 验收标准
   * @param goalText 原始目标文本
   * @param gates 验收门控列表
   * @returns 冻结后的 FrozenGates
   */
  async freeze(goalText: string, gates: Gate[]): Promise<FrozenGates> {
    this.gates = {
      goalText,
      frozenAt: Date.now(),
      gates: gates.map(g => ({ ...g })), // 深拷贝避免外部修改
      locked: true,
    };
    await this.persist();
    return this.gates;
  }

  /** 获取当前冻结的 gates（未冻结时返回 null） */
  getGates(): FrozenGates | null {
    return this.gates;
  }

  /**
   * 更新 Gate 状态（不修改 criteria）
   * @param gateId Gate ID
   * @param status 新状态
   * @param evidence 证据（可选）
   * @returns 是否更新成功
   */
  updateGate(gateId: string, status: GateStatus, evidence?: string): boolean {
    const gate = this.gates?.gates.find(g => g.id === gateId);
    if (!gate) return false;
    gate.status = status;
    if (evidence !== undefined) gate.evidence = evidence;
    return true;
  }

  /**
   * 修改 Gate 的 criteria（需先 unlock，即 locked=false）
   *
   * 语义：locked=true 表示冻结不可变，modifyGate 被拒绝；
   *       locked=false 表示已解锁，允许修改 criteria。
   * 调用方必须保证已获得用户显式确认，并先调用 unlock()。
   *
   * @param gateId Gate ID
   * @param newCriteria 新的验收标准
   * @returns 是否修改成功
   */
  async modifyGate(gateId: string, newCriteria: string): Promise<boolean> {
    // locked=true（冻结）时拒绝修改；locked=false（已解锁）时允许
    if (this.gates?.locked) return false;
    if (!this.gates) return false;
    const gate = this.gates.gates.find(g => g.id === gateId);
    if (!gate) return false;
    gate.criteria = newCriteria;
    await this.persist();
    return true;
  }

  /**
   * 解锁 gates（允许 modifyGate 修改 criteria）
   * 解锁后 locked=false，modifyGate 才能工作
   */
  async unlock(): Promise<void> {
    if (!this.gates) return;
    this.gates.locked = false;
    await this.persist();
  }

  /** 重新锁定 gates */
  async lock(): Promise<void> {
    if (!this.gates) return;
    this.gates.locked = true;
    await this.persist();
  }

  /**
   * 从磁盘加载 gates
   * @returns 加载的 FrozenGates（文件不存在或解析失败时返回 null）
   */
  async load(): Promise<FrozenGates | null> {
    try {
      const content = await fs.readFile(this.gatesFile, 'utf-8');
      this.gates = JSON.parse(content) as FrozenGates;
      return this.gates;
    } catch {
      return null;
    }
  }

  /** 清空内存中的 gates（不删除磁盘文件） */
  clear(): void {
    this.gates = null;
  }

  /**
   * 持久化 gates 到磁盘
   * 自动创建 .routedev 目录
   */
  private async persist(): Promise<void> {
    if (!this.gates) return;
    await fs.mkdir(this.gatesDir, { recursive: true });
    await fs.writeFile(
      this.gatesFile,
      JSON.stringify(this.gates, null, 2),
      'utf-8',
    );
  }
}

/**
 * 工具函数：从步骤描述列表构造 Gate 列表
 * @param stepDescriptions 步骤描述数组
 * @returns Gate 列表（id 为 step-1, step-2, ...）
 */
export function gatesFromSteps(stepDescriptions: string[]): Gate[] {
  return stepDescriptions.map((desc, i) => ({
    id: `step-${i + 1}`,
    criteria: desc,
    status: 'pending' as const,
  }));
}
