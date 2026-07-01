// src/agent/workflow/dag-engine.ts
// DAG 工作流引擎：拓扑排序 + 分层并行执行 + 失败重试 + 人工升级阈值
//
// 解决问题：多步骤任务存在依赖关系时，需要按依赖顺序执行；
// 同层无依赖节点可并行加速；单点失败需可重试；连续失败达阈值后跳过避免死循环。
//
// 核心算法：
//   - topologicalSort：Kahn 算法（入度计数 + BFS），有环返回 null
//   - layeredSort：BFS 分层，同层入度为 0 的节点归到同一批
//   - execute：按层 Promise.all 并行，同层内按 maxParallel 分批；失败重试 retryLimit 次

// ============================================================
// 类型定义
// ============================================================

/** DAG 节点定义 */
export interface DagNode {
  /** 节点唯一 ID */
  id: string;
  /** 依赖的节点 ID 列表（执行前必须全部完成） */
  dependsOn: string[];
  /** 节点动作描述（支持 {{variable}} 模板替换） */
  action: string;
  /** 节点级变量（覆盖 workflow.variables，优先级更高） */
  variables?: Record<string, string>;
}

/** DAG 工作流定义 */
export interface DagWorkflow {
  /** 全部节点 */
  nodes: DagNode[];
  /** 工作流级变量（被所有节点共享，可被节点级 variables 覆盖） */
  variables: Record<string, unknown>;
}

/** DAG 执行结果 */
export interface DagExecutionResult {
  /** 节点 ID → 执行结果（仅包含成功执行的节点） */
  results: Map<string, unknown>;
  /** 成功节点的执行顺序（按完成先后） */
  executionOrder: string[];
  /** 失败节点 ID 列表（重试耗尽或被阈值跳过） */
  failedNodes: string[];
  /** 总耗时（毫秒） */
  durationMs: number;
}

/** DagEngine 构造参数 */
export interface DagEngineOptions {
  /** 同层最大并行数（默认 3） */
  maxParallel?: number;
  /** 失败重试次数（默认 2，即最多尝试 1+2=3 次） */
  retryLimit?: number;
  /** 人工升级阈值：累计失败次数达此值后跳过该节点（默认 3） */
  humanEscalationThreshold?: number;
}

// ============================================================
// DagEngine
// ============================================================

/**
 * DAG 工作流引擎
 *
 * 使用方式：
 *   const engine = new DagEngine({ maxParallel: 3, retryLimit: 2 });
 *   const result = await engine.execute(workflow, async (node, action) => {
 *     return await runAgent(action);
 *   });
 */
export class DagEngine {
  private readonly maxParallel: number;
  private readonly retryLimit: number;
  private readonly humanEscalationThreshold: number;
  /** 节点累计失败次数（跨多次 execute 调用，用于触发人工升级阈值） */
  private readonly failureCounts: Map<string, number> = new Map();

  constructor(opts?: DagEngineOptions) {
    this.maxParallel = opts?.maxParallel ?? 3;
    this.retryLimit = opts?.retryLimit ?? 2;
    this.humanEscalationThreshold = opts?.humanEscalationThreshold ?? 3;
  }

  /**
   * 拓扑排序：Kahn 算法（入度计数 + BFS），有环返回 null
   *
   * 与 layeredSort 的区别：返回扁平节点数组，不保留层信息
   * 用于需要顺序执行序列的场景（如串行执行计划生成）
   *
   * @param nodes 待排序的节点列表
   * @returns 拓扑序节点数组；存在环时返回 null
   */
  topologicalSort(nodes: DagNode[]): DagNode[] | null {
    const layers = this.layeredSort(nodes);
    if (layers === null) return null;
    return layers.flat();
  }

  /**
   * 分层排序：BFS 同批次入度为 0 的节点归到同一层
   *
   * 与 topologicalSort 的区别：保留层信息，便于按层并行执行
   *
   * @param nodes 待排序的节点列表
   * @returns 按层分组的节点列表；存在环时返回 null
   */
  layeredSort(nodes: DagNode[]): DagNode[][] | null {
    const inDegree = this.buildInDegree(nodes);
    const dependents = this.buildDependents(nodes);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    // 初始层：所有入度为 0 的节点
    let currentLayerIds: string[] = [];
    for (const node of nodes) {
      if ((inDegree.get(node.id) ?? 0) === 0) {
        currentLayerIds.push(node.id);
      }
    }

    const layers: DagNode[][] = [];
    let processedCount = 0;

    while (currentLayerIds.length > 0) {
      // 当前层的节点
      const layerNodes: DagNode[] = [];
      for (const id of currentLayerIds) {
        const n = nodeMap.get(id);
        if (n) layerNodes.push(n);
      }
      layers.push(layerNodes);
      processedCount += layerNodes.length;

      // 计算下一层：处理当前层节点后，入度变 0 的节点
      const nextLayerIds: string[] = [];
      for (const id of currentLayerIds) {
        for (const depId of dependents.get(id) ?? []) {
          const newDeg = (inDegree.get(depId) ?? 0) - 1;
          inDegree.set(depId, newDeg);
          if (newDeg === 0) nextLayerIds.push(depId);
        }
      }
      currentLayerIds = nextLayerIds;
    }

    // 处理节点数 < 总数 → 有环
    if (processedCount < nodes.length) return null;
    return layers;
  }

  /**
   * 变量替换：将 {{name}} 替换为 variables[name]
   *
   * 规则：
   *   - 变量未定义（不在 map 中）或值为 null/undefined → 替换为空字符串
   *   - 其他值 → String(value)
   *   - 支持变量名两侧空白：{{ name }} → variables['name']
   *
   * @param action 含 {{variable}} 模板的字符串
   * @param variables 变量字典
   * @returns 替换后的字符串
   */
  resolveVariables(action: string, variables: Record<string, unknown>): string {
    return action.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
      const val = variables[name];
      return val == null ? '' : String(val);
    });
  }

  /**
   * 按层并行执行工作流
   *
   * 执行策略：
   *   1. layeredSort 分层
   *   2. 同层节点按 maxParallel 分批，批内 Promise.all 并行
   *   3. 单节点失败 → 重试 retryLimit 次；仍失败 → 记录到 failedNodes
   *   4. 节点累计失败次数（failureCounts）≥ humanEscalationThreshold → 跳过该节点
   *
   * @param workflow 工作流定义
   * @param executor 节点执行回调（接收节点和已替换变量的 action，返回任意结果）
   * @returns 执行结果（含成功结果、执行顺序、失败节点、耗时）
   */
  async execute(
    workflow: DagWorkflow,
    executor: (node: DagNode, resolvedAction: string) => Promise<unknown>,
  ): Promise<DagExecutionResult> {
    const startTime = Date.now();
    const results = new Map<string, unknown>();
    const executionOrder: string[] = [];
    const failedNodes: string[] = [];

    // 空工作流直接返回
    if (workflow.nodes.length === 0) {
      return { results, executionOrder, failedNodes, durationMs: Date.now() - startTime };
    }

    // 分层；存在环则全部节点失败
    const layers = this.layeredSort(workflow.nodes);
    if (layers === null) {
      return {
        results,
        executionOrder,
        failedNodes: workflow.nodes.map(n => n.id),
        durationMs: Date.now() - startTime,
      };
    }

    // 逐层执行
    for (const layer of layers) {
      // 同层内按 maxParallel 分批
      for (let i = 0; i < layer.length; i += this.maxParallel) {
        const batch = layer.slice(i, i + this.maxParallel);
        const batchOutcomes = await Promise.all(
          batch.map(node => this.executeNode(node, workflow.variables, executor)),
        );
        for (const outcome of batchOutcomes) {
          if (outcome.success) {
            results.set(outcome.id, outcome.result);
            executionOrder.push(outcome.id);
          } else {
            failedNodes.push(outcome.id);
          }
        }
      }
    }

    return { results, executionOrder, failedNodes, durationMs: Date.now() - startTime };
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /**
   * 执行单个节点：含重试逻辑和阈值检查
   */
  private async executeNode(
    node: DagNode,
    workflowVariables: Record<string, unknown>,
    executor: (node: DagNode, resolvedAction: string) => Promise<unknown>,
  ): Promise<{ id: string; success: boolean; result?: unknown }> {
    // 累计失败达阈值 → 跳过
    if ((this.failureCounts.get(node.id) ?? 0) >= this.humanEscalationThreshold) {
      return { id: node.id, success: false };
    }

    // 合并变量：节点级覆盖工作流级
    const mergedVars: Record<string, unknown> = {
      ...workflowVariables,
      ...(node.variables ?? {}),
    };
    const resolvedAction = this.resolveVariables(node.action, mergedVars);

    // 重试循环：初始尝试 + retryLimit 次重试
    let attempt = 0;
    while (attempt <= this.retryLimit) {
      try {
        const result = await executor(node, resolvedAction);
        return { id: node.id, success: true, result };
      } catch {
        attempt += 1;
        // 累计失败次数 +1（跨 execute 调用累积）
        const prev = this.failureCounts.get(node.id) ?? 0;
        this.failureCounts.set(node.id, prev + 1);
        // 累计达阈值 → 停止重试，避免无谓消耗
        if ((this.failureCounts.get(node.id) ?? 0) >= this.humanEscalationThreshold) {
          break;
        }
      }
    }
    return { id: node.id, success: false };
  }

  /**
   * 构建节点入度表（每个节点依赖了多少个其他节点）
   * 依赖中引用了不存在节点 ID 时，忽略该条依赖
   */
  private buildInDegree(nodes: DagNode[]): Map<string, number> {
    const inDegree = new Map<string, number>();
    const knownIds = new Set(nodes.map(n => n.id));
    for (const node of nodes) {
      inDegree.set(node.id, 0);
    }
    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        // 仅当依赖的节点存在时才计数
        if (knownIds.has(dep)) {
          inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
        }
      }
    }
    return inDegree;
  }

  /**
   * 构建下游映射：nodeId → 直接依赖该节点的节点 ID 列表
   * 用于 Kahn 出队时减入度
   */
  private buildDependents(nodes: DagNode[]): Map<string, string[]> {
    const dependents = new Map<string, string[]>();
    const knownIds = new Set(nodes.map(n => n.id));
    for (const node of nodes) {
      dependents.set(node.id, []);
    }
    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        if (knownIds.has(dep)) {
          dependents.get(dep)?.push(node.id);
        }
      }
    }
    return dependents;
  }
}
