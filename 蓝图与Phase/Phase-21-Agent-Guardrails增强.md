# Phase 21 — Agent Guardrails 增强

> **Phase 类型：** 功能增强（Enhancement）
> **前置依赖：** Phase 17b（AgentMiddlewarePipeline、ToolResponse、StallDetector、Handoff 已就绪）
> **目标版本：** v0.19.0
> **执行人注意：** 本 Phase 在 Phase 17b 已交付的中间件管线和结构化响应基础上，叠加生产级 Guardrails。每个 Task 独立可测。
## 背景

AgentScope 2.0 有三层权限引擎（deny → human-in-the-loop → auto-approve）。architect-loop 有 gate freezing（锁定验收标准后再执行）和 adversarial falsification（用独立 pass 推翻自己的结论）。RouteDev Phase 17b 已打好地基——AgentMiddlewarePipeline 提供五阶段拦截点，ToolResponse 让工具失败不崩溃 Agent Loop。本 Phase 建造：**权限有分层、目标有门控、Worker 有隔离、结论有验证、上下文有压缩**。
## 核心原则

1. **Deny 不可覆盖** — deny 规则写死在配置中，任何 autonomy mode 不能绕过
2. **Gate 冻结后不可变** — 修改验收标准需用户显式确认
3. **Worker 崩溃不上溯** — 异常转结构化错误，Orchestrator 决定重试/跳过/中止
4. **对抗检查用廉价模型** — 降低"同模型自我验证"的确认偏差
5. **压缩有优先级** — system prompt 和当前目标永不压缩，老消息最先摘要
## 接口对齐观察表

| 接口 / 类型 | 当前签名 | 文件位置 | 备注 |
|---|---|---|---|
| `PermissionChecker` | class, `check(toolName, args): PermissionResult` | `src/tools/permission.ts` | Task 1 增强 |
| `ToolRegistryAdapter` | `execute(toolName, args): Promise<ToolResponse>` | `src/tools/registry.ts`（executor.ts 已在 Phase 17c 删除） | Task 1 插入权限检查。注意：工具执行走 ToolRegistryAdapter |
| `OrchestratorAgent` | class, `run(plan): Promise<OrchestratorResult>` | `src/agent/multi/orchestrator.ts` | Task 3 增强 |
| `GoalVerifier.verify()` | `verify(plan, result): Promise<VerificationResult>` | `src/agent/goal-verifier.ts` | Task 2/4 扩展 |
| `ContextManager` | `compress(messages): { compressed, result }` + `compactIfNeeded()` + `recallMemories(query)` + `getKnowledgeGraph()` | `src/agent/memory/context-manager.ts` | Task 5 增强。Phase 17c 已集成 ContextCompactor 和 KnowledgeGraph |
| `AgentMiddlewarePipeline` | `register(phase, handler)` / `execute(phase, ctx)` | `src/agent/middleware.ts` | Phase 17b Task 8 |
| `ToolResponse` | `{ content, isError, metadata? }` | `src/tools/types.ts` | Phase 17b Task 9 |
| `AutonomyMode` | `'auto' \| 'semi' \| 'manual'` | `src/config/schema.ts` | Task 1 参考 |
| `VerificationResult` | `{ passed: boolean, details: string }` | `src/agent/goal-verifier.ts` | Task 4 扩展 |

## Task 1：三层权限引擎（AgentScope 模式）

> **目标：** Deny / Confirm / Auto-approve 三层显式规则。最严规则永远胜出。

### Step 1：创建 `src/tools/permission-engine.ts`

```typescript
export type PermissionDecision = 'deny' | 'confirm' | 'auto';

export interface PermissionRule {
  id: string;
  layer: PermissionDecision;
  toolPattern: string;          // 支持通配符 *
  argsPredicate?: (args: Record<string, unknown>) => boolean;
  description: string;
}

export interface PermissionCheckResult {
  decision: PermissionDecision;
  matchedRuleId?: string;
  reason: string;
}

export class PermissionEngine {
  private rules: PermissionRule[] = [];

  loadRules(rules: PermissionRule[]): void { this.rules = rules; }

  /** 三层按优先级合并：deny > confirm > auto */
  check(toolName: string, args: Record<string, unknown>, mode: AutonomyMode): PermissionCheckResult {
    const matched = this.rules.filter(r => this.matchRule(r, toolName, args));
    const denyRule = matched.find(r => r.layer === 'deny');
    if (denyRule) return { decision: 'deny', matchedRuleId: denyRule.id, reason: denyRule.description };
    const confirmRule = matched.find(r => r.layer === 'confirm');
    if (confirmRule) return { decision: 'confirm', matchedRuleId: confirmRule.id, reason: confirmRule.description };
    // 无规则 → 看 autonomy mode
    return { decision: mode === 'auto' ? 'auto' : 'confirm', reason: 'Fallback' };
  }

  private matchRule(rule: PermissionRule, toolName: string, args: Record<string, unknown>): boolean {
    if (rule.toolPattern !== '*' && rule.toolPattern !== toolName) {
      if (!rule.toolPattern.endsWith('*') || !toolName.startsWith(rule.toolPattern.slice(0, -1))) return false;
    }
    return !rule.argsPredicate || rule.argsPredicate(args);
  }
}
```

### Step 2：默认规则集

```typescript
export const DEFAULT_DENY_RULES: PermissionRule[] = [
  { id: 'deny-rm-rf-root', layer: 'deny', toolPattern: 'shell_exec',
    argsPredicate: (a) => /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/(\s|$)/.test(String(a.command ?? '')),
    description: 'Blocked: rm -rf /' },
  { id: 'deny-system-dirs', layer: 'deny', toolPattern: 'file_write',
    argsPredicate: (a) => /^\/(etc|proc|sys|dev|boot)\//.test(String(a.path ?? '')),
    description: 'Blocked: write to system directory' },
];
export const DEFAULT_CONFIRM_RULES: PermissionRule[] = [
  { id: 'confirm-shell-exec', layer: 'confirm', toolPattern: 'shell_exec', description: 'Shell command requires confirmation' },
];
export const DEFAULT_AUTO_RULES: PermissionRule[] = [
  { id: 'auto-file-read', layer: 'auto', toolPattern: 'file_read', description: 'Read is safe' },
  { id: 'auto-glob', layer: 'auto', toolPattern: 'glob', description: 'Search is safe' },
];
```

### Step 3：注册到 AgentMiddlewarePipeline 的 onActing 阶段

```typescript
middleware.register('onActing', async (ctx, next) => {
  const result = permissionEngine.check(ctx.toolName!, ctx.toolArgs ?? {}, autonomyMode);
  if (result.decision === 'deny') {
    ctx.metadata.permissionDenied = result.reason;
    return; // 不调用 next()，工具不执行
  }
  if (result.decision === 'confirm') {
    const ok = await commandBridge.requestConfirm(`[权限] ${result.reason} (y/n)`);
    if (!ok) { ctx.metadata.permissionDenied = 'User rejected'; return; }
  }
  await next();
});
```

> **执行人注意：** ToolExecutor 执行前检查 `ctx.metadata.permissionDenied`，存在则返回 `{ content: reason, isError: true }`。

### Step 4：测试（6 用例）

deny 规则在 auto 模式下不可绕过；file_read 自动放行；shell_exec 触发 confirm；无匹配 + manual → confirm；通配符 `file_*` 正确匹配。

## Task 2：Goal Gate System（architect-loop 模式）

> **目标：** /goal 分解后冻结验收标准到 `.gates.json`，GoalVerifier 比对冻结 gates。

### Step 1：创建 `src/agent/goal-gates.ts`

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';

export interface Gate {
  id: string;
  criteria: string;
  status: 'pending' | 'passed' | 'failed' | 'skipped';
  evidence?: string;
}

export interface FrozenGates {
  goalText: string;
  frozenAt: number;
  gates: Gate[];
  locked: boolean;
}

export class GoalGateManager {
  private gates: FrozenGates | null = null;
  private gatesDir: string;

  constructor(projectRoot: string) { this.gatesDir = path.join(projectRoot, '.routedev'); }

  async freeze(goalText: string, gates: Gate[]): Promise<FrozenGates> {
    this.gates = { goalText, frozenAt: Date.now(), gates, locked: true };
    await this.persist();
    return this.gates;
  }

  getGates(): FrozenGates | null { return this.gates; }

  updateGate(gateId: string, status: Gate['status'], evidence?: string): boolean {
    const gate = this.gates?.gates.find(g => g.id === gateId);
    if (!gate) return false;
    gate.status = status;
    if (evidence) gate.evidence = evidence;
    return true;
  }

  /** 修改门控需调用方保证已获得用户确认 */
  async modifyGate(gateId: string, newCriteria: string): Promise<boolean> {
    if (!this.gates?.locked) return false;
    const gate = this.gates.gates.find(g => g.id === gateId);
    if (!gate) return false;
    gate.criteria = newCriteria;
    await this.persist();
    return true;
  }

  async load(): Promise<FrozenGates | null> {
    try {
      this.gates = JSON.parse(await fs.readFile(path.join(this.gatesDir, '.gates.json'), 'utf-8'));
      return this.gates;
    } catch { return null; }
  }

  private async persist(): Promise<void> {
    if (!this.gates) return;
    await fs.mkdir(this.gatesDir, { recursive: true });
    await fs.writeFile(path.join(this.gatesDir, '.gates.json'), JSON.stringify(this.gates, null, 2));
  }
}
```

### Step 2：集成到 /goal 命令

计划分解后立即冻结：

```typescript
const gates: Gate[] = plan.steps.map((step, i) => ({
  id: `step-${i + 1}`,
  criteria: step.acceptanceCriteria ?? step,
  status: 'pending' as const,
}));
await gateManager.freeze(goalText, gates);
```

GoalVerifier.verify() 增加可选 gates 参数（保持向后兼容）：
`verify(plan, result, gates?: FrozenGates): Promise<VerificationResult>`

### Step 3：测试（5 用例）

freeze 写入 .gates.json；load 恢复数据；updateGate 更新状态；无文件时 load 返回 null；locked 时 modify 行为正确。

## Task 3：Worker 异常隔离（AgentScope 模式）

> **目标：** Worker 异常永远不崩溃 Orchestrator。可重试/跳过/中止。

### Step 1：定义类型（在 `src/agent/multi/orchestrator.ts`）

```typescript
export type WorkerErrorType = 'tool_failure' | 'llm_error' | 'timeout' | 'permission_denied' | 'unknown';

export interface WorkerError {
  type: WorkerErrorType;
  workerId: string;
  message: string;
  suggestedAction: 'retry' | 'skip' | 'abort';
  retryCount: number;
}

export type WorkerOutcome =
  | { success: true; result: string; workerId: string }
  | { success: false; error: WorkerError };
```

### Step 2：隔离包装器

```typescript
private async executeWorkerIsolated(workerId: string, task: WorkerTask, maxRetries = 2): Promise<WorkerOutcome> {
  let retryCount = 0;
  while (retryCount <= maxRetries) {
    try {
      const result = await this.executeWorker(workerId, task);
      return { success: true, result, workerId };
    } catch (error) {
      retryCount++;
      const errorType = this.classifyWorkerError(error);
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Worker ${workerId} failed (attempt ${retryCount}/${maxRetries + 1})`, { errorType });
      if (retryCount > maxRetries || !this.isRetryable(errorType)) {
        return { success: false, error: {
          type: errorType, workerId, message,
          suggestedAction: this.isRetryable(errorType) ? 'retry' : (errorType === 'unknown' ? 'abort' : 'skip'),
          retryCount: retryCount - 1,
        }};
      }
      await new Promise(r => setTimeout(r, 1000 * retryCount));
    }
  }
  return { success: false, error: { type: 'unknown', workerId, message: 'Unexpected', suggestedAction: 'abort', retryCount } };
}
```

> **执行人注意：** Orchestrator 主循环中将 `executeWorker()` 替换为 `executeWorkerIsolated()`。根据 `suggestedAction`：retry 已内部处理，skip 跳过当前 Worker，abort 中止整个 plan 并返回部分结果。

### Step 3：测试（5 用例）

Worker 抛异常不崩溃 Orchestrator；可重试错误重试 2 次；不可重试立即 skip；permission_denied 不重试；timeout 触发重试后成功返回 success。

## Task 4：对抗性验证（architect-loop 模式）

> **目标：** 完成后用独立 pass 尝试推翻结论，发现问题以 challenges 呈现。

### Step 1：扩展 VerificationResult（在 `src/agent/goal-verifier.ts`）

```typescript
export interface Challenge {
  severity: number;   // 0-1, 1 最严重
  description: string;
  suggestion?: string;
}

// 扩展 VerificationResult：
export interface VerificationResult {
  passed: boolean;
  details: string;
  challenges?: Challenge[];  // 新增
}
```

### Step 2：adversarialCheck 方法

```typescript
async adversarialCheck(
  goalText: string,
  result: string,
  adversarialClient: ILLMClient,
  threshold = 0.5,
): Promise<Challenge[]> {
  const prompt = `你是严格审查员。尝试推翻以下结论。\n\n目标:\n${goalText}\n\n结果:\n${result}\n\n列出有实质意义的质疑，JSON 数组格式: [{severity, description, suggestion}]`;
  const response = await adversarialClient.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
  });
  try {
    const challenges = JSON.parse(response.content) as Challenge[];
    return challenges.filter(c => c.severity >= threshold);
  } catch {
    logger.warn('Adversarial check: parse failed');
    return [];
  }
}
```

在 verify() 中集成（options.adversarial?.enabled 时调用），challenges 作为附加信息不改变 passed 结果。

> **执行人注意：** adversarialClient 用 `fast` tier 模型（与主 Agent 不同）。在 config/schema.ts 中新增 `adversarial?: { enabled, threshold, modelTier? }` 配置项。

### Step 3：测试（5 用例）

正确解析 challenges；threshold 过滤低严重度；无效 JSON 返回空数组；enabled=false 跳过；challenges 不影响 passed。

## Task 5：上下文窗口自动压缩（AgentScope 模式）

> **目标：** 80% token 阈值自动压缩。大工具输出 offload。system prompt 永不压缩。

### Step 1：压缩事件类型（在 `src/agent/memory/context-manager.ts`）

```typescript
export interface CompressionEvent {
  tokensBefore: number;
  tokensAfter: number;
  messagesCompressed: number;
  offloadedOutputs: number;
  timestamp: number;
}
export type CompressionCallback = (event: CompressionEvent) => void;
```

### Step 2：增强 compress() 逻辑

压缩优先级（从先到后）：old_messages → recent_messages → blackboard → goal_context。system_prompt **永不压缩**。

```typescript
async compress(messages: LLMMessage[], options?: { maxTokens?: number; offloadDir?: string }): Promise<{ compressed: LLMMessage[]; result: CompressionEvent }> {
  const maxTokens = options?.maxTokens ?? Math.floor(this.contextWindowLimit * 0.8);
  let currentTokens = this.estimateTotalTokens(messages);
  if (currentTokens <= maxTokens) return { compressed: messages, result: noOpEvent(currentTokens) };

  const tokensBefore = currentTokens;
  let messagesCompressed = 0, offloadedOutputs = 0;
  const result = [...messages];

  // 第一轮：offload 大工具输出（>2000 tokens）
  for (let i = 0; i < result.length; i++) {
    if (result[i].role === 'tool' && this.estimateTokens(result[i].content) > 2000) {
      if (options?.offloadDir) await this.offloadToFile(result[i].content, options.offloadDir, i);
      result[i] = { ...result[i], content: `[offloaded] ${result[i].content.slice(0, 200)}...` };
      offloadedOutputs++;
    }
  }

  // 第二轮：从最老消息开始摘要替换，保留 system prompt (i=0) 和最后 6 条
  const preserveLast = 6;
  for (let i = 1; i < result.length - preserveLast && this.estimateTotalTokens(result) > maxTokens; i++) {
    if (result[i].role !== 'system') {
      result[i] = { ...result[i], content: `[已压缩] ${result[i].content.slice(0, 100)}...` };
      messagesCompressed++;
    }
  }

  const event = { tokensBefore, tokensAfter: this.estimateTotalTokens(result), messagesCompressed, offloadedOutputs, timestamp: Date.now() };
  this.compressionCallbacks.forEach(cb => cb(event));
  return { compressed: result, result: event };
}
```

> **执行人注意：** 在 ReAct Loop 每次 LLM 调用前检查 token 量：`if (totalTokens > limit * 0.8)` 则调用 compress()。offloadDir 使用 `.routedev/offloaded/`。Token 估算复用中文感知函数（Phase 17b）。

### Step 3：测试（6 用例）

低于 80% 不触发；超 80% 压缩老消息；system prompt 不变；大输出被 offload；最近 6 条保留；压缩事件回调触发。

## 验收标准

1. **PermissionEngine** 三层规则正确，deny 不可被 auto 绕过（6 测试）
2. **GoalGateManager** 冻结/加载/修改正确（5 测试）
3. **Worker 隔离** 异常不上溯，重试/跳过/中止逻辑正确（5 测试）
4. **对抗性验证** challenges 解析和过滤正确（5 测试）
5. **上下文压缩** 超 80% 自动压缩，system prompt 不压缩（6 测试）
6. **新增测试 >= 27 个**，全部通过
7. **pnpm build** 和 **pnpm typecheck** 无错误

## 对下一阶段的提醒

1. **PermissionEngine 配置化** — 规则应从 `config.yaml` 的 `security.permissionRules` 加载
2. **Gate 的 LLM 验证** — GoalGateManager 做结构化管理，实际验证 gate criteria 是 GoalVerifier + LLM 的责任
3. **adversarialClient 选择** — 建议 `fast` tier，后续可在配置中指定具体模型
4. **压缩摘要质量** — 当前简单截取，后续可用 LLM 生成高质量摘要（增加延迟）
5. **Worker 幂等性** — 重试假设操作幂等，非幂等操作需在 WorkerTask 标记 `idempotent: boolean`
6. **多进程 RateLimiter** — PermissionEngine 的 confirm 依赖 CommandBridge 用户交互，server 模式需不同确认机制
