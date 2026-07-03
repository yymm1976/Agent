# Phase 68 — 检索/搜索/发现三分与知识图谱

> **版本目标：** v4.6.7
> **前置依赖：** Phase 67 完成
> **后继依赖：** 无（本 Phase 是知识表征层增强，可与 Phase 69+ 并行）
> **新增测试要求：** ≥ 35 个
> **研究依据：** 精读 arXiv:2606.01444《Self-Revising Discovery Systems for Science: A Categorical Framework for Agentic AI》（MIT，2026-05-31）全文。论文核心论断：科学发现不是"答案生成"，而是"表征体制（representational regime）的修订"——证据、制品、操作、验证器被类型化的方式发生改变。重要科学操作往往改变词汇表本身（新有效变量 / 新可容许操作 / 新验证器 / 新工具 / 新制品类型）。论文形式化"类型化制品系统"五组件（Schema / Artifact population / Provenance graph / Gate-Verifier / Regime-update mechanism），并结构性区分三种操作：**Retrieval（检索，添加已可表示的制品）/ Search（搜索，固定 schema 内找新路径或新组合）/ Discovery（发现，改变制品与操作被类型化的体制）**。发现被建模为"经核验的体制迁移 u: S_b → S_b'"，旧制品由左 Kan 扩展 Lan_u I_t 迁运到新体制；**Kan 障碍**——Kan 扩展在孤立新类型上取空值，意味着"仅靠迁运无法填充新类型"，必须由门核验的新制品填充，这是具体的、可计算的反驳。论文案例（光纤网络力学）的关键洞察：**模型选择本身（含被拒替代）被记录为类型化溯源——让"失败"也成为知识图谱的一等公民。**
> **核心命题：** RouteDev 当前所有"知识"都是扁平的——[CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 只存"消息快照"、[ProjectMemoryManager](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 的 decisions.log 是无类型 JSONL、[CrossModelReviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 否决的方案直接丢弃。Phase 68 把论文的"类型化制品 + 溯源图 + 三分操作 + 被拒替代保留 + Kan 障碍空类型检查"降维落地：让 RouteDev 的每一次检索/组合/新技能注册都被显式分类，让每一条决策都有类型与父节点，让被拒方案可检索，让"新依赖输入类型无人填充"时发出可计算的反驳警示。**让"失败"和"成功"一样成为知识图谱的一等公民。**

---

## 项目现状审计与可行性结论

### 1. 论文与 RouteDev 缺口的映射

| 论文组件 | 核心 Contribution | RouteDev 现状缺口 | Phase 68 Task |
|---------------|-------------------|-------------------|---------------|
| 三种操作结构性区分（Figure 1） | Retrieval / Search / Discovery 三分 | CCRCache 命中、compositional-router 组合、新技能注册三者无分类，混为一谈 | Task 1（三分标注） |
| 类型化制品 + Provenance graph（Section 2.1） | 制品有类型、记录父节点与产生操作、操作复合即谱系 | [project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 的 decisions.log 是无类型 JSONL，无溯源边 | Task 2（溯源图升级） |
| 被拒替代保留（光纤案例） | 模型选择（含被拒替代）物化为类型化溯源，"失败"是一等公民 | [CrossModelReviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 否决的方案直接丢弃，被拒原因只在 summary 字符串里 | Task 3（被拒替代保留） |
| Kan 障碍（空类型警示） | Kan 扩展在孤立新类型取空值 = 仅靠迁运无法填充，必须门核验的新制品填充 | 动态注册新技能/导入新 policy 时，不检查"依赖输入类型在现有 schema 是否有制品可填充" | Task 4（空类型警示） |
| Gate/Verifier（MDL/AIC） | 显式门决定 accept/reject/supersede/hold，可量化场景用 MDL/AIC 硬阈值 | CrossModelReviewer 只用 LLM 软判断，无可量化的描述长度/复杂度硬阈值 | Task 5（定量门） |
| Regime-update mechanism | 体制扩展 u: S_b → S_b' 被记录为可追溯的迁移声明 | 新技能注册、新 policy 导入无"体制迁移"记录到 [AuditChain](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) | Task 1 + Task 4 |

### 2. 可行性总评

- **Task 1（三分标注）：** 高度可行。CCRCache.retrieve 已有命中/未命中信号；compositional-router.composeDAG 已有"是否产生新组合"信号；skill-lifecycle.checkCreationTrigger 已有"是否创建新技能"信号。只需新增 OperationClassifier 聚合这三处信号并打标签。
- **Task 2（溯源图升级）：** 可行。ProjectMemoryManager 已有 appendDecision 与 decisions.log，只需扩展 DecisionRecord 增加 artifactType / parentIds / producingOperation 字段，并在内存维护 ProvenanceGraph 邻接表。
- **Task 3（被拒替代保留）：** 可行。CrossModelReviewer.review 已返回 CodeReviewResult（含 passed/issues/summary），只需在 passed=false 时额外写入 RejectedAlternativeStore，含被拒原因与门元数据。
- **Task 4（Kan 障碍空类型警示）：** 中等可行。需定义"输入类型"的概念——工程上降维为"新技能/policy 声明的输入 schema 字段名集合"，与现有制品种群（project-memory 的 artifactType 集合 + CCRCache 的 message 类型）求差集，差集非空即"空类型"。
- **Task 5（MDL/AIC 定量门 + 配置收口）：** 可行。MDL 降维为"方案描述的 token 估计长度"（已有 token-estimate 工具），AIC 降维为"复杂度惩罚 + 拟合度"的启发式评分，作为 CrossModelReviewer 的硬阈值补充。

### 3. 降维原则（论文范畴论 → 工程概念）

论文是范畴论形式化框架，**不能照搬数学形式**。本 Phase 的降维映射：

| 范畴论概念 | 工程降维实现 |
|---------------|-------------------|
| Schema 范畴 S_b（对象=制品类型，态射=操作） | `ArtifactType` 联合类型 + `OperationSignature` 接口 |
| Artifact population（copresheaf） | `Map<ArtifactType, Artifact[]>` 制品种群表 |
| Provenance graph（元素范畴 ∫I_t） | `ProvenanceGraph` 邻接表（节点=制品，边=产生操作） |
| Gate/Verifier（谓词/评分泛函） | `QuantitativeGate`（MDL/AIC 启发式评分）+ CrossModelReviewer 软判断 |
| Regime update u: S_b → S_b' | 新增 ArtifactType / 新增 OperationSignature / 新增 Skill，记录为 `RegimeTransition` |
| 左 Kan 扩展 Lan_u I_t（迁运） | `transportArtifacts(oldType → newType)` 映射函数（旧制品按规则映射到新类型） |
| Kan 障碍（孤立新类型取空值） | `KanObstacleChecker`：新类型在现有种群中无制品可填充时发出"空类型"警示 |
| 残余内容（超出迁运的部分） | transport 后与实际制品集求差，差集代表"真正新发现" |

copresheaf / Kan 扩展 / 元素范畴等**只作概念启发**，工程实现用类型化制品 / 溯源图 / 空类型检查等具体机制。

---

## 核心设计原则

### 原则 1：三分优先于混为一谈

论文 Figure 1 的核心结构性区分——Retrieval / Search / Discovery 不是同一个动作的强弱版本，而是**本体论上不同**的操作。Phase 68 的每个知识写入点都要回答："这是检索（已可表示的制品）/ 搜索（固定 schema 内新组合）/ 发现（改变体制）？" 不能回答就降级为不标注，但绝不能错标。

### 原则 2：被拒替代是一等公民

论文光纤案例的关键洞察——模型选择本身（含被拒替代）被记录为类型化溯源，让"失败"也成为知识图的一等公民。Phase 68 的 CrossModelReviewer 否决方案时，**必须保留为可检索的 RejectedAlternative**，含被拒原因与门元数据。下次遇到相似任务时可先查"历史上被拒的方案"，避免重蹈覆辙。

### 原则 3：空类型是可计算的反驳

论文 Kan 障碍——Kan 扩展在孤立新类型上取空值，意味着"仅靠迁运无法填充新类型"，这是具体的、可计算的反驳。Phase 68 的 KanObstacleChecker 在动态注册新技能/导入新 policy 时，若依赖输入类型在现有 schema 无制品可填充，**必须发出"空类型"警示并阻断或提示**，不能默默接受一个无法满足的依赖。

### 原则 4：体制迁移必须可追溯

论文 Regime-update mechanism——当证据无法用当前 schema 表示时扩展或修订 schema，且这种扩展本身是被记录的。Phase 68 的每次"发现"（新技能注册 / 新 policy 导入 / 新依赖边）都要作为 `RegimeTransition` 记录到 [AuditChain](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts)，含迁移前后 schema 摘要，让体制演化本身可审计。

### 原则 5：反写死与 Fail-open（延续 Phase 51/61）

所有新增能力必须有配置开关、设置页入口、明确接线点。默认关闭。三分标注失败、溯源图写入失败、空类型检查异常时 fail-open（降级为不标注/不阻断），不阻塞主流程。

### 原则 6：死代码防护与执行人自审（延续 Phase 51/53）

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

## Task 1：检索/搜索/发现三分标注（≥ 8 测试）

### 1.1 论文借鉴

论文 Figure 1 结构性区分三种操作：
- **Retrieval（检索）**：添加一个**已可表示**的制品（不改变 schema，不改变种群结构，只是把已知的放进来）
- **Search（搜索）**：在**固定 schema 内**找到新路径或新对象（新组合，同词汇表）
- **Discovery（发现）**：改变制品与操作被类型化的**体制**（新词汇表——新有效变量/新可容许操作/新验证器/新工具/新制品类型）

RouteDev 现状：CCRCache 命中、compositional-router DAG 组合、新技能注册三者都发生在不同模块，但没有任何统一的"这次操作属于哪一类"标注。这导致无法回答"这次任务是检索了已有经验，还是组合了已有技能，还是引入了新能力"——而这三类的可信度、复核要求、保留策略本应不同。

### 1.2 设计

新增 `OperationKind` 联合类型与 `OperationClassifier`：

```ts
// src/skills/operation-classifier.ts
// Phase 68 Task 1：检索/搜索/发现三分标注
// 论文借鉴：arXiv:2606.01444 Figure 1 三种操作结构性区分

/**
 * 操作种类（论文 Figure 1 三分）
 * - retrieval：添加已可表示的制品（CCRCache 命中、project-memory 已有 decision 复用）
 * - search：固定 schema 内的新组合（compositional-router DAG 内多技能组合）
 * - discovery：改变体制（新技能注册、新 policy 导入、新依赖边类型）
 */
export type OperationKind = 'retrieval' | 'search' | 'discovery';

/**
 * 操作分类输入信号
 * 由各模块（CCRCache / compositional-router / skill-lifecycle）注入
 */
export interface OperationSignal {
  /** CCRCache 是否命中（命中 → retrieval 倾向） */
  ccrHit?: boolean;
  /** compositional-router 是否产生了多技能 DAG 组合（是 → search 倾向） */
  dagComposed?: boolean;
  /** 是否注册了新技能 / 导入了新 policy / 新增了依赖边类型（是 → discovery） */
  regimeExtended?: boolean;
  /** 新增的 ArtifactType（discovery 时填写） */
  newArtifactTypes?: string[];
}

/**
 * 操作分类结果
 */
export interface OperationClassification {
  kind: OperationKind;
  /** 分类依据（人类可读） */
  reason: string;
  /** 时间戳 */
  timestamp: number;
  /** 关联的会话 ID */
  sessionId: string;
}

/**
 * 操作分类器——纯函数
 *
 * 分类优先级（论文 Figure 1 的本体论优先序）：
 *   1. regimeExtended=true → discovery（体制改变最高优先级）
 *   2. dagComposed=true → search（固定 schema 内新组合）
 *   3. ccrHit=true → retrieval（已可表示制品的添加）
 *   4. 都为 false → retrieval（默认降级为最低风险的 retrieval）
 *
 * 纯函数，无副作用。
 */
export function classifyOperation(signal: OperationSignal, sessionId: string): OperationClassification {
  const timestamp = Date.now();
  if (signal.regimeExtended) {
    return {
      kind: 'discovery',
      reason: `体制扩展：新增 ArtifactType [${(signal.newArtifactTypes ?? []).join(', ')}]`,
      timestamp,
      sessionId,
    };
  }
  if (signal.dagComposed) {
    return {
      kind: 'search',
      reason: '固定 schema 内多技能 DAG 组合',
      timestamp,
      sessionId,
    };
  }
  return {
    kind: 'retrieval',
    reason: signal.ccrHit ? 'CCRCache 命中，添加已可表示制品' : '无体制扩展无新组合，默认 retrieval',
    timestamp,
    sessionId,
  };
}

/**
 * 体制迁移记录（论文 Regime-update mechanism 的工程落地）
 * discovery 操作触发，记录到 AuditChain
 */
export interface RegimeTransition {
  /** 迁移前 schema 摘要（ArtifactType 集合） */
  beforeSchema: string[];
  /** 迁移后 schema 摘要 */
  afterSchema: string[];
  /** 触发的操作分类 */
  trigger: OperationClassification;
  /** 迁移声明（人类可读） */
  claim: string;
}

/**
 * 构造体制迁移记录
 * 纯函数。
 */
export function buildRegimeTransition(
  beforeSchema: string[],
  afterSchema: string[],
  trigger: OperationClassification,
): RegimeTransition {
  const added = afterSchema.filter((t) => !beforeSchema.includes(t));
  return {
    beforeSchema: [...beforeSchema],
    afterSchema: [...afterSchema],
    trigger,
    claim: `体制扩展：新增类型 [${added.join(', ')}]，由 ${trigger.reason} 触发`,
  };
}
```

### 1.3 接线点

- 新增：`src/skills/operation-classifier.ts`
- 修改：[ccr-cache.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) — `retrieve` 命中时回调注入 `ccrHit=true` 信号（可选 hook，不破坏现有签名）
- 修改：[compositional-router.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/compositional-router.ts) — `composeDAG` 返回时若 `nodes.length > 1` 注入 `dagComposed=true` 信号
- 修改：[skill-lifecycle.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/skill-lifecycle.ts) — `checkCreationTrigger` 返回建议时注入 `regimeExtended=true` 与 `newArtifactTypes`
- 修改：[audit-logger.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) — 新增 `logRegimeTransition(transition)` 快捷方法
- 修改：[goal-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/goal-runner.ts) — 在关键节点收集信号并调用 classifyOperation，discovery 时记录 RegimeTransition

### 1.4 Step 分解

- [ ] **Step 1: 定义 OperationKind / OperationSignal / OperationClassification 类型**

新建 `src/skills/operation-classifier.ts`，实现上述类型与 `classifyOperation` 纯函数。

- [ ] **Step 2: 实现 RegimeTransition 与 buildRegimeTransition**

实现体制迁移记录构造。`beforeSchema` / `afterSchema` 为 ArtifactType 字符串数组（与 Task 2 的 ArtifactType 联合类型对齐）。

- [ ] **Step 3: 接入 CCRCache 信号**

在 [ccr-cache.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的 `retrieve` / `retrieveByPrefix` 命中时，通过可选的 `onHit?: () => void` 回调通知调用方（不破坏现有签名，调用方自行决定是否收集信号）。

- [ ] **Step 4: 接入 compositional-router 信号**

在 [compositional-router.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/compositional-router.ts) 的 `composeDAG` 返回值增加可选 `composed: boolean` 字段（`nodes.length > 1` 时为 true），调用方据此注入 `dagComposed` 信号。

- [ ] **Step 5: 接入 skill-lifecycle 信号**

在 [skill-lifecycle.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/skill-lifecycle.ts) 的 `checkCreationTrigger` 返回 `SkillCreationSuggestion` 时，调用方注入 `regimeExtended=true` 与 `newArtifactTypes=[suggestedName]`。

- [ ] **Step 6: AuditLogger 新增 logRegimeTransition**

在 [audit-logger.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) 新增快捷方法，action 用 `'regime_transition'`（扩展 AuditAction 联合类型），details 含 before/after schema 与 claim。

- [ ] **Step 7: goal-runner 收集信号并标注**

在 [goal-runner.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/goal-runner.ts) 的关键节点（CCR 检索后、DAG 组装后、技能创建后）收集信号，调用 `classifyOperation`，discovery 时调用 `logRegimeTransition`。fail-open：信号收集失败时不阻断主流程。

- [ ] **Step 8: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
operationClassification: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用三分标注（默认 false） */
  enabled: z.boolean().default(false),
  /** 是否在 discovery 时记录 RegimeTransition 到 AuditChain */
  logRegimeTransition: z.boolean().default(true),
})).default({}),
```

- [ ] **Step 9: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/skills/operation-classifier.test.ts`，覆盖：
- retrieval 分类（ccrHit=true，无 dagComposed 无 regimeExtended）
- search 分类（dagComposed=true）
- discovery 分类（regimeExtended=true）
- 优先级（regimeExtended 优先于 dagComposed 优先于 ccrHit）
- buildRegimeTransition 构造正确性
- beforeSchema/afterSchema 差集计算
- 默认降级为 retrieval
- 配置关闭时跳过标注

- [ ] **Step 10: 提交**

```powershell
git add -A
git commit -m "feat(phase-68): 检索/搜索/发现三分标注

新增 OperationClassifier，CCRCache 命中=retrieval，DAG 组合=search，新技能注册=discovery
论文借鉴：arXiv:2606.01444 Figure 1 三种操作结构性区分
体制迁移：discovery 操作记录 RegimeTransition 到 AuditChain"
```

---

## Task 2：类型化制品 + 溯源图升级 project_memory（≥ 8 测试）

### 2.1 论文借鉴

论文 Section 2.1 类型化制品系统五组件中的前三个：
1. **Schema**（制品类型与操作的 schema）——类型为对象、操作为态射
2. **Artifact population**（制品种群）——存储实际制品实例
3. **Provenance graph**（溯源图）——每个被接受制品记录父节点与产生操作；**操作复合即科学谱系**

RouteDev 现状：[project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 的 `decisions.log` 是无类型 JSONL，每条 DecisionRecord 只有 `type`（decision/architecture/pitfall 等粗分类）但无显式的"制品类型"、无父节点、无产生操作。无法回答"这条决策是由哪条 earlier decision 经哪个操作产生的"——而论文证明这种谱系是知识图谱的核心。

### 2.2 设计

新增 `ArtifactType` 联合类型、`TypedArtifact` 接口与 `ProvenanceGraph` 类：

```ts
// src/memory/provenance-graph.ts
// Phase 68 Task 2：类型化制品 + 溯源图
// 论文借鉴：arXiv:2606.01444 Section 2.1 类型化制品系统（Schema / Artifact population / Provenance graph）

/**
 * 制品类型（论文 Schema 范畴的对象，工程降维为联合类型）
 * - decision：关键决策
 * - pattern：可复用模式
 * - pitfall：陷阱（含被拒替代，与 Task 3 联动）
 * - api-contract：API 契约
 * - test-evidence：测试证据
 * - review-result：审查结果
 */
export type ArtifactType =
  | 'decision'
  | 'pattern'
  | 'pitfall'
  | 'api-contract'
  | 'test-evidence'
  | 'review-result';

/**
 * 产生操作（论文 Schema 范畴的态射，工程降维为联合类型）
 * - retrieval：检索（Task 1 三分）
 * - search：搜索组合（Task 1 三分）
 * - discovery：体制扩展（Task 1 三分）
 * - review：审查（CrossModelReviewer）
 * - test：测试验证
 * - refine：精炼（SkillLifecycle refine）
 */
export type ProducingOperation =
  | 'retrieval'
  | 'search'
  | 'discovery'
  | 'review'
  | 'test'
  | 'refine';

/**
 * 类型化制品（论文的 artifact，工程降维为接口）
 */
export interface TypedArtifact {
  /** 制品唯一 ID */
  id: string;
  /** 制品类型 */
  artifactType: ArtifactType;
  /** 产生操作 */
  producingOperation: ProducingOperation;
  /** 父制品 ID 列表（论文 Provenance graph 的父节点） */
  parentIds: string[];
  /** 制品内容（人类可读摘要） */
  content: string;
  /** 关联文件（可选） */
  relatedFiles?: string[];
  /** 时间戳 */
  timestamp: number;
  /** 关联会话 ID */
  sessionId: string;
  /** Task 1 三分标注（可选，由 OperationClassifier 填充） */
  operationKind?: 'retrieval' | 'search' | 'discovery';
}

/**
 * 溯源图边（论文的态射，连接父制品与子制品）
 */
export interface ProvenanceEdge {
  /** 父制品 ID */
  from: string;
  /** 子制品 ID */
  to: string;
  /** 产生操作（边上的态射标签） */
  operation: ProducingOperation;
}

/**
 * 溯源图（论文 Provenance graph 的工程实现）
 * 内存维护邻接表，持久化到 .routedev/provenance.jsonl
 */
export class ProvenanceGraph {
  /** 制品表：id -> TypedArtifact */
  private artifacts = new Map<string, TypedArtifact>();
  /** 边表：from -> [{to, operation}] */
  private edges = new Map<string, ProvenanceEdge[]>();

  /**
   * 注册一个类型化制品，并自动建立与父制品的溯源边
   * 若 parentIds 中的父制品不存在，记录 warn 但不阻断（fail-open）
   */
  addArtifact(artifact: TypedArtifact): void {
    this.artifacts.set(artifact.id, artifact);
    for (const parentId of artifact.parentIds) {
      const edge: ProvenanceEdge = {
        from: parentId,
        to: artifact.id,
        operation: artifact.producingOperation,
      };
      const arr = this.edges.get(parentId) ?? [];
      arr.push(edge);
      this.edges.set(parentId, arr);
    }
  }

  /** 查询制品 */
  getArtifact(id: string): TypedArtifact | undefined {
    return this.artifacts.get(id);
  }

  /** 按类型查询制品种群（论文 Artifact population） */
  getByType(type: ArtifactType): TypedArtifact[] {
    return [...this.artifacts.values()].filter((a) => a.artifactType === type);
  }

  /**
   * 查询某制品的所有祖先（论文的"科学谱系"）
   * BFS 遍历 parentIds，返回按拓扑序排列的祖先列表
   */
  getLineage(id: string): TypedArtifact[] {
    const visited = new Set<string>();
    const result: TypedArtifact[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const artifact = this.artifacts.get(cur);
      if (artifact) {
        result.push(artifact);
        for (const pid of artifact.parentIds) {
          if (!visited.has(pid)) queue.push(pid);
        }
      }
    }
    return result;
  }

  /**
   * 查询某制品的所有后代
   * BFS 遍历 edges
   */
  getDescendants(id: string): TypedArtifact[] {
    const visited = new Set<string>();
    const result: TypedArtifact[] = [];
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const outEdges = this.edges.get(cur) ?? [];
      for (const e of outEdges) {
        if (!visited.has(e.to)) {
          const a = this.artifacts.get(e.to);
          if (a) result.push(a);
          queue.push(e.to);
        }
      }
    }
    return result;
  }

  /** 导出当前 schema 摘要（ArtifactType 集合），供 Task 1/4 使用 */
  getSchemaSummary(): string[] {
    const types = new Set<string>();
    for (const a of this.artifacts.values()) {
      types.add(a.artifactType);
    }
    return [...types];
  }

  /** 持久化到 jsonl */
  serialize(): string {
    return [...this.artifacts.values()].map((a) => JSON.stringify(a)).join('\n');
  }

  /** 从 jsonl 恢复 */
  deserialize(data: string): void {
    this.artifacts.clear();
    this.edges.clear();
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      try {
        const a = JSON.parse(line) as TypedArtifact;
        this.addArtifact(a);
      } catch {
        // 跳过损坏行
      }
    }
  }
}
```

### 2.3 接线点

- 新增：`src/memory/provenance-graph.ts`
- 修改：[project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) — `appendDecision` 增加可选 `artifactType` / `parentIds` / `producingOperation` 参数；装配 `ProvenanceGraph` 单例
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — `ProjectMemoryConfigSchema` 增加 `provenanceGraph` 子配置
- 修改：[app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) — 装配 ProvenanceGraph，启动时 load，退出时 flush

### 2.4 Step 分解

- [ ] **Step 1: 定义 ArtifactType / ProducingOperation / TypedArtifact 类型**

新建 `src/memory/provenance-graph.ts`，实现上述类型。

- [ ] **Step 2: 实现 ProvenanceGraph 类**

实现 `addArtifact` / `getArtifact` / `getByType` / `getLineage` / `getDescendants` / `getSchemaSummary` / `serialize` / `deserialize`。getLineage 与 getDescendants 用 BFS，含环检测（visited 集合）。

- [ ] **Step 3: 持久化路径**

持久化到 `.routedev/provenance.jsonl`，与 [project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 的 decisions.log 同目录。启动时 deserialize，退出时 serialize 覆写。

- [ ] **Step 4: 升级 ProjectMemoryManager.appendDecision**

在 [project-memory.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/memory/project-memory.ts) 的 `appendDecision` 增加可选参数：

```ts
async appendDecision(
  sessionId: string,
  type: DecisionRecord['type'],
  decision: string,
  reasoning: string,
  relatedFiles?: string[],
  // Phase 68 Task 2 新增
  artifactType?: ArtifactType,
  parentIds?: string[],
  producingOperation?: ProducingOperation,
): Promise<void>;
```

当 `artifactType` 提供时，构造 `TypedArtifact` 并调用 `provenanceGraph.addArtifact`，同时仍写入 decisions.log（向后兼容）。

- [ ] **Step 5: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 的 `ProjectMemoryConfigSchema` 增加：

```ts
provenanceGraph: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用溯源图（默认 false） */
  enabled: z.boolean().default(false),
  /** 持久化路径 */
  persistPath: z.string().default('.routedev/provenance.jsonl'),
  /** 最大制品数（防止无界增长） */
  maxArtifacts: z.number().int().min(100).default(10000),
})).default({}),
```

- [ ] **Step 6: 装配单例**

在 [app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) 装配 ProvenanceGraph，注入 ProjectMemoryManager。

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/memory/provenance-graph.test.ts`，覆盖：
- addArtifact + getArtifact 基本读写
- getByType 按类型查询
- addArtifact 自动建立溯源边
- getLineage BFS 祖先查询（多代）
- getDescendants BFS 后代查询
- 环检测（A→B→A 不死循环）
- getSchemaSummary 导出类型集合
- serialize + deserialize 往返一致性

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-68): 类型化制品 + 溯源图升级 project_memory

新增 ProvenanceGraph，TypedArtifact 含 artifactType/parentIds/producingOperation
论文借鉴：arXiv:2606.01444 Section 2.1 Provenance graph，操作复合即科学谱系
向后兼容：appendDecision 可选新参数，不传时退回原 decisions.log 行为"
```

---

## Task 3：被拒替代保留（≥ 7 测试）

### 3.1 论文借鉴

论文光纤网络力学案例的关键洞察：候选模型 A（各向同性纤维计数描述子）vs B（方向张量各向异性刚度代理）；AIC 门接受 B 拒绝 A；扰动测试验证稳健性；**全部（被接受模型、被拒替代、门、测试、体制迁移声明）物化为类型化制品与态射**，渲染成人类可读科学图。

**关键洞察：模型选择本身（含被拒替代）被记录为类型化溯源——让"失败"也成为知识图的一等公民。**

RouteDev 现状：[CrossModelReviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 否决方案时（`passed=false`），结果只在 `CodeReviewResult.summary` 字符串里，**直接丢弃**。下次遇到相似任务时无法查"历史上被拒的方案及其被拒原因"，可能重蹈覆辙。

### 3.2 设计

新增 `RejectedAlternative` 接口与 `RejectedAlternativeStore` 类：

```ts
// src/agent/rejected-alternative-store.ts
// Phase 68 Task 3：被拒替代保留
// 论文借鉴：arXiv:2606.01444 光纤案例——被拒替代物化为类型化溯源，"失败"是一等公民

import type { CodeReviewResult } from './unified-reviewer.js';

/**
 * 被拒替代（论文的 rejected alternative，物化为类型化制品）
 */
export interface RejectedAlternative {
  /** 制品唯一 ID */
  id: string;
  /** 被拒方案摘要 */
  proposalSummary: string;
  /** 被拒原因（人类可读） */
  rejectionReason: string;
  /** 门元数据（哪个门拒了，门类型与分数） */
  gate: {
    /** 门类型：cross-model-review / quantitative-gate / user-reject */
    gateType: 'cross-model-review' | 'quantitative-gate' | 'user-reject';
    /** 门分数（可选，quantitative-gate 时填写） */
    score?: number;
    /** 门阈值（可选） */
    threshold?: number;
  };
  /** 完整审查结果（含 issues） */
  reviewResult: CodeReviewResult;
  /** 关联任务描述 */
  taskDescription: string;
  /** 关联文件 */
  relatedFiles: string[];
  /** 时间戳 */
  timestamp: number;
  /** 关联会话 ID */
  sessionId: string;
  /** Task 2 联动：作为 pitfall 类型制品注册到 ProvenanceGraph 的 ID（可选） */
  provenanceArtifactId?: string;
}

/**
 * 被拒替代存储——可检索的"失败知识库"
 * 持久化到 .routedev/rejected-alternatives.jsonl
 */
export class RejectedAlternativeStore {
  private records: RejectedAlternative[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords = 5000) {
    this.maxRecords = maxRecords;
  }

  /**
   * 记录一个被拒替代
   * FIFO 淘汰：超过 maxRecords 时删除最旧的
   */
  add(record: RejectedAlternative): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  /**
   * 按任务描述关键词检索被拒替代
   * 简单实现：子串匹配 + 关键词 Jaccard（复用 compositional-router 的思路）
   */
  queryByTask(taskDescription: string, limit = 5): RejectedAlternative[] {
    const keywords = this.extractKeywords(taskDescription);
    if (keywords.length === 0) return [];
    return this.records
      .map((r) => ({
        record: r,
        score: this.jaccard(keywords, this.extractKeywords(r.taskDescription)),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.record);
  }

  /** 按门类型过滤 */
  filterByGate(gateType: RejectedAlternative['gate']['gateType']): RejectedAlternative[] {
    return this.records.filter((r) => r.gate.gateType === gateType);
  }

  /** 获取全部（分页） */
  list(limit = 50, offset = 0): RejectedAlternative[] {
    return this.records.slice(offset, offset + limit);
  }

  /** 持久化 */
  serialize(): string {
    return this.records.map((r) => JSON.stringify(r)).join('\n');
  }

  /** 恢复 */
  deserialize(data: string): void {
    this.records = [];
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.records.push(JSON.parse(line));
      } catch {
        // 跳过损坏行
      }
    }
  }

  // ===== 内部辅助 =====

  private extractKeywords(text: string): Set<string> {
    // 复用 compositional-router 的停用词思路（简化版）
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 1);
    return new Set(tokens);
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }
}
```

### 3.3 接线点

- 新增：`src/agent/rejected-alternative-store.ts`
- 修改：[cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) — `review` 返回 `passed=false` 时，构造 `RejectedAlternative` 写入 store
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `rejectedAlternativeStore` 配置
- 修改：[app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) — 装配 RejectedAlternativeStore 单例
- 联动 Task 2：被拒替代同时作为 `pitfall` 类型制品注册到 ProvenanceGraph

### 3.4 Step 分解

- [ ] **Step 1: 定义 RejectedAlternative 接口**

新建 `src/agent/rejected-alternative-store.ts`，实现上述接口。

- [ ] **Step 2: 实现 RejectedAlternativeStore**

实现 `add` / `queryByTask` / `filterByGate` / `list` / `serialize` / `deserialize`。FIFO 淘汰，maxRecords 默认 5000。

- [ ] **Step 3: 接入 CrossModelReviewer**

在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 的 `review` 方法返回前，若 `result.passed === false`，构造 `RejectedAlternative`：
- proposalSummary：从 executionSummary + modifiedFiles 摘要
- rejectionReason：result.summary + 关键 issues 的 description
- gate：`{ gateType: 'cross-model-review' }`
- reviewResult：完整 result
- taskDescription：goalDescription

注入方式：构造函数可选注入 `RejectedAlternativeStore`，未注入时跳过（向后兼容）。

- [ ] **Step 4: 联动 ProvenanceGraph**

被拒替代写入 store 时，同时作为 `pitfall` 类型制品注册到 ProvenanceGraph（若装配了），`producingOperation='review'`，`parentIds` 为该任务相关的 decision 制品 ID（若有）。

- [ ] **Step 5: 持久化**

持久化到 `.routedev/rejected-alternatives.jsonl`，启动时 deserialize，退出时 serialize 覆写。与 [AuditChain](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/harness/audit-logger.ts) 同目录。

- [ ] **Step 6: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
rejectedAlternativeStore: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用被拒替代保留（默认 false） */
  enabled: z.boolean().default(false),
  /** 持久化路径 */
  persistPath: z.string().default('.routedev/rejected-alternatives.jsonl'),
  /** 最大记录数（FIFO 淘汰） */
  maxRecords: z.number().int().min(100).default(5000),
  /** 查询默认 limit */
  defaultQueryLimit: z.number().int().min(1).max(50).default(5),
})).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/rejected-alternative-store.test.ts`，覆盖：
- add + list 基本读写
- FIFO 淘汰（超过 maxRecords）
- queryByTask 关键词检索（命中/不命中）
- queryByTask Jaccard 排序
- filterByGate 按门类型过滤
- serialize + deserialize 往返一致性
- CrossModelReviewer passed=false 时写入 store

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-68): 被拒替代保留

新增 RejectedAlternativeStore，CrossModelReviewer 否决方案保留可检索
论文借鉴：arXiv:2606.01444 光纤案例——被拒替代物化为类型化溯源，'失败'是一等公民
联动：被拒替代同时作为 pitfall 类型制品注册到 ProvenanceGraph"
```

---

## Task 4：Kan 障碍"空类型"警示（≥ 6 测试）

### 4.1 论文借鉴

论文 Kan 扩展迁运与 Kan 障碍：发现 = 经核验的体制迁移 u: S_b → S_b'。旧制品由左 Kan 扩展 Lan_u I_t 运到新体制。与迁移后状态比较识别"残余内容"（超出函子迁运的部分，代表真正新发现）。

**Kan 障碍——Kan 扩展在孤立新类型上取空值，意味着"仅靠迁运无法填充新类型"，必须由门核验的新制品填充。这是具体的、可计算的反驳。**

工程降维（不照搬数学形式）：
- **左 Kan 扩展 Lan_u I_t**（迁运）→ `transportArtifacts`：旧制品按规则映射到新类型（如旧 `decision` 制品可映射为新 `api-contract` 制品的内容来源）
- **Kan 障碍**（孤立新类型取空值）→ `KanObstacleChecker`：新技能/policy 声明的输入类型在现有制品种群中无制品可填充时，发出"空类型"警示
- **门核验的新制品填充** → 警示后，必须由用户提供新制品或显式确认该类型暂不填充，否则阻断注册

RouteDev 现状：动态注册新技能（[skill-lifecycle.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/skill-lifecycle.ts) 的 checkCreationTrigger）、导入新 policy（[policy-engine.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts)）时，**不检查"依赖输入类型在现有 schema 是否有制品可填充"**。可能注册一个永远无法被满足的依赖。

### 4.2 设计

新增 `KanObstacleChecker` 类：

```ts
// src/skills/kan-obstacle-checker.ts
// Phase 68 Task 4：Kan 障碍"空类型"警示
// 论文借鉴：arXiv:2606.01444 Kan 障碍——Kan 扩展在孤立新类型取空值，
// 意味着"仅靠迁运无法填充新类型"，必须由门核验的新制品填充
//
// 工程降维（不照搬范畴论形式）：
//   - 左 Kan 扩展 Lan_u I_t（迁运）→ transportArtifacts 映射函数
//   - Kan 障碍（孤立新类型取空值）→ 检查新类型在现有种群是否有制品可填充
//   - 门核验的新制品填充 → 警示后必须由用户提供新制品或显式确认

import type { ProvenanceGraph, ArtifactType } from '../memory/provenance-graph.js';
import { logger } from '../utils/logger.js';

/**
 * 新技能/policy 声明的输入依赖
 */
export interface InputDependency {
  /** 依赖的输入类型（论文的"新类型"） */
  requiredType: ArtifactType | string;
  /** 依赖描述（人类可读） */
  description: string;
  /** 是否允许从旧类型迁运填充（论文的 Lan_u I_t 迁运） */
  transportableFrom?: ArtifactType[];
}

/**
 * Kan 障碍检查结果
 */
export interface KanObstacleResult {
  /** 是否存在空类型（Kan 障碍） */
  hasObstacle: boolean;
  /** 无法填充的输入类型列表 */
  emptyTypes: string[];
  /** 警示消息（人类可读） */
  warning: string;
  /** 建议的填充方式（论文的"门核验的新制品填充"） */
  suggestions: string[];
}

/**
 * Kan 障碍检查器
 *
 * 检查逻辑（论文 Kan 障碍的工程降维）：
 *   1. 对每个 InputDependency.requiredType，检查现有种群（ProvenanceGraph）是否有该类型制品
 *   2. 若无，检查 transportableFrom 是否能从旧类型迁运填充
 *   3. 若迁运也无法填充 → Kan 障碍（空类型），发出警示
 *
 * 配置开关：
 *   - enabled=true：检测到空类型时阻断注册（fail-closed）
 *   - enabled=false：仅 warn 不阻断（fail-open，向后兼容）
 */
export class KanObstacleChecker {
  constructor(
    private readonly graph: ProvenanceGraph,
    private readonly config: {
      enabled: boolean;
      /** 是否阻断注册（true=fail-closed，false=仅 warn） */
      blockOnObstacle: boolean;
    },
  ) {}

  /**
   * 检查一组输入依赖是否存在 Kan 障碍
   */
  check(dependencies: InputDependency[]): KanObstacleResult {
    const currentSchema = new Set(this.graph.getSchemaSummary());
    const emptyTypes: string[] = [];
    const suggestions: string[] = [];

    for (const dep of dependencies) {
      // 1. 现有种群是否有该类型制品
      if (currentSchema.has(dep.requiredType)) {
        // 有该类型 → 检查是否有实际制品实例
        const instances = this.graph.getByType(dep.requiredType as ArtifactType);
        if (instances.length > 0) continue; // 有制品可填充，无障碍
      }

      // 2. 尝试迁运填充（论文的 Lan_u I_t）
      if (dep.transportableFrom && dep.transportableFrom.length > 0) {
        const canTransport = dep.transportableFrom.some((srcType) => {
          const srcInstances = this.graph.getByType(srcType);
          return srcInstances.length > 0;
        });
        if (canTransport) {
          suggestions.push(`类型 '${dep.requiredType}' 可从 [${dep.transportableFrom.join(', ')}] 迁运填充`);
          continue; // 迁运可填充，无障碍
        }
      }

      // 3. Kan 障碍：现有种群与迁运都无法填充
      emptyTypes.push(dep.requiredType);
      suggestions.push(
        `类型 '${dep.requiredType}' 在现有 schema 无制品可填充，且无法迁运——需提供门核验的新制品`,
      );
    }

    const hasObstacle = emptyTypes.length > 0;
    const warning = hasObstacle
      ? `Kan 障碍：输入类型 [${emptyTypes.join(', ')}] 无法填充（迁运失败，需门核验新制品）`
      : '';

    if (hasObstacle) {
      logger.warn('KanObstacleChecker: 检测到空类型', {
        emptyTypes,
        blockOnObstacle: this.config.blockOnObstacle,
      });
    }

    return { hasObstacle, emptyTypes, warning, suggestions };
  }

  /**
   * 检查并决定是否阻断注册
   * @returns true=允许注册，false=阻断（fail-closed）
   */
  checkAndDecide(dependencies: InputDependency[]): {
    allowed: boolean;
    result: KanObstacleResult;
  } {
    const result = this.check(dependencies);
    if (result.hasObstacle && this.config.blockOnObstacle) {
      return { allowed: false, result };
    }
    return { allowed: true, result };
  }
}
```

### 4.3 接线点

- 新增：`src/skills/kan-obstacle-checker.ts`
- 修改：[skill-lifecycle.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/skill-lifecycle.ts) — `checkCreationTrigger` 返回建议后，调用 KanObstacleChecker 检查新技能声明的输入依赖
- 修改：[policy-engine.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) — 导入新 policy 时调用 KanObstacleChecker
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `kanObstacleChecker` 配置
- 联动 Task 1：空类型警示若未阻断，则该注册仍记为 `discovery`（体制扩展），但 RegimeTransition 中标注"含 Kan 障碍"

### 4.4 Step 分解

- [ ] **Step 1: 定义 InputDependency / KanObstacleResult 类型**

新建 `src/skills/kan-obstacle-checker.ts`，实现上述类型。

- [ ] **Step 2: 实现 KanObstacleChecker.check**

按三步逻辑：现有种群检查 → 迁运填充检查 → Kan 障碍判定。fail-open：graph 不可用时返回 `hasObstacle=false`。

- [ ] **Step 3: 实现 checkAndDecide**

`blockOnObstacle=true` 时阻断注册（fail-closed），`false` 时仅 warn。

- [ ] **Step 4: 接入 skill-lifecycle**

在 [skill-lifecycle.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/skills/skill-lifecycle.ts) 的 `checkCreationTrigger` 返回 `SkillCreationSuggestion` 后，调用方（goal-runner）用 KanObstacleChecker 检查新技能的输入依赖（从 suggestedName 与 reason 推断 requiredType，或由 Skill 定义显式声明 inputs）。

- [ ] **Step 5: 接入 policy-engine**

在 [policy-engine.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/policy-engine.ts) 导入新 policy 时，检查 policy 声明的输入依赖类型。

- [ ] **Step 6: 联动 Task 1**

空类型警示未阻断时，仍记为 discovery，但 RegimeTransition.claim 追加"（含 Kan 障碍：[emptyTypes]）"。

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
kanObstacleChecker: z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 Kan 障碍检查（默认 false） */
  enabled: z.boolean().default(false),
  /** 是否阻断注册（true=fail-closed，false=仅 warn） */
  blockOnObstacle: z.boolean().default(false),
})).default({}),
```

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/skills/kan-obstacle-checker.test.ts`，覆盖：
- 现有种群有制品 → 无障碍
- 现有种群无制品但可迁运 → 无障碍 + suggestion
- 现有种群无制品且不可迁运 → Kan 障碍
- blockOnObstacle=true 时阻断注册
- blockOnObstacle=false 时仅 warn 不阻断
- graph 不可用时 fail-open

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(phase-68): Kan 障碍空类型警示

新增 KanObstacleChecker，新技能/policy 注册时检查输入类型是否可填充
论文借鉴：arXiv:2606.01444 Kan 障碍——迁运无法填充的孤立新类型需门核验新制品
工程降维：copresheaf/Kan 扩展只作概念启发，用类型化制品/迁运映射/空类型检查实现"
```

---

## Task 5：MDL/AIC 定量门 + 配置收口与全量验证（≥ 6 测试）

### 5.1 论文借鉴

论文 Section 2.1 第 4 组件 Gate/Verifier：新制品不自动提交，由显式门决定 accept/reject/supersede/hold（MDL/AIC/压力评分/同行评审）。光纤案例：AIC 门接受 B（更低 AIC = 更优拟合/复杂度权衡）拒 A。

RouteDev 现状：[CrossModelReviewer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 只用 LLM 软判断（输出 passed/issues/summary），**无可量化的描述长度/复杂度硬阈值**。对于可量化场景（如两个候选方案谁更简洁），软判断不可重复、不可审计。

### 5.2 设计

新增 `QuantitativeGate` 类，作为 CrossModelReviewer 的硬阈值补充：

```ts
// src/agent/quantitative-gate.ts
// Phase 68 Task 5：MDL/AIC 定量门
// 论文借鉴：arXiv:2606.01444 Gate/Verifier——MDL/AIC 硬阈值决定 accept/reject
//
// 工程降维（不照搬统计学形式）：
//   - MDL（最小描述长度）→ 方案描述的 token 估计长度（复用 token-estimate 工具）
//   - AIC → 复杂度惩罚 + 拟合度的启发式评分
//   - 门决策：accept / reject / hold（论文的 accept/reject/supersede/hold）

import { estimateTokens } from '../utils/token-estimate.js';

/**
 * 候选方案（待门评估）
 */
export interface CandidateSolution {
  /** 方案 ID */
  id: string;
  /** 方案描述（人类可读，用于 MDL 估算） */
  description: string;
  /** 方案代码/产物（可选，用于复杂度估算） */
  artifact?: string;
  /** 拟合度（0-1，由测试通过率或验证信号聚合，见 Phase 61 ExecutionVerifier） */
  fitScore?: number;
  /** 复杂度（可选，未提供时按 token 估计） */
  complexity?: number;
}

/**
 * 门决策结果（论文的 accept/reject/supersede/hold）
 */
export type GateDecision = 'accept' | 'reject' | 'supersede' | 'hold';

/**
 * 定量门评估结果
 */
export interface GateEvaluation {
  /** 决策 */
  decision: GateDecision;
  /** MDL 评分（描述长度，越短越优） */
  mdlScore: number;
  /** AIC 评分（复杂度惩罚 + 拟合度，越低越优） */
  aicScore: number;
  /** 综合分（0-1，越高越优） */
  compositeScore: number;
  /** 决策依据（人类可读） */
  rationale: string;
}

/**
 * 定量门配置
 */
export interface QuantitativeGateConfig {
  /** 是否启用定量门 */
  enabled: boolean;
  /** MDL 权重（默认 0.4） */
  mdlWeight: number;
  /** AIC 权重（默认 0.6） */
  aicWeight: number;
  /** accept 阈值（综合分 >= 此值且为候选最高 → accept） */
  acceptThreshold: number;
  /** reject 阈值（综合分 < 此值 → reject） */
  rejectThreshold: number;
  /** 复杂度惩罚系数（AIC 中 complexity * 此系数） */
  complexityPenalty: number;
}

export const DEFAULT_GATE_CONFIG: QuantitativeGateConfig = {
  enabled: false,
  mdlWeight: 0.4,
  aicWeight: 0.6,
  acceptThreshold: 0.7,
  rejectThreshold: 0.3,
  complexityPenalty: 0.01,
};

/**
 * 定量门——MDL/AIC 启发式评分
 *
 * 评分逻辑（论文 MDL/AIC 的工程降维）：
 *   - MDL：description 的 token 估计长度，归一化到 [0,1]（越短越优）
 *     mdlScore = 1 - min(1, tokens / 500)  // 500 token 为参考上限
 *   - AIC：复杂度惩罚 + 拟合度
 *     aicScore = fitScore - complexity * complexityPenalty  // 越低越优（AIC 越小越好）
 *     归一化到 [0,1]：normalizedAic = 1 - min(1, max(0, aicScore))
 *   - 综合分：compositeScore = mdlWeight * mdlScore + aicWeight * normalizedAic
 *
 * 决策逻辑：
 *   - 单候选：compositeScore >= acceptThreshold → accept；< rejectThreshold → reject；否则 hold
 *   - 多候选：最高分 >= acceptThreshold → accept，次高 supersede 被拒（与 Task 3 联动）；都 < rejectThreshold → 全 reject
 */
export class QuantitativeGate {
  constructor(private readonly config: QuantitativeGateConfig) {}

  /**
   * 评估单个候选
   */
  evaluate(candidate: CandidateSolution): GateEvaluation {
    const tokens = estimateTokens(candidate.description + (candidate.artifact ?? ''));
    const mdlScore = 1 - Math.min(1, tokens / 500);

    const fitScore = candidate.fitScore ?? 0.5;
    const complexity = candidate.complexity ?? tokens;
    const aicRaw = fitScore - complexity * this.config.complexityPenalty;
    const normalizedAic = 1 - Math.min(1, Math.max(0, aicRaw));

    const compositeScore =
      this.config.mdlWeight * mdlScore + this.config.aicWeight * normalizedAic;

    let decision: GateDecision;
    let rationale: string;
    if (compositeScore >= this.config.acceptThreshold) {
      decision = 'accept';
      rationale = `综合分 ${compositeScore.toFixed(3)} >= acceptThreshold ${this.config.acceptThreshold}`;
    } else if (compositeScore < this.config.rejectThreshold) {
      decision = 'reject';
      rationale = `综合分 ${compositeScore.toFixed(3)} < rejectThreshold ${this.config.rejectThreshold}`;
    } else {
      decision = 'hold';
      rationale = `综合分 ${compositeScore.toFixed(3)} 介于 reject 与 accept 之间，需人工/软判断`;
    }

    return { decision, mdlScore, aicScore: normalizedAic, compositeScore, rationale };
  }

  /**
   * 评估多个候选并决策（论文光纤案例：A vs B，AIC 门接受 B 拒 A）
   * @returns 按综合分降序排列的评估列表；最高分 accept，其余 supersede（被拒）
   */
  evaluateMultiple(candidates: CandidateSolution[]): GateEvaluation[] {
    const evaluations = candidates.map((c) => ({ candidate: c, eval: this.evaluate(c) }));
    evaluations.sort((a, b) => b.eval.compositeScore - a.eval.compositeScore);

    if (evaluations.length === 0) return [];

    const top = evaluations[0];
    const result: GateEvaluation[] = [];

    if (top.eval.decision === 'accept') {
      // 最高分 accept，其余 supersede
      result.push({ ...top.eval, decision: 'accept' });
      for (let i = 1; i < evaluations.length; i++) {
        result.push({
          ...evaluations[i].eval,
          decision: 'supersede',
          rationale: `被更优候选 ${top.candidate.id} 取代（${top.eval.compositeScore.toFixed(3)} > ${evaluations[i].eval.compositeScore.toFixed(3)}）`,
        });
      }
    } else {
      // 最高分未达 accept，全部按原决策（reject/hold）
      for (const e of evaluations) result.push(e.eval);
    }

    return result;
  }
}
```

### 5.3 接线点

- 新增：`src/agent/quantitative-gate.ts`
- 修改：[cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) — 可量化场景下，先调用 QuantitativeGate.evaluateMultiple，supersede/reject 的候选联动 Task 3 写入 RejectedAlternativeStore
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `quantitativeGate` 配置
- 修改：[defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) — 同步默认值
- 修改：desktop renderer 设置页 — 新增"定量门"分区

### 5.4 Step 分解

- [ ] **Step 1: 定义 CandidateSolution / GateDecision / GateEvaluation 类型**

新建 `src/agent/quantitative-gate.ts`，实现上述类型与 `QuantitativeGateConfig`。

- [ ] **Step 2: 实现 evaluate（单候选）**

按 MDL + AIC 启发式评分。复用 [token-estimate.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/utils/token-estimate.ts) 的 `estimateTokens`。决策：accept / reject / hold。

- [ ] **Step 3: 实现 evaluateMultiple（多候选）**

按综合分降序，最高分 accept 时其余 supersede（与 Task 3 联动写入 RejectedAlternativeStore）。最高分未达 accept 时全部按原决策。

- [ ] **Step 4: 接入 CrossModelReviewer**

在 [cross-model-reviewer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/cross-model-reviewer.ts) 的 `review` 方法前，若配置启用且场景可量化（有多个候选方案或方案有 fitScore），调用 QuantitativeGate。supersede/reject 的候选构造 RejectedAlternative 写入 store（gate.gateType='quantitative-gate'，gate.score=compositeScore，gate.threshold=acceptThreshold）。

- [ ] **Step 5: 配置 schema 收口**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加顶层 `phase68Integration` 聚合 Task 1-5 所有子配置：

```ts
phase68Integration: z.preprocess((v) => v ?? {}, z.object({
  /** Task 1：三分标注 */
  operationClassification: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    logRegimeTransition: z.boolean().default(true),
  })),
  /** Task 2：溯源图 */
  provenanceGraph: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    persistPath: z.string().default('.routedev/provenance.jsonl'),
    maxArtifacts: z.number().int().min(100).default(10000),
  })),
  /** Task 3：被拒替代保留 */
  rejectedAlternativeStore: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    persistPath: z.string().default('.routedev/rejected-alternatives.jsonl'),
    maxRecords: z.number().int().min(100).default(5000),
    defaultQueryLimit: z.number().int().min(1).max(50).default(5),
  })),
  /** Task 4：Kan 障碍检查 */
  kanObstacleChecker: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    blockOnObstacle: z.boolean().default(false),
  })),
  /** Task 5：定量门 */
  quantitativeGate: z.preprocess((v) => v ?? {}, z.object({
    enabled: z.boolean().default(false),
    mdlWeight: z.number().min(0).max(1).default(0.4),
    aicWeight: z.number().min(0).max(1).default(0.6),
    acceptThreshold: z.number().min(0).max(1).default(0.7),
    rejectThreshold: z.number().min(0).max(1).default(0.3),
    complexityPenalty: z.number().min(0).default(0.01),
  })),
})).default({}),
```

- [ ] **Step 6: defaults.ts 同步**

在 [defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) 增加 phase68Integration 默认值。

- [ ] **Step 7: 设置页 UI**

在 desktop renderer 设置页新增"Phase 68 知识图谱"分区：
- 三分标注开关
- 溯源图开关 + 持久化路径
- 被拒替代保留开关 + 查询入口
- Kan 障碍检查开关 + 阻断模式
- 定量门开关 + 权重滑块 + 阈值

UI 风格遵循用户偏好（圆角、紫色调、lucide-react 图标）。

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/quantitative-gate.test.ts`，覆盖：
- 单候选 accept（综合分 >= acceptThreshold）
- 单候选 reject（综合分 < rejectThreshold）
- 单候选 hold（介于两者之间）
- 多候选 supersede（最高分 accept，其余 supersede）
- MDL 评分（描述越短越优）
- 配置关闭时跳过

- [ ] **Step 9: 全量验证**

```powershell
pnpm typecheck
pnpm test
pnpm build:electron
```

预期：全绿，新增 ≥ 35 个测试通过。

- [ ] **Step 10: 文档同步**

更新 README.md 与 ARCHITECTURE.md，说明知识图谱与三分操作架构。

- [ ] **Step 11: 提交**

```powershell
git add -A
git commit -m "feat(phase-68): MDL/AIC 定量门 + 配置收口与全量验证

新增 QuantitativeGate，MDL/AIC 启发式评分作 CrossModelReviewer 硬阈值补充
论文借鉴：arXiv:2606.01444 Gate/Verifier——MDL/AIC 决定 accept/reject/supersede/hold
配置收口：phase68Integration 聚合 Task 1-5 全部子配置
版本：v4.6.7"
```

---

## 风险与回滚

### 风险 1：三分标注误判（把 discovery 错标为 search）
- **缓解**：分类优先级明确（regimeExtended > dagComposed > ccrHit），且 discovery 必须有 `newArtifactTypes` 物证；无物证时降级为 search
- **回滚**：关闭 `phase68Integration.operationClassification.enabled`

### 风险 2：溯源图无界增长
- **缓解**：`maxArtifacts` 默认 10000，超出时 FIFO 淘汰最旧制品（同时清理对应的边）
- **回滚**：关闭 `phase68Integration.provenanceGraph.enabled`，删除 `.routedev/provenance.jsonl`

### 风险 3：被拒替代保留泄露敏感信息（被拒方案可能含密钥/凭证）
- **缓解**：写入前复用现有 [result-sanitizer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/result-sanitizer.ts) 脱敏；relatedFiles 仅记录路径不记录内容
- **回滚**：关闭 `phase68Integration.rejectedAlternativeStore.enabled`，删除 `.routedev/rejected-alternatives.jsonl`

### 风险 4：Kan 障碍阻断合法的新技能注册（误报）
- **缓解**：默认 `blockOnObstacle=false`（仅 warn），用户确认无障碍后可手动放行；`transportableFrom` 提供迁运兜底
- **回滚**：关闭 `phase68Integration.kanObstacleChecker.enabled`

### 风险 5：定量门 MDL/AIC 启发式偏差（短描述但差方案得高分）
- **缓解**：定量门是 CrossModelReviewer 的**补充**而非替代，软判断仍执行；`aicWeight` 默认 0.6 > `mdlWeight` 0.4，拟合度权重更高
- **回滚**：关闭 `phase68Integration.quantitativeGate.enabled`，退回纯软判断

### 风险 6：体制迁移记录污染 AuditChain
- **缓解**：仅 `discovery` 操作记录 RegimeTransition，retrieval/search 不记录；AuditChain 已有哈希链防篡改
- **回滚**：关闭 `phase68Integration.operationClassification.logRegimeTransition`

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 35 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] 三分标注总开关默认关闭，设置页可开启
- [ ] CCRCache 命中标注为 retrieval，compositional-router DAG 组合标注为 search，新技能注册标注为 discovery
- [ ] discovery 操作记录 RegimeTransition 到 AuditChain
- [ ] ProvenanceGraph 持久化与恢复正常（.routedev/provenance.jsonl）
- [ ] TypedArtifact 含 artifactType / parentIds / producingOperation，可查询谱系
- [ ] CrossModelReviewer 否决方案保留为 RejectedAlternative，可按任务检索
- [ ] 被拒替代同时作为 pitfall 类型制品注册到 ProvenanceGraph
- [ ] KanObstacleChecker 检测到空类型时发出警示，blockOnObstacle 可配
- [ ] QuantitativeGate 对可量化场景给出 accept/reject/supersede/hold 决策
- [ ] supersede/reject 候选联动写入 RejectedAlternativeStore
- [ ] phase68Integration 聚合 Task 1-5 全部子配置，设置页可调
- [ ] fail-open：各模块失败时不阻塞主流程（除 KanObstacleChecker 的 fail-closed 模式）
- [ ] README.md 与 ARCHITECTURE.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过，新增 export 均有消费方
- [ ] 配置字段自审：新增的每个 zod schema 字段有读取方
- [ ] 执行人自审报告已附在每个 Task 的提交信息中
