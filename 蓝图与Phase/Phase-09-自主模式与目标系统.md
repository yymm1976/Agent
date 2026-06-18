# Phase 9：自主模式 + /goal 命令

**回应**：Phase 6/7/8 综合报告的 CONCERN

| # | CONCERN | 处理 |
|---|---------|------|
| C1 | `ITool.validateArgs()` 实际返回 `{ valid, errors }`，非 spec 中的 `string \| null` | Phase 9 的工具相关代码沿用 `{ valid, errors }` 签名 |
| C2 | `IToolRegistry.unregister()` 返回 `void`，非 `boolean` | Phase 9 不依赖 unregister 返回值 |
| C3 | `ToolCategory` 已扩展含 `'mcp'` | Phase 9 新增的 GoalParser/Verifier 不涉及工具注册 |
| C4 | 权限确认 UI 当前 confirm 级别自动放行 | **本 Phase 核心任务**：实现交互式确认 |
| C5 | 对话历史硬截断 20 条 | Phase 9 暂不改变，留待 Phase 11 增量 Checkpoint |

---

**目标**：实现三种自主度模式（auto/semi/manual）的运行时切换与工具调用交互式确认，实现 /goal 命令（目标分解→逐步执行→独立验证），实现 /auto /semi /manual 模式切换命令。

**蓝图参考**：第七节 7.2（自主度控制 AutonomyController）、7.3（/goal 命令与目标分解）、7.4（GoalVerifier）

**前置依赖**：Phase 5（ReActAgentLoop）+ Phase 6-8（工具系统全部就位）

---

## 架构说明

Phase 9 做两件事：**自主度控制**（控制"什么时候需要人确认"）和**目标系统**（让 Agent 按步骤完成复杂任务）。

```
Phase 8 之后的状态：
  ReActAgentLoop → ToolRegistryAdapter → ToolRegistry（7 个内置工具 + MCP 工具）
  PermissionChecker（autoApproveConfirm: true，所有 confirm 自动放行）
  CLI 命令：/help /status /clear /quit /mcp

Phase 9 新增：
  1. 自主度控制
     /auto /semi /manual → AutonomyMode state（运行时可切换）
     PermissionChecker.setAutonomyMode() → 按模式决定是否放行
     ReActAgentLoop.run() 新增 onConfirmTool 回调 → CLI 拦截用户输入作为确认
     确认 UX：显示操作内容 → 用户输入 y/n → 继续或跳过

  2. 目标系统
     /goal "描述" --verify "条件"
       → GoalParser（LLM 分解为步骤列表）
       → 展示步骤卡片 → 用户确认
       → 逐步执行（每步走 ReActAgentLoop）
       → GoalVerifier（独立 LLM 验证完成度）
```

**关键约束**：
- 自主模式状态在 **会话内生效**，不持久化（重启恢复 config.yaml 的 defaultMode）
- 确认回调是 **异步** 的：ReAct loop 暂停等待用户输入，输入 "y" 继续，"n" 跳过
- /goal 的逐步执行 **复用现有 ReActAgentLoop**——每个步骤作为一个 userMessage 发送
- GoalVerifier 使用 **独立 LLM 调用**（config.goalVerifier.modelId），不参与实际工作
- 目标状态仅在内存中管理（Phase 9 不做持久化，Phase 10 检查点系统再做）

---

## 具体任务

### Task 1：配置与类型扩展

**文件：**
- 修改 `src/config/schema.ts`（扩展 AutonomyConfigSchema）
- 修改 `src/config/defaults.ts`（新增默认值）
- 创建 `src/agent/goal-types.ts`（目标系统数据结构）

- [ ] **Step 1：扩展 AutonomyConfigSchema**

在 `src/config/schema.ts` 中修改 `AutonomyConfigSchema`，新增确认超时和自动批准工具模式：

```typescript
// 修改前：
export const AutonomyConfigSchema = z.object({
  defaultMode: AutonomyModeSchema.default('semi'),
});

// 修改后：
export const AutonomyConfigSchema = z.object({
  defaultMode: AutonomyModeSchema.default('semi'),
  /** 确认等待超时（毫秒）。超时后按模式自动决定：auto→批准，semi→批准，manual→拒绝 */
  confirmTimeoutMs: z.number().positive().int().default(60000),
  /** 始终自动批准的工具名 glob 模式（即使在 manual 模式下也放行） */
  autoApprovePatterns: z.array(z.string()).default([
    'file_read', 'file_search', 'code_search',
  ]),
});
```

同步更新 `defaults.ts`：

```typescript
autonomy: {
  defaultMode: 'semi',
  confirmTimeoutMs: 60000,
  autoApprovePatterns: ['file_read', 'file_search', 'code_search'],
},
```

- [ ] **Step 2：创建 goal-types.ts**

```typescript
// src/agent/goal-types.ts
// 目标系统数据结构（Phase 9）

import type { TokenUsageInfo } from '../router/types.js';

/** 计划步骤状态 */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/** 计划步骤（GoalParser 输出的每一步） */
export interface PlanStep {
  /** 步骤 ID（从 1 开始） */
  id: number;
  /** 步骤描述（给 LLM 的指令） */
  description: string;
  /** 当前状态 */
  status: StepStatus;
  /** 预期访问的文件路径 */
  expectedFiles: string[];
  /** 依赖的步骤 ID 列表 */
  dependencies: number[];
  /** 执行结果摘要 */
  result?: string;
  /** Token 消耗 */
  usage?: TokenUsageInfo;
}

/** 目标计划（/goal 命令的完整输出） */
export interface GoalPlan {
  /** 目标唯一 ID */
  id: string;
  /** 目标描述 */
  description: string;
  /** 验证条件（--verify 参数） */
  verifyCriteria: string;
  /** 步骤列表 */
  steps: PlanStep[];
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** 整体状态 */
  status: 'planning' | 'confirmed' | 'executing' | 'verifying' | 'completed' | 'failed' | 'cancelled';
  /** 验证结果 */
  verificationResult?: VerificationResult;
  /** 总 Token 消耗 */
  totalUsage?: TokenUsageInfo;
}

/** GoalVerifier 的验证结果 */
export interface VerificationResult {
  /** 是否通过 */
  passed: boolean;
  /** 置信度 0-1 */
  confidence: number;
  /** 推理说明 */
  reasoning: string;
  /** 缺失项（未满足的条件） */
  missingItems: string[];
  /** 改进建议 */
  suggestions: string[];
  /** 验证时间 */
  timestamp: number;
  /** 验证 Token 消耗 */
  usage?: TokenUsageInfo;
}

/** GoalParser 的 LLM 输出格式（JSON） */
export interface GoalParserOutput {
  goalDescription: string;
  verifyCriteria: string;
  steps: Array<{
    id: number;
    description: string;
    expectedFiles: string[];
    dependencies: number[];
  }>;
}

/** 工具确认请求（传给 onConfirmTool 回调） */
export interface ToolConfirmRequest {
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/config/schema.ts src/config/defaults.ts src/agent/goal-types.ts
git commit -m "feat(config): extend AutonomyConfig and add goal system types for Phase 9"
```

---

### Task 2：PermissionChecker 自主模式感知

**文件：** 修改 `src/tools/permission.ts`

给 PermissionChecker 增加自主模式感知能力：根据当前模式（auto/semi/manual）决定是否自动放行 confirm 级别的工具。

- [ ] **Step 1：修改 PermissionChecker**

```typescript
// 在 PermissionChecker 类中，替换 autoApproveConfirm 为 autonomyMode

import type { IPermissionChecker, PermissionLevel, PermissionRule } from './types.js';
import type { AutonomyMode } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export class PermissionChecker implements IPermissionChecker {
  private rules: PermissionRule[] = [];
  /** 当前自主模式 */
  private mode: AutonomyMode;
  /** 始终自动批准的工具名 glob 模式 */
  private autoApprovePatterns: string[];

  constructor(
    mode: AutonomyMode = 'semi',
    autoApprovePatterns: string[] = ['file_read', 'file_search', 'code_search'],
  ) {
    this.mode = mode;
    this.autoApprovePatterns = autoApprovePatterns;
  }

  /** 运行时切换自主模式 */
  setAutonomyMode(mode: AutonomyMode): void {
    const oldMode = this.mode;
    this.mode = mode;
    logger.info(`Autonomy mode changed: ${oldMode} → ${mode}`);
  }

  /** 获取当前模式 */
  getAutonomyMode(): AutonomyMode {
    return this.mode;
  }

  checkPermission(toolName: string, _args: Record<string, unknown>): PermissionLevel {
    const level = this.getPermissionLevel(toolName);

    // deny 永远拒绝（任何模式下）
    if (level === 'deny') {
      logger.warn('Tool execution denied by permission rule', { toolName });
      return 'deny';
    }

    // auto 永远放行（任何模式下）
    if (level === 'auto') {
      return 'auto';
    }

    // confirm 级别：根据模式和工具名决定
    // 1. 检查是否在 autoApprovePatterns 中（任何模式都放行）
    if (this.isAutoApprovePattern(toolName)) {
      logger.debug('Tool auto-approved by pattern', { toolName, mode: this.mode });
      return 'auto';
    }

    // 2. 根据模式处理
    switch (this.mode) {
      case 'auto':
        // 全自动：所有 confirm 自动放行
        return 'auto';

      case 'semi':
        // 半自动：confirm 需要确认（返回 confirm，由 CLI 层弹出确认）
        return 'confirm';

      case 'manual':
        // 手动：每步都需确认
        return 'confirm';
    }
  }

  // addRule / removeRule / listRules / getPermissionLevel / matchPattern 保持不变

  /** 检查工具名是否匹配 autoApprovePatterns */
  private isAutoApprovePattern(toolName: string): boolean {
    return this.autoApprovePatterns.some(pattern => this.matchPattern(toolName, pattern));
  }

  // matchPattern 方法保持不变（已有的 glob 匹配逻辑）
}
```

**关键变化**：
- `autoApproveConfirm: boolean` → `mode: AutonomyMode`（更细粒度控制）
- 构造函数签名变了：`new PermissionChecker(mode, autoApprovePatterns)`
- `checkPermission()` 在 semi/manual 模式下返回 `'confirm'`（不再自动降为 `'auto'`）
- 新增 `setAutonomyMode()` / `getAutonomyMode()` 方法

- [ ] **Step 2：更新 App.tsx 中的初始化**

```typescript
// 修改前：
const permissionCheckerRef = useRef(new PermissionChecker(true));

// 修改后：
const permissionCheckerRef = useRef(new PermissionChecker(
  config.autonomy.defaultMode,
  config.autonomy.autoApprovePatterns,
));
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/tools/permission.ts src/cli/App.tsx
git commit -m "feat(tools): make PermissionChecker autonomy-mode-aware"
```

---

### Task 3：ReActAgentLoop 工具确认回调

**文件：** 修改 `src/agent/loop.ts`、`src/agent/loop-config.ts`

在 ReActAgentLoop 中新增 `onConfirmTool` 回调——在执行工具前暂停，等待外部确认。

- [ ] **Step 1：扩展 ReActRunParams 和 ReActEvent**

在 `src/agent/loop-config.ts` 中新增 `approval_required` 事件变体：

```typescript
// 在 ReActEvent 联合类型中新增：
export type ReActEvent =
  | { type: 'thinking'; message: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; toolName: string; toolCallId: string }
  | { type: 'tool_call_result'; toolName: string; toolCallId: string; result: string; isError: boolean }
  /** 工具需要确认（semi/manual 模式下） */
  | { type: 'approval_required'; toolName: string; toolCallId: string; arguments: Record<string, unknown> }
  | { type: 'error'; error: string; usage?: TokenUsageInfo }
  | { type: 'done'; content: string; usage: TokenUsageInfo };
```

在 `src/agent/loop.ts` 的 `ReActRunParams` 中新增回调：

```typescript
export interface ReActRunParams {
  userMessage: string;
  llmClient: ILLMClient;
  routeDecision: RoutingResult;
  conversationHistory: LLMMessage[];
  systemPrompt?: string;
  signal?: AbortSignal;
  /** 工具确认回调。返回 true 批准执行，返回 false 跳过该工具 */
  onConfirmTool?: (request: {
    toolName: string;
    toolCallId: string;
    arguments: Record<string, unknown>;
  }) => Promise<boolean>;
}
```

- [ ] **Step 2：在工具执行循环中插入确认逻辑**

在 `loop.ts` 的 `for (const toolCall of result.toolCalls)` 循环中，在 `executeTool` 之前插入确认逻辑：

```typescript
// 执行每个工具调用
for (const toolCall of result.toolCalls) {
  yield {
    type: 'tool_call_start',
    toolName: toolCall.name,
    toolCallId: toolCall.id,
  };

  // ===== Phase 9 新增：工具确认 =====
  let approved = true;
  if (params.onConfirmTool) {
    yield {
      type: 'approval_required',
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      arguments: toolCall.arguments,
    };
    approved = await params.onConfirmTool({
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      arguments: toolCall.arguments,
    });
  }

  let toolResult: string;
  let isError: boolean;

  if (!approved) {
    // 用户拒绝 → 不执行工具，注入拒绝信息
    toolResult = `[用户拒绝] 工具 ${toolCall.name} 的执行被用户拒绝。请根据你的理解直接用文本回答用户。`;
    isError = true;
  } else {
    toolResult = await this.toolExecutor.executeTool(
      toolCall.name,
      toolCall.id,
      toolCall.arguments,
    );
    isError = toolResult.includes('不可用') || toolResult.includes('不存在') || toolResult.includes('错误');
  }

  yield {
    type: 'tool_call_result',
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    result: toolResult,
    isError,
  };

  // 将工具结果注入上下文
  messages.push({
    role: 'user',
    content: [{
      type: 'tool_result' as const,
      toolUseId: toolCall.id,
      content: toolResult,
      isError,
    }],
  });
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/loop-config.ts src/agent/loop.ts
git commit -m "feat(agent): add onConfirmTool callback for interactive tool approval"
```

---

### Task 4：GoalParser（目标分解）

**文件：** 创建 `src/agent/goal-parser.ts`

将用户的 `/goal` 输入分解为结构化的步骤计划。

- [ ] **Step 1：实现 GoalParser**

```typescript
// src/agent/goal-parser.ts
// 目标解析器：将 /goal 输入分解为步骤计划
// 使用 LLM 进行分解，返回 GoalPlan

import type { ILLMClient } from '../router/types.js';
import type { RoutingResult } from '../router/types.js';
import type { GoalPlan, PlanStep, GoalParserOutput } from './goal-types.js';
import { logger } from '../utils/logger.js';

/** 目标解析的系统提示 */
const GOAL_PARSER_SYSTEM_PROMPT = `你是一个任务分解专家。用户会给你一个开发目标和验证条件，你需要将其分解为可执行的步骤列表。

## 输出格式
严格输出 JSON（不要包含 markdown 代码块标记），格式如下：
{
  "goalDescription": "目标的简洁描述",
  "verifyCriteria": "验证条件",
  "steps": [
    {
      "id": 1,
      "description": "具体步骤描述（足够详细，让 Agent 能直接执行）",
      "expectedFiles": ["src/example.ts"],
      "dependencies": []
    }
  ]
}

## 规则
- 每个步骤应该是可独立执行的原子操作
- dependencies 引用前面步骤的 id（如步骤 3 依赖步骤 1 和 2）
- expectedFiles 列出该步骤预期会读取或修改的文件
- description 要具体到 Agent 可以直接执行，不要过于抽象
- 步骤数量控制在 2-10 个
- 使用与用户相同的语言`;

export class GoalParser {
  /**
   * 解析目标，返回步骤计划
   */
  async parse(
    goalDescription: string,
    verifyCriteria: string,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
  ): Promise<GoalPlan> {
    const userPrompt = `目标: ${goalDescription}\n验证条件: ${verifyCriteria || '由你判断目标是否完成'}`;

    logger.info('Parsing goal', { description: goalDescription });

    try {
      // 使用非流式调用（需要完整 JSON）
      const response = await llmClient.complete({
        model: routeDecision.model.id,
        messages: [{ role: 'user', content: userPrompt }],
        systemPrompt: GOAL_PARSER_SYSTEM_PROMPT,
        maxTokens: 2000,
        timeoutMs: 30000,
      });

      // 解析 LLM 返回的 JSON
      const jsonText = this.extractJSON(response.content);
      const parsed: GoalParserOutput = JSON.parse(jsonText);

      // 转换为 GoalPlan
      const plan: GoalPlan = {
        id: `goal-${Date.now()}`,
        description: parsed.goalDescription || goalDescription,
        verifyCriteria: parsed.verifyCriteria || verifyCriteria,
        steps: parsed.steps.map(s => ({
          id: s.id,
          description: s.description,
          status: 'pending' as const,
          expectedFiles: s.expectedFiles ?? [],
          dependencies: s.dependencies ?? [],
        })),
        createdAt: Date.now(),
        status: 'planning',
      };

      logger.info('Goal parsed', {
        planId: plan.id,
        stepCount: plan.steps.length,
      });

      return plan;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Goal parsing failed', { error: msg });
      throw new Error(`目标解析失败: ${msg}`);
    }
  }

  /** 从 LLM 输出中提取 JSON（处理可能的 markdown 代码块包裹） */
  private extractJSON(text: string): string {
    // 尝试直接解析
    try {
      JSON.parse(text);
      return text;
    } catch {
      // 尝试提取 ```json ... ``` 代码块
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        return codeBlockMatch[1].trim();
      }
      // 尝试提取 { ... } 块
      const braceMatch = text.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        return braceMatch[0];
      }
      throw new Error('无法从 LLM 输出中提取 JSON');
    }
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/goal-parser.ts
git commit -m "feat(agent): implement GoalParser for /goal command step decomposition"
```

---

### Task 5：GoalVerifier（独立验证）

**文件：** 创建 `src/agent/goal-verifier.ts`

使用独立的 LLM 调用验证目标是否真正完成。

- [ ] **Step 1：实现 GoalVerifier**

```typescript
// src/agent/goal-verifier.ts
// 目标验证器：独立验证 /goal 是否完成
// 使用独立模型调用，不参与实际工作，避免认知偏差

import type { ILLMClient, RoutingResult } from '../router/types.js';
import type { VerificationResult, GoalPlan, PlanStep } from './goal-types.js';
import type { GoalVerifierConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

const VERIFIER_SYSTEM_PROMPT = `你是一个独立的目标验证器。你的任务是审查执行结果，判断目标是否真正完成。

## 重要原则
- 审查实际产出（文件修改、测试结果），而非 Agent 的声明
- 如果有任何不确定的地方，降低置信度
- 列出所有缺失项和改进建议

## 输出格式
严格输出 JSON（不要包含 markdown 代码块标记）：
{
  "passed": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "详细推理过程",
  "missingItems": ["缺失项1", "缺失项2"],
  "suggestions": ["建议1", "建议2"]
}

## 判断标准
- passed: 所有验证条件都满足时为 true
- confidence: 0.0（完全不确定）到 1.0（完全确定）
- missingItems: 未满足的条件或未完成的步骤
- suggestions: 即使通过了也可以给出改进建议`;

export class GoalVerifier {
  private config: GoalVerifierConfig;

  constructor(config: GoalVerifierConfig) {
    this.config = config;
  }

  /**
   * 验证目标是否完成
   * @param plan 目标计划（含各步骤执行结果）
   * @param llmClient 用于验证的 LLM 客户端
   * @param verifyRouteDecision 验证模型的路由决策
   */
  async verify(
    plan: GoalPlan,
    llmClient: ILLMClient,
    verifyRouteDecision: RoutingResult,
  ): Promise<VerificationResult> {
    if (!this.config.enabled) {
      return {
        passed: true,
        confidence: 1.0,
        reasoning: '验证器已禁用，自动通过',
        missingItems: [],
        suggestions: [],
        timestamp: Date.now(),
      };
    }

    logger.info('Verifying goal', { planId: plan.id });

    const executionSummary = this.buildExecutionSummary(plan);

    const userPrompt = [
      `## 目标`,
      plan.description,
      ``,
      `## 验证条件`,
      plan.verifyCriteria || '由你判断目标是否完成',
      ``,
      `## 执行摘要`,
      executionSummary,
    ].join('\n');

    try {
      const response = await llmClient.complete({
        model: verifyRouteDecision.model.id,
        messages: [{ role: 'user', content: userPrompt }],
        systemPrompt: VERIFIER_SYSTEM_PROMPT,
        maxTokens: this.config.maxTokensPerVerification,
        timeoutMs: 30000,
      });

      const jsonText = this.extractJSON(response.content);
      const parsed = JSON.parse(jsonText);

      const result: VerificationResult = {
        passed: parsed.passed ?? false,
        confidence: parsed.confidence ?? 0.5,
        reasoning: parsed.reasoning ?? '无推理',
        missingItems: parsed.missingItems ?? [],
        suggestions: parsed.suggestions ?? [],
        timestamp: Date.now(),
        usage: response.usage,
      };

      logger.info('Goal verification complete', {
        planId: plan.id,
        passed: result.passed,
        confidence: result.confidence,
      });

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Goal verification failed', { error: msg });

      return {
        passed: false,
        confidence: 0,
        reasoning: `验证过程出错: ${msg}`,
        missingItems: ['验证未能完成'],
        suggestions: ['请重新运行验证'],
        timestamp: Date.now(),
      };
    }
  }

  /** 构建执行摘要文本 */
  private buildExecutionSummary(plan: GoalPlan): string {
    const lines: string[] = [];

    for (const step of plan.steps) {
      const statusIcon = this.getStatusIcon(step.status);
      lines.push(`### 步骤 ${step.id}: ${step.description}`);
      lines.push(`状态: ${statusIcon} ${step.status}`);
      if (step.expectedFiles.length > 0) {
        lines.push(`预期文件: ${step.expectedFiles.join(', ')}`);
      }
      if (step.result) {
        lines.push(`结果: ${step.result}`);
      }
      if (step.usage) {
        lines.push(`Token: ${step.usage.totalTokens}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'completed': return '✓';
      case 'failed': return '✗';
      case 'skipped': return '○';
      case 'in_progress': return '●';
      default: return '○';
    }
  }

  private extractJSON(text: string): string {
    try {
      JSON.parse(text);
      return text;
    } catch {
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) return codeBlockMatch[1].trim();
      const braceMatch = text.match(/\{[\s\S]*\}/);
      if (braceMatch) return braceMatch[0];
      throw new Error('无法从验证器输出中提取 JSON');
    }
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/goal-verifier.ts
git commit -m "feat(agent): implement GoalVerifier for independent goal verification"
```

---

### Task 6：CLI 集成（自主度 + 确认 UX + /goal 命令）

**文件：** 修改 `src/cli/App.tsx`

这是 Phase 9 最大的集成任务——把自主度控制、确认 UX、目标系统全部接入 CLI。

- [ ] **Step 1：自主度状态可切换**

```typescript
// 修改 autonomyMode 从 const → 可变 state
// 修改前：
const [autonomyMode] = useState(config.autonomy.defaultMode);

// 修改后：
const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>(config.autonomy.defaultMode);
```

- [ ] **Step 2：工具确认回调**

```typescript
// 新增 ref 和回调
import type { AutonomyMode } from '../config/schema.js';

// 在 App 组件内部：
const pendingConfirmRef = useRef<{
  resolve: (approved: boolean) => void;
  request: { toolName: string; arguments: Record<string, unknown> };
} | null>(null);

// onConfirmTool 回调
const handleToolConfirm = useCallback(async (request: {
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
}): Promise<boolean> => {
  // 1. 检查 PermissionChecker 的决定
  const level = permissionCheckerRef.current.checkPermission(request.toolName, request.arguments);

  if (level === 'auto') return true;
  if (level === 'deny') return false;

  // 2. confirm 级别 → 在 CLI 中显示确认提示
  const argsPreview = Object.entries(request.arguments)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 50) : JSON.stringify(v)}`)
    .join(', ');

  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: `⚠️ 需要确认: ${request.toolName}(${argsPreview})\n输入 y 批准，n 拒绝`,
  }]);

  // 3. 创建 Promise，等待用户输入
  return new Promise<boolean>((resolve) => {
    pendingConfirmRef.current = { resolve, request };

    // 超时自动处理
    const timeout = config.autonomy.confirmTimeoutMs;
    setTimeout(() => {
      if (pendingConfirmRef.current?.resolve === resolve) {
        // 超时：auto/semi 模式批准，manual 模式拒绝
        const autoApprove = autonomyMode !== 'manual';
        pendingConfirmRef.current = null;
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `⏰ 确认超时，自动${autoApprove ? '批准' : '拒绝'}`,
        }]);
        resolve(autoApprove);
      }
    }, timeout);
  });
}, [autonomyMode, config.autonomy.confirmTimeoutMs]);
```

- [ ] **Step 3：修改 handleSubmit 以路由确认输入**

```typescript
// 在 handleSubmit 的最开头（添加用户消息之前），插入确认路由逻辑：

const handleSubmit = useCallback(async (text: string) => {
  // ===== Phase 9：检查是否有待确认的工具调用 =====
  if (pendingConfirmRef.current) {
    const answer = text.trim().toLowerCase();
    const approved = answer === 'y' || answer === 'yes' || answer === '是';

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: approved
        ? `✓ 已批准: ${pendingConfirmRef.current.request.toolName}`
        : `✗ 已拒绝: ${pendingConfirmRef.current.request.toolName}`,
    }]);

    const resolve = pendingConfirmRef.current.resolve;
    pendingConfirmRef.current = null;
    resolve(approved);
    return; // 不作为新消息处理
  }

  // ... 后续的原有逻辑不变 ...
}, [/* 现有依赖 */]);
```

- [ ] **Step 4：传入 onConfirmTool 到 ReAct loop**

```typescript
// 修改 agentLoopRef.current.run() 调用，传入 onConfirmTool：

for await (const event of agentLoopRef.current.run({
  userMessage: text,
  llmClient: client,
  routeDecision,
  conversationHistory: conversationHistoryRef.current,
  systemPrompt,
  onConfirmTool: handleToolConfirm, // ← Phase 9 新增
})) {
  // ... 现有的事件处理逻辑 ...

  // 在 switch 中新增 approval_required 事件处理：
  case 'approval_required':
    // 确认提示已在 handleToolConfirm 中显示，这里无需重复
    // 但可以更新状态栏（如果有）
    break;
}
```

- [ ] **Step 5：/auto /semi /manual 命令**

在 `handleCommand` 的 switch 中添加三个模式切换命令：

```typescript
case '/auto':
  setAutonomyMode('auto');
  permissionCheckerRef.current.setAutonomyMode('auto');
  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: '已切换到全自动模式（auto）：所有工具调用自动执行，无需确认。',
  }]);
  break;

case '/semi':
  setAutonomyMode('semi');
  permissionCheckerRef.current.setAutonomyMode('semi');
  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: '已切换到半自动模式（semi）：关键操作（shell_exec, git 写操作等）执行前需确认。',
  }]);
  break;

case '/manual':
  setAutonomyMode('manual');
  permissionCheckerRef.current.setAutonomyMode('manual');
  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: '已切换到手动模式（manual）：所有工具调用执行前都需确认（autoApprovePatterns 中的工具除外）。',
  }]);
  break;
```

- [ ] **Step 6：/goal 命令**

```typescript
case '/goal': {
  // 解析 /goal "描述" --verify "条件"
  const goalText = parts.slice(1).join(' ');
  let description = goalText;
  let verifyCriteria = '';

  const verifyMatch = goalText.match(/--verify\s+"([^"]+)"/);
  if (verifyMatch) {
    verifyCriteria = verifyMatch[1];
    description = goalText.replace(/--verify\s+"[^"]+"/, '').trim();
  }
  // 也支持无引号的 --verify
  const verifyMatch2 = description.match(/--verify\s+(.+)$/);
  if (!verifyCriteria && verifyMatch2) {
    verifyCriteria = verifyMatch2[1].trim();
    description = description.replace(/--verify\s+.+$/, '').trim();
  }

  if (!description) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '用法: /goal "目标描述" --verify "验证条件"\n例: /goal "重构 Entry.java" --verify "所有测试通过且无编译错误"',
    }]);
    break;
  }

  // 标记正在处理
  setIsProcessing(true);
  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: `📋 正在解析目标: ${description}`,
  }]);

  try {
    // 1. 分类 + 路由（用 simple 级别做解析，不需要 reasoning 模型）
    const classifyResult = await classifier.classify({ query: description });
    const routeDecision = await modelRouter.route(classifyResult);
    const client = clientManager.get(routeDecision.providerId);

    if (!client || !client.isReady()) {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: '错误: LLM 客户端不可用，无法解析目标。',
      }]);
      setIsProcessing(false);
      break;
    }

    // 2. 解析目标
    const goalParser = new GoalParser();
    const plan = await goalParser.parse(description, verifyCriteria, client, routeDecision);

    // 3. 展示步骤卡片
    const stepCards = plan.steps.map(step => {
      const deps = step.dependencies.length > 0
        ? ` (依赖: ${step.dependencies.join(', ')})`
        : '';
      const files = step.expectedFiles.length > 0
        ? `\n   📄 ${step.expectedFiles.join(', ')}`
        : '';
      return `  ${step.id}. ${step.description}${deps}${files}`;
    }).join('\n');

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: [
        `📋 目标计划: ${plan.description}`,
        verifyCriteria ? `🔍 验证条件: ${verifyCriteria}` : '',
        ``,
        `步骤 (${plan.steps.length}):`,
        stepCards,
        ``,
        `输入 y 开始执行，n 取消`,
      ].filter(Boolean).join('\n'),
    }]);

    // 4. 保存计划到 ref，等待用户确认
    currentGoalPlanRef.current = plan;
    awaitingGoalConfirmRef.current = true;

  } catch (error) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `目标解析失败: ${error instanceof Error ? error.message : String(error)}`,
    }]);
    setIsProcessing(false);
  }
  break;
}
```

- [ ] **Step 7：目标确认与逐步执行**

新增两个 ref 和一个执行函数：

```typescript
const currentGoalPlanRef = useRef<GoalPlan | null>(null);
const awaitingGoalConfirmRef = useRef(false);

// 在 handleSubmit 中（pendingConfirmRef 检查之后），新增目标确认路由：

// ===== Phase 9：检查是否在等待目标确认 =====
if (awaitingGoalConfirmRef.current) {
  const answer = text.trim().toLowerCase();
  awaitingGoalConfirmRef.current = false;

  if (answer === 'y' || answer === 'yes' || answer === '是') {
    // 开始逐步执行
    await executeGoalPlan(currentGoalPlanRef.current!);
  } else {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '目标已取消。',
    }]);
    if (currentGoalPlanRef.current) {
      currentGoalPlanRef.current.status = 'cancelled';
    }
    setIsProcessing(false);
  }
  return;
}
```

逐步执行函数：

```typescript
const executeGoalPlan = useCallback(async (plan: GoalPlan) => {
  plan.status = 'executing';

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];

    // 跳过已完成的步骤
    if (step.status === 'completed' || step.status === 'skipped') continue;

    // 检查依赖
    const depsMet = step.dependencies.every(depId => {
      const dep = plan.steps.find(s => s.id === depId);
      return dep?.status === 'completed';
    });
    if (!depsMet) {
      step.status = 'skipped';
      step.result = '前置依赖未完成，跳过';
      continue;
    }

    // 更新步骤状态
    step.status = 'in_progress';
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `▶️ 执行步骤 ${step.id}/${plan.steps.length}: ${step.description}`,
    }]);

    try {
      // 分类 + 路由
      const classifyResult = await classifier.classify({ query: step.description });
      const routeDecision = await modelRouter.route(classifyResult);
      const client = clientManager.get(routeDecision.providerId);

      if (!client || !client.isReady()) {
        step.status = 'failed';
        step.result = 'LLM 客户端不可用';
        continue;
      }

      // 通过 ReAct loop 执行步骤
      const assistantId = nextId();
      setMessages(prev => [...prev, {
        id: assistantId,
        role: 'assistant' as const,
        content: '',
        isStreaming: true,
      }]);

      let stepContent = '';
      let stepUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      for await (const event of agentLoopRef.current.run({
        userMessage: step.description,
        llmClient: client,
        routeDecision,
        conversationHistory: conversationHistoryRef.current,
        systemPrompt,
        onConfirmTool: handleToolConfirm,
      })) {
        switch (event.type) {
          case 'text_delta':
            stepContent += event.text;
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, content: stepContent } : m
            ));
            break;
          case 'tool_call_start':
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system' as const,
              content: `🔧 [步骤${step.id}] ${event.toolName}`,
            }]);
            break;
          case 'error':
            setMessages(prev => prev.map(m =>
              m.id === assistantId
                ? { ...m, content: stepContent + `\n⚠️ ${event.error}` }
                : m
            ));
            break;
          case 'done':
            stepUsage = event.usage;
            break;
        }
      }

      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, isStreaming: false } : m
      ));

      step.status = 'completed';
      step.result = stepContent.slice(0, 200);
      step.usage = stepUsage;

      // 更新对话历史
      conversationHistoryRef.current.push({ role: 'user', content: step.description });
      conversationHistoryRef.current.push({ role: 'assistant', content: stepContent });

      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `✓ 步骤 ${step.id} 完成`,
      }]);

    } catch (error) {
      step.status = 'failed';
      step.result = error instanceof Error ? error.message : String(error);
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `✗ 步骤 ${step.id} 失败: ${step.result}`,
      }]);
    }
  }

  // 逐步执行完成 → 验证
  const completedSteps = plan.steps.filter(s => s.status === 'completed').length;
  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: `📋 步骤执行完成: ${completedSteps}/${plan.steps.length} 成功`,
  }]);

  // GoalVerifier 验证
  if (config.goalVerifier.enabled && config.goalVerifier.autoVerify) {
    plan.status = 'verifying';
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '🔍 正在验证目标是否完成...',
    }]);

    try {
      const verifier = new GoalVerifier(config.goalVerifier);

      // 使用 goalVerifier 指定的模型
      const verifyClassify = await classifier.classify({ query: '验证' });
      const verifyRoute = await modelRouter.route(verifyClassify);
      const verifyClient = clientManager.get(verifyRoute.providerId);

      if (verifyClient && verifyClient.isReady()) {
        const verification = await verifier.verify(plan, verifyClient, verifyRoute);
        plan.verificationResult = verification;

        const passedIcon = verification.passed ? '✅' : '❌';
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: [
            `${passedIcon} 验证结果: ${verification.passed ? '通过' : '未通过'} (置信度: ${(verification.confidence * 100).toFixed(0)}%)`,
            `推理: ${verification.reasoning}`,
            verification.missingItems.length > 0
              ? `缺失: ${verification.missingItems.join(', ')}`
              : '',
            verification.suggestions.length > 0
              ? `建议: ${verification.suggestions.join(', ')}`
              : '',
          ].filter(Boolean).join('\n'),
        }]);

        plan.status = verification.passed ? 'completed' : 'failed';
        plan.completedAt = Date.now();
      }
    } catch (error) {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `验证过程出错: ${error instanceof Error ? error.message : String(error)}`,
      }]);
    }
  }

  plan.status = plan.status === 'verifying' ? 'completed' : plan.status;
  setIsProcessing(false);
}, [classifier, modelRouter, clientManager, systemPrompt, config, handleToolConfirm]);
```

- [ ] **Step 8：更新 /help 和 /status**

在 /help 中添加新命令：

```
  /auto   /semi   /manual  - 切换自主度模式
  /goal "描述" --verify "条件" - 设定目标并逐步执行
```

在 /status 中添加当前自主模式和目标状态：

```typescript
`自主模式: ${autonomyMode}`,
currentGoalPlanRef.current
  ? `当前目标: ${currentGoalPlanRef.current.description} (${currentGoalPlanRef.current.status})`
  : '当前目标: 无',
```

- [ ] **Step 9：新增 import**

```typescript
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import type { GoalPlan } from '../agent/goal-types.js';
import type { AutonomyMode } from '../config/schema.js';
```

- [ ] **Step 10：构建验证 → 测试 → 提交**

```powershell
pnpm build
pnpm typecheck
pnpm test
git add src/cli/App.tsx
git commit -m "feat(cli): implement autonomy mode switching, tool confirmation UX, and /goal command"
```

---

### Task 7：单元测试

**文件：**
- 创建 `tests/agent/goal-parser.test.ts`
- 创建 `tests/agent/goal-verifier.test.ts`
- 修改 `tests/tools/permission.test.ts`（自主模式测试）
- 修改 `tests/agent/loop.test.ts`（确认回调测试）

- [ ] **Step 1：PermissionChecker 自主模式测试**

在已有测试文件中追加：

- auto 模式 → confirm 级别工具返回 'auto'（自动放行）
- semi 模式 → confirm 级别工具返回 'confirm'（需要确认）
- manual 模式 → confirm 级别工具返回 'confirm'（需要确认）
- autoApprovePatterns 中的工具 → 任何模式都返回 'auto'
- setAutonomyMode() 切换后 → checkPermission 结果跟随变化
- deny 规则 → 任何模式都返回 'deny'

- [ ] **Step 2：ReAct loop 确认回调测试**

- onConfirmTool 未传入 → 工具直接执行（向后兼容）
- onConfirmTool 返回 true → 工具正常执行
- onConfirmTool 返回 false → 工具不执行，注入拒绝信息
- onConfirmTool 返回 false → LLM 看到拒绝信息后继续循环
- 多个工具调用 → 每个都独立确认

- [ ] **Step 3：GoalParser 测试**

测试点（mock LLM client）：
- 正常解析 → 返回 GoalPlan，steps 数量 > 0
- LLM 返回 JSON 包裹在 ```json ``` 中 → 正确提取
- LLM 返回非法 JSON → 抛出异常
- 验证 criteria 正确传递
- 步骤 dependencies 正确映射

- [ ] **Step 4：GoalVerifier 测试**

测试点（mock LLM client）：
- 验证通过 → passed: true, confidence > 0.5
- 验证不通过 → passed: false, missingItems 非空
- config.enabled: false → 自动通过
- LLM 返回非法 JSON → passed: false, confidence: 0
- buildExecutionSummary 正确格式化各步骤状态

- [ ] **Step 5：运行全部测试 → 提交**

```powershell
pnpm test
git add tests/
git commit -m "test(agent): add tests for Phase 9 autonomy mode, goal parser, and goal verifier"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 175 个用例，Phase 8 的 141 + Phase 9 新增 ~35）
4. /auto、/semi、/manual 命令可以在运行时切换自主模式
5. semi/manual 模式下，confirm 级别的工具调用会暂停等待用户确认（y/n）
6. auto 模式下，所有工具调用自动执行（无需确认）
7. autoApprovePatterns 中的工具在任何模式下都自动执行
8. 确认超时后按模式自动决定（auto/semi → 批准，manual → 拒绝）
9. /goal "描述" --verify "条件" 能正确解析为步骤计划
10. 步骤计划展示后，用户确认开始逐步执行
11. 每个步骤通过 ReActAgentLoop 执行，结果记录到 GoalPlan
12. GoalVerifier 使用独立模型验证目标完成度
13. ReActEvent 新增 approval_required 事件变体
14. CLI 的 /help 和 /status 反映新增功能

## 注意事项

- **PermissionChecker 构造函数签名变更**：从 `new PermissionChecker(true)` 改为 `new PermissionChecker('semi', ['file_read', ...])`。所有创建 PermissionChecker 的地方（App.tsx 和测试文件）需要同步更新
- **确认回调的异步流**：`onConfirmTool` 返回 Promise，ReAct loop 会 `await` 这个 Promise。Promise 在 CLI 的 `handleSubmit` 中被 resolve（通过 `pendingConfirmRef`）。这依赖 JavaScript 事件循环的协作调度——loop 暂停时不阻塞 React 渲染和用户输入
- **handleSubmit 输入路由优先级**：pendingConfirmRef（工具确认）> awaitingGoalConfirmRef（目标确认）> 正常消息处理。这个优先级确保确认输入不会被误当作新消息
- **ReActEvent 向后兼容**：新增的 `approval_required` 事件不影响现有消费者。App.tsx 中的 switch-case 已有 default 分支（虽然没显式写出），新增 case 即可
- **GoalParser 的 LLM 选择**：使用当前路由决策的模型（不强制使用 reasoning 级别），因为目标分解本身不需要特别强的推理能力
- **GoalVerifier 的 LLM 选择**：使用 `config.goalVerifier.modelId` 指定的模型（默认 kimi-k2.7），通过独立路由获取客户端。这确保验证不受工作模型的"认知偏差"影响
- **对话历史管理**：每个步骤执行后都会把 userMessage + assistantContent 追加到 `conversationHistoryRef`。如果一个目标有 5 个步骤，就会增加 10 条历史。当前硬截断 20 条可能丢失早期上下文。Phase 11 增量 Checkpoint 会解决这个问题
- **目标状态不做持久化**：Phase 9 的 GoalPlan 只存在内存中（ref），重启后丢失。Phase 10 检查点系统会将目标状态持久化
- **/goal 命令的引号处理**：`--verify "条件"` 中的引号是必需的（因为条件可能包含空格）。如果用户忘记引号，代码会尝试无引号的匹配
- **executeGoalPlan 的 AbortSignal**：当前实现没有传递 signal 给每个步骤的 ReAct loop run。如果用户想取消正在执行的目标，需要 Ctrl+C 退出整个程序。Phase 10 的 /pause 命令会解决这个问题
- **GoalVerifier 的 token 预算**：`config.goalVerifier.maxTokensPerVerification` 默认 1000 tokens。如果验证条件很复杂，可能需要调大这个值

---

*Phase 9 | 蓝图 V1.0 | 预估新增文件：~3 个 | 预估修改文件：~5 个（schema.ts、defaults.ts、permission.ts、loop-config.ts、loop.ts、App.tsx）*
