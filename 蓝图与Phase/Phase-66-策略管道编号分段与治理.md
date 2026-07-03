# Phase 66 — 策略管道编号分段与治理

> **版本目标：** v4.6.5
> **前置依赖：** Phase 65 完成
> **后继依赖：** Phase 67（推理质量诊断与 SNR 过滤）依赖本 Phase 的 AuditChain 状态承诺快照与 PolicyEngine 编号分段管道
> **新增测试要求：** ≥ 40 个
> **研究依据：** 精读 arXiv:2605.23218《Foundation Protocol: A Coordination Layer for Agentic Society》（FoundationAgents 联合 11 家机构，2026-05-22）全文 + 附录 A。论文核心论断：多 Agent 协调不应依赖临时约定的"礼仪"，而应由**协议层**强制——所有入站 mail 在到达应用层前必须流经一条**编号分段有序管道**（Checkpoint Pipeline，附录 A），每段位有独立的语义职责（100s 会话验证 / 200s 权限 / 300s 速率与内容 / 400s 业务校验 / 500s 用户自定义 / 800s 副作用 / 900s 执行）。论文用 **CallOwner 机制**把"是否需人类拍板"统一为三类 call-owner 策略（always_pass / conditional / always_call），通过 CallOwnerMixin 混入现有 checkpoint 而非新增类型；用同步等待 10s + 超时挂起 + 异步 ApprovalResponseCheckPoint 恢复，把"等待人类"从阻塞问题变成"挂起 + 后续拾取"的状态机问题。合约生命周期由 Arbiter 仲裁者驱动**确定性硬编码状态机**（不可配置），settled 状态携带 Arbiter SHA-256 签名不可变；**Reputation 不独立存储，从签名合约链实时重算**——任何实体可向 Arbiter 索取他方合约历史、验证每个签名、自行计算声誉，无需信任 Arbiter 摘要。论文代码：https://github.com/FoundationAgents/foundation-protocol（Python，MIT，PyPI）。
> **核心命题：** RouteDev 的 [PolicyEngine](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) 当前是**无序策略列表**——四类 policy（intent_guard / playbook / tool_guide / tool_approval）按 priority 排序后顺序评估，但段位语义混在一起：会话级鉴权、权限级 friend-check、内容级速率、业务级校验、用户自定义、副作用、执行级仲裁都挤在同一个 for 循环里，无法保证"权限校验通过后才执行业务校验"这类**有序不变量**。Phase 66 把 Foundation Protocol 的 Checkpoint Pipeline 编号分段、CallOwner 同步等待+异步恢复、状态机签名快照链、Reputation 派生可信度四套机制落地，让策略治理从"列表式"升级为"协议式"。

---

## 项目现状审计与可行性结论

### 1. 论文与 RouteDev 缺口的映射

| Foundation Protocol 机制 | 核心 Contribution | RouteDev 现状缺口 | Phase 66 Task |
|--------------------------|-------------------|-------------------|---------------|
| Checkpoint Pipeline 编号分段 | 所有入站 mail 流经 100-999 编号段有序管道（附录 A） | PolicyEngine 四类 policy 平铺排序，无段位语义，无有序不变量保证 | Task 1（编号分段管道） |
| CallOwner 同步等待 + 异步恢复 | call_owner 10s 同步等 + 超时挂起到 pending_approvals + ApprovalResponseCheckPoint 拾取 | tool_approval 仅 requireApproval 标志，无超时挂起、无异步恢复 | Task 2（同步等待+异步恢复） |
| CallOwnerMixin 混入 | 三类 call-owner 策略通过 mixin 注入现有 checkpoint，不引入新类型 | 现有 checkpoint 重写才能加审批，扩展性差 | Task 3（Mixin 模式） |
| Contract 状态机签名快照 | Arbiter 驱动硬编码状态机，settled 携带 SHA-256 签名不可变 | [AuditChain](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) 仅追加日志，无"状态承诺"快照、无 settled 不可变性 | Task 4（签名快照链） |
| Reputation 从签名链派生 | 不独立存储，从签名合约链实时重算，无需信任 Arbiter | [project_memory](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) topics 静态条目，无可信度派生 | Task 5（派生可信度） |
| 配置收口 | 硬编码仲裁层 + 可配置实体层分层 | 编号段位、call-owner 策略、超时时长散落各处 | Task 6（配置收口） |

### 2. 可行性总评

- **Task 1（Checkpoint 编号分段管道）：** 高度可行。现有 PolicyEngine 已有 `evaluateAction` / `evaluateToolCall` / `evaluateInput` 三个入口，只需在评估前按编号段位分组、按段位序执行。
- **Task 2（CallOwner 同步等待+异步恢复）：** 中等可行。tool-approval 当前是同步 requireApproval，需扩展为"同步等 10s → 超时挂起 → 持久化 pending_approvals → 异步 ApprovalResponseCheckPoint 拾取恢复"四态状态机。复用现有 [AuditLogger](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) 的 jsonl 持久化经验。
- **Task 3（CallOwnerMixin 混入）：** 高度可行。TypeScript mixin 模式与 PolicyEngine 的 Policy 接口正交——只需在 Policy 上增加可选 `callOwner` 字段，评估时不改 PolicyEngine 主流程，仅在 callOwner=always_call/conditional 时触发 Task 2 的等待逻辑。
- **Task 4（状态机签名快照链）：** 可行。[AuditChain](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) 已实现 SHA-256 哈希链（Phase 53 Task 4），扩展为"状态承诺"快照只需在阶段变迁时（compose-pipeline 阶段流转、CrossModelReviewer 结论落定）写入带 settled 标记的快照记录。
- **Task 5（Reputation 派生可信度）：** 可行。project_memory 的 topics 条目当前是静态文本，扩展为携带"被成功引用次数 / 被否决次数"两个派生计数器，从 AuditChain 实时重算。
- **Task 6（配置收口）：** 高度可行。遵循 Phase 51 反写死原则。

---

## 核心设计原则

### 原则 1：有序管道优先于无序列表

论文核心机制——所有入站 mail 在到达应用层前流经编号分段有序管道。Phase 66 的每个 Task 都要回答："这个策略属于哪个编号段位？段位间的有序不变量是什么？" 如果答不出，说明策略职责混叠，需重新分类。

### 原则 2：等待人类不阻塞主流程

论文 CallOwner 机制——call_owner 发出 APPROVAL_REQUEST 后同步等 10s，超时则挂起消息并持久化到 pending_approvals，owner 后续响应由 ApprovalResponseCheckPoint 拾取恢复。Phase 66 的等待逻辑必须可降级为"挂起+异步恢复"，不阻塞 Agent 主循环。

### 原则 3：Mixin 优先于继承

论文 CallOwnerMixin 通过混入现有 checkpoint 注入 call-owner 策略，不引入新 checkpoint 类型。Phase 66 扩展现有 Policy 时优先用可选字段 + 评估期分支，不新建 Policy 子类。

### 原则 4：硬编码仲裁层 + 可配置实体层

论文分层——Arbiter 仲裁层硬编码不可配置（保证确定性），实体层（friend/contract/reputation）可配置。Phase 66 的状态机流转规则硬编码（compose-pipeline 四阶段、CrossModelReviewer 结论状态），具体策略规则可配置。

### 原则 5：Reputation 派生而非存储

论文 Reputation 从签名合约链实时重算，不独立存储——任何实体可向 Arbiter 索取合约历史、验证签名、自行计算声誉。Phase 66 的可信度指标必须可从 AuditChain 重算，project_memory 中只存派生缓存。

### 原则 6：反写死原则（延续 Phase 51）

所有新增能力必须有配置开关、设置页面入口、明确代码接线点。编号段位管道默认关闭，用户在设置页开启。

### 原则 7：Fail-open

段位管道查询失败、CallOwner 超时挂起失败时，降级为现有 PolicyEngine 顺序评估逻辑，不阻塞主流程。

### 原则 8：死代码防护与执行人自审（延续 Phase 51/53）

**死代码零容忍**：本 Phase 新增的每个类、函数、配置字段、接口必须有明确的消费方（调用点或读取点）。

**执行人自审硬性要求**（每个 Task 完成后必须执行，未通过不得提交）：

1. **新增模块消费验证**：用 `rtk grep` 搜索新增类/函数名，确认至少有一个调用点（测试文件除外）
2. **配置字段消费验证**：新增的每个 zod schema 字段，必须确认有读取方（`rtk grep` 字段名确认非零引用）
3. **导出必要性验证**：新增的 `export` 必须有外部消费者；同文件内使用的 schema 用 `const` 而非 `export const`（延续 Phase 53 类型清理）
4. **knip 扫描**：Task 完成后运行 `npx knip`，新增文件不得出现在"未引用"列表中（动态 import 接线的 policy 文件除外，需在自审报告中说明）
5. **自审报告**：每个 Task 的最后一个 Step 必须是"死代码自审"，在提交信息中附自审结论（如"knip 通过，新增 5 个 export 均有消费方"）

**禁止**：
- 禁止新增"未来可能用到"的配置字段（YAGNI）
- 禁止新增未被调用的工具函数
- 禁止 export 仅供同文件使用的常量/类型

---

## Task 1：Checkpoint 编号分段管道（≥ 8 测试）

### 1.1 论文借鉴

Foundation Protocol 附录 A 的 Checkpoint Pipeline——所有入站 mail 在到达应用层前流经编号分段有序管道：

- **100-199 Session verification**（会话验证：签名校验、会话有效性）
- **200-299 Permissions**（权限：FriendCheckPoint, FriendRequestCheckPoint）
- **300-399 Rate / content**（速率/内容：速率限制、内容过滤）
- **400-499 Business validation**（业务校验：业务规则、参数合法性）
- **500-599 User-defined**（用户自定义：用户扩展规则）
- **800-899 Side effects**（副作用：CarbonCopyCheckpoint 抄送）
- **900-999 Execution**（执行：ArbiterCheckPoint 仲裁执行）

论文的关键不变量：**段位间有序**——200s 权限段不会在 100s 会话段未通过时执行，900s 执行段不会在 400s 业务段未通过时执行。RouteDev 当前 [PolicyEngine](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) 的四类 policy 按 priority 排序后顺序评估，但 priority 是全局数值，无段位语义——一个 tool_approval（priority=100）可能比一个 intent_guard（priority=50）先评估，导致"权限未通过却已执行业务校验"的乱序。

### 1.2 设计

在 PolicyEngine 上新增编号段位映射，现有四类 policy 映射到论文段位：

| 论文段位 | 段位语义 | RouteDev 映射 | 现有 PolicyType |
|---------|---------|---------------|----------------|
| 100-199 | Session verification | intent_guard（意图鉴权） | intent_guard |
| 200-299 | Permissions | （预留：未来 friend/workspace 权限） | — |
| 300-399 | Rate / content | （预留：速率限制、内容过滤） | — |
| 400-499 | Business validation | tool-approval（工具调用业务校验） | tool_approval |
| 500-599 | User-defined | tool-guide（用户自定义工具指引） | tool_guide |
| 800-899 | Side effects | （预留：副作用抄送） | — |
| 900-999 | Execution | （预留：仲裁执行） | — |

playbook 类型作为"跨段位元规则"不强制映射到单一段位，按其 priority 落到对应段位。

新增 `CheckpointPipeline` 类，包装现有 PolicyEngine：

```ts
// src/policies/checkpoint-pipeline.ts
import type { PolicyEngine, PolicyEvalResult, AgentAction, PolicyDecision } from './policy-engine.js';
import { logger } from '../utils/logger.js';

/**
 * 论文段位定义（附录 A）
 * 段位间有序：低段位未通过则高段位不执行
 */
export type CheckpointSegment =
  | 100  // Session verification（intent_guard）
  | 200  // Permissions（预留）
  | 300  // Rate / content（预留）
  | 400  // Business validation（tool_approval）
  | 500  // User-defined（tool_guide）
  | 800  // Side effects（预留）
  | 999; // Execution（预留，Arbiter 仲裁）

/** 段位评估结果 */
export interface SegmentEvalResult {
  /** 段位编号 */
  segment: CheckpointSegment;
  /** 该段位是否通过 */
  passed: boolean;
  /** 段位内所有 policy 的评估明细 */
  details: PolicyEvalResult[];
  /** 段位拒绝原因（passed=false 时非空） */
  rejectReason?: string;
}

/** 管道整体评估结果 */
export interface PipelineEvalResult {
  /** 整体是否通过（所有启用段位通过） */
  passed: boolean;
  /** 各段位评估结果（按段位序） */
  segments: SegmentEvalResult[];
  /** 第一个未通过的段位（passed=false 时有值） */
  firstFailedSegment?: CheckpointSegment;
  /** 拒绝原因聚合 */
  rejectReasons: string[];
}

/**
 * Checkpoint 编号分段管道
 *
 * 包装现有 PolicyEngine，按论文段位有序执行：
 *   100s 会话验证 → 200s 权限 → 300s 速率 → 400s 业务 → 500s 用户自定义 → 800s 副作用 → 900s 执行
 *
 * 段位间有序不变量：低段位未通过则高段位不执行（短路）
 * 段位内不短路：所有匹配的 policy 都会评估（聚合 action）
 */
export class CheckpointPipeline {
  /** 段位执行顺序（论文附录 A 顺序） */
  private static readonly SEGMENT_ORDER: CheckpointSegment[] = [100, 200, 300, 400, 500, 800, 999];

  constructor(
    private readonly engine: PolicyEngine,
    private readonly config: {
      enabled: boolean;
      /** 启用的段位列表（未列出的段位跳过） */
      enabledSegments: CheckpointSegment[];
      /** 段位短路：低段位失败时是否跳过高段位（默认 true，论文不变量） */
      shortCircuit: boolean;
    },
  ) {}

  /**
   * 按 PolicyType 映射到段位
   * playbook 类型按其 priority 落到对应段位（priority 100-199 → 100s 段，依此类推）
   */
  private mapTypeToSegment(type: string, priority: number): CheckpointSegment {
    switch (type) {
      case 'intent_guard': return 100;
      case 'tool_approval': return 400;
      case 'tool_guide': return 500;
      case 'playbook': {
        // playbook 按 priority 段位归类
        if (priority >= 100 && priority < 200) return 100;
        if (priority >= 200 && priority < 300) return 200;
        if (priority >= 400 && priority < 500) return 400;
        if (priority >= 500 && priority < 600) return 500;
        return 500; // 默认归到 500s 用户自定义段
      }
      default: return 500;
    }
  }

  /**
   * 管道式评估 Agent 动作
   * 按段位序执行，段位间短路（低段位失败则跳过高段位）
   * 段位内不短路（所有匹配 policy 都评估）
   */
  evaluateAction(action: AgentAction): PipelineEvalResult {
    if (!this.config.enabled) {
      // 关闭时降级为现有 PolicyEngine 顺序评估
      const decision = this.engine.evaluateAction(action);
      return {
        passed: !decision.denied,
        segments: [],
        rejectReasons: decision.reason ? [decision.reason] : [],
      };
    }

    const segments: SegmentEvalResult[] = [];
    const rejectReasons: string[] = [];
    let firstFailedSegment: CheckpointSegment | undefined;
    let overallPassed = true;

    for (const segment of CheckpointPipeline.SEGMENT_ORDER) {
      // 跳过未启用的段位
      if (!this.config.enabledSegments.includes(segment)) continue;

      // 段位间短路：低段位失败则跳过高段位
      if (this.config.shortCircuit && !overallPassed) break;

      // 取该段位对应的所有 policy 评估结果
      const segmentResult = this.evaluateSegment(segment, action);
      segments.push(segmentResult);

      if (!segmentResult.passed) {
        overallPassed = false;
        if (firstFailedSegment === undefined) firstFailedSegment = segment;
        if (segmentResult.rejectReason) rejectReasons.push(segmentResult.rejectReason);
      }
    }

    return {
      passed: overallPassed,
      segments,
      firstFailedSegment,
      rejectReasons,
    };
  }

  /** 评估单个段位 */
  private evaluateSegment(segment: CheckpointSegment, action: AgentAction): SegmentEvalResult {
    const allPolicies = this.engine.list();
    const segmentPolicies = allPolicies.filter(p => {
      if (!p.enabled) return false;
      return this.mapTypeToSegment(p.type, p.priority) === segment;
    });

    if (segmentPolicies.length === 0) {
      // 空段位视为通过
      return { segment, passed: true, details: [] };
    }

    // 段位内：所有 policy 都评估（不短路），deny-overrides 聚合
    const details: PolicyEvalResult[] = [];
    let segmentPassed = true;
    let rejectReason: string | undefined;

    for (const policy of segmentPolicies) {
      const matched = this.matchPolicyToAction(policy, action);
      const result: PolicyEvalResult = {
        matched,
        action: matched ? policy.action : {},
        policyId: policy.id,
        policyName: policy.name,
      };
      details.push(result);

      // deny-overrides：任一 block 即段位失败
      if (matched && policy.action.block && segmentPassed) {
        segmentPassed = false;
        rejectReason = policy.action.response ?? `Policy "${policy.name}" blocked at segment ${segment}`;
      }
    }

    return {
      segment,
      passed: segmentPassed,
      details,
      rejectReason,
    };
  }

  /** 简化的 policy-action 匹配（复用 PolicyEngine 内部 matchTrigger 逻辑） */
  private matchPolicyToAction(policy: { trigger: { mode: string; keywords?: string[] } }, action: AgentAction): boolean {
    if (policy.trigger.mode === 'always') return true;
    const keywords = policy.trigger.keywords ?? [];
    if (keywords.length === 0) return false;
    const text = [action.toolName, action.description].filter(Boolean).join(' ').toLowerCase();
    return keywords.some(kw => kw && text.includes(kw.toLowerCase()));
  }
}
```

### 1.3 接线点

- 新增：`src/policies/checkpoint-pipeline.ts`
- 修改：`src/policies/policy-engine.ts` — 新增 `list()` 已存在，复用；新增内部 `matchTrigger` 暴露为 `matchTriggerPublic`（供 CheckpointPipeline 调用，避免重复实现）
- 修改：`src/agent/loop.ts` — `setPolicyEngine` 后追加 `setCheckpointPipeline`，onActing 中间件改为调用 `pipeline.evaluateAction`
- 修改：`src/cli/app-init.ts` — 装配 CheckpointPipeline 单例，包装现有 PolicyEngine

### 1.4 Step 分解

- [ ] **Step 1: 定义 CheckpointSegment 类型与 SEGMENT_ORDER 常量**

新建 `src/policies/checkpoint-pipeline.ts`，按论文附录 A 定义 7 个段位常量与执行顺序数组。

- [ ] **Step 2: 实现 mapTypeToSegment 映射函数**

按 1.2 表格实现：intent_guard→100、tool_approval→400、tool_guide→500、playbook 按 priority 落段。

- [ ] **Step 3: 实现 evaluateSegment 单段位评估**

取段位内所有 policy，段位内不短路，deny-overrides 聚合，返回 SegmentEvalResult。

- [ ] **Step 4: 实现 evaluateAction 管道式评估**

按 SEGMENT_ORDER 遍历启用的段位，段位间短路（low fail → skip high），返回 PipelineEvalResult。关闭时降级为现有 engine.evaluateAction。

- [ ] **Step 5: PolicyEngine 暴露 matchTriggerPublic**

在 [policy-engine.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) 把私有 `matchTrigger` 暴露为公开方法（或新增 `matchTriggerPublic`），避免 CheckpointPipeline 重复实现。

- [ ] **Step 6: 接入 loop.ts 的 onActing 中间件**

在 [loop.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts) 新增 `setCheckpointPipeline` setter，onActing 中间件优先调用 `pipeline.evaluateAction`，未注入时回退到 `policyEngine.evaluateAction`。

- [ ] **Step 7: 装配单例**

在 [app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) 装配 CheckpointPipeline，包装现有 PolicyEngine，注入 loop。

- [ ] **Step 8: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 CheckpointPipelineConfig：

```ts
checkpointPipeline: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用编号分段管道（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 启用的段位列表 */
  enabledSegments: z.array(z.number().int()).default([100, 400, 500]),
  /** 段位间短路（低段位失败时跳过高段位） */
  shortCircuit: z.boolean().default(true),
})).default({}),
```

- [ ] **Step 9: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/policies/checkpoint-pipeline.test.ts`，覆盖：
- 段位映射正确性（intent_guard→100、tool_approval→400、tool_guide→500）
- 段位间短路（100s 失败则 400s 不执行）
- 段位内不短路（同段位多 policy 都评估）
- deny-overrides 聚合（同段位任一 block 即段位失败）
- 空段位通过
- firstFailedSegment 正确性
- 关闭时降级为现有 evaluateAction
- 配置开关关闭时跳过管道

- [ ] **Step 10: 提交**

```powershell
git add -A
git commit -m "feat(phase-66): Checkpoint 编号分段管道

新增 CheckpointPipeline，包装 PolicyEngine 按论文段位有序执行
论文借鉴：Foundation Protocol 附录 A 的 100-999 编号分段管道
段位映射：intent_guard→100s / tool_approval→400s / tool_guide→500s
不变量：段位间短路（低段位失败则跳过高段位），段位内不短路"
```

---

## Task 2：CallOwner 同步等待 + 超时挂起 + 异步恢复（≥ 8 测试）

### 2.1 论文借鉴

Foundation Protocol 的 CallOwner 等待策略——call_owner 发出 APPROVAL_REQUEST 后**同步等待 10s**；owner 10s 内响应则立即返回；**超时则挂起消息并持久化到 pending_approvals**；owner 后续响应由 **ApprovalResponseCheckPoint** 拾取、取出挂起消息、恢复处理。论文强调："等待人类不是阻塞问题，而是挂起+后续拾取的状态机问题"——这把"等用户回来"从同步阻塞变成异步状态变迁。RouteDev 当前 [PolicyEngine](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) 的 tool_approval 仅返回 `requireApproval: boolean` 标志，调用方自行处理确认——既无超时挂起，也无异步恢复，用户离开 10 分钟 Agent 就一直阻塞。

### 2.2 设计

新增 `CallOwnerCoordinator` 类，把 tool_approval 的等待逻辑扩展为四态状态机：

```ts
// src/policies/call-owner-coordinator.ts
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { ensureDir } from '../utils/paths.js';

/** CallOwner 策略（论文三类） */
export type CallOwnerStrategy =
  | 'always_pass'    // agent 自决，不请 owner
  | 'conditional'    // 条件触发（如高风险才请 owner）
  | 'always_call';   // 总是请 owner 审批；无 owner 回退 always_pass

/** 等待状态（论文四态状态机） */
export type ApprovalState =
  | 'pending'        // 已发 APPROVAL_REQUEST，等待 owner 响应
  | 'approved'       // owner 已批准
  | 'denied'         // owner 已拒绝
  | 'timeout_pending';// 同步等待 10s 超时，已挂起到 pending_approvals

/** 挂起的审批请求（持久化到 .routedev/pending-approvals.jsonl） */
export interface PendingApproval {
  /** 唯一 ID */
  id: string;
  /** 触发的动作描述 */
  actionDescription: string;
  /** 工具名 */
  toolName: string;
  /** 工具参数（用于恢复时重新执行） */
  args: Record<string, unknown>;
  /** 触发时间戳 */
  requestedAt: number;
  /** 同步等待超时时间戳（requestedAt + 10000ms） */
  syncTimeoutAt: number;
  /** 当前状态 */
  state: ApprovalState;
  /** owner 响应时间戳（approved/denied 时有值） */
  respondedAt?: number;
  /** owner 响应内容 */
  responseNote?: string;
  /** 关联的 session/goal 上下文（用于恢复时定位） */
  contextRef: {
    sessionId: string;
    goalId?: string;
    stepId?: number;
  };
}

/**
 * CallOwner 协调器
 *
 * 论文等待策略：
 *   1. call_owner 发出 APPROVAL_REQUEST 后同步等 10s
 *   2. owner 10s 内响应 → 立即返回
 *   3. 超时 → 挂起到 pending_approvals + 持久化
 *   4. owner 后续响应 → ApprovalResponseCheckPoint 拾取恢复
 */
export class CallOwnerCoordinator {
  /** 挂起的审批请求（内存索引） */
  private pending = new Map<string, PendingApproval>();
  /** 同步等待中的 Promise 解析器（key = approvalId） */
  private syncWaiters = new Map<string, { resolve: (r: 'approved' | 'denied' | 'timeout') => void; timer: NodeJS.Timeout }>();

  constructor(private readonly config: {
    /** 同步等待时长（毫秒，论文值 10000） */
    syncWaitMs: number;
    /** 持久化路径 */
    persistPath: string;
    /** 是否启用 */
    enabled: boolean;
  }) {}

  /**
   * 请求 owner 审批（同步等待 + 超时挂起）
   *
   * @returns 'approved' owner 同步批准 / 'denied' owner 同步拒绝 / 'timeout' 同步等待超时已挂起
   */
  async requestApproval(params: {
    actionDescription: string;
    toolName: string;
    args: Record<string, unknown>;
    contextRef: PendingApproval['contextRef'];
  }): Promise<{ result: 'approved' | 'denied' | 'timeout'; approvalId: string }> {
    const approvalId = this.generateId();
    const now = Date.now();
    const record: PendingApproval = {
      id: approvalId,
      actionDescription: params.actionDescription,
      toolName: params.toolName,
      args: params.args,
      requestedAt: now,
      syncTimeoutAt: now + this.config.syncWaitMs,
      state: 'pending',
      contextRef: params.contextRef,
    };
    this.pending.set(approvalId, record);

    // 同步等待 owner 响应，超时则挂起
    const result = await new Promise<'approved' | 'denied' | 'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        // 超时：挂起到 pending_approvals
        record.state = 'timeout_pending';
        this.persist(record).catch(err => {
          logger.warn('CallOwner: persist pending approval failed', { error: String(err) });
        });
        this.syncWaiters.delete(approvalId);
        resolve('timeout');
      }, this.config.syncWaitMs);

      this.syncWaiters.set(approvalId, { resolve, timer });
    });

    return { result, approvalId };
  }

  /**
   * owner 响应审批（同步或异步）
   *
   * 同步期内响应：直接 resolve 等待中的 Promise
   * 超时后响应：从 pending_approvals 拾取，标记 approved/denied，触发恢复回调
   */
  respondApproval(params: {
    approvalId: string;
    decision: 'approved' | 'denied';
    note?: string;
  }): boolean {
    const record = this.pending.get(params.approvalId);
    if (!record) {
      logger.warn('CallOwner: approval not found', { id: params.approvalId });
      return false;
    }

    record.state = params.decision;
    record.respondedAt = Date.now();
    record.responseNote = params.note;

    // 同步等待中：直接 resolve
    const waiter = this.syncWaiters.get(params.approvalId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.syncWaiters.delete(params.approvalId);
      waiter.resolve(params.decision);
      return true;
    }

    // 超时后异步响应：持久化新状态，触发恢复回调
    this.persist(record).catch(err => {
      logger.warn('CallOwner: persist approval response failed', { error: String(err) });
    });
    this.notifyRecovery(record);
    return true;
  }

  /**
   * ApprovalResponseCheckPoint 拾取挂起的审批
   * 启动时调用，加载 pending_approvals.jsonl，恢复内存索引
   */
  async loadPendingApprovals(): Promise<PendingApproval[]> {
    try {
      const content = await fs.readFile(this.config.persistPath, 'utf-8');
      const records = content.split('\n').filter(Boolean).map(line => JSON.parse(line) as PendingApproval);
      for (const r of records) {
        if (r.state === 'pending' || r.state === 'timeout_pending') {
          this.pending.set(r.id, r);
        }
      }
      return records.filter(r => r.state === 'timeout_pending' || r.state === 'pending');
    } catch {
      return [];
    }
  }

  /** 触发恢复回调（由调用方注册） */
  onRecovery: ((record: PendingApproval) => void) | null = null;
  private notifyRecovery(record: PendingApproval): void {
    if (this.onRecovery) {
      try {
        this.onRecovery(record);
      } catch (err) {
        logger.warn('CallOwner: recovery callback failed', { error: String(err) });
      }
    }
  }

  /** 持久化单条记录（追加写 jsonl） */
  private async persist(record: PendingApproval): Promise<void> {
    await ensureDir(path.dirname(this.config.persistPath));
    await fs.appendFile(this.config.persistPath, JSON.stringify(record) + '\n', 'utf-8');
  }

  private generateId(): string {
    return `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
```

### 2.3 接线点

- 新增：`src/policies/call-owner-coordinator.ts`
- 修改：`src/policies/policy-engine.ts` — `PolicyAction` 增加 `callOwner?: CallOwnerStrategy` 字段（Task 3 详细描述）
- 修改：`src/agent/loop.ts` — onActing 中间件检测到 requireApproval 时，调用 `coordinator.requestApproval` 替代现有同步 confirm 回调
- 修改：`src/cli/app-init.ts` — 装配 CallOwnerCoordinator 单例，启动时 `loadPendingApprovals` 恢复挂起请求

### 2.4 Step 分解

- [ ] **Step 1: 定义 PendingApproval 与 CallOwnerStrategy 类型**

新建 `src/policies/call-owner-coordinator.ts`，按 2.2 定义 PendingApproval 接口（含四态 state、contextRef、syncTimeoutAt）与 CallOwnerStrategy 三值枚举。

- [ ] **Step 2: 实现 requestApproval 同步等待 + 超时挂起**

按 2.2 实现：构造 PendingApproval → 注册同步等待 Promise + setTimeout → 超时持久化到 pending-approvals.jsonl → 返回 'timeout'。

- [ ] **Step 3: 实现 respondApproval 同步/异步双路径**

同步等待中：clearTimeout + resolve Promise。超时后：持久化新状态 + notifyRecovery 回调。

- [ ] **Step 4: 实现 loadPendingApprovals 持久化恢复**

启动时读取 .routedev/pending-approvals.jsonl，恢复 state=pending/timeout_pending 的记录到内存索引。

- [ ] **Step 5: 接入 loop.ts onActing 中间件**

在 [loop.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts) 新增 `setCallOwnerCoordinator` setter，onActing 中间件检测到 requireApproval 时：
- 若 coordinator 未注入或 disabled → 走现有 onConfirmTool 同步回调
- 若 coordinator 启用 → 调用 requestApproval，result='timeout' 时把 step 挂起（标记 goal 为 paused-awaiting-approval），不阻塞 loop

- [ ] **Step 6: ApprovalResponseCheckPoint 拾取**

在 [app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) 启动时调用 `coordinator.loadPendingApprovals()`，对每条 timeout_pending 记录：
- 若 owner 已异步响应 → notifyRecovery 触发 goal 恢复
- 若仍 pending → 在状态栏显示"等待审批：N 条"

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 CallOwnerConfig：

```ts
callOwner: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 CallOwner 协调器（默认 false） */
  enabled: z.boolean().default(false),
  /** 同步等待时长（毫秒，论文值 10000） */
  syncWaitMs: z.number().int().min(1000).max(60000).default(10000),
  /** 持久化路径 */
  persistPath: z.string().default('.routedev/pending-approvals.jsonl'),
})).default({}),
```

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/policies/call-owner-coordinator.test.ts`，覆盖：
- 同步期内 owner 响应 → 返回 approved/denied
- 同步等待超时 → 返回 timeout + 持久化到 jsonl
- 超时后 owner 异步响应 → notifyRecovery 触发
- loadPendingApprovals 恢复内存索引
- approvalId 不存在时 respondApproval 返回 false
- 配置关闭时跳过协调器
- 持久化文件不存在时 loadPendingApprovals 返回空
- 多条并发审批互不干扰

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(phase-66): CallOwner 同步等待+超时挂起+异步恢复

新增 CallOwnerCoordinator，tool_approval 等待逻辑升级为四态状态机
论文借鉴：Foundation Protocol 的 call_owner 10s 同步等 + 超时挂起 + ApprovalResponseCheckPoint 拾取
持久化：.routedev/pending-approvals.jsonl"
```

---

## Task 3：CallOwnerMixin 混入模式（≥ 6 测试）

### 3.1 论文借鉴

Foundation Protocol 的 CallOwnerMixin——通过混入现有 checkpoint 注入三类 call-owner 策略（always_pass / conditional / always_call），**不引入新 checkpoint 类型**。论文强调："CallOwnerMixin 混入模式使现有 checkpoint 无需重写即可获得 call-owner 能力"——这把"加审批"从"新建子类"变成"挂载 mixin"。RouteDev 现有 [PolicyEngine](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) 的 Policy 接口要加审批能力，必须扩展 action 字段或新建子类——扩展字段是侵入式修改，新建子类违反论文 mixin 精神。

### 3.2 设计

在 Policy 接口上新增**可选** `callOwner` 字段，评估期分支：

```ts
// src/policies/policy-engine.ts（扩展）
export interface Policy {
  id: string;
  type: PolicyType;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  trigger: PolicyTrigger;
  action: PolicyAction;
  /**
   * Phase 66 Task 3：CallOwnerMixin 混入（借鉴 Foundation Protocol）
   * 不引入新 PolicyType，仅在评估期注入 call-owner 策略
   * - undefined / 'always_pass'：agent 自决，不请 owner
   * - 'conditional'：条件触发（如高风险动作才请 owner）
   * - 'always_call'：总是请 owner 审批；无 owner 回退 always_pass
   */
  callOwner?: CallOwnerStrategy;
  /**
   * conditional 模式的条件函数（返回 true 时请 owner）
   * 默认条件：args 包含敏感路径 / 高风险命令
   */
  callOwnerCondition?: (action: AgentAction) => boolean;
}
```

新增 `CallOwnerMixin` 工具函数，把 mixin 逻辑从 PolicyEngine 主流程解耦：

```ts
// src/policies/call-owner-mixin.ts
import type { Policy, AgentAction } from './policy-engine.js';
import type { CallOwnerStrategy } from './call-owner-coordinator.js';

/**
 * CallOwnerMixin 工具函数
 *
 * 借鉴 Foundation Protocol：不引入新 checkpoint 类型，通过 mixin 注入 call-owner 策略
 * 在 PolicyEngine 评估流程外独立判断 call-owner 行为
 */
export class CallOwnerMixin {
  /**
   * 判断 policy 是否需要请 owner
   *
   * @param policy 策略对象
   * @param action 动作对象（用于 conditional 模式判断）
   * @returns 是否需要请 owner
   */
  static shouldCallOwner(policy: Policy, action: AgentAction): boolean {
    const strategy: CallOwnerStrategy = policy.callOwner ?? 'always_pass';
    switch (strategy) {
      case 'always_pass':
        return false;
      case 'always_call':
        return true;
      case 'conditional':
        // conditional 模式：调用 policy.callOwnerCondition，默认条件为高风险
        if (policy.callOwnerCondition) {
          return policy.callOwnerCondition(action);
        }
        // 默认条件：动作描述包含"删除"/"执行"/"修改 .env"等高风险关键词
        return CallOwnerMixin.isHighRiskAction(action);
    }
  }

  /** 默认高风险判断 */
  static isHighRiskAction(action: AgentAction): boolean {
    const text = [action.toolName, action.description].filter(Boolean).join(' ').toLowerCase();
    const highRiskKeywords = ['删除', '执行', '修改 .env', 'rm -rf', 'format', 'drop table', 'force push'];
    return highRiskKeywords.some(kw => text.includes(kw.toLowerCase()));
  }

  /**
   * 给现有 policy 注入 call-owner 策略（mixin 模式）
   * 不修改 policy 的 type/trigger/action，仅设置 callOwner 字段
   *
   * @example
   * const mixinPolicy = CallOwnerMixin.inject(existingPolicy, 'conditional');
   */
  static inject(policy: Policy, strategy: CallOwnerStrategy, condition?: (a: AgentAction) => boolean): Policy {
    return {
      ...policy,
      callOwner: strategy,
      callOwnerCondition: condition,
    };
  }

  /**
   * 批量给某类 policy 注入 call-owner 策略
   * 例如给所有 tool_approval 类型的 policy 注入 always_call
   */
  static injectBatch(policies: Policy[], type: Policy['type'], strategy: CallOwnerStrategy): Policy[] {
    return policies.map(p => p.type === type ? CallOwnerMixin.inject(p, strategy) : p);
  }
}
```

### 3.3 接线点

- 修改：`src/policies/policy-engine.ts` — Policy 接口增加 `callOwner?` 与 `callOwnerCondition?` 可选字段
- 新增：`src/policies/call-owner-mixin.ts`
- 修改：`src/agent/loop.ts` — onActing 中间件在 evaluateAction 后，遍历 matched policy 调用 `CallOwnerMixin.shouldCallOwner`，若任一为 true 则触发 Task 2 的 `coordinator.requestApproval`
- 修改：`src/cli/app-init.ts` — 默认给所有 tool_approval 类型的 policy 注入 `conditional` call-owner 策略（受配置开关控制）

### 3.4 Step 分解

- [ ] **Step 1: 扩展 Policy 接口**

在 [policy-engine.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) 的 Policy 接口增加 `callOwner?: CallOwnerStrategy` 与 `callOwnerCondition?: (action: AgentAction) => boolean` 两个可选字段。导入 CallOwnerStrategy 类型。

- [ ] **Step 2: 实现 CallOwnerMixin.shouldCallOwner**

新建 `src/policies/call-owner-mixin.ts`，按 3.2 实现 shouldCallOwner 三分支：always_pass=false、always_call=true、conditional=调用 condition 或默认高风险判断。

- [ ] **Step 3: 实现 isHighRiskAction 默认条件**

默认高风险关键词列表：删除/执行/修改 .env/rm -rf/format/drop table/force push。

- [ ] **Step 4: 实现 inject 与 injectBatch**

inject 单条 policy 注入 call-owner 策略；injectBatch 按类型批量注入。

- [ ] **Step 5: 接入 loop.ts onActing**

在 [loop.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts) onActing 中间件：
1. 调用 `pipeline.evaluateAction(action)`（Task 1）得到 PipelineEvalResult
2. 若 passed=false → 直接拒绝
3. 若 passed=true → 遍历 matched policy，调用 `CallOwnerMixin.shouldCallOwner`，任一为 true 则触发 `coordinator.requestApproval`

- [ ] **Step 6: 默认注入 conditional 策略**

在 [app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) 装配时，若配置开启，对所有 tool_approval 类型的 policy 调用 `CallOwnerMixin.injectBatch(policies, 'tool_approval', 'conditional')`。

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 的 CallOwnerConfig 增加字段：

```ts
/** 默认注入到 tool_approval 的 call-owner 策略（off=不注入） */
defaultStrategyForToolApproval: z.enum(['off', 'always_pass', 'conditional', 'always_call']).default('off'),
/** 默认注入到 intent_guard 的 call-owner 策略 */
defaultStrategyForIntentGuard: z.enum(['off', 'always_pass', 'conditional', 'always_call']).default('off'),
```

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/policies/call-owner-mixin.test.ts`，覆盖：
- shouldCallOwner 三分支（always_pass/conditional/always_call）
- isHighRiskAction 默认关键词命中
- inject 单条注入不修改原 policy 其他字段
- injectBatch 按类型批量注入
- callOwnerCondition 自定义条件覆盖默认
- Policy 接口扩展后向后兼容（无 callOwner 字段时按 always_pass）

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(phase-66): CallOwnerMixin 混入模式

新增 CallOwnerMixin，不引入新 PolicyType，通过可选字段注入 call-owner 策略
论文借鉴：Foundation Protocol 的 CallOwnerMixin 混入模式
三类策略：always_pass / conditional / always_call"
```

---

## Task 4：状态机签名快照链（≥ 6 测试）

### 4.1 论文借鉴

Foundation Protocol 的 Contract 生命周期——Arbiter 仲裁者驱动**确定性硬编码状态机**（不可配置），合约八态 DRAFT→...→SETTLED，**settled 不可变携带 Arbiter SHA-256 签名**。论文分层：硬编码仲裁层（保证确定性）+ 可配置实体层（friend/contract/reputation 可配）。RouteDev 的 [AuditChain](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts)（Phase 53 Task 4）已实现 SHA-256 哈希链追加日志，但**没有"状态承诺"快照**——compose-pipeline 阶段流转、CrossModelReviewer 结论落定这些"状态变迁点"只记录事件，不记录"状态快照+签名"。一旦后续修改了 compose 阶段提示词或 reviewer 结论，无法证明"当时的状态是什么"。

### 4.2 设计

在 AuditLogger 上新增"状态承诺快照"——在状态变迁点（compose-pipeline 阶段流转、CrossModelReviewer 结论落定）写入带 settled 标记的快照记录，携带 SHA-256 签名，不可变。

```ts
// src/harness/state-snapshot-chain.ts
import crypto from 'node:crypto';
import type { AuditLogger } from './audit-logger.js';
import { logger } from '../utils/logger.js';

/** 状态机类型（论文硬编码仲裁层） */
export type StateMachineType =
  | 'compose_pipeline'   // Compose 四阶段流转：requirements→coding→testing→review→settled
  | 'cross_model_review' // 跨模型审查结论：pending→approved/denied→settled
  | 'call_owner_approval';// CallOwner 审批：pending→approved/denied→settled

/** 状态快照记录（settled 不可变） */
export interface StateSnapshotRecord {
  /** 快照 ID */
  id: string;
  /** 状态机类型 */
  machineType: StateMachineType;
  /** 当前状态 */
  state: string;
  /** 是否已 settled（settled=true 不可变，携带签名） */
  settled: boolean;
  /** 状态载荷（如 compose 阶段的提示词、reviewer 结论的 issues） */
  payload: Record<string, unknown>;
  /** 上一快照的 hash（链式） */
  previousSnapshotHash: string;
  /** 当前快照的 hash（settled=true 时携带签名） */
  hash: string;
  /** Arbiter 签名（settled=true 时有值，对 hash 的 SHA-256 签名） */
  arbiterSignature?: string;
  /** 时间戳 */
  timestamp: number;
  /** 关联上下文 */
  contextRef: {
    sessionId: string;
    goalId?: string;
    stepId?: number;
  };
}

/**
 * 状态机签名快照链
 *
 * 借鉴 Foundation Protocol 的 Contract 生命周期：
 *   1. 硬编码状态机（不可配置）保证确定性
 *   2. settled 状态携带 Arbiter SHA-256 签名，不可变
 *   3. 状态变迁点写入快照，形成链式审计
 *
 * 与 AuditLogger 的关系：
 *   - AuditLogger 记录"事件流"（追加日志）
 *   - StateSnapshotChain 记录"状态承诺"（settled 不可变）
 */
export class StateSnapshotChain {
  /** 上一快照的 hash（创世为 64 个 '0'） */
  private previousHash = '0'.repeat(64);
  /** 已写入的快照（内存索引，按 id） */
  private snapshots = new Map<string, StateSnapshotRecord>();

  constructor(
    private readonly auditLogger: AuditLogger,
    private readonly config: {
      /** Arbiter 签名密钥（用于 settled 签名） */
      arbiterSecret: string;
      /** 是否启用 */
      enabled: boolean;
    },
  ) {}

  /**
   * 写入状态快照
   *
   * @param params 快照参数
   * @param settle 是否立即 settle（true 则携带签名不可变）
   */
  async writeSnapshot(params: {
    machineType: StateMachineType;
    state: string;
    payload: Record<string, unknown>;
    contextRef: StateSnapshotRecord['contextRef'];
    settle?: boolean;
  }): Promise<StateSnapshotRecord> {
    if (!this.config.enabled) {
      // 关闭时仅写 audit log，不写快照链
      this.auditLogger.log('state_snapshot', params.state, {
        machineType: params.machineType,
        payload: params.payload,
      });
      // 返回一个未签名的占位记录
      return {
        id: this.generateId(),
        machineType: params.machineType,
        state: params.state,
        settled: false,
        payload: params.payload,
        previousSnapshotHash: this.previousHash,
        hash: '',
        timestamp: Date.now(),
        contextRef: params.contextRef,
      };
    }

    const id = this.generateId();
    const timestamp = Date.now();
    const settled = params.settle ?? false;

    // 计算 hash = SHA-256(id + machineType + state + settled + payload + previousHash + timestamp)
    const hashInput = `${id}${params.machineType}${params.state}${settled}${JSON.stringify(params.payload)}${this.previousHash}${timestamp}`;
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const record: StateSnapshotRecord = {
      id,
      machineType: params.machineType,
      state: params.state,
      settled,
      payload: params.payload,
      previousSnapshotHash: this.previousHash,
      hash,
      timestamp,
      contextRef: params.contextRef,
    };

    // settled 状态携带 Arbiter 签名（对 hash 的 HMAC-SHA256）
    if (settled) {
      record.arbiterSignature = crypto
        .createHmac('sha256', this.config.arbiterSecret)
        .update(hash)
        .digest('hex');
    }

    this.snapshots.set(id, record);
    this.previousHash = hash;

    // 同步写一条 audit log（事件流）
    this.auditLogger.log('state_snapshot', params.state, {
      snapshotId: id,
      machineType: params.machineType,
      settled,
      hash,
      arbiterSigned: settled,
      payload: params.payload,
    });

    logger.debug('StateSnapshotChain: snapshot written', {
      id, machineType: params.machineType, state: params.state, settled,
    });

    return record;
  }

  /**
   * 验证快照链完整性
   * - previousSnapshotHash 链接正确
   * - hash 未被篡改
   * - settled 快照的 arbiterSignature 有效
   */
  verifyChain(records: StateSnapshotRecord[]): boolean {
    let prevHash = '0'.repeat(64);
    for (const record of records) {
      if (record.previousSnapshotHash !== prevHash) return false;
      const hashInput = `${record.id}${record.machineType}${record.state}${record.settled}${JSON.stringify(record.payload)}${record.previousSnapshotHash}${record.timestamp}`;
      const computed = crypto.createHash('sha256').update(hashInput).digest('hex');
      if (computed !== record.hash) return false;
      // settled 快照验证签名
      if (record.settled && record.arbiterSignature) {
        const expectedSig = crypto
          .createHmac('sha256', this.config.arbiterSecret)
          .update(record.hash)
          .digest('hex');
        try {
          const a = Buffer.from(expectedSig, 'hex');
          const b = Buffer.from(record.arbiterSignature, 'hex');
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
        } catch {
          return false;
        }
      }
      prevHash = record.hash;
    }
    return true;
  }

  /** 按 machineType 取快照序列 */
  getByMachineType(machineType: StateMachineType): StateSnapshotRecord[] {
    return Array.from(this.snapshots.values())
      .filter(r => r.machineType === machineType)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  private generateId(): string {
    return `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
```

### 4.3 接线点

- 新增：`src/harness/state-snapshot-chain.ts`
- 修改：`src/agent/compose-pipeline.ts` — 阶段流转时（requirements→coding→testing→review）调用 `snapshotChain.writeSnapshot`，最终 review 完成时 settle=true
- 修改：`src/agent/cross-model-reviewer.ts` — review 结论落定时调用 `snapshotChain.writeSnapshot`，settled=true 携带签名
- 修改：`src/cli/app-init.ts` — 装配 StateSnapshotChain 单例，注入 compose-pipeline 与 cross-model-reviewer

### 4.4 Step 分解

- [ ] **Step 1: 定义 StateSnapshotRecord 与 StateMachineType**

新建 `src/harness/state-snapshot-chain.ts`，按 4.2 定义三类状态机类型与快照记录接口（含 previousSnapshotHash、hash、arbiterSignature）。

- [ ] **Step 2: 实现 writeSnapshot**

按 4.2 实现：构造 record → 计算 hash → settled 时计算 HMAC-SHA256 签名 → 更新 previousHash → 同步写 audit log。

- [ ] **Step 3: 实现 verifyChain 链式验证**

遍历 records：检查 previousSnapshotHash 链接、hash 重算匹配、settled 快照的 arbiterSignature 用 timingSafeEqual 验证。

- [ ] **Step 4: 接入 compose-pipeline 阶段流转**

在 [compose-pipeline.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/compose-pipeline.ts) 的 `evaluateAdvance` 流转点：
- 阶段切换前调用 `writeSnapshot({ machineType: 'compose_pipeline', state: currentPhase, payload: { phasePrompt, lastResult }, settle: false })`
- review 阶段完成时 settle=true

- [ ] **Step 5: 接入 cross-model-reviewer 结论落定**

在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 的 `review()` 返回前：
- 调用 `writeSnapshot({ machineType: 'cross_model_review', state: result.passed ? 'approved' : 'denied', payload: { issues, summary }, settle: true })`

- [ ] **Step 6: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 StateSnapshotChainConfig：

```ts
stateSnapshotChain: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用状态快照链（默认 false） */
  enabled: z.boolean().default(false),
  /** Arbiter 签名密钥（从环境变量 ROUTEDEV_ARBITER_SECRET 读取，未配置时禁用签名） */
  arbiterSecretEnv: z.string().default('ROUTEDEV_ARBITER_SECRET'),
})).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/harness/state-snapshot-chain.test.ts`，覆盖：
- 写入非 settle 快照（无签名）
- 写入 settle 快照（携带 HMAC 签名）
- previousSnapshotHash 链式正确
- verifyChain 链完整返回 true
- 篡改 payload 后 verifyChain 返回 false
- 篡改 settled 快照的 arbiterSignature 后 verifyChain 返回 false
- getByMachineType 按类型过滤
- 配置关闭时仅写 audit log 不写快照链

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-66): 状态机签名快照链

新增 StateSnapshotChain，compose-pipeline 阶段流转与 CrossModelReviewer 结论落定时写入快照
论文借鉴：Foundation Protocol 的 Contract 生命周期 + Arbiter SHA-256 签名
settled 不可变：携带 HMAC-SHA256 签名，verifyChain 验证完整性"
```

---

## Task 5：Reputation 派生可信度（≥ 6 测试）

### 5.1 论文借鉴

Foundation Protocol 的 Reputation——**不独立存储，从签名合约链实时重算**。任何实体可向 Arbiter 索取他方合约历史、验证每个签名、自行计算声誉，无需信任 Arbiter 摘要。论文关键论断："独立存储的 reputation 是可篡改的、是需信任 Arbiter 的——只有从签名链派生才能保证无需信任"。RouteDev 的 [project_memory](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) topics 条目是静态文本，没有可信度指标——某个 topic 条目（如"该项目用 pnpm"）被多少次成功引用、被多少次否决，无从查证。Phase 66 Task 4 的 StateSnapshotChain 落地后，project_memory 的 topic 引用事件已被审计链记录，可从中派生可信度。

### 5.2 设计

在 project_memory 的 topics 条目上新增"派生可信度"指标，从 AuditChain + StateSnapshotChain 实时重算：

```ts
// src/memory/reputation-deriver.ts
import type { AuditLogger } from '../harness/audit-logger.js';
import type { StateSnapshotChain, StateSnapshotRecord } from '../harness/state-snapshot-chain.js';
import { logger } from '../utils/logger.js';

/** 派生可信度指标 */
export interface DerivedReputation {
  /** topic 条目 ID */
  topicId: string;
  /** 被成功引用次数（review approved 且引用了该 topic） */
  successRefCount: number;
  /** 被否决次数（review denied 且引用了该 topic） */
  rejectedRefCount: number;
  /** 派生可信度（0-1，successRefCount / (successRefCount + rejectedRefCount)） */
  credibility: number;
  /** 最近一次引用时间戳 */
  lastReferencedAt?: number;
  /** 派生计算时间戳（用于缓存失效判断） */
  computedAt: number;
}

/**
 * Reputation 派生器
 *
 * 借鉴 Foundation Protocol：Reputation 不独立存储，从签名合约链实时重算
 * 任何模块可索取 topic 的引用历史、验证每个签名、自行计算可信度
 *
 * 数据源：
 *   - AuditLogger：topic 引用事件（action='topic_reference'）
 *   - StateSnapshotChain：cross_model_review 的 settled 快照（验证签名）
 */
export class ReputationDeriver {
  /** 可信度缓存（key = topicId，失效条件：缓存时间 > maxCacheAgeMs） */
  private cache = new Map<string, DerivedReputation>();
  private readonly maxCacheAgeMs: number;

  constructor(
    private readonly auditLogger: AuditLogger,
    private readonly snapshotChain: StateSnapshotChain | null,
    config: { maxCacheAgeMs?: number; enabled: boolean },
  ) {
    this.maxCacheAgeMs = config.maxCacheAgeMs ?? 60_000; // 默认缓存 1 分钟
  }

  /**
   * 派生 topic 的可信度
   * 从 AuditChain 重算 successRefCount / rejectedRefCount
   *
   * @param topicId topic 条目 ID
   */
  async deriveReputation(topicId: string): Promise<DerivedReputation> {
    // 缓存命中检查
    const cached = this.cache.get(topicId);
    if (cached && Date.now() - cached.computedAt < this.maxCacheAgeMs) {
      return cached;
    }

    // 从 AuditLogger 读取该 topic 的所有引用事件
    const referenceEvents = await this.queryTopicReferences(topicId);
    let successRefCount = 0;
    let rejectedRefCount = 0;
    let lastReferencedAt: number | undefined;

    for (const event of referenceEvents) {
      lastReferencedAt = Math.max(lastReferencedAt ?? 0, event.timestamp);
      // 验证关联的 settled 快照签名（若启用 snapshotChain）
      if (this.snapshotChain && event.snapshotId) {
        const snapshot = this.snapshotChain.getByMachineType('cross_model_review')
          .find(s => s.id === event.snapshotId);
        if (!snapshot || !snapshot.settled || !snapshot.arbiterSignature) {
          // 无效签名：不计入可信度
          continue;
        }
      }
      if (event.outcome === 'approved') successRefCount++;
      else if (event.outcome === 'denied') rejectedRefCount++;
    }

    const total = successRefCount + rejectedRefCount;
    const credibility = total === 0 ? 0.5 : successRefCount / total; // 无引用时默认 0.5

    const result: DerivedReputation = {
      topicId,
      successRefCount,
      rejectedRefCount,
      credibility,
      lastReferencedAt,
      computedAt: Date.now(),
    };
    this.cache.set(topicId, result);
    return result;
  }

  /**
   * 批量派生多个 topic 的可信度
   * 用于 project_memory 加载时一次性派生所有 topic
   */
  async deriveBatch(topicIds: string[]): Promise<Map<string, DerivedReputation>> {
    const results = new Map<string, DerivedReputation>();
    await Promise.all(topicIds.map(async id => {
      results.set(id, await this.deriveReputation(id));
    }));
    return results;
  }

  /** 失效缓存（topic 被更新或引用事件新增时调用） */
  invalidate(topicId?: string): void {
    if (topicId) this.cache.delete(topicId);
    else this.cache.clear();
  }

  /** 查询 topic 的引用事件（从 AuditLogger jsonl 读取） */
  private async queryTopicReferences(topicId: string): Promise<Array<{
    timestamp: number;
    outcome: 'approved' | 'denied';
    snapshotId?: string;
  }>> {
    // 简化实现：从 AuditLogger 的内存或 jsonl 查询 action='topic_reference' 的记录
    // 实际实现需 AuditLogger 提供 queryByAction 接口
    // 此处返回空数组作为占位，实际接线时由 AuditLogger 提供
    return [];
  }
}
```

### 5.3 接线点

- 新增：`src/memory/reputation-deriver.ts`
- 修改：`src/memory/project-memory.ts` — topics 条目加载时调用 `deriver.deriveBatch`，把 DerivedReputation 附加到条目
- 修改：`src/agent/cross-model-reviewer.ts` — review 完成后，若 modifiedFiles 涉及 project_memory 中的 topic，记录 `topic_reference` 事件到 AuditLogger
- 修改：`src/harness/audit-logger.ts` — 新增 `logTopicReference(topicId, outcome, snapshotId?)` 快捷方法

### 5.4 Step 分解

- [ ] **Step 1: 定义 DerivedReputation 接口**

新建 `src/memory/reputation-deriver.ts`，按 5.2 定义 DerivedReputation（含 successRefCount、rejectedRefCount、credibility、computedAt）。

- [ ] **Step 2: 实现 deriveReputation 派生逻辑**

按 5.2 实现：缓存命中检查 → 查询 topic 引用事件 → 验证 settled 快照签名 → 计算 successRefCount/rejectedRefCount/credibility → 写缓存。

- [ ] **Step 3: 实现缓存失效**

invalidate(topicId?) 单条/全部失效。topic 被更新或新增引用事件时调用。

- [ ] **Step 4: AuditLogger 新增 logTopicReference**

在 [audit-logger.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) 新增：

```ts
logTopicReference(topicId: string, outcome: 'approved' | 'denied', snapshotId?: string): void {
  this.log('topic_reference', topicId, { outcome, snapshotId }, 'success');
}
```

- [ ] **Step 5: 接入 cross-model-reviewer**

在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) review 完成后：
- 若 modifiedFiles 涉及 project_memory 中的 topic（通过文件路径匹配）
- 调用 `auditLogger.logTopicReference(topicId, result.passed ? 'approved' : 'denied', snapshot.id)`
- 调用 `deriver.invalidate(topicId)` 失效缓存

- [ ] **Step 6: 接入 project-memory 加载**

在 [project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) topics 加载时：
- 调用 `deriver.deriveBatch(topicIds)` 批量派生
- 把 DerivedReputation 附加到 topics 条目（新增可选字段 `derivedReputation?: DerivedReputation`）

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加 ReputationDeriverConfig：

```ts
reputationDeriver: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用派生可信度（默认 false） */
  enabled: z.boolean().default(false),
  /** 缓存时长（毫秒，默认 60000） */
  maxCacheAgeMs: z.number().int().min(0).default(60000),
})).default({}),
```

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/memory/reputation-deriver.test.ts`，覆盖：
- 无引用事件 → credibility=0.5
- 全部 approved → credibility=1.0
- 全部 denied → credibility=0.0
- 混合 approved/denied → credibility=successCount/totalCount
- 缓存命中（连续调用返回同一对象）
- 缓存失效后重算
- snapshotChain 签名验证失败时不计入
- 批量派生正确性

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(phase-66): Reputation 派生可信度

新增 ReputationDeriver，project_memory topics 条目携带派生可信度
论文借鉴：Foundation Protocol 的 Reputation 从签名合约链实时重算
派生指标：successRefCount / rejectedRefCount / credibility
缓存：默认 1 分钟，topic 更新时失效"
```

---

## Task 6：配置收口、设置页与全量验证（≥ 6 测试）

### 6.1 目标

收口 Phase 66 所有配置项，确保设置页可调，全量验证通过。

### 6.2 Step 分解

- [ ] **Step 1: 配置 schema 收口**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 的 AppConfigSchema 增加顶层 `foundationProtocol` 字段，聚合 Task 1-5 的所有子配置：

```ts
foundationProtocol: z.preprocess((v) => v ?? {}, z.object({
  /** 总开关（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** Task 1：Checkpoint 编号分段管道 */
  checkpointPipeline: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    enabledSegments: z.array(z.number().int()).default([100, 400, 500]),
    shortCircuit: z.boolean().default(true),
  })).default({}),
  /** Task 2：CallOwner 同步等待+异步恢复 */
  callOwner: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    syncWaitMs: z.number().int().min(1000).max(60000).default(10000),
    persistPath: z.string().default('.routedev/pending-approvals.jsonl'),
    defaultStrategyForToolApproval: z.enum(['off', 'always_pass', 'conditional', 'always_call']).default('off'),
    defaultStrategyForIntentGuard: z.enum(['off', 'always_pass', 'conditional', 'always_call']).default('off'),
  })).default({}),
  /** Task 4：状态机签名快照链 */
  stateSnapshotChain: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    arbiterSecretEnv: z.string().default('ROUTEDEV_ARBITER_SECRET'),
  })).default({}),
  /** Task 5：Reputation 派生可信度 */
  reputationDeriver: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    maxCacheAgeMs: z.number().int().min(0).default(60000),
  })).default({}),
})).default({}),
```

- [ ] **Step 2: defaults.ts 同步**

在 [defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) 增加对应默认值。

- [ ] **Step 3: 设置页 UI**

在 desktop renderer 设置页新增"Foundation Protocol"分区：
- 总开关
- 子开关（CheckpointPipeline / CallOwner / StateSnapshotChain / ReputationDeriver）
- 参数配置（段位列表、syncWaitMs、缓存时长）
- 挂起的审批列表查看（pending-approvals.jsonl 渲染）
- "立即清除挂起审批"按钮

UI 风格遵循用户偏好（圆角、紫色调、lucide-react 图标）。

- [ ] **Step 4: 段位映射可视化**

在设置页增加段位映射可视化：
- 100s Session verification ← intent_guard
- 400s Business validation ← tool_approval
- 500s User-defined ← tool_guide
- 200s/300s/800s/900s 标记"预留"

帮助用户理解论文段位与现有 PolicyType 的对应关系。

- [ ] **Step 5: 全量验证**

```powershell
pnpm typecheck
pnpm test
pnpm build:electron
```

预期：全绿，新增 ≥ 40 个测试通过。

- [ ] **Step 6: 文档同步**

更新 README.md 与 ARCHITECTURE.md，说明 Foundation Protocol 编号分段管道架构。

- [ ] **Step 7: 配置测试**

新建 `tests/config/foundation-protocol-config.test.ts`，覆盖：
- 默认配置加载（总开关 false）
- 子配置默认值正确
- 段位列表校验（仅允许 100/200/300/400/500/800/999）
- syncWaitMs 范围校验（1000-60000）
- arbiterSecretEnv 默认值
- 配置热加载（watcher 触发后重新装配）

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-66): 配置收口、设置页与全量验证

Foundation Protocol 总开关 + 5 个子开关 + 参数配置 + 挂起审批列表查看
论文借鉴：Foundation Protocol 四平面架构完整落地
版本：v4.6.5"
```

---

## 风险与回滚

### 风险 1：段位管道误短路导致合法动作被拒
- **缓解**：段位间短路默认开启，但段位内 deny-overrides 聚合——单条 policy 误判不会跨段位传染；firstFailedSegment 字段帮助定位
- **回滚**：关闭 `foundationProtocol.checkpointPipeline.enabled`，降级为现有 PolicyEngine 顺序评估

### 风险 2：CallOwner 同步等待拖慢主循环
- **缓解**：同步等待 10s 是上限，owner 同步响应则立即返回；超时挂起不阻塞 loop，goal 标记为 paused-awaiting-approval
- **回滚**：关闭 `foundationProtocol.callOwner.enabled`，回退到现有 onConfirmTool 同步回调

### 风险 3：pending-approvals.jsonl 膨胀
- **缓解**：审批完成后记录标记为 approved/denied，定期归档；设置页提供"立即清除已处理审批"按钮
- **回滚**：删除 `.routedev/pending-approvals.jsonl`，下次启动 loadPendingApprovals 返回空

### 风险 4：StateSnapshotChain 签名密钥泄露
- **缓解**：arbiterSecret 从环境变量 ROUTEDEV_ARBITER_SECRET 读取，不写入配置文件；密钥未配置时禁用签名（settled 快照无签名但仍记录）
- **回滚**：关闭 `foundationProtocol.stateSnapshotChain.enabled`，仅写 audit log 不写快照链

### 风险 5：Reputation 派生重算拖慢 project_memory 加载
- **缓解**：缓存默认 1 分钟；批量派生用 Promise.all 并行；topic 数量超过 100 时分批派生
- **回滚**：关闭 `foundationProtocol.reputationDeriver.enabled`，topics 条目不带可信度

### 风险 6：CallOwnerMixin 默认注入策略过于激进
- **缓解**：默认策略为 'off'，用户在设置页显式选择 'conditional' 或 'always_call'；'conditional' 模式仅在 isHighRiskAction 命中时请 owner
- **回滚**：把 `defaultStrategyForToolApproval` 改回 'off'

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 40 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] Foundation Protocol 总开关默认关闭，设置页可开启
- [ ] 开启后 PolicyEngine 按编号段位有序执行（100s→400s→500s）
- [ ] 段位间短路：低段位失败时高段位不执行
- [ ] CallOwner 同步等待 10s + 超时挂起 + 异步恢复链路完整
- [ ] pending-approvals.jsonl 持久化与恢复正常
- [ ] CallOwnerMixin 不引入新 PolicyType，仅通过可选字段注入
- [ ] StateSnapshotChain 在 compose-pipeline 流转与 cross-model-review 结论时写入快照
- [ ] settled 快照携带 HMAC-SHA256 签名，verifyChain 验证完整性
- [ ] ReputationDeriver 从 AuditChain 实时重算可信度
- [ ] project_memory topics 条目携带派生可信度
- [ ] fail-open：任一子模块失败时降级为现有逻辑，不阻塞主流程
- [ ] 设置页 Foundation Protocol 分区可调（总开关 + 5 个子开关 + 参数）
- [ ] README.md 与 ARCHITECTURE.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过，新增 export 均有消费方
- [ ] 配置字段自审：新增的每个 zod schema 字段有读取方
- [ ] 执行人自审报告已附在每个 Task 的提交信息中
