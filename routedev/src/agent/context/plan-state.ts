// src/agent/context/plan-state.ts
// Phase 71 Task E2：显式 plan 可读写状态
//
// 设计借鉴 deepagents：把 plan/todo 作为显式文件状态，Agent 通过工具读写 plan，
// 避免 plan 状态散落在 system prompt 和隐式上下文。
//
// 特性：
// 1. 复用 Task E1 的 VirtualFS 实例存取（不直接读文件）
// 2. JSON 序列化存储到 VFS 的 /plan/current.json
// 3. fail-open：JSON 解析失败返回 null，不抛异常
// 4. 严禁死代码：PlanState 由 plan-tool 消费，plan-tool 由 app-init 注册到 ToolRegistry

import type { VirtualFS } from './virtual-fs.js';

/**
 * 单个 plan 步骤
 */
export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** 依赖的前置步骤 ID 列表（可选） */
  dependsOn?: string[];
  /** 失败原因（仅 status='failed' 时有效） */
  failureReason?: string;
}

/**
 * 完整 plan
 */
export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
}

/** Plan 在 VFS 中的存储路径 */
const PLAN_PATH = '/plan/current.json';

/**
 * 显式 plan 状态：包装 VirtualFS 中的 /plan 路径
 *
 * 内存中通过 VFS 维护 plan JSON 文件，让 LLM 通过工具读写 plan 状态。
 * 所有方法 fail-open：plan 不存在 / 解析失败 / step 不存在时静默忽略或返回 null。
 */
export class PlanState {
  private readonly vfs: VirtualFS;

  constructor(vfs: VirtualFS) {
    this.vfs = vfs;
  }

  /**
   * 读取当前 plan
   * @returns 当前 plan；不存在或 JSON 解析失败时返回 null（fail-open）
   */
  getPlan(): Plan | null {
    const raw = this.vfs.read(PLAN_PATH);
    if (raw === null || raw === '') return null;
    try {
      return JSON.parse(raw) as Plan;
    } catch {
      // fail-open：JSON 解析失败返回 null，不抛异常
      return null;
    }
  }

  /**
   * 写入完整 plan（覆盖式）
   * 调用方负责设置 createdAt / updatedAt（保持数据原样写入，便于往返测试）
   */
  setPlan(plan: Plan): void {
    this.vfs.write(PLAN_PATH, JSON.stringify(plan, null, 2));
  }

  /**
   * 更新指定步骤的字段（部分更新）
   * plan 或 step 不存在时静默忽略
   */
  updateStep(stepId: string, update: Partial<PlanStep>): void {
    const plan = this.getPlan();
    if (!plan) return;
    const idx = plan.steps.findIndex((s) => s.id === stepId);
    if (idx === -1) return;
    plan.steps[idx] = { ...plan.steps[idx], ...update };
    plan.updatedAt = Date.now();
    this.vfs.write(PLAN_PATH, JSON.stringify(plan, null, 2));
  }

  /**
   * 追加一个步骤到 plan 末尾
   * plan 不存在时静默忽略
   */
  addStep(step: PlanStep): void {
    const plan = this.getPlan();
    if (!plan) return;
    plan.steps.push(step);
    plan.updatedAt = Date.now();
    this.vfs.write(PLAN_PATH, JSON.stringify(plan, null, 2));
  }

  /**
   * 删除指定步骤
   * plan 或 step 不存在时静默忽略
   */
  removeStep(stepId: string): void {
    const plan = this.getPlan();
    if (!plan) return;
    const before = plan.steps.length;
    plan.steps = plan.steps.filter((s) => s.id !== stepId);
    if (plan.steps.length === before) return; // 未找到，无变更
    plan.updatedAt = Date.now();
    this.vfs.write(PLAN_PATH, JSON.stringify(plan, null, 2));
  }
}
