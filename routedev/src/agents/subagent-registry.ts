// src/agents/subagent-registry.ts
// Phase 97 Part E：子会话注册表——子 Agent 可见性基础设施
//
// 设计目的：
//   让 spawn_agent 生成的子 Agent 成为「真正可见、可检查、可停止」的会话：
//   - 创建时登记 childSessionId，UI 可打开检查（运行状态/描述/耗时）
//   - 运行中可停止（AbortController 由执行器写入）
//   - 会话恢复后仍能按 childSessionId 查询子任务结果
//
// 与现有设施的关系：
//   - SubAgentLifecycle：状态机（running/completed/failed），面向委托体系内部
//   - SubagentRegistry：会话可见性视图（面向 UI / IPC），两者互补不重叠

/** 子会话状态 */
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** 子会话可见性记录 */
export interface SubagentRecord {
  /** 子会话 ID（spawn 时生成，与 SubAgentSessionScope.sessionId 对齐格式） */
  childSessionId: string;
  /** 父会话 ID（溯源用，可为空） */
  parentSessionId?: string;
  /** 短标签（UI 显示用） */
  description: string;
  /** 子 Agent 类型 */
  subagentType: string;
  /** 执行状态 */
  status: SubagentStatus;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间（completed/failed/aborted 时写入） */
  completedAt?: number;
  /** 执行结果（成功时 result；失败时 error；由执行器写入） */
  result?: string;
  error?: string;
  /** 执行结束后的总 token（可选，由执行器写入） */
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

/**
 * 子会话注册表
 * 主进程单例（随 AppDependencies 装配），所有 spawn 路径共用
 */
export class SubagentRegistry {
  private records = new Map<string, SubagentRecord>();
  /** childSessionId → AbortController（运行中可停止） */
  private abortControllers = new Map<string, AbortController>();

  /** 登记新子会话，返回该会话的 AbortController（供执行器绑定中断信号） */
  register(record: Omit<SubagentRecord, 'createdAt'> & { createdAt?: number }): AbortController {
    const rec: SubagentRecord = {
      ...record,
      createdAt: record.createdAt ?? Date.now(),
    };
    this.records.set(rec.childSessionId, rec);
    const controller = new AbortController();
    this.abortControllers.set(rec.childSessionId, controller);
    return controller;
  }

  /** 更新状态（completed/failed/aborted）并写入结果 */
  update(
    childSessionId: string,
    patch: Partial<Pick<SubagentRecord, 'status' | 'result' | 'error' | 'completedAt' | 'tokenUsage'>>,
  ): void {
    const rec = this.records.get(childSessionId);
    if (!rec) return;
    Object.assign(rec, patch);
    if (patch.status && patch.status !== 'running' && !rec.completedAt) {
      rec.completedAt = Date.now();
    }
    if (patch.status && patch.status !== 'running') {
      this.abortControllers.delete(childSessionId);
    }
  }

  /** 按 childSessionId 获取记录 */
  get(childSessionId: string): SubagentRecord | undefined {
    return this.records.get(childSessionId);
  }

  /** 列出全部子会话（按创建时间倒序）；可按父会话过滤 */
  list(parentSessionId?: string): SubagentRecord[] {
    const all = [...this.records.values()];
    const filtered = parentSessionId
      ? all.filter((r) => r.parentSessionId === parentSessionId)
      : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 请求停止运行中的子会话；返回是否命中 */
  stop(childSessionId: string): boolean {
    const controller = this.abortControllers.get(childSessionId);
    if (!controller) return false;
    controller.abort();
    const rec = this.records.get(childSessionId);
    if (rec && rec.status === 'running') {
      rec.status = 'aborted';
      rec.completedAt = Date.now();
      this.abortControllers.delete(childSessionId);
    }
    return true;
  }
}
