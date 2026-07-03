# Phase 65-67 模块详细说明

本文档为 Phase 65-67 中引入的所有模块提供详细说明，帮助理解这些学术命名模块的功能和使用场景。

## 目录

- [Phase 65: 记忆系统重构](#phase-65-记忆系统重构)
- [Phase 66: 基础协议](#phase-66-基础协议)
- [Phase 67: 推理质量诊断](#phase-67-推理质量诊断)
- [配置说明](#配置说明)
- [使用示例](#使用示例)

---

## Phase 65: 记忆系统重构

### MemoryStore（记忆存储）

**目的**: 统一的记忆存储后端，支持 SQLite 和内存两种模式。

**核心功能**:
- 持久化存储对话历史和决策记录
- 支持嵌入向量存储（可选）
- 提供查询接口供其他模块检索

**使用场景**: 需要长期保存项目上下文和历史决策时启用。

**配置路径**: `config.memorySystem.memoryStore`

---

### IncrementalExtractor（增量提取器）

**目的**: 从对话流中逐步提取关键信息，避免重复处理。

**核心功能**:
- 支持两种模式：
  - `diff`: 仅提取新增内容
  - `full`: 每次全量提取
- 识别并保存项目决策、技术栈、约束条件等

**使用场景**: 长对话中需要持续跟踪关键信息变化。

**配置路径**: `config.memorySystem.incrementalExtractor`

---

### HybridRetriever（混合检索器）

**目的**: 结合关键词匹配（BM25）和语义搜索（嵌入向量）的混合检索。

**核心功能**:
- BM25 权重 + 嵌入权重的加权组合
- 时间衰减：优先返回近期相关内容
- Top-K 结果排序

**使用场景**: 需要从历史记忆中找出最相关的上下文。

**配置路径**: `config.memorySystem.hybridRetriever`

---

### ConservativeMerger（保守合并器）

**目的**: 安全地合并新信息到现有记忆，避免覆盖重要内容。

**核心功能**:
- 冲突检测：识别新旧信息的矛盾
- 保守策略：存疑时保留旧信息
- 审计日志：记录所有合并决策

**使用场景**: 防止错误信息污染项目记忆库。

**配置路径**: `config.memorySystem.conservativeMerger`

---

### RejectedAlternativeStore（被拒方案存储）

**目的**: 保存被拒绝的技术方案和原因，避免重复讨论。

**核心功能**:
- 记录方案内容、拒绝原因、拒绝时间
- 可查询历史拒绝记录
- 支持方案重新激活

**使用场景**: 团队协作时避免重复提出已被否决的方案。

**配置路径**: `config.memorySystem.rejectedAlternativeStore`

---

### LocalMaintenancePolicy（本地维护策略）

**目的**: 定期清理和优化记忆库，防止无限增长。

**核心功能**:
- 过期清理：删除超过保留期的记忆
- 重要性评分：保留访问频繁的记忆
- 自动压缩：合并相似记忆条目

**使用场景**: 长期运行的项目需要定期维护记忆库。

**配置路径**: `config.memorySystem.localMaintenance`

---

### EvalMetrics（评估指标）

**目的**: 记录和统计记忆系统的性能指标。

**核心功能**:
- 检索准确率、召回率
- 平均响应时间
- 缓存命中率

**使用场景**: 研究和优化记忆系统性能。

**配置路径**: `config.memorySystem.evalMetrics`

---

### BM25Index（BM25 索引）

**目的**: 基于词频-逆文档频率的关键词检索索引。

**核心功能**:
- 快速关键词匹配
- 支持中英文分词
- 增量更新索引

**使用场景**: HybridRetriever 的关键词检索后端。

**配置路径**: 通过 `HybridRetriever` 自动创建

---

## Phase 66: 基础协议

### CheckpointPipeline（检查点管道）

**目的**: 在推理过程中设置检查点，支持分段执行和回滚。

**核心功能**:
- 分段编号：pre(100-199), mid(200-299), post(300-399), eval(400-499), cleanup(500-599)
- 短路模式：某个检查点失败时终止后续执行
- 状态快照：每个检查点保存当前状态

**使用场景**: 复杂任务需要分阶段验证和回滚能力。

**配置路径**: `config.foundationProtocol.checkpointPipeline`

---

### CallOwnerCoordinator（调用所有者协调器）

**目的**: 协调多个并发 worker 对共享资源的访问，避免冲突。

**核心功能**:
- 所有权锁定：某个 worker 持有资源时，其他 worker 需等待
- 同步等待：支持配置等待超时
- 持久化状态：重启后恢复所有权信息

**使用场景**: 多 worker 并发修改同一文件或资源时。

**配置路径**: `config.foundationProtocol.callOwnerCoordinator`

---

### CallOwnerMixin（调用所有者混入）

**目的**: 为任意模块添加所有权跟踪能力的辅助类。

**核心功能**:
- 自动注册/注销所有权
- 与 CallOwnerCoordinator 集成
- 支持继承和组合模式

**使用场景**: 开发新模块时需要所有权管理。

**配置路径**: `config.foundationProtocol.callOwnerMixin`

---

### StateSnapshotChain（状态快照链）

**目的**: 维护状态变更的完整历史链，支持任意时间点回溯。

**核心功能**:
- 链式存储：每个快照指向前一个快照
- 增量保存：仅存储变更部分
- 快速回溯：通过快照 ID 直接跳转

**使用场景**: 需要完整追溯推理过程或实验对比。

**配置路径**: `config.foundationProtocol.stateSnapshotChain`

---

### ReputationDeriver（信誉推导器）

**目的**: 根据历史表现计算模块/worker 的信誉分数。

**核心功能**:
- 成功率统计：成功/失败次数
- 时间加权：近期表现权重更高
- 信誉等级：S/A/B/C/F 五级评分

**使用场景**: 动态路由时优先选择高信誉的执行路径。

**配置路径**: `config.foundationProtocol.reputationDeriver`

---

## Phase 67: 推理质量诊断

### MICrossScorer（互信息交叉评分器）

**名称解释**: MI = Mutual Information（互信息）

**目的**: 通过互信息代理指标诊断推理质量，检测推理坍缩。

**核心原理**:
- **retrievalAcc**: 模型对 prompt 的正确检索比例
- **randomBaseline**: 随机基线 = 1/P（P = prompts 数量）
- **miZScore**: (avgRetrievalAcc - randomBaseline) / stdDev
- **坍缩告警**: miZScore 持续低于阈值时，说明推理退化为随机输出

**使用场景**:
- 研究模型推理质量
- 检测推理过程中的质量下降
- 对比不同 prompt 策略的效果

**配置路径**: `config.reasoningQualityDiagnostics.miCrossScorer`

**关键参数**:
- `collapseThreshold`: 坍缩阈值（默认 1.5）
- `minPrompts`: 最小 prompt 数量（默认 2）
- `samplesPerPrompt`: 每个 prompt 的采样数（默认 4）

---

### SNRAwareFilter（信噪比感知过滤器）

**名称解释**: SNR = Signal-to-Noise Ratio（信噪比）

**目的**: 基于奖励方差（RV）过滤低质量任务，避免浪费计算资源。

**核心原理**:
1. 计算每个任务的 RV（Reward Variance，奖励方差）
2. 按 RV 降序排列，保留前 topP%（如 90%）
3. 如果零信号任务占比超过阈值，拒绝整个 batch

**使用场景**:
- 多 worker 并行执行前筛选高价值任务
- 避免执行明显无意义的任务
- 资源受限时优先执行高 RV 任务

**配置路径**: `config.reasoningQualityDiagnostics.snrAwareFilter`

**关键参数**:
- `topP`: 保留前 N% 高 RV 任务（默认 0.9）
- `minRVThreshold`: 最低 RV 阈值（默认 0.01）
- `batchRejectRatio`: 批量拒绝比例（默认 0.7）

---

### EpistemicTokenProtector（认知不确定性 Token 保护器）

**名称解释**: Epistemic = 认知的、知识论的

**目的**: 保护推理过程中表达不确定性的 token 及其邻域，避免被压缩删除。

**核心原理**:
- **Epistemic Tokens**: `wait`, `hmm`, `actually`, `but`, `perhaps`, `maybe` 等
- 这些 token 反映模型的认知探索过程，包含备选假设和思考轨迹
- 保护策略：对每个 epistemic token 所在行，保护 [i-N, i+N] 邻域范围

**使用场景**:
- 上下文压缩时避免丢失关键思考过程
- 保留推理的"探索性"部分
- 研究模型的不确定性表达模式

**配置路径**: `config.reasoningQualityDiagnostics.epistemicTokenProtector`

**关键参数**:
- `neighborhoodLines`: 邻域保护行数（默认 3）
- `customTokens`: 自定义 epistemic token 列表

**内置 Epistemic Tokens**:
```typescript
[
  'wait', 'hmm', 'actually', 'let me reconsider',
  'on second thought', 'but', 'however', 'perhaps',
  'maybe', 'not sure'
]
```

---

### EpistemicIntegrityChecker（认知完整性检查器）

**目的**: 验证压缩后的内容是否保留了关键的认知不确定性信息。

**核心功能**:
- 检测压缩前后 epistemic token 的保留率
- 计算邻域保留完整性
- 生成完整性报告和建议

**使用场景**:
- 验证上下文压缩策略的质量
- 确保重要思考过程未被删除
- 调试压缩算法

**配置路径**: `config.reasoningQualityDiagnostics.epistemicIntegrityChecker`

---

### EpistemicPreservingSummarizer（认知保留摘要器）

**目的**: 生成保留认知不确定性信息的摘要，而非简单删除或压缩。

**核心功能**:
- 识别 epistemic token 相关段落
- 优先保留包含不确定性表达的内容
- 生成"有损但保留认知轨迹"的摘要

**使用场景**:
- 需要压缩上下文但不能丢失思考过程
- 生成可读性强的推理过程摘要
- 研究和展示模型的推理轨迹

**配置路径**: `config.reasoningQualityDiagnostics.epistemicPreservingSummarizer`

---

### QualityMetricsRecorder（质量指标记录器）

**目的**: 统一记录和导出所有推理质量指标。

**核心功能**:
- 记录 MI、SNR、epistemic 保留率等指标
- 支持导出为 JSON/CSV 格式
- 提供时间序列分析接口

**使用场景**:
- 研究推理质量趋势
- 对比不同配置的效果
- 生成质量报告

**配置路径**: `config.reasoningQualityDiagnostics.qualityMetricsRecorder`

---

## 配置说明

### 配置预设

为简化配置，系统提供 4 种预设模式：

#### 1. 极简模式 (minimal)
```typescript
{
  memorySystem: { enabled: false },
  foundationProtocol: { enabled: false },
  reasoningQualityDiagnostics: { enabled: false }
}
```
**适用场景**: 日常编码、快速原型开发、学习使用

#### 2. 均衡模式 (balanced) - 默认
```typescript
{
  memorySystem: { enabled: true },
  foundationProtocol: { enabled: true },
  reasoningQualityDiagnostics: { enabled: true }
}
```
**适用场景**: 通用开发任务、团队协作、中等规模项目

#### 3. 高级模式 (advanced)
```typescript
{
  memorySystem: { enabled: true },
  foundationProtocol: { enabled: true },
  reasoningQualityDiagnostics: { enabled: true },
  adversarial: { enabled: true },
  optimization: {
    structuredState: { enabled: true },
    declarativeContext: { enabled: true },
    conciseThinking: { enabled: true }
  }
}
```
**适用场景**: 大型项目、性能调优、复杂架构重构

#### 4. 研究模式 (research)
```typescript
{
  memorySystem: { enabled: true, evalMetrics: { enabled: true } },
  foundationProtocol: { enabled: true, reputationDeriver: { enabled: true } },
  reasoningQualityDiagnostics: {
    enabled: true,
    miCrossScorer: { samplesPerPrompt: 8 },
    qualityMetricsRecorder: { enabled: true }
  },
  adversarial: { enabled: true, threshold: 0.7 }
}
```
**适用场景**: AI 研究、算法验证、实验性功能测试

### 使用预设配置

```typescript
import { applyPreset } from './config/presets.js';
import { loadConfig } from './config/loader.js';

// 加载当前配置
const currentConfig = loadConfig();

// 应用预设（保留用户自定义设置）
const newConfig = applyPreset(currentConfig, 'advanced');
```

---

## 使用示例

### 示例 1: 启用记忆系统跟踪项目决策

```typescript
// 配置文件
{
  memorySystem: {
    enabled: true,
    memoryStore: {
      enabled: true,
      dbPath: '.routedev/memory.db',
      backend: 'sqlite'
    },
    incrementalExtractor: {
      enabled: true,
      mode: 'diff'
    },
    hybridRetriever: {
      enabled: true,
      bm25Weight: 0.5,
      embeddingWeight: 0.3,
      topK: 10
    }
  }
}

// 运行时使用
const deps = await createAppDependencies(config, clientManager);

// 提取关键信息
await deps.incrementalExtractor.extract(conversationHistory);

// 检索相关历史
const relevantMemories = await deps.hybridRetriever.retrieve('用户认证方案');
```

---

### 示例 2: 诊断推理质量

```typescript
// 配置文件
{
  reasoningQualityDiagnostics: {
    enabled: true,
    miCrossScorer: {
      enabled: true,
      collapseThreshold: 1.5,
      minPrompts: 3,
      samplesPerPrompt: 4
    },
    qualityMetricsRecorder: {
      enabled: true,
      outputPath: '.routedev/quality-metrics.json'
    }
  }
}

// 运行时使用
const deps = await createAppDependencies(config, clientManager);

// 计算 MI 代理指标
const scores = [
  { promptId: 'p1', retrievalAcc: 0.85, randomBaseline: 0.33 },
  { promptId: 'p2', retrievalAcc: 0.72, randomBaseline: 0.33 },
  { promptId: 'p3', retrievalAcc: 0.91, randomBaseline: 0.33 }
];

const snapshot = deps.miCrossScorer.computeMIProxy(scores);

if (snapshot.collapseWarning) {
  console.warn('推理质量下降，建议调整 prompt 策略');
}

// 记录指标
deps.qualityMetricsRecorder.record({
  timestamp: Date.now(),
  miZScore: snapshot.miZScore,
  collapseWarning: snapshot.collapseWarning
});
```

---

### 示例 3: 保护认知不确定性信息

```typescript
// 配置文件
{
  reasoningQualityDiagnostics: {
    enabled: true,
    epistemicTokenProtector: {
      enabled: true,
      neighborhoodLines: 3,
      customTokens: ['需要思考', '不太确定']
    },
    epistemicIntegrityChecker: {
      enabled: true
    }
  }
}

// 运行时使用
const deps = await createAppDependencies(config, clientManager);

const originalMessage = `
我尝试了方案 A。
Wait, 方案 A 可能有性能问题。
Let me reconsider - 方案 B 更合适。
最终选择方案 B。
`;

// 保护 epistemic token 邻域
const protectedMessage = deps.epistemicTokenProtector.protectMessage(originalMessage);

// 检查完整性
const integrityReport = deps.epistemicIntegrityChecker.checkIntegrity(
  originalMessage,
  protectedMessage
);

console.log(`Epistemic token 保留率: ${integrityReport.retentionRate * 100}%`);
```

---

## 参考资料

- [Phase 65 技术文档](../CHANGELOG.md#phase-65)
- [Phase 66 技术文档](../CHANGELOG.md#phase-66)
- [Phase 67 技术文档](../CHANGELOG.md#phase-67)
- [配置 Schema 定义](../src/config/schema.ts)
- [集成测试示例](../tests/integration/phase65-67-integration.test.ts)
