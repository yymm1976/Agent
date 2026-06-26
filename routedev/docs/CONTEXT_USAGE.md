# 上下文占用率（Context Usage）

> Phase 49 Task 4 · 模块：`src/agent/context-usage-panel.ts` + `src/cite/structured-injector.ts` + `src/skills/progressive-disclosure.ts` + `src/cite/style-sample-injector.ts`

## 概述

上下文占用率子系统负责监控、控制、优化 Agent 工作时的上下文窗口使用。200K+ 上下文窗口并不意味着可以无脑塞入——研究表明达到阈值后效果反而下降（"大海捞针问题"）。

知识库原文：
> "大海捞针问题：达到阈值后效果下降 → 解法：结构化文件解析（先脚本解析，不全量读取）。"
> "渐进式披露：先给 AI 最少必要信息，根据反馈逐步补充，避免一次性塞入过多 context 导致 AI 注意力分散。"
> "打样工程：定义代码框架和规范，AI 参照打样写出风格一致的代码，产出比程序员手写更整洁。"

本子系统由四个模块组成：
- **ContextUsagePanel**：占用率监控与可视化（只读，不压缩）
- **StructuredInjector**：文件引用结构化裁剪（解决大海捞针）
- **ProgressiveDisclosure**：Skill 渐进式披露（避免一次性塞入）
- **StyleSampleInjector**：打样代码注入（引导风格一致）

## 核心概念

### 三级阈值（与 context-compaction 共享）

| 阈值 | 占用率 | 建议动作 | 状态栏提示 |
|------|--------|---------|-----------|
| `THRESHOLD_CONSIDER` | 50% | `consider-compaction` | "建议压缩" |
| `THRESHOLD_SHOULD` | 80% | `should-compact` | "建议压缩" |
| `THRESHOLD_MUST` | 90% | `must-compact` | "即将强制压缩" |
| — | <50% | `ok` | "上下文充足" |

`ContextUsagePanel` 与 `context-compaction.ts` 共享这三档阈值，但职责不同：
- `context-compaction` 负责"压缩执行"（L1-L5 压缩策略）
- `context-usage-panel` 负责"占用可视化"（只读，不压缩）

### 分项 token 占用

ContextUsageInfo.breakdown 把上下文拆为五个分项：

| 分项 | 说明 |
|------|------|
| `systemPrompt` | 系统提示词 |
| `conversationHistory` | 对话历史 |
| `toolResults` | 工具调用结果 |
| `references` | 文件引用、文档引用 |
| `skillPrompts` | Skill 注入的提示 |

按分项定位"占用大户"是优化的第一步。

### 四个模块的协作

```
用户请求
   ↓
ContextUsagePanel.calculate()  ← 监控当前占用率
   ↓ (若 references 占用过高)
StructuredInjector.injectFileReference()
   → 不全量读文件，只注入相关符号块
   ↓ (若 skillPrompts 占用过高)
ProgressiveDisclosure.getMinimalInjection()
   → 只注入 frontmatter + 核心原则 + 适用范围
   ↓ (若需引导风格)
StyleSampleInjector.injectStyleSample()
   → 注入样板代码（标注"勿照抄业务逻辑"）
   ↓
LLM 调用
```

## 使用方式

### 1. ContextUsagePanel：占用率监控

```typescript
import { ContextUsagePanel } from '../agent/context-usage-panel.js';

const panel = new ContextUsagePanel();

const info = panel.calculate({
  systemPrompt,
  conversationHistory,
  toolResults,
  references,
  skillPrompts,
  maxTokens: 200_000,
});

console.log(panel.formatStatusBar(info));
// 输出：[══════════════░░░░░░░░░░] 52% ── 建议压缩

if (info.suggestion === 'must-compact') {
  // 触发强制压缩
}
```

强制立即计算（绕过频率限制）：
```typescript
const fresh = panel.forceCalculate(params);
```

### 2. StructuredInjector：文件引用裁剪

```typescript
import { StructuredInjector } from '../cite/structured-injector.js';

const injector = new StructuredInjector({
  codeMap: {  // 依赖注入，便于测试 mock
    getFileStructure: async (path) => { /* ... */ },
    queryRelevantSymbols: async (path, ctx) => { /* ... */ },
  },
});

const result = await injector.injectFileReference(
  'src/foo.ts',
  '用户在问 bar 函数',  // 对话上下文，用于查询相关符号
  2000,                  // 注入内容的 token 上限
);

// result.injectedText: 结构概览 + 相关代码块
// result.truncated: 是否被截断
// result.totalRelevantSymbols: 截断前的符号总数
```

输出格式：
```
文件：src/foo.ts
结构概览：
  - [function] bar (L10-30)
  - [class] Baz (L35-80)
--- 相关代码块 ---
### [function] bar (L10-30)
```
function bar() { ... }
```
[已注入 1/5 个符号块，达到 token 上限，部分内容已省略]
```

### 3. ProgressiveDisclosure：Skill 渐进式披露

```typescript
import { ProgressiveDisclosure } from '../skills/progressive-disclosure.js';

const disclosure = new ProgressiveDisclosure({
  readReference: {  // 依赖注入
    readReference: async (skillName, refName) => { /* ... */ },
  },
});

// Skill 触发时只注入最小集
const minimal = disclosure.getMinimalInjection(skill);
// 包含：frontmatter 摘要 + "核心原则"章节 + "适用范围"章节 + 按需加载提示

// SkillFlow 的 step 节点需要时才加载 references
const examples = await disclosure.loadReference(skill, 'examples');
```

最小注入集只包含：
- frontmatter 摘要（name / description / version / tags）
- body 的"核心原则"章节
- body 的"适用范围"章节
- 提示语："如需更详细的内容或示例，请通过 loadReference 按需加载"

不注入："任务路由"、"模块索引"等详细章节。

### 4. StyleSampleInjector：打样代码注入

```typescript
import { StyleSampleInjector } from '../cite/style-sample-injector.js';

const injector = new StyleSampleInjector({
  readFile: async (path) => fs.readFile(path, 'utf-8'),
  codeMap: { getFileStructure: async (path) => { /* ... */ } },
  listFiles: async (dir) => { /* ... */ },
});

// 显式指定样板文件
const result = await injector.injectStyleSample('src/index.ts', 1500);

// 或自动识别样板候选
const samples = await injector.autoDetectSamples('src/');
// 返回 3-5 个"结构清晰但业务简单"的文件
```

输出格式（明确标注是"风格样本"）：
```
【风格样本：参照此文件的结构/命名/错误处理风格，勿照抄业务逻辑】
文件：src/index.ts
结构概览：App(类), main(函数)
```
（样板代码内容）
```
```

## 配置

### ContextUsagePanel 常量

| 常量 | 值 | 说明 |
|------|----|----|
| `THRESHOLD_CONSIDER` | 0.5 | 50% 开始建议压缩 |
| `THRESHOLD_SHOULD` | 0.8 | 80% 强烈建议压缩 |
| `THRESHOLD_MUST` | 0.9 | 90% 即将强制压缩 |
| `UPDATE_INTERVAL` | 3 | 每 3 轮才更新一次面板（陷阱 #144） |
| `STATUS_BAR_WIDTH` | 20 | 状态栏进度条字符数 |

### StructuredInjector 依赖注入

```typescript
interface CodeMapQueryInterface {
  getFileStructure(filePath: string): Promise<FileStructure>;
  queryRelevantSymbols(filePath: string, conversationContext: string): Promise<SymbolBlock[]>;
}
```

不直接 import code-map 模块，通过此接口注入——便于测试 mock，也避免循环依赖。

### StyleSampleInjector 自动识别优先级

陷阱 #153：优先选"结构清晰但业务简单"的文件：

| 优先级 | 文件 pattern | 示例 |
|--------|-------------|------|
| 1（入口） | `index.ts` / `main.ts` / `app.ts` | `src/index.ts` |
| 2（接口） | `types.ts` / `*.interface.ts` / `interfaces.ts` | `src/router/types.ts` |
| 3（配置） | `config.ts` / `*.config.ts` / `settings.ts` | `config.example.yaml` |

返回上限 `AUTO_DETECT_LIMIT = 5` 个候选文件。

## 陷阱

### #144：上下文占用率面板更新影响性能

200K+ 上下文的 token 计数成为瓶颈——每次 LLM 调用都扫描全量文本估算 token 会拖慢响应。

**对策**：
- `UPDATE_INTERVAL = 3`：每 3 轮才真正更新面板，未到更新轮返回上一次结果
- `tokenCache`：Map 缓存长字符串（>32 字符）的 token 估算结果，同一字符串只算一次
- 短字符串（≤32 字符）不缓存——缓存开销大于收益
- 提供 `forceCalculate()` 绕过频率限制（用户主动请求查看、上下文剧变时）

### #145：结构化注入可能遗漏关键代码

codeMap 的符号查询可能不完整（全局函数、闭包内变量、动态生成的代码）。

**对策**：
- 截断时必须显示"已注入 N/M 个符号块"，让用户知道有内容被省略
- 至少注入 1 个符号块（即使超出预算也保留第一个，保证不为空）
- 预留结构概览的 token 预算（不被符号块挤占）

### #150：渐进式披露可能导致 AI 缺少关键信息

只注入"核心原则"和"适用范围"可能让 AI 不知道完整执行流程。

**对策**：
- 最小注入集末尾必须提示"如需更详细的内容或示例，请通过 loadReference 按需加载"
- `loadReference` 是动态加载机制——AI 请求更多信息时能加载 references/ 中的文档
- SkillFlow 的 step 节点按需加载当前步骤的 reference，而非 Skill 触发时全量加载

### #153：打样注入可能让 AI 过度模仿

虽然标注"勿照抄业务逻辑"，AI 仍可能把样板业务代码原样复制。

**对策**：
- 样板优先选"结构清晰但业务简单"的文件（入口、接口、配置）
- 避免选包含复杂业务逻辑的核心模块
- 注入文本明确标注"【风格样本：参照此文件的结构/命名/错误处理风格，勿照抄业务逻辑】"
- 可选：注入后检查 AI 产出与样板的相似度，过高时警告"疑似照抄样板"

### #155b：token 估算的精度

`estimateTokensSimple` 用启发式（英文 4 字符/token，中文 2 字符/token），与实际 tokenizer 结果有偏差。

**对策**：
- 估算偏保守（CJK 用 2 字符/token 比实际更保守）
- 阈值判定留有余量（50% 阈值实际触发时可能已是 45% 真实占用）
- 关键场景（如 maxTokens 截断）用估算值再减 10% 安全边际

## 与其他模块的关系

| 模块 | 关系 |
|------|------|
| `context-compaction.ts` | 共享三级阈值；compaction 负责"压缩执行"，本模块负责"占用可视化" |
| `cite/manager.ts` | 上游：CiteManager 管理引用标签，references 分项来自这里 |
| `cite/resolver.ts` | 上游：CiteResolver 生成 preflight 的 read_file 调用（全文读取），StructuredInjector 在返回后做结构化裁剪 |
| `skills/skill-flow-engine.ts` | 下游：SkillFlow 的 step 节点用 ProgressiveDisclosure 按需加载 reference |
| `skills/attractor.ts` | 上游：吸因子的 `styleSample` 字段指定样板文件路径 |
| `evaluation/online-monitor.ts` | 互补：OnlineMonitor.monitorCost 监控 Token 日环比，本模块监控单次会话占用率 |

## 相关文档

- [SKILLFLOW.md](./SKILLFLOW.md) — SkillFlow 引擎与节点类型
- [QUALITY_GATE.md](./QUALITY_GATE.md) — Skill 质量门
- [EVALUATION.md](./EVALUATION.md) — 评估集框架与在线监控
