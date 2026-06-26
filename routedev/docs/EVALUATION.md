# 评估集框架（Evaluation Framework）

> Phase 49 Task 5 · 模块：`src/evaluation/evaluation-framework.ts` + `online-monitor.ts`

## 概述

评估集是 RouteDev 工程化的灵魂。没有评估集就不叫工程化——95% 的 AI 工程师能做原型，能上生产的 5% 才拿高薪。本模块负责"上线前评估"和"运行时监控"两条线。

知识库原文：
> "评估集是生产化的灵魂——没有评估集就不叫工程化。"
> "评估集三层：Smoke set / Regression set / Comprehensive set。"
> "LLM-as-Judge 五大陷阱：位置偏差/长度偏差/自我偏好/风格偏差/缺少 ground truth。"
> "在线监控 7 类信号：延迟/成本/质量/错误率/安全/用户反馈/漂移。"

RouteDev 不是 SaaS 平台，规模缩小为：
- Smoke(10)：Skill 安装/更新时运行，2 分钟出结果
- Regression(30)：/goal 完成后运行，防退化
- OnlineMonitor：7 类信号 + 配置 ROI 评估

## 核心概念

### 评估集三层（RouteDev 缩小版）

| 评估集 | 用例数 | 触发时机 | 超时 | 用途 |
|--------|--------|---------|------|------|
| `smoke` | 10 | `skill-install` | 120s | Skill 安装/更新时快速验证 |
| `regression` | 30 | `goal-complete` | 600s | /goal 完成后防退化 |

`EVALUATION_SETS` 常量定义了这两套配置。

### LLM-as-Judge 五大陷阱及解法

| 陷阱 | 表现 | 解法 |
|------|------|------|
| 1. 位置偏差（Position Bias） | LLM 倾向给靠前/靠后的用例更高分 | Fisher-Yates 洗牌随机打乱用例顺序 |
| 2. 长度偏差（Length Bias） | LLM 倾向给长答案更高分 | Rubric 明确"长度不作为评分依据" |
| 3. 自我偏好（Self-Preference） | LLM 倾向给自己生成的答案更高分 | 跨模型评审（judge 模型 ≠ 被评估模型） |
| 4. 风格偏差（Style Bias） | LLM 倾向给"写得顺"的答案更高分 | 多维度 Rubric（不单看流畅度） |
| 5. 缺少 ground truth | 无参考答案无法客观评分 | 标注 expectedBehavior 参考案例 |

### Rubric 多维度评分

每个 EvaluationCase 携带自己的 Rubric（评分标准）：

```typescript
interface RubricItem {
  criterion: string;  // 评分维度（如"正确性""边界处理""安全性"）
  weight: number;     // 权重（>0，最终分数按加权平均）
}
```

综合得分 = Σ(维度得分 × 权重) / Σ 权重，>= `passThreshold`（默认 0.7）视为通过。

### 评估报告字段

```typescript
interface EvaluationReport {
  target: 'skill' | 'goal';
  targetId: string;
  totalCases: number;
  passed: number;
  failed: number;
  results: CaseResult[];        // 各用例明细（按打乱后顺序）
  rubricScores: RubricScore[];  // 全局 Rubric 聚合得分（按维度求平均）
  modelVersion: string;         // 陷阱 #149：必须记录
  timestamp: string;
}
```

### 在线监控 7 类信号

| 信号 | 阈值 | 告警条件 |
|------|------|---------|
| `latency` | P95 > 300ms | 延迟过高 |
| `cost` | 日环比 > 30% | Token 消耗突增 |
| `quality` | 错误路由率 > 5% | 路由质量下降 |
| `error-rate` | 失败率 > 1% | 执行失败过多 |
| `security` | 注入尝试 > 0 | 任何异常即告警 |
| `feedback` | 差评率 > 10% | 用户反馈不佳 |
| `drift` | KL 散度 > 0.2 | 意图分布漂移 |

第 8 类 `config-roi` 是陷阱 #155 的对策——对长期未使用的配置主动提示归档。

## 使用方式

### 运行 Smoke 评估集

```typescript
import { EvaluationFramework, EVALUATION_SETS } from '../evaluation/evaluation-framework.js';

const framework = new EvaluationFramework(
  // executeTarget：执行被评估目标（Skill 或 /goal）
  async (input, target, targetId) => {
    // 调用 Skill 或运行 /goal，返回实际输出
    return await runSkill(targetId, input);
  },
  // judge：LLM-as-Judge 回调（应由与被评估目标不同的模型承担）
  async (testCase, actualOutput) => {
    return await llmJudge(testCase, actualOutput);
  },
  'gpt-4-1106',  // Judge 模型版本（陷阱 #149：必须记录到报告）
  0.7,           // passThreshold
);

const report = await framework.runEvaluation(
  smokeCases,        // EvaluationCase[]（10 个用例）
  'skill',
  'my-skill-name',
);

console.log(`通过 ${report.passed}/${report.totalCases}`);
console.log(`Judge 模型：${report.modelVersion}`);
```

### 运行 Regression 评估集

```typescript
const report = await framework.runEvaluation(
  regressionCases,   // 30 个用例
  'goal',
  'goal-2026xxxx',
);
// /goal 完成后运行，防止功能退化
```

### 在线监控一次性运行

```typescript
import { OnlineMonitor } from '../evaluation/online-monitor.js';

const monitor = new OnlineMonitor();
const alerts = monitor.runAll({
  scoreCards,                    // 含 durationMs / tokenUsage / userFeedback
  yesterdayTotalTokens: 500_000,
  routingErrors: 8,
  totalRequests: 100,
  failures: 3,
  total: 200,
  injectionAttempts: 2,
  todayDistribution: { simple: 60, complex: 30, reasoning: 10 },
  yesterdayDistribution: { simple: 50, complex: 40, reasoning: 10 },
  configLastUsedDays: {          // 陷阱 #155：配置 ROI 评估
    'old-skill-1': 45,
    'active-skill': 1,
  },
});

for (const alert of alerts) {
  if (alert.severity === 'high') {
    notifyUser(alert.message);
  }
}
```

### 单项监控

```typescript
// 只监控延迟
const latencyAlerts = monitor.monitorLatency(scoreCards);

// 只监控漂移
const driftAlerts = monitor.monitorDrift(todayDist, yesterdayDist);

// 只监控配置 ROI（陷阱 #155）
const roiAlerts = monitor.monitorConfigRoi(configLastUsedDays, 30);
```

## 配置

### EvaluationFramework 构造参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `executeTarget` | `ExecuteTargetCallback` | — | 执行被评估目标的回调（必传） |
| `judge` | `JudgeCallback` | — | LLM-as-Judge 回调（必传，应由不同模型承担） |
| `modelVersion` | `string` | — | Judge 模型版本（写入报告，陷阱 #149） |
| `passThreshold` | `number` | 0.7 | 综合加权得分 >= 此值视为通过 |

### EVALUATION_SETS 常量

```typescript
export const EVALUATION_SETS: Record<'smoke' | 'regression', EvaluationSetConfig> = {
  smoke: { size: 10, trigger: 'skill-install', timeoutMs: 120_000 },
  regression: { size: 30, trigger: 'goal-complete', timeoutMs: 600_000 },
};
```

### OnlineMonitor 阈值常量

| 常量 | 值 | 说明 |
|------|----|----|
| `LATENCY_P95_THRESHOLD_MS` | 300 | 延迟阈值 |
| `COST_DAY_OVER_DAY_RATIO` | 0.3 | 成本日环比阈值 |
| `ROUTING_ERROR_RATE_THRESHOLD` | 0.05 | 错误路由率阈值 |
| `FAILURE_RATE_THRESHOLD` | 0.01 | 失败率阈值 |
| `INJECTION_ATTEMPT_THRESHOLD` | 0 | 注入尝试阈值（任何异常即告警） |
| `NEGATIVE_FEEDBACK_RATE_THRESHOLD` | 0.1 | 差评率阈值 |
| `KL_DIVERGENCE_THRESHOLD` | 0.2 | 漂移阈值 |
| `CONFIG_ARCHIVE_THRESHOLD_DAYS` | 30 | 配置归档阈值（陷阱 #155） |

### 告警严重度分级

每个监控方法根据实际值与阈值的差距分 `low` / `medium` / `high` 三级：
- `latency`：> 1000ms=high, > 600ms=medium, 其他=low
- `cost`：日环比 > 100%=high, > 60%=medium, 其他=low
- `error-rate`：失败率 > 10%=high, > 5%=medium, 其他=low
- `security`：注入 >= 10 次=high, >= 3 次=medium, 其他=low

## 陷阱

### #149：评估集的 LLM-as-Judge 可能因模型升级而失效

Judge 模型升级后，原有 Rubric 刻度可能失真（新模型打分整体偏高或偏低）。

**对策**：
- 评估报告必须记录 `modelVersion`
- 模型升级后需重新校准 Rubric（对比新旧模型对同一批用例的打分）
- 与 ModelDriftDetector 联动：检测到 Judge 模型升级时提示重新校准

### #155：配置 ROI 评估——只统计使用率不评估维护成本

在线监控若只统计"使用频率"而不评估"维护成本"，会鼓励用户堆砌配置（48 Agent + 182 Skill + 68 命令的维护成本巨大）。

**对策**：
- `monitorConfigRoi` 同时统计"配置使用率"和"配置维护成本"
- 对长期未使用的配置（默认 30 天）主动提示"该 Skill 30 天未使用，是否归档？"
- `configLastUsedDays` 字段记录每个配置的最近使用天数

### #149b：LLM-as-Judge 的自我偏好

如果 Judge 模型与被评估模型相同，Judge 会倾向于给自己生成的答案更高分。

**对策**：
- `judge` 回调应由"与被评估目标不同的模型"承担
- 跨模型评审——例如被评估目标是 GPT-4，Judge 用 Claude 或 Gemini
- 与 CrossModelReviewer（DUAL_LOOP.md）共享此原则

### #149c：位置偏差的洗牌不够彻底

单次 Fisher-Yates 洗牌可能仍有系统性偏差（如重要用例恰好都排在后面）。

**对策**：
- 关键评估可双向对照：正序跑一次，反序跑一次，对比结果
- 多次运行取平均（每次都重新洗牌）
- 报告中记录用例执行顺序，便于事后审计

### #149d：缺少 ground truth 时的 expectedBehavior 模糊

`expectedBehavior` 是行为约束而非精确输出，LLM-as-Judge 可能给出主观判断。

**对策**：
- expectedBehavior 应包含可验证的关键词（如"必须调用 read_file""必须拒绝"）
- Rubric 维度应包含"可验证性"——是否满足可客观检查的条件
- 关键场景补充精确的 ground truth（非模糊描述）

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| `skills/quality-gate.ts` | 互补：质量门是"上线前一次性验证"（3 场景），EvaluationFramework 是"运行时持续评估"（Smoke/Regression） |
| `skills/model-drift-detector.ts` | 联动：检测到 Judge 模型升级时触发 Rubric 重新校准（陷阱 #149） |
| `agent/dual-loop-orchestrator.ts` | 上游：DualLoop 的 GoalVerifier 验证单次目标完成，EvaluationFramework 验证整体质量 |
| `agent/cross-model-reviewer.ts` | 共享原则：跨模型评审避免自我偏好（陷阱 #149b） |
| `agent/multi/score-card.ts` | 上游：ScoreCard 记录单次执行指标，OnlineMonitor 聚合统计 |
| `router/routing-funnel.ts` | 上游：RoutingFunnel 的路由命中/未命中数据喂给 OnlineMonitor.monitorQuality |

## 相关文档

- [QUALITY_GATE.md](./QUALITY_GATE.md) — Skill 质量门
- [DUAL_LOOP.md](./DUAL_LOOP.md) — 双循环编排器与 CrossModelReviewer
- [ROUTING.md](./ROUTING.md) — 意图路由四层漏斗
