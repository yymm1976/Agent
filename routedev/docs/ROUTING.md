# 意图路由四层漏斗（Routing Funnel）

> Phase 49 Task 6 · 模块：`src/router/routing-funnel.ts` + `deterministic-rules.ts`

## 概述

意图路由四层漏斗是 RouteDev 的请求分发核心。它能用 1/3 的延迟、1/4 的成本实现全 LLM 路由方案的效果——靠的是"规则优先模型兜底"的分层设计。

知识库原文：
> "意图路由四层漏斗：L0 正则(<1ms, 拦截 60-80%) → L1 向量语义(30-100ms, 拦截 15-25%) → L2 大模型(1-2s, 仅 5-15%) → SafeNet(置信度+OOD+熔断, <3%)。"
> "效果：延迟降至全 LLM 方案的 1/3，成本降至 1/4。"

四条铁律：
1. **规则优先模型兜底**——能用正则/向量解决的不调大模型
2. **意图用枚举不用自由文本**——避免 LLM 返回任意字符串导致下游解析失败
3. **低置信度反问不瞎猜**——confidence < 阈值时标记 `needsClarification` 让 AI 反问用户
4. **上线第一天就埋监控**——每层命中/未命中/耗时全部记录日志（由调用方聚合到 OnlineMonitor）

## 核心概念

### 四层漏斗架构

```
用户输入
   ↓
┌─────────────────────────────────────────────┐
│ L0 正则匹配（<1ms，拦截 60-80%）              │
│   - 命中确定性规则 → confidence=1.0 → 返回    │
│   - 未命中 → 进入 L1                          │
└─────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────┐
│ L1 向量语义路由（30-100ms，拦截 15-25%，可选）│
│   - embedding + 余弦相似度匹配意图            │
│   - 命中 → confidence > 阈值 → 返回           │
│   - 未命中或不可用 → 进入 L2                  │
└─────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────┐
│ L2 大模型路由（1-2s，仅 5-15% 请求到达）      │
│   - LLMClassifier.classify() → ScenarioTier  │
│   - confidence > 阈值 → 返回                  │
│   - 否则 → 进入 SafeNet                       │
└─────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────┐
│ SafeNet（<3% 请求到达）                       │
│   - confidence < safeNet 阈值 → needsClarification │
│   - 连续低置信度 > 5 次 → 触发熔断            │
│   - 熔断期间所有请求回退默认模型              │
└─────────────────────────────────────────────┘
```

### L0 确定性规则（DeterministicRule）

L0 复用 `matchDeterministicRule`，规则表支持三种匹配方式：

| matchType | 说明 | 示例 pattern |
|-----------|------|-------------|
| `exact` | trim 后精确比较 | `/cost` |
| `startsWith` | trim 后前缀匹配 | `/trust` |
| `regex` | 正则匹配 | `^读取\s+(.+)$` |

命中后的三种 handler：

| handler | 说明 | 必填字段 |
|---------|------|---------|
| `direct-response` | 直接用 responseTemplate 返回（不调 LLM） | `responseTemplate`（支持 `{{now}}` `{{date}}` 占位符） |
| `tool-direct` | 直接调用 targetTool（不调 LLM） | `targetTool` |
| `command-dispatch` | 派发到 targetCommand | `targetCommand`（不含斜杠） |

内置规则覆盖：
- 斜杠命令查询：`/cost` `/history` `/status` `/help` `/trust` `/quality`
- 简单信息查询：当前时间、今天日期
- 纯文件操作：读取文件、列出目录

用户自定义规则从 `.routedev/deterministic-rules.json` 加载，与内置规则合并（内置在前，自定义在后，id 重复时跳过自定义）。

### L1 向量语义路由（可选）

通过依赖注入的 `VectorRouter` 接口实现：

```typescript
interface VectorRouter {
  route(input: string): Promise<RoutingResult | null>;
}
```

不传 `vectorRouter` 则跳过 L1，直接进 L2。L1 失败不阻断流程，降级到 L2。

### L2 大模型路由

通过依赖注入的 `LLMClassifier` 接口实现：

```typescript
interface LLMClassifier {
  classify(input: string): Promise<RoutingResult>;
}
```

铁律 2：`LLMClassifier` 内部应返回 `ScenarioTier` 枚举（`simple` / `medium` / `complex` / `reasoning`）而非自由文本。

L2 失败时返回极低置信度结果（confidence=0），交给 SafeNet 兜底。

### SafeNet 兜底

SafeNet 做三件事：
1. **置信度检查**：confidence < `safeNetConfidenceThreshold`（默认 0.5）→ 标记 `needsClarification=true`，model 标记为 `{id:'unknown', provider:'safe-net'}`
2. **熔断判定**：连续低置信度 > `circuitBreakerThreshold`（默认 5）次 → 触发熔断
3. **熔断降级**：熔断期间所有请求回退 `fallbackModel`，5 分钟冷却期后自动恢复

### 熔断器状态机

```
正常状态 ──(连续低置信度 > 5 次)──► 熔断状态
   ↑                                    │
   │                                    │ 5 分钟冷却期
   └────────────────────────────────────┘
```

熔断期间：
- `isCircuitBreakerActive()` 返回 true
- 所有请求直接回退 `fallbackTier`（默认 `complex` 保守策略）和 `fallbackModel`
- `RoutingResult.circuitBreakerActive = true`（供 UI 显示"路由系统降级运行"提示）
- `resetCircuitBreaker()` 可手动恢复（管理员干预）

## 使用方式

### 基本路由

```typescript
import { RoutingFunnel } from '../router/routing-funnel.js';

const funnel = new RoutingFunnel({
  // L2 LLM 分类器（必传）
  llmClassifier: {
    classify: async (input) => {
      // 调用 LLM 分类，返回 ScenarioTier 枚举
      return { tier: 'complex', confidence: 0.85, source: 'llm' };
    },
  },
  // 兜底模型（熔断期间使用）
  fallbackModel: { id: 'gpt-4o-mini', provider: 'openai' },
  // 可选：L1 向量路由器
  // vectorRouter: { route: async (input) => { /* ... */ } },
});

const result = await funnel.route('帮我写个函数');

console.log(result.source);      // 'l0-regex' | 'l1-vector' | 'llm' | 'safe-net'
console.log(result.tier);        // 'simple' | 'medium' | 'complex' | 'reasoning'
console.log(result.confidence);  // 0~1
if (result.needsClarification) {
  // 向用户反问澄清
}
```

### 自定义 L0 规则

```typescript
import { loadCustomRules, mergeRules, BUILTIN_DETERMINISTIC_RULES } from '../router/deterministic-rules.js';

const customRules = await loadCustomRules('.routedev/deterministic-rules.json');
const allRules = mergeRules(BUILTIN_DETERMINISTIC_RULES, customRules);

const funnel = new RoutingFunnel({
  llmClassifier,
  fallbackModel,
  l0Rules: allRules,  // 注入合并后的规则表
});
```

自定义规则文件格式（`.routedev/deterministic-rules.json`）：
```json
[
  {
    "id": "deploy-query",
    "pattern": "^部署\\s+(.+)$",
    "matchType": "regex",
    "handler": "tool-direct",
    "targetTool": "deploy_tool"
  }
]
```

### 熔断器管理

```typescript
// 检查是否熔断
if (funnel.isCircuitBreakerActive()) {
  showUserWarning('路由系统降级运行中');
}

// 获取连续低置信度计数（用于监控）
const count = funnel.getConsecutiveLowConfidence();

// 手动重置熔断（管理员干预）
funnel.resetCircuitBreaker();
```

## 配置

### RoutingFunnelConfig 完整字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `l0Rules` | `DeterministicRule[]` | 内置规则 | L0 规则表（undefined 时用内置） |
| `vectorRouter` | `VectorRouter` | — | L1 向量路由器（不传则跳过 L1） |
| `llmClassifier` | `LLMClassifier` | — | L2 LLM 分类器（必传） |
| `fallbackModel` | `{id, provider}` | — | 兜底模型（必传） |
| `fallbackTier` | `ScenarioTier` | `'complex'` | 兜底等级（保守策略） |
| `l0ConfidenceThreshold` | `number` | 0.9 | L0 命中阈值 |
| `l1ConfidenceThreshold` | `number` | 0.85 | L1 命中阈值 |
| `l2ConfidenceThreshold` | `number` | 0.7 | L2 命中阈值 |
| `safeNetConfidenceThreshold` | `number` | 0.5 | SafeNet 低置信度阈值 |
| `circuitBreakerThreshold` | `number` | 5 | 触发熔断的连续低置信度次数 |
| `circuitBreakerCooldownMs` | `number` | 300000 | 熔断冷却期（5 分钟） |

### 默认阈值常量

```typescript
DEFAULT_L0_CONFIDENCE_THRESHOLD = 0.9;
DEFAULT_L1_CONFIDENCE_THRESHOLD = 0.85;
DEFAULT_L2_CONFIDENCE_THRESHOLD = 0.7;
DEFAULT_SAFENET_CONFIDENCE_THRESHOLD = 0.5;
DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;  // 5 分钟
```

### DeterministicRule 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 规则唯一标识（用于审计/日志） |
| `pattern` | `string` | 是 | 匹配模式 |
| `matchType` | `'exact' \| 'regex' \| 'startsWith'` | 是 | 匹配方式 |
| `handler` | `'direct-response' \| 'tool-direct' \| 'command-dispatch'` | 是 | 命中后处理方式 |
| `responseTemplate` | `string` | handler=direct-response 时必填 | 响应模板（支持 `{{now}}` `{{date}}`） |
| `targetTool` | `string` | handler=tool-direct 时必填 | 目标工具名 |
| `targetCommand` | `string` | handler=command-dispatch 时必填 | 目标命令名（不含斜杠） |

## 陷阱

### #146：SafeNet 的熔断可能导致服务不可用

连续低置信度 > 5 次触发熔断，熔断期间所有请求回退默认模型。

**对策**：
- 5 分钟冷却期后自动恢复（`isCircuitBreakerActive` 内部检查冷却期）
- 熔断期间向用户显示"路由系统降级运行"提示（`circuitBreakerActive=true`）
- `resetCircuitBreaker()` 支持管理员手动干预
- `fallbackTier` 默认 `complex`（保守策略，宁可选强模型也不选弱模型）

### #146b：L0 规则顺序敏感

`matchDeterministicRule` 返回第一个匹配的规则，规则顺序影响命中结果。

**对策**：
- 内置规则按"斜杠命令 > 简单查询 > 文件操作"顺序排列
- 自定义规则追加在内置规则之后（不覆盖内置规则）
- 自定义规则 id 与内置重复时跳过（`mergeRules` 去重）
- 非法正则记录警告并跳过该规则，不阻断整个匹配链

### #146c：L2 LLM 分类失败时的兜底

`LLMClassifier.classify()` 抛异常时，L2 返回 confidence=0 的结果，交给 SafeNet 兜底。

**对策**：
- L2 失败不抛异常给调用方，而是返回极低置信度结果
- SafeNet 检测到低置信度会标记 `needsClarification`
- 连续 L2 失败会累积 `consecutiveLowConfidence`，最终触发熔断

### #146d：铁律 2——意图用枚举不用自由文本

如果 LLMClassifier 返回自由文本（如"这是个代码任务"），下游无法解析。

**对策**：
- `RoutingResult.tier` 类型为 `ScenarioTier` 枚举（`simple` / `medium` / `complex` / `reasoning`）
- `LLMClassifier` 实现方必须返回枚举值，不能返回字符串
- L0 规则的 `matchedRuleId` 即意图（规则 ID 是稳定标识）

### #146e：铁律 3——低置信度反问不瞎猜

confidence < `safeNetConfidenceThreshold` 时不能强行路由，否则会选错模型。

**对策**：
- SafeNet 标记 `needsClarification=true`
- model 标记为 `{id:'unknown', provider:'safe-net'}`
- 调用方检测到 `needsClarification` 应向用户反问（如"您是想做 X 还是 Y？"）
- `originalTier` 保留 LLM 给出的原始等级，便于审计

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| `router/types.ts` | 共享 `ScenarioTier` 类型（simple/medium/complex/reasoning） |
| `router/router.ts` | 上游：Router 调用 RoutingFunnel.route() 获取路由结果 |
| `evaluation/online-monitor.ts` | 下游：OnlineMonitor.monitorQuality 监控 routingErrors/totalRequests |
| `config/schema.ts` | 配置：`RouterConfig` 提供 classifierModel / fallbackChain / rules |
| `agent/dual-loop-orchestrator.ts` | 下游：DualLoop 根据 RoutingResult.tier 选择 Inner Loop 策略 |

## 相关文档

- [EVALUATION.md](./EVALUATION.md) — 评估集框架与在线监控（路由质量监控）
- [DUAL_LOOP.md](./DUAL_LOOP.md) — 双循环编排器（消费路由结果）
- [CONTEXT_USAGE.md](./CONTEXT_USAGE.md) — 上下文占用率（路由选择影响 token 预算）
