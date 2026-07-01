# Phase 53 — 代码卫生与安全治理加固

> **版本目标：** v4.2.0
> **前置依赖：** Phase 52（学术论文借鉴落地-自进化与可靠性工程）完成
> **新增测试要求：** ≥ 30 个
> **研究依据：** 基于两份内部报告：
> 1. **RouteDev-全量代码审查报告-2026-06-27.md** — 对 src/ 289 .ts + 17 .tsx + desktop/ 67 文件 + tests/ 260 .test.ts 的全量审计，确认 22 个死代码文件（~4,200 行）、6 个"装配但未连接"模块、ReActAgentLoop 的 setter 注入缺口、6 个桌面端死组件、根级遗留文件。
> 2. **开源项目调研报告-Phase53借鉴素材-2026-06-27.md** — 精读 9 个 GitHub 开源项目（microsoft/agent-governance-toolkit、Panniantong/Agent-Reach、NVIDIA/SkillSpector、rohitg00/ai-engineering-from-scratch、addyosmani/agent-skills、anthropics/skills、LMCache/LMCache、jnMetaCode/agency-agents-zh、affaan-m/ECC）的完整源码，提取 20 个共性模式，输出 17 个候选 Task。
> **核心命题：** Phase 50/51/52 完成了模块接入和配置化收尾，但全量审查暴露出三类系统性问题：① **代码卫生**——22 个死代码文件污染代码库，6 个模块"装配但未连接"（实例化后丢弃），ReActAgentLoop 仅 8 个 setter 远不够覆盖已创建的模块；② **安全治理**——策略引擎骨架存在但未接入执行路径，MCP 工具和第三方技能无安全扫描，Agent 可自由弱化自身配置约束；③ **运行时韧性**——上下文无内容寻址缓存导致重复 Token 消耗，无预算告警，无熔断器，无健康检查。Phase 53 把这三类问题落地为 12 个 Task，核心是从"有代码"升级为"代码生效 + 安全可控 + 运行时韧性"。

---

## 项目现状审计与可行性结论

### 1. 审查发现与调研借鉴的映射

| # | 来源 | 核心发现/机制 | RouteDev 现状缺口 | Phase 53 Task |
|---|------|---------------|-------------------|---------------|
| 1 | 审查报告 §3.1 | 22 个死代码文件（~4,200 行） | skills/ 9 个死文件、desktop/ 6 个死组件、evaluation/ 2 个死文件 | Task 1 |
| 2 | 审查报告 §3.2 + §4.2 | "装配但未连接" + setter 注入缺口 | 策略引擎/引用系统/宏系统/调度引擎创建后丢弃，Loop 仅 8 setter | Task 2 |
| 3 | AGT PolicyEngine | 确定性策略执行 + fail-closed | PolicyEngine 已存在但未接入 Loop | Task 3 |
| 4 | AGT AuditLogger | SHA-256 哈希链审计日志 | AuditLogger 存在但无哈希链 | Task 4 |
| 5 | AGT + SkillSpector | MCP 工具 4 类威胁扫描 | MCP 客户端已接入但无安全扫描 | Task 5 |
| 6 | SkillSpector | 技能安全扫描 + 风险评分递减 | 第三方技能安装无安全门控 | Task 6 |
| 7 | ECC | 配置保护守卫 + GateGuard | Agent 可自由修改配置约束 | Task 7 |
| 8 | LMCache | 内容可寻址分块缓存 + 分层存储 | 上下文管理无内容哈希，重复 Token 消耗 | Task 8 |
| 9 | ECC + ai-eng | 上下文预算监控 + 告警 | TokenProfiler 存在但无预算告警 UI | Task 9 |
| 10 | agency-agents + ai-eng | DAG 工作流引擎 + 拓扑排序 | Goal 流程非 DAG，无并行执行 | Task 10 |
| 11 | agency-agents + AGT | 熔断器三态 + 优雅降级 | Agent 调用连续失败无降级 | Task 11 |
| 12 | Agent-Reach | Doctor 健康检查 + Probe 层 | 无一键诊断所有集成状态 | Task 12 |

### 2. 可行性总评

- **Task 1（死代码清理）：** 高度可行。22 个文件已逐一确认零外部引用，删除即可。保留有测试的死代码模块标记为"待装配"。
- **Task 2（装配验证）：** 中等可行。需要为 ReActAgentLoop 添加 4-6 个新 setter，并修改 app-init.ts 中的实例化代码调用 setter。风险是部分模块可能设计上就是"被动可用"（如宏系统），需逐一判定。
- **Task 3（策略引擎接入）：** 可行。PolicyEngine 已实现，只需在 Loop 的 onActing 中间件插入调用。fail-closed 默认策略与现有 PermissionEngine 不冲突（PermissionEngine 是工具级，PolicyEngine 是动作级）。
- **Task 4（哈希链审计）：** 高度可行。AuditLogger 已有 append 日志，扩展为哈希链只需每条记录追加 previousHash 字段。
- **Task 5（MCP 安全扫描）：** 可行。4 类威胁检测都是确定性的正则/距离算法，无需 LLM。在 MCP 工具注册时插入扫描即可。
- **Task 6（技能安全门控）：** 中等可行。17 类漏洞模式的正则需要从 SkillSpector 移植。风险评分递减算法需新建。基线抑制需要用户配置基线文件。
- **Task 7（配置保护守卫）：** 中等可行。难点在于区分"修复代码"和"弱化配置"——需要启发式判断（如修改 .routedev.yaml 的 security 字段是弱化，修改 src/ 下的代码是修复）。
- **Task 8（前缀感知缓存）：** 中等可行。分块哈希算法清晰，但 L2 IndexedDB 需要桌面端适配。CLI 端可只用 L1 内存缓存。
- **Task 9（预算监控）：** 可行。TokenProfiler 已有数据，扩展为实时告警即可。告警 UI 在 CLI 用 Ink 组件，桌面端用 Toast。
- **Task 10（DAG 工作流引擎）：** 中等可行。拓扑排序和并行执行算法清晰，难点在于与现有 Goal 体系的集成——Goal 已有线性步骤，DAG 是超集。
- **Task 11（熔断器）：** 高度可行。三态机是经典模式，与 SubAgentScoreCard 集成即可。
- **Task 12（Doctor）：** 可行。每个集成的探测都是独立子任务，可增量实现。

---

## 核心设计原则

### 原则 1：代码卫生优先于新功能

审查报告确认 22 个死代码文件和 6 个"装配但未连接"模块。Phase 53 的 Task 1/2 必须先完成，确保新功能不建立在死代码之上。任何新 Task 的代码接线点必须引用已接入的模块，不得引用死代码。

### 原则 2：Fail-closed 默认策略（借鉴 AGT + SkillSpector）

所有安全相关模块的默认策略是"无匹配规则时拒绝"。这与 RouteDev 现有的 PermissionEngine（默认允许只读）不冲突——PermissionEngine 是工具级粒度，Phase 53 的策略引擎是动作级粒度，两者是叠加关系。

### 原则 3：确定性优先于 Prompt（借鉴 AGT）

Prompt 级别的安全指令不可靠（可被注入覆盖）。Phase 53 的所有安全检查必须是确定性代码（正则、哈希、距离算法），不依赖 LLM 判断。LLM 仅用于辅助分析（如 SkillSpector 的 Phase 2 语义分析），但 CRITICAL/HIGH 级别的静态发现即使 LLM 拒绝也保留。

### 原则 4：反写死原则（延续 Phase 51/52）

所有新增能力必须有配置开关（Zod schema）、设置页面入口（TabId + 控件）、明确代码接线点（文件级操作表格）。杜绝"写了但不接入"的孤立代码。

### 原则 5：诚实记账（借鉴 SkillSpector）

所有扫描/评估模块必须报告实际使用的能力：`requested` / `available` / `used` / `mode`。不误导用户"已扫描"而实际只跑了静态分析。

---

## Task 1：死代码清理与装配标记（≥ 2 测试）

### 1.1 借鉴来源

**RouteDev 全量代码审查报告 §3.1** — 确认 22 个死代码文件（~4,200 行），分布于 skills/（9 个）、agents/（3 个）、agent/（1 个）、evaluation/（2 个）、import/（1 个）、desktop/renderer/（6 个）。其中 skills/ 目录 45% 是死代码，形成"经过测试的死代码"现象——7 个死文件有完善单元测试。

### 1.2 RouteDev 缺口

22 个死代码文件污染代码库，增加认知负担和维护成本。但直接删除有风险——部分模块（如 compositional-router.ts、activity-store.ts）在 Phase 52 审查后已接入，需确认最新状态。

### 1.3 落地设计

```typescript
// scripts/audit-dead-code.ts（新建脚本）

/**
 * 死代码审计脚本
 * 扫描所有 .ts/.tsx 文件，检测零外部引用的导出
 *
 * 用法：node scripts/audit-dead-code.ts
 * 输出：dead-code-report.json
 */
export interface DeadCodeFinding {
  file: string;
  exports: string[];      // 零引用的导出符号
  hasTests: boolean;      // 是否有对应测试文件
  recommendation: 'delete' | 'keep-tagged' | 'investigate';
}

export function auditDeadCode(projectRoot: string): DeadCodeFinding[] {
  // 1. 收集所有 .ts/.tsx 文件的 export 声明
  // 2. 对每个 export，grep 全项目是否被 import
  // 3. 零引用的 export 标记为 dead
  // 4. 有测试的死代码标记为 'keep-tagged'
  // 5. 输出报告
}
```

**清理策略**：
- **直接删除**：根级遗留文件（p12-*.txt, p13-*.txt, 旧 tsconfig.json, install-utf8.log 等）
- **标记为"待装配"**：有测试的死代码模块（skills/code-style-analyzer.ts 等），在文件头部添加 `// @dead-code-pending-integration` 标记
- **重新验证**：Phase 52 已接入的模块（compositional-router.ts、activity-store.ts 等）从死代码列表移除

### 1.4 配置接入

无新增配置（清理任务）。

### 1.5 设置页面接入

无（清理任务）。

### 1.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `scripts/audit-dead-code.ts` | 新建 | 死代码审计脚本 |
| 根级 `p12-*.txt`, `p13-*.txt` | 删除 | Phase 12-13 调试产物 |
| 根级 `install-utf8.log`, `pnpm-err.log`, `pnpm-out.log` | 删除 | 空日志文件 |
| `skills/code-style-analyzer.ts` 等 | 标记 | 添加 `@dead-code-pending-integration` |
| `desktop/renderer/src/components/ui/Modal.tsx` | 删除 | 从未导入，App.tsx 用内联样式 |

### 1.7 测试要求

- 审计脚本正确识别零引用导出。
- 删除根级遗留文件后项目仍能正常构建。

---

## Task 2：装配验证与 setter 注入缺口修复（≥ 2 测试）

### 2.1 借鉴来源

**RouteDev 全量代码审查报告 §3.2 + §4.2** — ReActAgentLoop 仅有 8 个 setter（setMiddlewarePipeline / setProfiler / setSanitizer / setTraceCollector / setSteeringConsumer / setHookRunner / setComposePipeline / setConciergeThinking），但 app-init.ts 创建了远超 8 种功能模块。策略引擎（6 文件）、引用系统（5 文件）、宏系统（3 文件）、调度引擎（4 文件）可能处于"创建后丢弃"状态。

### 2.2 RouteDev 缺口

大量精心设计的模块可能在运行时完全不起作用——这是本项目最大的架构隐患。需要逐一验证每个实例化对象的后续 setter 调用链。

### 2.3 落地设计

```typescript
// src/agent/loop.ts — 新增 setter

export class ReActAgentLoop {
  // 现有 8 个 setter...

  /** Phase 53 Task 2：策略引擎 setter */
  private policyEngine?: PolicyEngine;
  setPolicyEngine(engine: PolicyEngine): void {
    this.policyEngine = engine;
  }

  /** Phase 53 Task 2：引用系统 setter */
  private citeManager?: CiteManager;
  setCiteManager(manager: CiteManager): void {
    this.citeManager = manager;
  }

  /** Phase 53 Task 2：宏系统 setter */
  private macroManager?: MacroManager;
  setMacroManager(manager: MacroManager): void {
    this.macroManager = manager;
  }

  /** Phase 53 Task 2：调度引擎 setter */
  private cronEngine?: CronEngine;
  setCronEngine(engine: CronEngine): void {
    this.cronEngine = engine;
  }
}
```

```typescript
// scripts/verify-wiring.ts（新建脚本）

/**
 * 装配验证脚本
 * 检查 app-init.ts 中每个实例化对象是否有对应的 setter 调用
 *
 * 用法：node scripts/verify-wiring.ts
 * 输出：wiring-report.json
 */
export interface WiringGap {
  module: string;          // 模块名
  instantiated: boolean;   // 是否在 app-init.ts 中实例化
  setterCalled: boolean;   // 是否调用了 setter
  gap: 'no-setter' | 'no-call' | 'ok';
}

export function verifyWiring(projectRoot: string): WiringGap[] {
  // 1. 解析 app-init.ts 中的所有 new XXX() 调用
  // 2. 解析 ReActAgentLoop 的所有 setXXX() 方法
  // 3. 对比：实例化了但无 setter → 'no-setter'
  //         有 setter 但未调用 → 'no-call'
  //         两者匹配 → 'ok'
}
```

### 2.4 配置接入

无新增配置（修复任务）。

### 2.5 设置页面接入

无（修复任务）。

### 2.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/loop.ts` | 修改 | 新增 4 个 setter |
| `src/cli/app-init.ts` | 修改 | 在实例化后调用 setter |
| `scripts/verify-wiring.ts` | 新建 | 装配验证脚本 |

### 2.7 测试要求

- 装配验证脚本正确识别 "no-setter" 和 "no-call" 缺口。
- 新增 setter 后，对应模块在 Loop 运行时被实际调用。

---

## Task 3：Agent 治理管线接入（≥ 3 测试）

### 3.1 借鉴来源

**microsoft/agent-governance-toolkit (AGT)** — PolicyEngine 是 AGT 的核心组件，支持 YAML/JSON 声明式策略规则，四种冲突解决策略（deny-overrides / allow-overrides / priority-first-match / most-specific-wins），内置速率限制和审批工作流。Fail-closed 默认策略（无匹配规则时拒绝）。

### 3.2 RouteDev 缺口

RouteDev 的 `src/policies/` 目录有 6 个文件（PolicyEngine, IntentGuard, Playbook, Arbitration, ToolApproval, ToolGuide），但审查报告确认这些模块"装配但未连接"——实例化后未通过 setter 注入 ReActAgentLoop，运行时完全不生效。

### 3.3 落地设计

```typescript
// src/policies/engine.ts（已存在，修改接入）

export class PolicyEngine {
  /**
   * Phase 53 Task 3：评估动作的策略合规性
   * 在 ReActAgentLoop 的 onActing 中间件中调用
   *
   * @returns deny 时返回拒绝原因，allow 时返回 null
   */
  evaluateAction(action: AgentAction): PolicyDecision {
    // 1. 匹配策略规则（YAML 声明式）
    // 2. 应用冲突解决策略（默认 deny-overrides）
    // 3. 无匹配规则时 fail-closed（返回 deny）
    // 4. 记录审计日志
  }
}

// src/agent/loop.ts — 在 onActing 中间件插入策略检查
private async onActing(action: AgentAction): Promise<void> {
  // Phase 53 Task 3：策略引擎检查（fail-closed）
  if (this.policyEngine) {
    const decision = this.policyEngine.evaluateAction(action);
    if (decision.denied) {
      throw new PolicyViolationError(decision.reason);
    }
  }
  // 继续执行工具...
}
```

### 3.4 配置接入

```typescript
// src/config/schema.ts — 在 SecurityConfigSchema 中增加
const PolicyEngineConfigSchema = z.object({
  /** 是否启用策略引擎（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 默认策略：无匹配规则时 deny（fail-closed） */
  defaultPolicy: z.enum(['deny', 'allow']).default('deny'),
  /** 冲突解决策略 */
  conflictResolution: z.enum([
    'deny-overrides',
    'allow-overrides',
    'priority-first-match',
    'most-specific-wins',
  ]).default('deny-overrides'),
  /** 策略规则文件路径（YAML） */
  rulesFile: z.string().default('.routedev/policies.yaml'),
});
```

### 3.5 设置页面接入

在 SettingsPage 的 `security` tab 中增加"策略引擎"子区域：
- Switch: "启用策略引擎"
- Select: "默认策略"（deny / allow）
- Select: "冲突解决策略"（4 选 1）
- Input[type=text]: "策略规则文件路径"

### 3.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/policies/engine.ts` | 修改 | 实现 evaluateAction 方法 |
| `src/agent/loop.ts` | 修改 | 新增 setPolicyEngine + onActing 插入检查 |
| `src/cli/app-init.ts` | 修改 | 实例化后调用 loop.setPolicyEngine() |
| `src/config/schema.ts` | 修改 | 增加 PolicyEngineConfigSchema |
| `desktop/renderer/src/components/settings/SettingsSecurityTab.tsx` | 修改 | 增加策略引擎控件 |

### 3.7 测试要求

- 策略引擎 enabled=false 时退回原行为（向后兼容）。
- deny-overrides 策略下，任一规则 deny 则整体 deny。
- fail-closed 默认策略下，无匹配规则时 deny。

---

## Task 4：哈希链审计日志（≥ 2 测试）

### 4.1 借鉴来源

**AGT AuditLogger** — SHA-256 哈希链追加日志，每条记录的 hash = SHA-256(timestamp + agentId + action + decision + previousHash + metadata)，创世哈希为 64 个零，溢出后保留接缝哈希，timingSafeEqual 防篡改验证。

### 4.2 RouteDev 缺口

RouteDev 的 `src/harness/audit-logger.ts` 已存在但只做普通追加日志，无哈希链防篡改机制。审计日志可被静默修改或删除。

### 4.3 落地设计

```typescript
// src/harness/audit-logger.ts（已存在，修改）

export class AuditLogger {
  private previousHash: string = '0'.repeat(64); // 创世哈希

  /**
   * Phase 53 Task 4：追加哈希链审计记录
   * 每条记录包含 previousHash，形成防篡改链
   */
  append(entry: AuditEntry): AuditRecord {
    const record: AuditRecord = {
      timestamp: Date.now(),
      agentId: entry.agentId,
      action: entry.action,
      decision: entry.decision,
      metadata: entry.metadata,
      previousHash: this.previousHash,
    };
    // 计算当前记录的哈希
    record.hash = this.computeHash(record);
    this.previousHash = record.hash;
    this.writeToDisk(record);
    return record;
  }

  /**
   * 验证哈希链完整性
   * 用 timingSafeEqual 防止时序攻击
   */
  verifyChain(records: AuditRecord[]): boolean {
    let prevHash = '0'.repeat(64);
    for (const record of records) {
      const computed = this.computeHash(record);
      if (!crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(record.hash))) {
        return false; // 哈希不匹配，记录被篡改
      }
      if (record.previousHash !== prevHash) {
        return false; // 链断裂
      }
      prevHash = record.hash;
    }
    return true;
  }

  private computeHash(record: AuditRecord): string {
    const data = `${record.timestamp}${record.agentId}${record.action}${record.decision}${record.previousHash}${JSON.stringify(record.metadata)}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}
```

### 4.4 配置接入

```typescript
// src/config/schema.ts — 在 SecurityConfigSchema 中增加
const AuditChainConfigSchema = z.object({
  /** 是否启用哈希链（默认 false，向后兼容） */
  enabled: z.boolean().default(false),
  /** 审计日志文件路径 */
  logFile: z.string().default('.routedev/audit-chain.jsonl'),
  /** 溢出时保留的接缝哈希数 */
  overflowSealCount: z.number().int().min(1).default(1),
});
```

### 4.5 设置页面接入

在 `security` tab 中增加"哈希链审计"子区域：
- Switch: "启用哈希链审计"
- Input[type=text]: "审计日志文件路径"
- Button: "验证审计链完整性"（触发 verifyChain）

### 4.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/harness/audit-logger.ts` | 修改 | 实现哈希链 + verifyChain |
| `src/config/schema.ts` | 修改 | 增加 AuditChainConfigSchema |
| `src/cli/app-init.ts` | 修改 | 按 config 开关初始化 |
| `desktop/renderer/src/components/settings/SettingsSecurityTab.tsx` | 修改 | 增加哈希链控件 |

### 4.7 测试要求

- 哈希链正确链接（每条记录的 previousHash = 上一条的 hash）。
- 篡改任意记录后 verifyChain 返回 false。
- enabled=false 时退回普通追加日志。

---

## Task 5：MCP 安全扫描器（≥ 3 测试）

### 5.1 借鉴来源

**AGT McpSecurityScanner + SkillSpector** — 4 类威胁检测：① 工具投毒（正则匹配 `<system>`, `ignore previous` 等注入模式）② 名称仿冒（与已知工具名的 Levenshtein 距离 ≤2）③ 隐藏指令（零宽 Unicode + 同形字）④ 地毯式替换（描述 >500 字符 + 2+ 指令模式）。

### 5.2 RouteDev 缺口

RouteDev 的 MCP 客户端已接入（`src/tools/mcp/client.ts`），但无安全扫描。第三方 MCP 工具可直接注册到 ToolRegistry，无任何安全检查。

### 5.3 落地设计

```typescript
// src/tools/mcp/security-scanner.ts（新建文件）

export interface McpSecurityFinding {
  toolName: string;
  threatType: 'poisoning' | 'impersonation' | 'hidden_instruction' | 'carpet_bombing';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string; // 匹配的文本片段
}

export class McpSecurityScanner {
  private readonly injectionPatterns = [
    /<system>/i,
    /ignore previous/i,
    /ignore all/i,
    /disregard/i,
    /you are now/i,
    /new instructions/i,
  ];

  private readonly hiddenUnicodeRanges = [
    /[\u200B-\u200D]/,  // 零宽空格
    /[\uFEFF]/,          // BOM
    /[\u2060-\u2069]/,   // 不可见字符
  ];

  /**
   * 扫描 MCP 工具定义
   * 在工具注册到 ToolRegistry 之前调用
   */
  scan(toolDef: McpToolDefinition): McpSecurityFinding[] {
    const findings: McpSecurityFinding[] = [];
    // 1. 工具投毒检测
    // 2. 名称仿冒检测（Levenshtein 距离）
    // 3. 隐藏指令检测
    // 4. 地毯式替换检测
    return findings;
  }
}
```

### 5.4 配置接入

```typescript
const McpSecurityScanConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** 阻断阈值：severity >= 此级别的发现阻止注册 */
  blockThreshold: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
  /** 已知工具名列表（用于仿冒检测） */
  knownToolNames: z.array(z.string()).default([]),
});
```

### 5.5 设置页面接入

在 `mcp` tab 中增加"MCP 安全扫描"子区域：
- Switch: "启用 MCP 安全扫描"
- Select: "阻断阈值"
- Button: "扫描已注册工具"（触发全量扫描）

### 5.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/tools/mcp/security-scanner.ts` | 新建 | 4 类威胁检测 |
| `src/tools/mcp/client.ts` | 修改 | 注册前调用 scan |
| `src/config/schema.ts` | 修改 | 增加 McpSecurityScanConfigSchema |
| `desktop/renderer/src/components/settings/SettingsMcpTab.tsx` | 修改 | 增加扫描控件 |

### 5.7 测试要求

- 工具投毒模式被正确检测。
- Levenshtein 距离 ≤2 的名称被标记为仿冒。
- 零宽 Unicode 被检测。
- 描述 >500 字符 + 2+ 指令模式被标记为地毯式替换。

---

## Task 6：技能安全扫描门控（≥ 3 测试）

### 6.1 借鉴来源

**NVIDIA/SkillSpector** — 26.1% 的 Agent 技能包含漏洞，5.2% 显示恶意意图。双阶段分析（Phase 1 静态 15 个分析器 + Phase 2 语义 3 个 LLM 分析器）。风险评分算法：CRITICAL=50, HIGH=25, MEDIUM=10, LOW=5，同规则递减（第 2 次 0.5x，第 3 次 0.25x）。元分析器的严重性地板——CRITICAL 和 HIGH 静态发现即使 LLM 拒绝也保留。

### 6.2 RouteDev 缺口

RouteDev 的技能体系（`src/skills/`）无安装前安全门控。第三方技能（如从 anthropics/skills 或 ECC 导入）可直接安装，无漏洞扫描。

### 6.3 落地设计

```typescript
// src/skills/security-gate.ts（新建文件）

export interface SkillSecurityFinding {
  rule: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  evidence: string;
  line?: number;
}

export interface SkillScanResult {
  skillId: string;
  score: number;          // 0-100，>50 拒绝自动安装
  findings: SkillSecurityFinding[];
  scanMode: 'static-only' | 'static+llm';
  llmRequested: boolean;
  llmAvailable: boolean;
  llmUsed: boolean;
}

export class SkillSecurityGate {
  /** 17 类漏洞模式的正则规则 */
  private readonly vulnerabilityRules: VulnerabilityRule[] = [
    // 1. 命令注入
    { id: 'cmd_injection', pattern: /eval\(|exec\(|system\(/i, severity: 'critical' },
    // 2. 路径穿越
    { id: 'path_traversal', pattern: /\.\.\//i, severity: 'high' },
    // 3. SSRF
    { id: 'ssrf', pattern: /fetch\(|axios\(|http\.get\(/i, severity: 'medium' },
    // ... 14 more
  ];

  /**
   * 扫描技能
   * @param skillDir 技能目录
   * @returns 扫描结果，score > 50 拒绝自动安装
   */
  scan(skillDir: string): SkillScanResult {
    // 1. 静态分析：17 类正则规则
    // 2. 风险评分：基础分 + 同规则递减（第 2 次 0.5x，第 3 次 0.25x）
    // 3. 可执行文件 1.3x 乘数
    // 4. 封顶 0-100
    // 5. 诚实记账：报告 scanMode / llmRequested / llmAvailable / llmUsed
  }
}
```

### 6.4 配置接入

```typescript
const SkillSecurityGateConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** 自动安装的分数阈值（>此值需用户确认） */
  autoInstallThreshold: z.number().int().min(0).max(100).default(50),
  /** 基线抑制文件（Glob + SHA-256 指纹） */
  baselineFile: z.string().default('.routedev/skill-baseline.json'),
});
```

### 6.5 设置页面接入

在 `skills` tab 中增加"技能安全门控"子区域：
- Switch: "启用技能安全扫描"
- Input[type=number]: "自动安装阈值"（0-100）
- Button: "扫描已安装技能"

### 6.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/skills/security-gate.ts` | 新建 | 17 类漏洞扫描 + 风险评分 |
| `src/skills/lifecycle/manager.ts` | 修改 | 安装前调用 scan |
| `src/config/schema.ts` | 修改 | 增加 SkillSecurityGateConfigSchema |
| `desktop/renderer/src/components/settings/SettingsSkillsTab.tsx` | 修改 | 增加门控控件 |

### 6.7 测试要求

- 17 类漏洞模式被正确检测。
- 同规则递减算法：第 2 次匹配 0.5x，第 3 次 0.25x。
- score > 50 的技能被拒绝自动安装。
- 诚实记账字段正确报告。

---

## Task 7：配置保护守卫（≥ 2 测试）

### 7.1 借鉴来源

**affaan-m/ECC 配置保护守卫 + GateGuard** — 阻止 AI 弱化自己的约束（如禁用 linting 规则来消除错误）。GateGuard 阻止首次 Edit/Write 任何文件，要求 Agent 先调查文件的导入者、数据模式和用户指令。

### 7.2 RouteDev 缺口

RouteDev 的 Agent 可通过 file_edit 工具自由修改配置文件（.routedev.yaml, config.yaml, 权限规则, 安全策略, 钩子配置），无任何守卫。

### 7.3 落地设计

```typescript
// src/tools/builtin/config-guard.ts（新建文件）

export class ConfigGuard {
  /** 受保护的配置文件 pattern */
  private readonly protectedPatterns = [
    /\.routedev\.yaml$/i,
    /config\.yaml$/i,
    /\.routedev\/policies\.yaml$/i,
    /\.routedev\/hooks\.yaml$/i,
    /\.routedev\/permissions\.json$/i,
  ];

  /**
   * 检查文件修改是否被允许
   * @returns denied 时返回原因
   */
  checkModification(filePath: string, content: string): GuardDecision {
    // 1. 匹配 protectedPatterns
    // 2. 如果是配置文件，分析 diff：
    //    - 弱化 security 字段（如 enabled: true → false）→ deny
    //    - 弱化 commandBlacklist / toolBlacklist → deny
    //    - 其他修改 → warn（允许但记录审计日志）
    // 3. 首次触发时警告用户
  }
}

// src/tools/builtin/file-edit.ts — 在执行前调用 ConfigGuard
```

### 7.4 配置接入

```typescript
const ConfigGuardConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** 首次触发时是否弹窗确认 */
  warnOnFirst: z.boolean().default(true),
  /** 受保护文件 pattern（用户可扩展） */
  protectedPatterns: z.array(z.string()).default([]),
});
```

### 7.5 设置页面接入

在 `security` tab 中增加"配置保护守卫"子区域：
- Switch: "启用配置保护"
- Switch: "首次触发弹窗确认"
- Textarea: "受保护文件 pattern"（每行一个）

### 7.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/tools/builtin/config-guard.ts` | 新建 | 配置保护守卫 |
| `src/tools/builtin/file-edit.ts` | 修改 | 执行前调用 ConfigGuard |
| `src/tools/builtin/file-write.ts` | 修改 | 执行前调用 ConfigGuard |
| `src/config/schema.ts` | 修改 | 增加 ConfigGuardConfigSchema |
| `desktop/renderer/src/components/settings/SettingsSecurityTab.tsx` | 修改 | 增加守卫控件 |

### 7.7 测试要求

- 弱化 security.enabled 的修改被 deny。
- 弱化 commandBlacklist 的修改被 deny。
- 非配置文件修改不受影响。
- enabled=false 时不拦截。

---

## Task 8：前缀感知上下文缓存（≥ 3 测试）

### 8.1 借鉴来源

**LMCache/LMCache** — 内容可寻址分块缓存：输入 Token 按固定大小分块（默认 256 Token），每块 SHA-256 链式哈希（与前缀哈希链接），相同 Token 序列自动产生相同缓存键。分层存储：GPU VRAM → CPU RAM → 本地 SSD → 远程服务器。Skip-existing 优化：存储时逐块顺序检查，遇到第一个未缓存的块即停止。

### 8.2 RouteDev 缺口

RouteDev 的上下文管理（`src/agent/memory/context-manager.ts`）无内容哈希，每次请求重新发送完整上下文。相同前缀的对话历史重复消耗 Token。

### 8.3 落地设计

```typescript
// src/agent/memory/prefix-cache.ts（新建文件）

export interface CacheBlock {
  hash: string;           // SHA-256 链式哈希
  tokens: number[];
  size: number;           // Token 数
}

export class PrefixAwareCache {
  private readonly blockSize: number;  // 默认 256
  private l1Cache: Map<string, CacheBlock> = new Map(); // L1 内存
  private l1MaxSize: number = 1000;    // L1 最多 1000 块

  /**
   * 分块并计算哈希
   * 链式哈希：每块的 hash = SHA-256(blockContent + previousBlockHash)
   */
  chunkAndHash(tokens: number[]): CacheBlock[] {
    const blocks: CacheBlock[] = [];
    let previousHash = '0'.repeat(64);
    for (let i = 0; i < tokens.length; i += this.blockSize) {
      const chunk = tokens.slice(i, i + this.blockSize);
      const hash = this.computeChainHash(chunk, previousHash);
      blocks.push({ hash, tokens: chunk, size: chunk.length });
      previousHash = hash;
    }
    return blocks;
  }

  /**
   * Skip-existing 写入
   * 逐块顺序检查，遇到第一个未缓存的块即停止
   */
  skipExistingWrite(blocks: CacheBlock[]): number {
    let firstMiss = -1;
    for (let i = 0; i < blocks.length; i++) {
      if (!this.l1Cache.has(blocks[i].hash)) {
        firstMiss = i;
        break;
      }
    }
    if (firstMiss === -1) return blocks.length; // 全部命中
    // 从 firstMiss 开始写入
    for (let i = firstMiss; i < blocks.length; i++) {
      this.put(blocks[i]);
    }
    return firstMiss;
  }

  /**
   * L1 LRU 淘汰
   */
  private put(block: CacheBlock): void {
    if (this.l1Cache.size >= this.l1MaxSize) {
      const oldest = this.l1Cache.keys().next().value;
      this.l1Cache.delete(oldest);
    }
    this.l1Cache.set(block.hash, block);
  }
}
```

### 8.4 配置接入

```typescript
const PrefixCacheConfigSchema = z.object({
  enabled: z.boolean().default(false),
  blockSize: z.number().int().min(64).max(1024).default(256),
  l1MaxSize: z.number().int().min(100).default(1000),
  /** 是否对齐 Anthropic prompt caching API */
  alignAnthropicApi: z.boolean().default(true),
});
```

### 8.5 设置页面接入

在 `memory` tab 中增加"前缀感知缓存"子区域：
- Switch: "启用前缀感知缓存"
- Input[type=number]: "分块大小"（64-1024）
- Input[type=number]: "L1 最大块数"

### 8.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/memory/prefix-cache.ts` | 新建 | 分块哈希 + LRU 缓存 |
| `src/agent/memory/context-manager.ts` | 修改 | 接入 PrefixAwareCache |
| `src/config/schema.ts` | 修改 | 增加 PrefixCacheConfigSchema |
| `desktop/renderer/src/components/settings/SettingsMemoryTab.tsx` | 修改 | 增加缓存控件 |

### 8.7 测试要求

- 相同 Token 序列产生相同缓存键。
- 链式哈希正确（改变前缀则后续哈希全变）。
- Skip-existing 在第一个未缓存块停止。
- L1 LRU 淘汰正确。

---

## Task 9：上下文预算监控与告警（≥ 3 测试）

### 9.1 借鉴来源

**affaan-m/ECC 上下文预算监控 + rohitg00/ai-eng 多会话交接** — Token 耗尽、成本超支、范围蔓延、工具循环时注入警告。多会话交接在 50-75% 上下文预算时执行（不是 95%），交接文档必须包含下一个任务。

### 9.2 RouteDev 缺口

RouteDev 的 TokenProfiler 存在但无预算告警。Agent 在接近上下文窗口限制时无预警，直接溢出后触发上下文压缩。

### 9.3 落地设计

```typescript
// src/agent/budget-monitor.ts（新建文件）

export interface BudgetAlert {
  type: 'token_low' | 'cost_overrun' | 'scope_creep' | 'tool_loop';
  severity: 'info' | 'warn' | 'critical';
  message: string;
  current: number;
  threshold: number;
}

export class BudgetMonitor {
  private tokenUsage: number = 0;
  private tokenLimit: number;
  private costAccumulated: number = 0;
  private costLimit: number;
  private toolCallHistory: string[] = [];

  /**
   * 实时监控，注入告警到 Agent 上下文
   * 在 50% / 75% / 90% 阈值时触发不同级别告警
   */
  check(): BudgetAlert[] {
    const alerts: BudgetAlert[] = [];
    // 1. Token 耗尽预警
    const ratio = this.tokenUsage / this.tokenLimit;
    if (ratio >= 0.9) alerts.push({ type: 'token_low', severity: 'critical', ... });
    else if (ratio >= 0.75) alerts.push({ type: 'token_low', severity: 'warn', ... });
    else if (ratio >= 0.5) alerts.push({ type: 'token_low', severity: 'info', ... });
    // 2. 成本超支
    // 3. 范围蔓延（工具调用次数异常增长）
    // 4. 工具循环检测（连续相同工具调用）
    return alerts;
  }
}
```

### 9.4 配置接入

```typescript
const BudgetMonitorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  tokenWarnRatio: z.number().min(0.1).max(1).default(0.75),
  costLimitPerSession: z.number().positive().default(10), // 美元
  toolLoopThreshold: z.number().int().min(3).default(5),
});
```

### 9.5 设置页面接入

在 `cost` tab 中增加"预算监控"子区域：
- Switch: "启用预算监控"
- Input[type=number]: "Token 预警比例"（0.1-1）
- Input[type=number]: "会话成本上限"（美元）
- Input[type=number]: "工具循环阈值"

### 9.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/budget-monitor.ts` | 新建 | 4 类告警 |
| `src/agent/loop.ts` | 修改 | 每次工具调用后检查 |
| `src/config/schema.ts` | 修改 | 增加 BudgetMonitorConfigSchema |
| `desktop/renderer/src/components/settings/SettingsCostTab.tsx` | 修改 | 增加监控控件 |

### 9.7 测试要求

- Token 使用达 75% 时触发 warn 告警。
- 成本超支时触发 critical 告警。
- 连续 5 次相同工具调用触发 tool_loop 告警。

---

## Task 10：DAG 工作流引擎（≥ 4 测试）

### 10.1 借鉴来源

**jnMetaCode/agency-agents-zh + rohitg00/ai-eng** — DAG 工作流引擎：解析 `depends_on` 数组，独立节点并行执行，`{{variable}}` 模板标签传递数据。Plan-and-Execute (ReWOO)：Planner 生成 DAG → Worker 拓扑排序并行执行 → Solver 综合。

### 10.2 RouteDev 缺口

RouteDev 的 Goal 流程是线性步骤列表，无 DAG 编排。多步骤间有依赖关系但无法声明，只能顺序执行。

### 10.3 落地设计

```typescript
// src/agent/workflow/dag-engine.ts（新建文件）

export interface DagNode {
  id: string;
  dependsOn: string[];    // 依赖节点 ID
  action: string;          // 动作描述
  variables?: Record<string, string>; // {{variable}} 模板
}

export interface DagWorkflow {
  nodes: DagNode[];
  variables: Record<string, unknown>;
}

export class DagEngine {
  /**
   * 拓扑排序
   * 使用 Kahn 算法，检测循环依赖
   */
  topologicalSort(nodes: DagNode[]): DagNode[] | null {
    // 1. 计算入度
    // 2. 入度为 0 的节点入队
    // 3. BFS，每出队一个节点，其邻居入度 -1
    // 4. 入度为 0 的邻居入队
    // 5. 如果排序后节点数 < 总节点数 → 有环
  }

  /**
   * 并行执行独立节点
   */
  async execute(workflow: DagWorkflow): Promise<void> {
    const sorted = this.topologicalSort(workflow.nodes);
    if (!sorted) throw new Error('DAG 包含循环依赖');
    // 按层级并行执行（同层无依赖的节点并行）
  }

  /**
   * 变量替换
   * {{variable}} → 实际值
   */
  resolveVariables(action: string, variables: Record<string, unknown>): string {
    return action.replace(/\{\{(\w+)\}\}/g, (_, key) => String(variables[key] ?? ''));
  }
}
```

### 10.4 配置接入

```typescript
const DagEngineConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxParallel: z.number().int().min(1).max(10).default(3),
  retryLimit: z.number().int().min(0).max(5).default(2),
  /** 人类升级阈值：连续失败 N 次后请求人类介入 */
  humanEscalationThreshold: z.number().int().min(1).default(3),
});
```

### 10.5 设置页面接入

在 `workflow` tab 中增加"DAG 引擎"子区域：
- Switch: "启用 DAG 工作流"
- Input[type=number]: "最大并行度"（1-10）
- Input[type=number]: "重试上限"（0-5）
- Input[type=number]: "人类升级阈值"

### 10.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/workflow/dag-engine.ts` | 新建 | 拓扑排序 + 并行执行 |
| `src/agent/goal-parser.ts` | 修改 | 解析 Goal 为 DAG |
| `src/config/schema.ts` | 修改 | 增加 DagEngineConfigSchema |
| `desktop/renderer/src/components/settings/SettingsWorkflowTab.tsx` | 修改 | 增加 DAG 控件 |

### 10.7 测试要求

- 拓扑排序正确（A→B→C 输出 [A, B, C]）。
- 循环依赖被检测（返回 null）。
- 同层独立节点并行执行。
- `{{variable}}` 被正确替换。

---

## Task 11：熔断器模式（≥ 2 测试）

### 11.1 借鉴来源

**jnMetaCode/agency-agents-zh + AGT CascadeContainment** — 熔断器三态：CLOSED（正常）/ OPEN（断路）/ HALF-OPEN（试探恢复）。连续 N 次失败 → OPEN，拒绝调用并返回降级响应。超时后 → HALF-OPEN，允许单次试探。试探成功 → CLOSED，失败 → 回到 OPEN。

### 11.2 RouteDev 缺口

RouteDev 的 Agent 调用连续失败时无优雅降级。子 Agent 反复失败会消耗预算，无熔断机制。

### 11.3 落地设计

```typescript
// src/agent/circuit-breaker.ts（新建文件）

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThreshold: number;  // 连续失败 N 次后熔断（默认 5）
  resetTimeout: number;       // 熔断后多久尝试恢复（毫秒，默认 60000）
  halfOpenMaxAttempts: number; // HALF-OPEN 状态最多试探次数（默认 1）
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount: number = 0;
  private lastFailureTime: number = 0;

  /**
   * 检查是否允许调用
   */
  canCall(): boolean {
    switch (this.state) {
      case 'closed':
        return true;
      case 'open':
        // 检查是否超过 resetTimeout
        if (Date.now() - this.lastFailureTime > this.config.resetTimeout) {
          this.state = 'half_open';
          return true;
        }
        return false; // 拒绝调用
      case 'half_open':
        return true; // 允许试探
    }
  }

  /**
   * 记录调用结果
   */
  recordResult(success: boolean): void {
    if (success) {
      this.failureCount = 0;
      this.state = 'closed'; // 试探成功 → 恢复
    } else {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      if (this.state === 'half_open') {
        this.state = 'open'; // 试探失败 → 重新熔断
      } else if (this.failureCount >= this.config.failureThreshold) {
        this.state = 'open'; // 连续失败达阈值 → 熔断
      }
    }
  }
}
```

### 11.4 配置接入

```typescript
const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  failureThreshold: z.number().int().min(1).default(5),
  resetTimeout: z.number().int().min(1000).default(60000),
  halfOpenMaxAttempts: z.number().int().min(1).default(1),
});
```

### 11.5 设置页面接入

在 `agent` tab 中增加"熔断器"子区域：
- Switch: "启用熔断器"
- Input[type=number]: "失败阈值"（1-20）
- Input[type=number]: "恢复超时（毫秒）"
- Input[type=number]: "试探次数"

### 11.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/circuit-breaker.ts` | 新建 | 三态熔断器 |
| `src/agents/sub-agent-lifecycle.ts` | 修改 | 子 Agent 调用前检查熔断器 |
| `src/agent/multi/worker-executor.ts` | 修改 | Worker 调用前检查熔断器 |
| `src/config/schema.ts` | 修改 | 增加 CircuitBreakerConfigSchema |
| `desktop/renderer/src/components/settings/SettingsAgentTab.tsx` | 修改 | 增加熔断器控件 |

### 11.7 测试要求

- 连续 5 次失败后 state 变为 open。
- open 状态下 canCall 返回 false。
- resetTimeout 后 state 变为 half_open。
- half_open 试探成功后 state 变为 closed。

---

## Task 12：Agent 健康检查 / Doctor（≥ 3 测试）

### 12.1 借鉴来源

**Panniantong/Agent-Reach** — `agent-reach doctor` 一键健康检查，使用真实子进程探测（不是 `shutil.which()`），区分 missing / broken / timeout 三种失败模式。环境自动检测评分式指标。

### 12.2 RouteDev 缺口

RouteDev 无一键诊断所有集成状态的功能。用户遇到问题时需手动检查 LLM Provider、MCP Server、频道适配器、本地工具的可用性。

### 12.3 落地设计

```typescript
// src/cli/doctor.ts（新建文件）

export interface ProbeResult {
  component: string;       // 组件名
  status: 'ok' | 'missing' | 'broken' | 'timeout';
  version?: string;        // 版本信息
  latencyMs?: number;      // 探测延迟
  message: string;         // 诊断信息
  suggestion?: string;     // 修复建议
}

export class Doctor {
  /**
   * 探测所有集成状态
   */
  async runAllChecks(): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    // 1. LLM Provider 连通性（每个 provider 发送 ping 请求）
    // 2. MCP Server 运行状态（每个 MCP server 发送 tools/list）
    // 3. 频道适配器 Webhook 可用性（发送 test message）
    // 4. 本地工具版本（git --version, node --version, pnpm --version）
    // 5. 配置文件完整性（schema 校验）
    return results;
  }

  /**
   * 输出诊断报告
   * CLI：彩色表格
   * 桌面端：JSON 供 UI 渲染
   */
  formatReport(results: ProbeResult[]): string {
    // 彩色表格输出
  }
}

// src/cli/commands/doctor.ts（新建命令）
// /doctor 命令：调用 Doctor.runAllChecks() 并输出报告
```

### 12.4 配置接入

```typescript
const DoctorConfigSchema = z.object({
  /** 探测超时（毫秒） */
  probeTimeout: z.number().int().min(1000).default(10000),
  /** 是否在启动时自动运行 doctor */
  runOnStartup: z.boolean().default(false),
});
```

### 12.5 设置页面接入

在 `advanced` tab 中增加"健康检查"子区域：
- Button: "运行健康检查"（触发 Doctor）
- 探测结果以表格形式展示

### 12.6 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/cli/doctor.ts` | 新建 | Doctor 探测器 |
| `src/cli/commands/doctor.ts` | 新建 | /doctor 命令 |
| `src/cli/app-init.ts` | 修改 | 按 runOnStartup 开关启动时运行 |
| `desktop/renderer/src/components/DoctorPanel.tsx` | 新建 | 桌面端健康仪表板 |
| `src/config/schema.ts` | 修改 | 增加 DoctorConfigSchema |

### 12.7 测试要求

- LLM Provider 不可达时返回 timeout。
- MCP Server 不存在时返回 missing。
- 本地工具版本正确探测。
- 探测超时不超过 probeTimeout。

---

## 验收清单

### 代码卫生

- [ ] 22 个死代码文件已清理或标记
- [ ] 装配验证脚本通过（零 "no-setter" / "no-call" 缺口）
- [ ] ReActAgentLoop 新增 setter 全部被调用
- [ ] fail-open 模块加载失败时有 warn 日志
- [ ] 根级遗留文件已清理

### 安全治理

- [ ] 策略引擎接入 onActing 中间件，fail-closed 默认策略生效
- [ ] 哈希链审计日志可验证完整性
- [ ] MCP 工具注册前通过 4 类威胁扫描
- [ ] 第三方技能安装前通过 17 类漏洞扫描
- [ ] 配置文件修改被守卫拦截弱化操作

### 运行时韧性

- [ ] 前缀感知缓存命中率 > 50%（相同前缀场景）
- [ ] Token 预算达 75% 时触发 warn 告警
- [ ] DAG 工作流拓扑排序正确，循环依赖被检测
- [ ] 熔断器在连续 5 次失败后进入 open 状态
- [ ] `routedev doctor` 命令输出所有集成状态

### 反写死合规

- [ ] 所有新增能力有 Zod schema 定义
- [ ] 所有用户可配置项有设置页面入口
- [ ] 所有代码接线点在文件级操作表格中列出
- [ ] 零孤立代码（所有新模块被至少一条生产路径引用）

### 测试

- [ ] 新增测试 ≥ 30 个
- [ ] 所有测试通过
- [ ] `tsc --noEmit` 零错误

---

## 任务依赖关系

```
Task 1 (死代码清理) ─┐
                     ├─→ Task 3 (策略引擎接入) ─→ Task 7 (配置保护)
Task 2 (装配验证) ───┘                              │
                                                     ↓
Task 4 (哈希链审计) ←── 依赖 Task 3 的策略动作记录
Task 5 (MCP 安全扫描) ── 独立
Task 6 (技能安全门控) ── 依赖 Task 5 的扫描算法

Task 8 (前缀感知缓存) ── 独立
Task 9 (预算监控) ──── 依赖 Task 8
Task 10 (DAG 引擎) ─── 独立
Task 11 (熔断器) ───── 独立
Task 12 (Doctor) ───── 独立，建议最后做（汇总所有集成状态）
```

## 测试要求估算

| 梯队 | 任务数 | 预估新增测试 |
|------|--------|-------------|
| 代码卫生（Task 1-2） | 2 | ≥ 4 |
| 安全治理（Task 3-7） | 5 | ≥ 13 |
| 运行时韧性（Task 8-12） | 5 | ≥ 13 |
| **合计** | **12** | **≥ 30** |

## 知识库来源索引

| Task | 借鉴来源 | 核心机制 |
|------|----------|----------|
| 1-2 | RouteDev 全量审查报告 | 死代码 + 装配缺口 |
| 3 | microsoft/agent-governance-toolkit | PolicyEngine + fail-closed |
| 4 | microsoft/agent-governance-toolkit | SHA-256 哈希链审计 |
| 5 | microsoft/agent-governance-toolkit + NVIDIA/SkillSpector | MCP 4 类威胁检测 |
| 6 | NVIDIA/SkillSpector | 17 类漏洞扫描 + 风险评分递减 |
| 7 | affaan-m/ECC | 配置保护守卫 + GateGuard |
| 8 | LMCache/LMCache | 内容可寻址分块缓存 |
| 9 | affaan-m/ECC + ai-engineering-from-scratch | 预算监控 + 多会话交接 |
| 10 | agency-agents-zh + ai-engineering-from-scratch | DAG 工作流 + ReWOO |
| 11 | agency-agents-zh + microsoft/agent-governance-toolkit | 熔断器三态 |
| 12 | Agent-Reach | Doctor 健康检查 + Probe 层 |
