# Phase 15：可观测性（Trace 收集 + 审计日志）

**回应**：Phase 14 完成报告的 CONCERN（预计）

| # | CONCERN | 处理 |
|---|---------|------|
| C1 | Orchestrator 分析失败时无日志，静默降级为串行 | **本 Phase 核心**：TraceCollector 记录完整决策链，降级事件可追溯 |
| C2 | Worker 执行过程不透明，出了问题只能看终端输出 | **本 Phase 核心**：每个 Worker 的 ReAct 事件流写入 Trace，可事后回放 |
| C3 | Token 消耗只在 TokenTracker 中统计，无法关联到具体步骤/工具 | 本 Phase 在 Trace 中记录每次 LLM 调用的 usage，关联到 stepId + toolName |
| C4 | 用户确认（approve/deny）没有持久化记录 | **本 Phase 核心**：AuditLogger 记录所有确认事件 |
| C5 | Blackboard 状态变化无历史记录 | AuditLogger 记录 Blackboard 写入事件（key + source + timestamp） |
| C6 | 渠道消息处理无审计 | AuditLogger 记录渠道入站/出站消息摘要 |

---

**目标**：为 RouteDev 建立两套可观测性基础设施——**Trace**（开发调试用，记录 Agent 执行过程的完整事件流）和 **Audit**（合规安全用，记录所有敏感操作的 JSONL 日志）。

**蓝图参考**：第九节 9.4（AuditLogger：审计内容、存储格式、30 天保留）

**前置依赖**：Phase 14（多 Agent 基础——Orchestrator / Worker 产生 Trace 事件源）

---

## 架构说明

可观测性是给系统装"行车记录仪"。Trace 是详细版——记录每一次思考、每一次工具调用、每一次模型响应，方便调试"AI 为什么这么做"。Audit 是精简版——只记录"谁在什么时候做了什么"，方便事后追溯和安全审计。

```
Phase 15 架构全景：

ReActAgentLoop.run()
  │  yield ReActEvent
  │
  ├─→ TraceCollector（被动记录，不干预执行流）
  │     │
  │     ├── 每个事件打时间戳
  │     ├── 关联 sessionId / goalId / stepId / workerRole
  │     ├── 写入内存缓冲区
  │     └── 会话结束时持久化到 {AppData}/traces/{date}/{session}.trace.jsonl
  │
  ├─→ AuditLogger（只记录敏感/关键操作）
  │     │
  │     ├── 文件写入/删除
  │     ├── Shell 命令执行
  │     ├── 用户确认（approve / deny）
  │     ├── 模型路由决策
  │     ├── /goal 开始/结束
  │     ├── /rollback 执行
  │     ├── Blackboard 写入
  │     └── 渠道消息（入站/出站摘要）
  │
  └─→ CLI 查看
        ├── /trace list      — 列出最近的 trace 会话
        ├── /trace view <id> — 回放指定 trace（时间线视图）
        └── /audit list      — 列出今天的审计事件
```

**关键约束**：
- Trace 和 Audit 都是 **旁路记录**——不干预、不阻塞主执行流。写入失败只 log warning，不影响 Agent 正常工作
- Trace 文件使用 JSONL 格式（一行一个事件），支持流式读取大文件
- Audit 文件同样 JSONL，按日期分目录，30 天自动清理
- Trace 事件基于已有的 `ReActEvent`（7 种变体）和 `AgentEvent`（8 种变体），不引入新事件类型
- `ToolExecutorAdapter` 用装饰器模式包装，透明地注入 trace 记录

---

## 具体任务

### Task 1：Trace 类型定义

**文件：** 创建 `src/harness/trace-types.ts`

Trace 系统的数据结构。一个 Trace = 一次完整的 Agent 会话执行记录（包含多个 Span，每个 Span = 一个 ReAct 迭代或一个 Worker 执行）。

- [ ] **Step 1：定义 Trace 核心类型**

```typescript
// src/harness/trace-types.ts
// Trace 系统类型定义（Phase 15）
// 设计目标：记录 Agent 执行的完整事件流，支持事后回放和调试

import type { ReActEvent } from '../agent/loop-config.js';
import type { TokenUsageInfo } from '../router/types.js';

/** Trace 会话——一次完整的用户交互（一次 /goal 或一次 chat） */
export interface TraceSession {
  /** 会话 ID（UUID 短格式） */
  id: string;
  /** 创建时间戳 */
  startTime: number;
  /** 结束时间戳（未结束时为 undefined） */
  endTime?: number;
  /** 关联的 /goal ID（如有） */
  goalId?: string;
  /** 用户输入的原始文本 */
  userInput: string;
  /** 模型路由决策 */
  routeDecision?: {
    modelId: string;
    tier: string;
    fallbackUsed: boolean;
  };
  /** 总 token 消耗（累计） */
  totalUsage?: TokenUsageInfo;
  /** Span 列表（运行时在内存中，持久化时写入 JSONL） */
  spanCount: number;
  /** 是否已结束 */
  completed: boolean;
}

/** Trace Span——一个执行单元（一次 ReAct 迭代 / 一个 Worker 任务 / 一次工具调用） */
export interface TraceSpan {
  /** Span ID（在 Session 内自增） */
  id: number;
  /** 所属 Session ID */
  sessionId: string;
  /** Span 类型 */
  type: 'react_iteration' | 'tool_call' | 'llm_call' | 'worker_task' | 'goal_step';
  /** 开始时间戳 */
  startTime: number;
  /** 结束时间戳 */
  endTime?: number;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 关联的步骤 ID（/goal 步骤） */
  stepId?: number;
  /** 关联的 Worker 角色（多 Agent 模式） */
  workerRole?: string;
  /** 事件负载（根据 type 不同而不同） */
  payload: TraceSpanPayload;
  /** 状态 */
  status: 'running' | 'completed' | 'error' | 'aborted';
  /** 错误信息（如有） */
  error?: string;
}

/** Span 负载——根据 span type 区分 */
export type TraceSpanPayload =
  | {
      type: 'react_iteration';
      iteration: number;
      thought?: string;
      action?: { toolName: string; args: Record<string, unknown> };
      observation?: { result: string; isError: boolean };
    }
  | {
      type: 'tool_call';
      toolName: string;
      toolCallId: string;
      args: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      approvalRequired?: boolean;
      approved?: boolean;
    }
  | {
      type: 'llm_call';
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      responseLength: number;
      toolCallCount: number;
    }
  | {
      type: 'worker_task';
      role: string;
      description: string;
      modifiedFiles: string[];
      conclusion?: string;
    }
  | {
      type: 'goal_step';
      stepId: number;
      description: string;
      totalSteps: number;
    };

/** Trace 事件——写入 JSONL 的一行记录 */
export interface TraceRecord {
  /** 时间戳（ISO 字符串） */
  timestamp: string;
  /** Session ID */
  sessionId: string;
  /** Span ID（可选，某些事件不属于特定 Span） */
  spanId?: number;
  /** 事件类型 */
  event: string;
  /** 事件数据 */
  data: Record<string, unknown>;
}
```

- [ ] **Step 2：定义 Audit 类型**

```typescript
/** 审计事件类型 */
export type AuditAction =
  | 'file_write'
  | 'file_delete'
  | 'shell_exec'
  | 'user_confirm'
  | 'user_deny'
  | 'route_decision'
  | 'goal_start'
  | 'goal_complete'
  | 'goal_fail'
  | 'rollback'
  | 'checkpoint_create'
  | 'blackboard_write'
  | 'channel_message_in'
  | 'channel_message_out'
  | 'permission_change'
  | 'config_change';

/** 审计记录——JSONL 中的一行 */
export interface AuditRecord {
  /** 时间戳（ISO 字符串） */
  timestamp: string;
  /** Session ID */
  sessionId: string;
  /** 操作类型 */
  action: AuditAction;
  /** Agent ID（单 Agent 时为 'main'，多 Agent 时为 worker role） */
  agentId: string;
  /** 操作目标（文件路径、命令、渠道名等） */
  target: string;
  /** 操作详情 */
  details: Record<string, unknown>;
  /** 操作结果 */
  result: 'success' | 'failure' | 'denied' | 'skipped';
  /** 用户确认信息（如有） */
  confirmation?: {
    requested: boolean;
    approved: boolean;
    reason?: string;
  };
}

/** TraceCollector 配置 */
export interface TraceCollectorConfig {
  /** 是否启用 Trace 收集 */
  enabled: boolean;
  /** 单个 Session 最大 Span 数（超出丢弃最旧的） */
  maxSpansPerSession: number;
  /** 存储目录（默认 {AppData}/traces） */
  storageDir?: string;
}

/** AuditLogger 配置 */
export interface AuditLoggerConfig {
  /** 是否启用审计 */
  enabled: boolean;
  /** 保留天数（超出自动清理） */
  retentionDays: number;
  /** 存储目录（默认 {AppData}/audit） */
  storageDir?: string;
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/harness/trace-types.ts
git commit -m "feat(harness): add trace and audit type definitions for Phase 15"
```

---

### Task 2：TraceCollector 核心实现

**文件：** 创建 `src/harness/trace-collector.ts`

TraceCollector 是被动的"行车记录仪"——它监听 ReActEvent 流，将每个事件转换为 TraceSpan 写入缓冲区，不干预执行流。

- [ ] **Step 1：实现 TraceCollector**

```typescript
// src/harness/trace-collector.ts
// Trace 收集器：被动记录 Agent 执行过程的事件流
// 设计原则：旁路记录，不阻塞、不干预、写入失败只 warn
//
// 工作流程：
//   1. 会话开始时 startSession()
//   2. 每个 ReActEvent 通过 recordEvent() 记录
//   3. 工具调用通过 recordToolCall() / recordToolResult() 记录
//   4. LLM 调用通过 recordLLMCall() 记录
//   5. 会话结束时 endSession() 持久化到磁盘

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ReActEvent } from '../agent/loop-config.js';
import type { TokenUsageInfo, RoutingResult } from '../router/types.js';
import type {
  TraceSession,
  TraceSpan,
  TraceRecord,
  TraceCollectorConfig,
} from './trace-types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

const DEFAULT_CONFIG: TraceCollectorConfig = {
  enabled: true,
  maxSpansPerSession: 500,
};

export class TraceCollector {
  private config: TraceCollectorConfig;
  private currentSession: TraceSession | null = null;
  private spans: TraceSpan[] = [];
  private spanCounter = 0;

  constructor(config?: Partial<TraceCollectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 开始新的 Trace 会话 */
  startSession(userInput: string, routeDecision?: RoutingResult): string {
    const id = crypto.randomUUID().slice(0, 8);
    this.currentSession = {
      id,
      startTime: Date.now(),
      userInput: userInput.slice(0, 200), // 截断避免过大
      routeDecision: routeDecision
        ? {
            modelId: routeDecision.model.id,
            tier: routeDecision.model.tier,
            fallbackUsed: routeDecision.fallbackUsed,
          }
        : undefined,
      spanCount: 0,
      completed: false,
    };
    this.spans = [];
    this.spanCounter = 0;

    logger.debug('Trace session started', { sessionId: id });
    return id;
  }

  /** 记录 ReAct 事件（从 AsyncGenerator 流中旁路记录） */
  recordEvent(event: ReActEvent): void {
    if (!this.config.enabled || !this.currentSession) return;

    try {
      const record: TraceRecord = {
        timestamp: new Date().toISOString(),
        sessionId: this.currentSession.id,
        event: event.type,
        data: this.extractEventData(event),
      };

      // 根据事件类型创建/更新 Span
      switch (event.type) {
        case 'thinking':
          this.startSpan('react_iteration', {
            thought: event.message,
          });
          break;

        case 'tool_call_start':
          this.startSpan('tool_call', {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
          });
          break;

        case 'tool_call_result':
          this.completeCurrentSpan('tool_call', {
            result: event.result.slice(0, 500), // 截断
            isError: event.isError,
          });
          break;

        case 'done':
          this.recordUsage(event.usage);
          break;

        case 'error':
          this.failCurrentSpan(event.error);
          break;

        // text_delta 和 approval_required 只写 record，不创建 span
      }

      // 异步写入（不阻塞主流程）
      this.writeRecord(record);
    } catch (err) {
      logger.warn('TraceCollector: failed to record event', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 记录工具调用（供 ToolExecutor 装饰器调用） */
  recordToolCall(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    approvalRequired: boolean,
  ): void {
    if (!this.config.enabled || !this.currentSession) return;

    const span = this.startSpan('tool_call', {
      type: 'tool_call' as const,
      toolName,
      toolCallId: toolCallId,
      args,
      approvalRequired,
    });

    this.writeRecord({
      timestamp: new Date().toISOString(),
      sessionId: this.currentSession.id,
      spanId: span.id,
      event: 'tool_call_start',
      data: { toolName, args, approvalRequired },
    });
  }

  /** 记录工具结果 */
  recordToolResult(
    toolName: string,
    toolCallId: string,
    result: string,
    isError: boolean,
    approved?: boolean,
  ): void {
    if (!this.config.enabled || !this.currentSession) return;

    this.completeCurrentSpan('tool_call', {
      type: 'tool_call' as const,
      toolName,
      toolCallId,
      result: result.slice(0, 500),
      isError,
      approved,
    });

    this.writeRecord({
      timestamp: new Date().toISOString(),
      sessionId: this.currentSession!.id,
      event: 'tool_call_end',
      data: { toolName, toolCallId, isError, approved },
    });
  }

  /** 记录 LLM 调用完成 */
  recordLLMCall(
    modelId: string,
    usage: TokenUsageInfo,
    responseLength: number,
    toolCallCount: number,
  ): void {
    if (!this.config.enabled || !this.currentSession) return;

    const span = this.startSpan('llm_call', {
      type: 'llm_call' as const,
      modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      responseLength,
      toolCallCount,
    });
    this.completeSpan(span.id, 'completed');
  }

  /** 记录 Worker 任务（多 Agent 模式） */
  recordWorkerTask(
    role: string,
    description: string,
    stepId: number,
  ): number {
    if (!this.config.enabled || !this.currentSession) return -1;

    const span = this.startSpan('worker_task', {
      type: 'worker_task' as const,
      role,
      description,
      modifiedFiles: [],
    });
    span.stepId = stepId;
    span.workerRole = role;
    return span.id;
  }

  /** 完成 Worker 任务记录 */
  completeWorkerTask(
    spanId: number,
    success: boolean,
    conclusion: string,
    modifiedFiles: string[],
  ): void {
    if (!this.config.enabled || !this.currentSession) return;

    const span = this.spans.find(s => s.id === spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = success ? 'completed' : 'error';
    if (span.payload.type === 'worker_task') {
      span.payload.conclusion = conclusion.slice(0, 300);
      span.payload.modifiedFiles = modifiedFiles;
    }
  }

  /** 记录 Goal 步骤 */
  recordGoalStep(stepId: number, description: string, totalSteps: number): number {
    if (!this.config.enabled || !this.currentSession) return -1;

    const span = this.startSpan('goal_step', {
      type: 'goal_step' as const,
      stepId,
      description: description.slice(0, 200),
      totalSteps,
    });
    span.stepId = stepId;
    return span.id;
  }

  /** 结束会话并持久化 */
  async endSession(totalUsage?: TokenUsageInfo): Promise<void> {
    if (!this.currentSession) return;

    this.currentSession.endTime = Date.now();
    this.currentSession.completed = true;
    this.currentSession.spanCount = this.spans.length;
    this.currentSession.totalUsage = totalUsage;

    try {
      await this.flushToDisk();
      logger.debug('Trace session ended', {
        sessionId: this.currentSession.id,
        spans: this.spans.length,
      });
    } catch (err) {
      logger.warn('TraceCollector: failed to flush session', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.currentSession = null;
    this.spans = [];
  }

  /** 获取当前 Session ID */
  getSessionId(): string | null {
    return this.currentSession?.id ?? null;
  }

  /** 获取当前 Session 的 Span 列表（用于 /trace view） */
  getSpans(): TraceSpan[] {
    return [...this.spans];
  }

  /** 列出磁盘上的 Trace 会话 */
  async listSessions(limit = 20): Promise<TraceSession[]> {
    const dir = this.getStorageDir();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dayDir = path.join(dir, today);
      const files = await fs.readdir(dayDir);
      const sessions: TraceSession[] = [];

      for (const file of files) {
        if (!file.endsWith('.session.json')) continue;
        try {
          const content = await fs.readFile(path.join(dayDir, file), 'utf-8');
          sessions.push(JSON.parse(content));
        } catch {
          // 跳过损坏的文件
        }
      }

      return sessions
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /** 读取指定 Session 的 Trace 记录（从 JSONL 文件） */
  async readSessionRecords(sessionId: string): Promise<TraceRecord[]> {
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, today, `${sessionId}.trace.jsonl`);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  // ===== 内部方法 =====

  private startSpan(type: TraceSpan['type'], payload: TraceSpan['payload']): TraceSpan {
    this.spanCounter++;

    // 超出限制丢弃最旧的
    if (this.spans.length >= this.config.maxSpansPerSession) {
      this.spans.shift();
    }

    const span: TraceSpan = {
      id: this.spanCounter,
      sessionId: this.currentSession!.id,
      type,
      startTime: Date.now(),
      payload,
      status: 'running',
    };
    this.spans.push(span);
    return span;
  }

  private completeCurrentSpan(
    type: TraceSpan['type'],
    payloadUpdate: Partial<TraceSpan['payload']>,
  ): void {
    // 找最后一个匹配类型的 running span
    const span = [...this.spans]
      .reverse()
      .find(s => s.type === type && s.status === 'running');
    if (!span) return;

    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = 'completed';
    Object.assign(span.payload, payloadUpdate);
  }

  private completeSpan(spanId: number, status: TraceSpan['status']): void {
    const span = this.spans.find(s => s.id === spanId);
    if (!span) return;
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = status;
  }

  private failCurrentSpan(error: string): void {
    const span = [...this.spans]
      .reverse()
      .find(s => s.status === 'running');
    if (!span) return;
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = 'error';
    span.error = error;
  }

  private recordUsage(usage: TokenUsageInfo): void {
    if (this.currentSession) {
      this.currentSession.totalUsage = usage;
    }
  }

  private extractEventData(event: ReActEvent): Record<string, unknown> {
    // 将 ReActEvent 转为可序列化的 plain object
    // 截断长文本避免文件过大
    switch (event.type) {
      case 'text_delta':
        return { textLength: event.text.length };
      case 'thinking':
        return { message: event.message.slice(0, 300) };
      case 'tool_call_start':
        return { toolName: event.toolName, toolCallId: event.toolCallId };
      case 'tool_call_result':
        return {
          toolName: event.toolName,
          isError: event.isError,
          resultLength: event.result.length,
        };
      case 'approval_required':
        return { toolName: event.toolName, reason: event.reason };
      case 'error':
        return { error: event.error };
      case 'done':
        return { contentLength: event.content.length };
      default:
        return {};
    }
  }

  private writeRecord(record: TraceRecord): void {
    // Fire-and-forget：异步写入不阻塞主流程
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);
    const filePath = path.join(dayDir, `${record.sessionId}.trace.jsonl`);

    ensureDir(dayDir);
    fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8').catch(err => {
      logger.warn('TraceCollector: write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async flushToDisk(): Promise<void> {
    if (!this.currentSession) return;

    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);
    ensureDir(dayDir);

    // 写入 Session 摘要
    const sessionPath = path.join(dayDir, `${this.currentSession.id}.session.json`);
    await fs.writeFile(
      sessionPath,
      JSON.stringify(this.currentSession, null, 2),
      'utf-8',
    );

    // Span 列表写入单独文件（方便快速查看）
    const spansPath = path.join(dayDir, `${this.currentSession.id}.spans.json`);
    await fs.writeFile(
      spansPath,
      JSON.stringify(this.spans, null, 2),
      'utf-8',
    );
  }

  private getStorageDir(): string {
    return this.config.storageDir
      ?? path.join(getAppDataDir(), 'traces');
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/harness/trace-collector.ts
git commit -m "feat(harness): implement TraceCollector for agent execution recording"
```

---

### Task 3：AuditLogger 实现

**文件：** 创建 `src/harness/audit-logger.ts`

AuditLogger 记录所有敏感/关键操作，按蓝图 9.4 规格存储。

- [ ] **Step 1：实现 AuditLogger**

```typescript
// src/harness/audit-logger.ts
// 审计日志器：记录所有敏感操作到 JSONL
// 蓝图参考：第九节 9.4 AuditLogger
//
// 存储结构：
//   {AppData}/audit/{date}/{session-id}.audit.jsonl
//
// 保留期限：配置 retentionDays（默认 30），超出自动清理
// 写入方式：fire-and-forget appendFile，失败只 warn

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuditRecord, AuditAction, AuditLoggerConfig } from './trace-types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

const DEFAULT_CONFIG: AuditLoggerConfig = {
  enabled: true,
  retentionDays: 30,
};

export class AuditLogger {
  private config: AuditLoggerConfig;
  private sessionId: string;

  constructor(sessionId: string, config?: Partial<AuditLoggerConfig>) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 记录一条审计事件 */
  log(
    action: AuditAction,
    target: string,
    details: Record<string, unknown>,
    result: AuditRecord['result'] = 'success',
    agentId = 'main',
    confirmation?: AuditRecord['confirmation'],
  ): void {
    if (!this.config.enabled) return;

    const record: AuditRecord = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      action,
      agentId,
      target,
      details,
      result,
      confirmation,
    };

    this.writeRecord(record);
  }

  /** 快捷方法：记录文件操作 */
  logFileWrite(filePath: string, agentId = 'main'): void {
    this.log('file_write', filePath, { operation: 'write' }, 'success', agentId);
  }

  /** 快捷方法：记录 Shell 命令 */
  logShellExec(command: string, agentId = 'main'): void {
    this.log('shell_exec', command, { commandLength: command.length }, 'success', agentId);
  }

  /** 快捷方法：记录用户确认 */
  logUserConfirm(toolName: string, approved: boolean, reason?: string): void {
    this.log(
      approved ? 'user_confirm' : 'user_deny',
      toolName,
      { reason },
      approved ? 'success' : 'denied',
      'main',
      { requested: true, approved, reason },
    );
  }

  /** 快捷方法：记录路由决策 */
  logRouteDecision(modelId: string, tier: string, fallbackUsed: boolean): void {
    this.log('route_decision', modelId, { tier, fallbackUsed }, 'success');
  }

  /** 快捷方法：记录 Goal 生命周期 */
  logGoalStart(goalId: string, description: string, stepCount: number): void {
    this.log('goal_start', goalId, { description: description.slice(0, 100), stepCount });
  }

  logGoalComplete(goalId: string, success: boolean): void {
    this.log(
      success ? 'goal_complete' : 'goal_fail',
      goalId,
      {},
      success ? 'success' : 'failure',
    );
  }

  /** 快捷方法：记录回滚 */
  logRollback(checkpointId: string, commitHash: string): void {
    this.log('rollback', checkpointId, { commitHash });
  }

  /** 快捷方法：记录 Blackboard 写入（多 Agent） */
  logBlackboardWrite(key: string, sourceRole: string, stepId: number): void {
    this.log('blackboard_write', key, { sourceRole, stepId });
  }

  /** 快捷方法：记录渠道消息 */
  logChannelMessage(
    direction: 'in' | 'out',
    channelType: string,
    sender: string,
    textLength: number,
  ): void {
    const action: AuditAction = direction === 'in' ? 'channel_message_in' : 'channel_message_out';
    this.log(action, channelType, { sender, textLength });
  }

  /** 清理过期的审计文件 */
  async cleanup(): Promise<number> {
    const dir = this.getStorageDir();
    let removedCount = 0;

    try {
      const entries = await fs.readdir(dir);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.config.retentionDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      for (const entry of entries) {
        // 目录名是日期格式 YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
        if (entry < cutoffStr) {
          const dayDir = path.join(dir, entry);
          try {
            await fs.rm(dayDir, { recursive: true, force: true });
            removedCount++;
          } catch {
            logger.warn('AuditLogger: failed to remove old directory', { dir: dayDir });
          }
        }
      }
    } catch {
      // 目录不存在，忽略
    }

    if (removedCount > 0) {
      logger.info('AuditLogger: cleaned up old records', {
        removedDays: removedCount,
        retentionDays: this.config.retentionDays,
      });
    }

    return removedCount;
  }

  /** 列出今天的审计记录（按时间倒序） */
  async listToday(limit = 50): Promise<AuditRecord[]> {
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);

    try {
      const files = await fs.readdir(dayDir);
      const records: AuditRecord[] = [];

      for (const file of files) {
        if (!file.endsWith('.audit.jsonl')) continue;
        const content = await fs.readFile(path.join(dayDir, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            records.push(JSON.parse(line));
          } catch {
            // 跳过损坏的行
          }
        }
      }

      return records
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /** 按 action 类型过滤审计记录 */
  async listByAction(action: AuditAction, limit = 50): Promise<AuditRecord[]> {
    const all = await this.listToday(200);
    return all.filter(r => r.action === action).slice(0, limit);
  }

  // ===== 内部方法 =====

  private writeRecord(record: AuditRecord): void {
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);
    ensureDir(dayDir);

    const filePath = path.join(dayDir, `${this.sessionId}.audit.jsonl`);
    fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8').catch(err => {
      logger.warn('AuditLogger: write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private getStorageDir(): string {
    return this.config.storageDir
      ?? path.join(getAppDataDir(), 'audit');
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/harness/audit-logger.ts
git commit -m "feat(harness): implement AuditLogger with JSONL format and 30-day retention"
```

---

### Task 4：TracingToolExecutor 装饰器

**文件：** 创建 `src/harness/tracing-executor.ts`

用装饰器模式包装 `ToolExecutorAdapter`，在工具执行前后自动注入 Trace 和 Audit 记录。这样不需要修改 `ReActAgentLoop` 或 `ToolRegistryAdapter` 的代码。

- [ ] **Step 1：实现装饰器**

```typescript
// src/harness/tracing-executor.ts
// 装饰器：透明地为 ToolExecutorAdapter 注入 Trace + Audit 记录
// 不修改原有代码，只在外部包装一层

import type { ToolExecutorAdapter } from '../agent/loop-config.js';
import type { LLMToolDefinition } from '../router/types.js';
import type { TraceCollector } from './trace-collector.js';
import type { AuditLogger } from './audit-logger.js';
import { logger } from '../utils/logger.js';

/** 敏感工具列表——这些工具的操作会被记录到审计日志 */
const AUDITED_TOOLS = new Set([
  'file_write',
  'file_delete',
  'shell_exec',
  'git_op',
]);

export class TracingToolExecutor implements ToolExecutorAdapter {
  private inner: ToolExecutorAdapter;
  private trace: TraceCollector;
  private audit: AuditLogger;
  private agentId: string;

  constructor(
    inner: ToolExecutorAdapter,
    trace: TraceCollector,
    audit: AuditLogger,
    agentId = 'main',
  ) {
    this.inner = inner;
    this.trace = trace;
    this.audit = audit;
    this.agentId = agentId;
  }

  getToolDefinitions(): LLMToolDefinition[] {
    return this.inner.getToolDefinitions();
  }

  hasTool(toolName: string): boolean {
    return this.inner.hasTool(toolName);
  }

  async executeTool(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    // Trace: 记录工具调用开始
    this.trace.recordToolCall(toolName, args, toolCallId, false);

    const startTime = Date.now();

    try {
      const result = await this.inner.executeTool(toolName, toolCallId, args);
      const durationMs = Date.now() - startTime;

      // Trace: 记录工具结果
      this.trace.recordToolResult(toolName, toolCallId, result, false);

      // Audit: 敏感工具记录
      if (AUDITED_TOOLS.has(toolName)) {
        const target = this.extractTarget(toolName, args);
        if (toolName === 'shell_exec') {
          this.audit.logShellExec(target, this.agentId);
        } else {
          this.audit.logFileWrite(target, this.agentId);
        }
      }

      logger.debug('Tool executed (traced)', {
        toolName,
        durationMs,
        resultLength: result.length,
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Trace: 记录错误
      this.trace.recordToolResult(toolName, toolCallId, errorMsg, true);

      // Audit: 失败也记录
      if (AUDITED_TOOLS.has(toolName)) {
        const target = this.extractTarget(toolName, args);
        this.audit.log(toolName === 'shell_exec' ? 'shell_exec' : 'file_write',
          target, { error: errorMsg }, 'failure', this.agentId);
      }

      throw error;
    }
  }

  /** 更新内部 executor（当工具注册表变化时） */
  updateInner(inner: ToolExecutorAdapter): void {
    this.inner = inner;
  }

  /** 从工具参数中提取操作目标（文件路径、命令等） */
  private extractTarget(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'file_write':
      case 'file_read':
      case 'file_delete':
        return String(args['filePath'] ?? args['path'] ?? 'unknown');
      case 'shell_exec':
        return String(args['command'] ?? 'unknown');
      case 'git_op':
        return `git ${args['operation'] ?? 'unknown'}`;
      default:
        return toolName;
    }
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/harness/tracing-executor.ts
git commit -m "feat(harness): add TracingToolExecutor decorator for transparent trace+audit"
```

---

### Task 5：App.tsx 集成

**文件：** 修改 `src/cli/App.tsx`

将 TraceCollector 和 AuditLogger 集成到 CLI 主循环中。

- [ ] **Step 1：初始化 Trace + Audit**

在 App 组件的 useRef 初始化区域添加：

```typescript
import { TraceCollector } from '../harness/trace-collector.js';
import { AuditLogger } from '../harness/audit-logger.js';
import { TracingToolExecutor } from '../harness/tracing-executor.js';

// useRef 初始化区域：
const traceRef = useRef(new TraceCollector({ enabled: true, maxSpansPerSession: 500 }));
const auditRef = useRef<AuditLogger | null>(null); // sessionId 后初始化
```

在 useEffect 初始化中：

```typescript
useEffect(() => {
  // ... 已有的初始化 ...

  // 初始化审计日志器（sessionId 在首次 chat 时生成）
  const sessionId = crypto.randomUUID().slice(0, 8);
  auditRef.current = new AuditLogger(sessionId);
  // 启动时清理过期审计记录
  auditRef.current.cleanup().catch(() => {});
}, []);
```

- [ ] **Step 2：在 handleSubmit 中注入 Trace**

在每次 chat 的 ReAct loop 调用前后：

```typescript
// handleSubmit 开头，routeDecision 获取之后：
const sessionId = traceRef.current.startSession(text, routeDecision);
// 延迟初始化 auditRef（如果还没有 sessionId）
if (!auditRef.current) {
  auditRef.current = new AuditLogger(sessionId);
}
auditRef.current.logRouteDecision(
  routeDecision.model.id,
  routeDecision.model.tier,
  routeDecision.fallbackUsed,
);

// 用 TracingToolExecutor 包装工具执行器
const tracingExecutor = new TracingToolExecutor(
  toolExecutorRef.current,
  traceRef.current,
  auditRef.current,
);

// 将 tracingExecutor 传给 ReAct loop（替代原来的 toolExecutorRef.current）
// 注意：agentLoopRef.current.updateToolExecutor(tracingExecutor)

// for await 循环中，每个 event 旁路记录：
for await (const event of agentLoopRef.current.run({...})) {
  traceRef.current.recordEvent(event);  // ← Phase 15 新增：旁路记录
  // ... 原有的事件处理逻辑不变 ...
}

// 循环结束后：
await traceRef.current.endSession(usage);
```

- [ ] **Step 3：在 executeGoalPlan 中注入 Trace + Audit**

```typescript
// executeGoalPlan 开头：
const sessionId = traceRef.current.startSession(
  `Goal: ${plan.description}`,
  undefined,
);
auditRef.current?.logGoalStart(plan.id, plan.description, plan.steps.length);

// 每个步骤循环中：
const goalSpanId = traceRef.current.recordGoalStep(
  step.id, step.description, plan.steps.length,
);

// 步骤执行结束后：
traceRef.current.completeSpan(goalSpanId, step.status === 'completed' ? 'completed' : 'error');

// executeGoalPlan 结束时：
const goalSuccess = plan.status === 'completed';
auditRef.current?.logGoalComplete(plan.id, goalSuccess);
await traceRef.current.endSession();
```

- [ ] **Step 4：在 handleToolConfirm 中注入 Audit**

```typescript
// handleToolConfirm 回调中：
const handleToolConfirm: ConfirmToolCallback = async (toolName, args) => {
  // ... 原有的确认逻辑 ...
  const approved = /* 用户选择 */;

  // Phase 15 新增：记录确认结果
  auditRef.current?.logUserConfirm(toolName, approved);

  return approved;
};
```

- [ ] **Step 5：在 /rollback 中注入 Audit**

```typescript
// /rollback 确认后执行时：
auditRef.current?.logRollback(checkpoint.id, checkpoint.gitCommitHash);
```

- [ ] **Step 6：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): integrate TraceCollector and AuditLogger into CLI main loop"
```

---

### Task 6：/trace + /audit CLI 命令

**文件：** 修改 `src/cli/App.tsx`

新增查看 Trace 和 Audit 记录的命令。

- [ ] **Step 1：/trace 命令**

```typescript
case '/trace': {
  const subCmd = parts[1]?.toLowerCase();

  switch (subCmd) {
    case 'list':
    case undefined: {
      const sessions = await traceRef.current.listSessions(10);
      if (sessions.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '没有 Trace 记录。',
        }]);
      } else {
        const lines = sessions.map((s, i) => {
          const time = new Date(s.startTime).toLocaleString('zh-CN');
          const duration = s.endTime
            ? `${((s.endTime - s.startTime) / 1000).toFixed(1)}s`
            : '进行中';
          const usage = s.totalUsage
            ? `${s.totalUsage.inputTokens + s.totalUsage.outputTokens} tokens`
            : '-';
          const model = s.routeDecision?.modelId ?? '-';
          return `  ${i + 1}. [${s.id}] ${time} | ${duration} | ${s.spanCount} spans | ${usage} | ${model}\n     ${s.userInput.slice(0, 60)}`;
        });
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `Trace 会话列表 (${sessions.length}):\n${lines.join('\n')}`,
        }]);
      }
      break;
    }

    case 'view': {
      const traceId = parts[2];
      if (!traceId) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '用法：/trace view <session-id>',
        }]);
        break;
      }

      const records = await traceRef.current.readSessionRecords(traceId);
      if (records.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `找不到 Trace ${traceId} 的记录。`,
        }]);
        break;
      }

      // 时间线视图：显示关键事件
      const timeline = records.slice(0, 30).map(r => {
        const time = new Date(r.timestamp).toLocaleTimeString('zh-CN');
        return `  ${time} [${r.event}] ${JSON.stringify(r.data).slice(0, 80)}`;
      });
      const more = records.length > 30 ? `\n  ... 还有 ${records.length - 30} 条记录` : '';
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `Trace ${traceId} 时间线 (${records.length} 条):\n${timeline.join('\n')}${more}`,
      }]);
      break;
    }

    default:
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          'Trace 命令：',
          '  /trace list       - 列出最近的 Trace 会话',
          '  /trace view <id>  - 查看指定会话的事件时间线',
        ].join('\n'),
      }]);
  }
  break;
}
```

- [ ] **Step 2：/audit 命令**

```typescript
case '/audit': {
  const subCmd = parts[1]?.toLowerCase();

  if (!auditRef.current) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '审计日志未初始化。',
    }]);
    break;
  }

  switch (subCmd) {
    case 'list':
    case undefined: {
      const records = await auditRef.current.listToday(20);
      if (records.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '今天没有审计记录。',
        }]);
      } else {
        const lines = records.map(r => {
          const time = new Date(r.timestamp).toLocaleTimeString('zh-CN');
          return `  ${time} [${r.action}] ${r.target} → ${r.result} (${r.agentId})`;
        });
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `今日审计记录 (${records.length} 条):\n${lines.join('\n')}`,
        }]);
      }
      break;
    }

    case 'files': {
      const records = await auditRef.current.listByAction('file_write', 20);
      if (records.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '今天没有文件写入记录。',
        }]);
      } else {
        const lines = records.map(r => {
          const time = new Date(r.timestamp).toLocaleTimeString('zh-CN');
          return `  ${time} ${r.target} (${r.agentId})`;
        });
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `文件操作记录 (${records.length} 条):\n${lines.join('\n')}`,
        }]);
      }
      break;
    }

    case 'commands': {
      const records = await auditRef.current.listByAction('shell_exec', 20);
      if (records.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '今天没有 Shell 命令记录。',
        }]);
      } else {
        const lines = records.map(r => {
          const time = new Date(r.timestamp).toLocaleTimeString('zh-CN');
          return `  ${time} ${r.target.slice(0, 60)} → ${r.result}`;
        });
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `Shell 命令记录 (${records.length} 条):\n${lines.join('\n')}`,
        }]);
      }
      break;
    }

    default:
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          '审计命令：',
          '  /audit list       - 查看今天的所有审计记录',
          '  /audit files      - 查看文件操作记录',
          '  /audit commands   - 查看 Shell 命令记录',
        ].join('\n'),
      }]);
  }
  break;
}
```

- [ ] **Step 3：更新 /help**

在 /help 输出中添加：

```
  /trace list/view   - 查看 Agent 执行 Trace
  /audit list/files  - 查看审计日志
```

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): add /trace and /audit commands for observability"
```

---

### Task 7：单元测试

**文件：** 创建 `tests/harness/trace-collector.test.ts`、`tests/harness/audit-logger.test.ts`、`tests/harness/tracing-executor.test.ts`

- [ ] **Step 1：TraceCollector 测试（8 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | startSession 返回 ID | sessionId 为 8 字符字符串 |
| 2 | recordEvent 记录 ReActEvent | thinking 事件创建 react_iteration span |
| 3 | recordToolCall + recordToolResult | tool_call span 状态从 running → completed |
| 4 | recordLLMCall | llm_call span 包含正确的 token 数据 |
| 5 | endSession 持久化到磁盘 | session.json 和 trace.jsonl 文件存在且内容正确 |
| 6 | listSessions 列出历史会话 | 返回按时间倒序的 session 列表 |
| 7 | maxSpansPerSession 限制 | 超出时丢弃最旧的 span |
| 8 | disabled 模式 | enabled: false 时不创建任何 span 或文件 |

- [ ] **Step 2：AuditLogger 测试（6 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | log 写入 JSONL | 文件格式正确，一行一条记录 |
| 2 | 快捷方法（logFileWrite / logShellExec） | action 和 target 字段正确 |
| 3 | logUserConfirm | confirmation 字段包含 requested/approved |
| 4 | listToday 读取记录 | 返回按时间倒序的记录 |
| 5 | listByAction 过滤 | 只返回匹配 action 的记录 |
| 6 | cleanup 清理过期文件 | 创建过期日期目录 → cleanup 后目录被删除 |

- [ ] **Step 3：TracingToolExecutor 测试（5 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | 透明代理 getToolDefinitions | 返回与 inner 相同的定义列表 |
| 2 | executeTool 正常执行 | inner.executeTool 被调用，trace 记录了 start + result |
| 3 | executeTool 异常传播 | 错误被 throw，trace 记录了 isError: true |
| 4 | 敏感工具触发审计 | file_write 执行后 audit 有对应记录 |
| 5 | 非敏感工具不审计 | file_read 执行后 audit 无记录 |

- [ ] **Step 4：运行全部测试 → 提交**

```powershell
npx vitest run
# 预期：至少 19 个新测试通过（8 + 6 + 5）
# 累计测试数：Phase 13 的 256 + 19 = 275+

pnpm build
pnpm typecheck
git add tests/harness/
git commit -m "test(harness): add TraceCollector, AuditLogger, TracingToolExecutor unit tests"
git push origin main
```

---

## 接口对齐观察表

以下签名已通过 Explore agent 对实际代码库验证（Phase 14 完成后基线）：

| 接口 | 文件 | 签名 | 本 Phase 引用方式 |
|------|------|------|-------------------|
| `ReActEvent` | `src/agent/loop-config.ts` | 7 种变体的 discriminated union | TraceCollector.recordEvent() 的入参 |
| `ToolExecutorAdapter` | `src/agent/loop-config.ts` | `getToolDefinitions()` / `executeTool()` / `hasTool()` | TracingToolExecutor 实现此接口 |
| `RoutingResult` | `src/router/types.ts` | `{ model: ModelConfig, providerId, fallbackUsed, degraded }` | TraceSession.routeDecision 提取字段 |
| `TokenUsageInfo` | `src/router/types.ts` | `{ inputTokens, outputTokens }` | TraceSession.totalUsage / TraceSpan payload |
| `ILLMClient` | `src/router/types.ts` | `complete()` / `stream()` / `isReady()` | 不直接使用（通过 ReAct loop） |
| `logger` | `src/utils/logger.ts` | winston createLogger singleton | `import { logger } from '../utils/logger.js'` |
| `getAppDataDir()` | `src/utils/paths.ts` | `() => string` | Trace 和 Audit 存储根目录 |
| `ensureDir()` | `src/utils/paths.ts` | `(string) => void` | 创建日期子目录 |
| `ReActAgentLoop.run()` | `src/agent/loop.ts` | `async *run(params): AsyncGenerator<ReActEvent>` | 事件流旁路记录点 |
| `ReActAgentLoop.updateToolExecutor()` | `src/agent/loop.ts` | `(executor: ToolExecutorAdapter) => void` | 注入 TracingToolExecutor |
| `ConfirmToolCallback` | `src/agent/loop-config.ts` | `(toolName, args) => Promise<boolean>` | handleToolConfirm 中注入 audit |
| `GoalPlan` | `src/agent/goal-types.ts` | `{ id, description, steps, status }` | auditRef.logGoalStart/Complete |

---

## 对下一阶段的提醒

1. **Trace 文件可能很大**：长时间 /goal 执行可能产生数千条 JSONL 记录。后续可加 gzip 压缩或自动归档
2. **Trace 跨日期**：如果会话跨过午夜，JSONL 写入当天的目录但 session 可能跨两天。当前按写入时间决定目录，不影响完整性
3. **Audit cleanup 只在启动时执行**：长时间运行的 serve 模式应加定时器（如每天凌晨清理一次）
4. **TracingToolExecutor 不记录 file_read**：只审计写操作。如果未来需要全量审计，把 AUDITED_TOOLS 改为可配置
5. **Trace 并发安全**：当前单 Session 单 TraceCollector。多 Agent 并行 Worker 共享同一个 collector，span 交错写入——这是设计意图（一个时间线包含所有 Worker），但 span 的 workerRole 字段是区分来源的关键
6. **/trace view 截断 30 条**：大 trace 应支持分页或过滤，后续优化
7. **与 CheckpointWriter 的 TokenTracker 集成**：当前 Trace 和 TokenTracker（src/router/tracker.ts）是两套独立的记录系统。后续可统一为 Trace 记录 token 消耗，TokenTracker 只做配额管理
