# Phase 32 — 接线、验证与收尾

> **版本目标：** v2.4.0
> **前置依赖：** Phase 31 完成（v2.3.0）
> **新增测试要求：** ≥ 45 个
> **蓝图引用：** BLUEPRINT.md §Agent Loop、§可观测性
> **核心哲学：** "写了不接等于没写"——Phase 31 的 8 个模块全部实现并测试，但零个接入生产路径。本 Phase 的唯一目标：**让已有的东西真正跑起来。**

---

## 背景与动机

Phase 31 设计并实现了统一工作流编排系统（TaskOrchestrator、RequirementsGatherer、ComplexityAnalyzer、ExecutionOrchestrator、UnifiedReviewer、ReadTracker、ToolResultSanitizer、CompletionGate）。代码写了、测试写了、配置项定义了、AGENTS.md 陷阱写了——但没有任何一个模块被接入 App.tsx 的分发路径。

打个比方：你造了一台新发动机（Phase 31），做了台架测试（单元测试），写了使用手册（AGENTS.md 陷阱），但忘了把它装进车里。车还是用的旧发动机。

本 Phase 同时回应审查报告的两个 Critical 发现和 Claude 的改进建议。

### 审查报告 C1/C2 总结

| 编号 | 发现 | 严重性 | 根因 |
|------|------|--------|------|
| C1 | Phase 31 的 8 个模块 100% 死代码 | Critical | 执行人只写了模块代码，未修改 App.tsx/loop.ts 等入口文件 |
| C2 | 安全防护层（ReadTracker/Sanitizer/filterSensitiveFields）全部未通电 | Critical | 同上——模块存在但无调用方 |

### 执行人质疑的实用性回应

执行人质疑"这些模块是否真的有用"。以下是每个模块对应的**真实用户场景**——如果这些场景不重要，模块可以删除；如果重要，就必须接线：

| 模块 | 如果不接线，会怎样？ | 接线后解决什么？ |
|------|----------------------|------------------|
| **TaskOrchestrator** | 用户说"重构认证模块"和"你好"走同一条路径——前者缺需求确认，后者浪费时间 | 简单问题秒回，复杂任务走全套 |
| **RequirementsGatherer** | 用户说"帮我改改那个文件"，Agent 凭猜测动手，改完发现方向不对 | Agent 先确认理解再动手 |
| **ComplexityAnalyzer** | 所有任务都串行执行，一个 5 文件重构要等 5 分钟 | 能并行的步骤并行，时间减半 |
| **ExecutionOrchestrator** | Orchestrator/WorkerExecutor/Blackboard 三个类从 Phase 14 就写好了，从未用过 | 终于用上已写好的多 Agent 基础设施 |
| **UnifiedReviewer** | Agent 说"完成了"，没有任何独立验证 | GoalVerifier + 代码审查双层验证 |
| **ReadTracker** | Agent 可以凭"印象"覆盖从未读过的文件内容 | 强制先读后写，防止盲覆盖 |
| **ToolResultSanitizer** | 恶意文件中的 "Ignore previous instructions" 直接注入 LLM | 检测注入模式并添加警告前缀 |
| **CompletionGate** | Agent 和 LLM 验证器都说"完成了"，但代码编译不过 | 独立运行 typecheck/lint/tests 兜底 |

**架构师判断：** 以上 8 个场景全部是真实风险。模块不需要删除，需要接线。

---

## Claude 建议核验与取舍

Claude 提供了 6 项改进建议（P0-1 到 P2）。逐项核验结果：

| Claude 建议 | 核验结果 | 取舍 |
|-------------|---------|------|
| **P0-1 缓存架构实测** | `cache_control` 代码在 anthropic.ts:222 存在但 `enableCache` 从未被设为 true → 死代码。六层缓存的 `CacheAwarePromptBuilder`/`CacheStatsTracker` 也未被生产代码导入。Claude 的结论正确（命中率是 0），但原因不是"没写"而是"没接" | **采纳，降为 Task 2** |
| **P0-2 Agent Eval** | TraceCollector/AuditLogger 确实存在且数据质量好。建议直接复用这些数据建 eval 集而非从零写。分类器准确率和降级链正确性是最高风险模块 | **采纳，降为 Task 3** |
| **P1-1 安全排序** | 企业微信 AES 实现符合协议规范（IV 从 Key 派生是协议要求非 bug），PKCS#7 验证严格，timing-safe 签名验证已实现。MCP schema 校验确实薄弱（只检查必填参数存在性，无类型/范围验证） | **MCP 部分采纳，放入 Task 4** |
| **P1-2 可观测性闭环** | 数据在收集中但无分析脚本。属于锦上添花，不阻塞发布 | **暂缓，放入 Future Work** |
| **P1-3 License** | AGPL-3.0 网络条款确实影响商业 SaaS 场景。但这是商业决策，不是代码任务 | **不纳入 Phase** |
| **P2 细节** | 版本号不一致已确认（MCP client 硬编码 0.8.0 vs 项目 2.3.0）。agents.md 陷阱 #22 引用了不存在的 `DeclarativeContextAcquirer` 类 | **采纳，放入 Task 4** |

---

## 接口对齐观察表

> **审计方式：** Explore Agent 对代码库逐项核实

| 接口/模块 | 已验证签名 | 所在文件:行号 | 备注 |
|-----------|-----------|-------------|------|
| App.tsx handleSubmit | `const handleSubmit = useCallback(async (text: string) => {...}, [...])` | `src/cli/App.tsx:324-384` | 5 级优先级链：tool confirm → goal confirm → 添加消息 → `/` 前缀命令 → chatRunner.runChat() |
| chatRunnerRef 调用 | `chatRunnerRef.current.runChat(text)` | `src/cli/App.tsx:383` | **这是当前唯一的非命令分发路径**，Phase 32 需改为 orchestrator.handle() |
| anthropic.ts enableCache | `if (options.enableCache)` → cache_control 逻辑 | `src/router/llm/anthropic.ts:216-228` | **enableCache 从未被设为 true**，cache_control 代码是死代码 |
| openai.ts enableCache | `if (options.enableCache)` → prompt_cache_key | `src/router/llm/openai.ts:219-222` | 同上，且 prompt_cache_key 不是标准 OpenAI 参数 |
| CacheAwarePromptBuilder | 组装稳定 system prompt，但不产生 cache_control | `src/router/cache-optimizer.ts:95-167` | 仅测试文件导入，生产代码未导入 |
| CacheStatsTracker | 追踪缓存命中统计 | `src/router/cache-optimizer.ts:225-305` | 仅测试文件导入 |
| MCP tool schema | `validateArgs()` 只检查必填参数存在性 | `src/tools/mcp/mcp-tool.ts:41-53` | 无类型/范围验证，`as unknown as ToolDefinition` 绕过类型检查 |
| MCP client version | `version: '0.8.0'` 硬编码 | `src/tools/mcp/client.ts:42` | 与项目版本 2.3.0 不一致 |
| DeclarativeContextAcquirer | **不存在** | — | agents.md 陷阱 #22 引用了一个不存在的类 |
| Phase 31 模块导入情况 | 8 个模块零生产导入 | 各模块文件 | 详见审查报告 |

### Phase 31 接口对齐表修正项

以下声明在 Phase 31 文档中已过时或不准确，本 Phase 需在接线时同步修正：

| Phase 31 声明 | 实际情况 | 修正 |
|---|---|---|
| CommandRegistry "26 个命令，3 个未注册" | 29 个全部已注册 | 改为 "29 个已注册命令" |
| HookRunner.fire() 在 hooks.ts:150，4 事件 | fire() 在 line 197，8 事件 | 更新行号和事件数 |
| GoalParser.parse() 在 goal-parser.ts:37 | parse() 在 line 54 | 更新行号 |
| GoalVerifier.verify() 签名 `(plan, gates, stepResults)` | 实际签名 `(plan, options: GoalVerifierOptions, gates?)` | 更新签名 |
| checkBudget() 在 tracker.ts:133-158，只检查 dailyLimit | 实际在 lines 179-218，同时检查 dailyLimit 和 perRequestLimit | 更新行号和描述 |

---

## Task 1：Phase 31 模块接线（C1/C2 修复）

> **比喻：** 发动机造好了，现在要把它装进车里——连接油门（App.tsx 入口）、排气管（loop.ts 工具注入路径）、仪表盘（UI 状态显示）、油箱（Token 预算）。

### 1.1 TaskOrchestrator 接入 App.tsx

**当前代码（App.tsx:382-383）：**
```
// 当前：所有非命令输入直接走 ChatRunner
chatRunnerRef.current.runChat(text);
```

**改为：**
```
// Phase 32：先经过 TaskOrchestrator 分发
if (deps.config.optimization?.workflow?.unifiedPipeline !== false) {
  const action = await orchestrator.handle(text);
  await dispatchOrchestratorAction(action);
} else {
  // 回退路径：unifiedPipeline 为 false 时保持当前行为
  chatRunnerRef.current.runChat(text);
}
```

**`dispatchOrchestratorAction` 函数**根据 `action.type` 分发：
- `direct_chat` → 调用 `chatRunner.runChat(action.input)`
- `pipeline_start` → 启动流水线，UI 显示分析状态
- `requirements_question` → 显示需求确认 UI
- `plan_ready` → 打开 StepEditor
- `execution_progress` → 流式渲染进度
- `review_result` / `completed` → 显示结果

**关键接入点：**
- `app-init.ts` 的 `createAppDependencies()` 需要实例化 `TaskOrchestrator` 并传入所有依赖
- `ServiceContext` 中的 `orchestrator` 字段已存在（line 171），只需确保实例化参数正确
- App.tsx 的 `handleSubmit` 需要获取 orchestrator 实例（通过 deps 传入或 ref 引用）

### 1.2 ToolResultSanitizer 接入 loop.ts

**当前代码（loop.ts 工具结果注入）：**
并行路径（lines 307-329）和串行路径（lines 444-452）直接将 `toolResult` 字符串注入 `messages`。

**改为：**
在注入前调用 `sanitizer.sanitize(toolName, toolResult)`：
```
// 在 loop.ts 的 toolResult 注入点前：
const sanitized = sanitizer.sanitize(toolCall.toolName, toolResult);
// 注入 sanitized.content 而非原始 toolResult
```

**ToolResultSanitizer 实例来源：**
- 在 `ReActAgentLoop` 构造函数中新增可选参数 `sanitizer?: ToolResultSanitizer`
- `ToolRegistryAdapter` 创建 loop 时传入 sanitizer
- 如果 sanitizer 为 undefined，跳过净化（向后兼容）

### 1.3 ReadTracker 接入工具执行路径

**方案：** 通过 `GuardedToolExecutorAdapter` 层接入（而非修改每个工具内部）。

**在 `GuardedToolExecutorAdapter.executeTool()` 中：**
```
// 工具执行前：检查 read-before-write
if (toolName === 'file_write' || toolName === 'file_edit') {
  const writeCheck = readTracker.checkWriteAllowed(args.path);
  if (!writeCheck.allowed) {
    return writeCheck.reason;  // 返回拦截消息，不执行工具
  }
}

// 执行工具...
const result = await inner.executeTool(toolName, callId, args);

// 工具执行后：记录读取
if (toolName === 'file_read') {
  readTracker.markRead(args.path);
}
```

**优势：** 不需要修改 file_write/file_read/file_edit 的源代码，在适配器层统一处理。

**新建文件例外：** `checkWriteAllowed()` 内部已通过 `fs.access()` 检查文件存在性，不存在的文件直接放行。

### 1.4 CompletionGate 接入审查流程

**接入点：** 在 goal-runner 的验证阶段（lines 284-338），GoalVerifier.verify() 之后追加 CompletionGate 检查：

```
// goal-runner.ts 验证阶段，在 GoalVerifier.verify() 之后：
if (config.optimization?.safety?.completionGate !== false) {
  const gateResult = await completionGate.verify({
    modifiedFiles: plan.steps.flatMap(s => s.modifiedFiles || []),
    projectPath: cwd,
    planDescription: plan.description,
  });
  if (!gateResult.passed) {
    // 将失败信息送回 Agent 修复（最多重试 1 次）
    const failedChecks = gateResult.checks.filter(c => !c.ok).map(c => c.name).join(', ');
    addSystemMessage(`⚠️ 代码验证未通过：${failedChecks}。正在尝试修复...`);
    // 注入失败信息让 Agent 自行修复
  }
}
```

### 1.5 Task 级 Token 预算激活

**当前问题：** `TokenTracker` 的 `startTask()`/`recordTaskUsage()`/`endTask()` 从未被调用。且 `record()` 和 `recordTaskUsage()` 各自独立累加 `taskSpent`，存在双计数 bug。

**修复双计数：** 在 `record()` 方法中（tracker.ts:97-99），当 `taskActive` 为 true 时，**不**累加 taskSpent（由 `recordTaskUsage()` 单独负责）：
```
record(usage, metadata) {
  // ... 现有逻辑 ...
  if (this.taskActive) {
    // 删除这行：this.taskSpent += usage.totalTokens;
    // taskSpent 由 recordTaskUsage() 统一管理
  }
}
```

**接入点：**
- `TaskOrchestrator` 在 `pipeline_start` 时调用 `tracker.startTask(budget)`
- `chat-runner.ts` 和 `goal-runner.ts` 在每次 `tracker.record()` 后调用 `tracker.recordTaskUsage(usage)`
- `TaskOrchestrator` 在完成/中止时调用 `tracker.endTask()`

### 1.6 filterSensitiveFields 接入

**接入点：** 在 `ToolResultSanitizer.sanitize()` 内部调用（在注入检测之后）：
```
sanitize(toolName, result) {
  let content = result;
  // 1. 智能截断（如果超过 16000 字符）
  // 2. 注入模式检测
  // 3. 敏感字段脱敏（新增）
  try {
    const parsed = JSON.parse(content);
    content = JSON.stringify(filterSensitiveFields(parsed));
  } catch {
    // 非 JSON 内容跳过脱敏
  }
  return { content, injectionDetected, ... };
}
```

### 验收标准

- [ ] App.tsx 的 handleSubmit 通过 TaskOrchestrator 分发（unifiedPipeline 为 true 时）
- [ ] `unifiedPipeline: false` 时回退到当前行为（向后兼容）
- [ ] quick_answer 短路直达 ChatRunner，无额外 LLM 调用
- [ ] development 意图走完整流水线（需求确认 → 分解 → 执行 → 审查）
- [ ] ToolResultSanitizer 在 loop.ts 的并行和串行路径均生效
- [ ] ReadTracker 拦截对未读文件的写入，放行新建文件
- [ ] CompletionGate 在 goal 验证阶段运行 typecheck/lint/tests
- [ ] TokenTracker 的 startTask/recordTaskUsage/endTask 被正确调用，无双计数
- [ ] filterSensitiveFields 在 ToolResultSanitizer 内被调用
- [ ] ≥ 15 个接线集成测试

---

## Task 2：缓存架构激活与实测

> **来源：** Claude P0-1 建议。
> **比喻：** 你设计了一套省油方案（六层缓存架构），但省油开关（enableCache）从来没打开过。现在要打开开关，跑一圈看看省了多少。

### 2.1 激活 enableCache

**当前问题：** `anthropic.ts:216` 和 `openai.ts:219` 的 `enableCache` 分支从未执行，因为所有 LLM 调用方都不传 `enableCache: true`。

**解决方案：** 在 `ModelRouter.route()` 返回的 `RoutingResult` 中新增 `enableCache: true` 字段。这样所有通过路由器发起的 LLM 调用自动启用缓存：

```
// src/router/router.ts 的 route() 方法：
return {
  // ... 现有字段 ...
  enableCache: true,  // Phase 32：全局启用 prompt 缓存
};
```

然后在 `chat-runner.ts` 和 `goal-runner.ts` 构建 LLM 请求选项时：
```
const options: LLMRequestOptions = {
  // ... 现有字段 ...
  enableCache: routeDecision.enableCache,
};
```

### 2.2 Anthropic cache_control 优化

**当前实现（anthropic.ts:214-228）** 只在 system prompt 上加了 `cache_control`。对于 Anthropic 缓存最大化，应在 tools 定义上也加标记：

```
// 在 anthropic.ts 的 buildRequestParams() 中：
if (options.enableCache && options.tools?.length) {
  params.tools = options.tools.map(tool => ({
    ...tool,
    cache_control: { type: 'ephemeral' },
  }));
}
```

### 2.3 CacheAwarePromptBuilder 接入

**当前问题：** `CacheAwarePromptBuilder` 组装稳定 system prompt 的逻辑（cache-optimizer.ts:95-167）只在测试中使用。生产代码中 `PromptTemplateManager.render()` 的输出直接作为 system prompt，不经过 CacheAwarePromptBuilder 的稳定化处理。

**解决方案：** 在 `chat-runner.ts` 构建 systemPrompt 时，通过 CacheAwarePromptBuilder 包装：
```
const rawPrompt = systemPromptRef.current;
const stablePrompt = CacheAwarePromptBuilder.buildStablePrefix({
  basePrompt: rawPrompt,
  // 其他稳定组件...
});
```

### 2.4 CacheStatsTracker 接入

**接入点：** 在 `TokenTracker.record()` 中增加缓存命中统计：
```
record(usage, metadata) {
  // ... 现有逻辑 ...
  if (this.cacheStatsTracker) {
    this.cacheStatsTracker.recordTurn({
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadInputTokens || 0,
      cacheCreationTokens: usage.cacheCreationInputTokens || 0,
    });
  }
}
```

### 2.5 逐层验证测试

按 Claude 建议的六层清单，编写验证测试：

| 层 | 测试方法 | 通过标准 |
|----|----------|----------|
| L1 稳定前缀 | 同一会话连续 5 轮，比较 system prompt 原始 bytes | 完全一致 |
| L2 变更走 user message | 触发 work mode 切换，system 哈希不变 | system 不变 |
| L3 压缩阈值 | 灌入长上下文，观察 50%/80%/90% 触发点 | 误差 <2% |
| L4 Shape 哈希 | 只改 tools 不改 system，诊断信息精准 | 诊断一致 |
| L5 计数器 | 触发压缩后 CacheStatsTracker 连续 | 计数连续 |
| L6 绝对值展示 | 大量新内容轮次的 UI 显示 | 显示绝对值 |

### 验收标准

- [ ] `enableCache` 在路由决策中全局启用
- [ ] Anthropic 请求的 system prompt 和 tools 均带 `cache_control` 标记
- [ ] CacheAwarePromptBuilder 在生产路径中处理 system prompt
- [ ] CacheStatsTracker 记录缓存命中数据
- [ ] 六层验证测试全部通过
- [ ] ≥ 10 个测试

---

## Task 3：Agent 行为 Eval 最小版本

> **来源：** Claude P0-2 建议。
> **比喻：** 你现在有了仪表盘（TraceCollector + AuditLogger），能看到各种数据。但你只是看着数据，从来没根据数据做过调整。Eval 就是把"看数据"变成"验证行为"的系统。

### 3.1 分类器准确率 Eval

**方法：** 创建黄金测试集（golden dataset），包含 30-50 个用户输入 + 预期 tier 标注。

**新建 `tests/eval/classifier-golden.json`：**
```
[
  { "input": "你好", "expected": "simple", "note": "问候语" },
  { "input": "重构认证模块，改用 JWT", "expected": "complex", "note": "多文件重构" },
  { "input": "读一下 config.yaml", "expected": "simple", "note": "单文件读取" },
  { "input": "帮我规划下个月的开发路线", "expected": "reasoning", "note": "规划类" },
  ...
]
```

**测试代码：**
```
describe('Classifier Eval', () => {
  const dataset = loadGoldenDataset('classifier');
  for (const case of dataset) {
    it(`正确分类: ${case.note}`, async () => {
      const result = await classifier.classify({ query: case.input });
      expect(result.tier).toBe(case.expected);
    });
  }
});
```

### 3.2 降级链正确性 Eval

**方法：** 模拟 provider apiKey 逐级缺失，验证降级路径：

```
describe('Degradation Chain Eval', () => {
  it('reasoning tier → 主模型可用时直接使用', ...);
  it('reasoning tier → 主模型不可用 → fallback 模型', ...);
  it('reasoning tier → 主+fallback 不可用 → 降级到 complex', ...);
  it('所有 provider 不可用 → 强制最低模型或抛出', ...);
  it('apiKey 为 placeholder → isModelAvailable 返回 false', ...);
});
```

### 3.3 ConflictDetector 盲区记录

不修复语义冲突检测（那是大工程），但将已知盲区写入 eval 集作为回归保护：

```
describe('ConflictDetector Known Blind Spots', () => {
  it('不同文件但语义冲突 → 当前检测不到（已知限制）', () => {
    const stepA = { likelyFiles: ['utils.ts'], description: '修改 getUser 签名' };
    const stepB = { likelyFiles: ['service.ts'], description: '调用 getUser' };
    const result = detector.detect(stepA, stepB);
    // 当前行为：hasConflict === false（已知限制，记录为 eval case）
    expect(result.hasConflict).toBe(false);
  });
});
```

### 验收标准

- [ ] 分类器黄金测试集 ≥ 30 条，覆盖率 ≥ 80%
- [ ] 降级链测试覆盖所有 5 级降级路径
- [ ] ConflictDetector 盲区以 eval case 形式记录
- [ ] ≥ 8 个测试

---

## Task 4：安全加固与细节修复

### 4.1 MCP 工具 Schema 校验

**当前问题：** `MCPTool.validateArgs()` 只检查必填参数是否存在，无类型验证。`mcp-tool.ts:31` 使用 `as unknown as ToolDefinition` 绕过类型检查。

**修复：** 新增基本的类型校验：
```
validateArgs(args) {
  const errors = [];
  const schema = this.definition.parameters;
  
  // 1. 必填参数存在性检查（现有）
  // 2. 类型检查（新增）
  for (const [key, value] of Object.entries(args)) {
    const propSchema = schema.properties?.[key];
    if (propSchema?.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== propSchema.type && propSchema.type !== 'any') {
        errors.push(`参数 ${key} 期望类型 ${propSchema.type}，实际为 ${actualType}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
```

### 4.2 MCP 工具描述注入检测

**来源：** Claude P1-1 建议——"恶意 MCP server 完全可以在工具描述里塞入对 LLM 的指令注入。"

**方案：** MCP 工具的 description 在注册到 ToolRegistry 前，过一遍 ToolResultSanitizer 的注入模式检测：
```
// mcp/client.ts 的 discoverTools() 中：
for (const tool of discoveredTools) {
  const sanitizedDesc = sanitizer.sanitize('mcp_description', tool.description);
  if (sanitizedDesc.injectionDetected) {
    logger.warn(`MCP tool ${tool.name} description 中检测到注入模式，已跳过注册`);
    continue;
  }
  registry.register(new MCPTool(tool, client));
}
```

### 4.3 MCP Client 版本号修复

**文件：** `src/tools/mcp/client.ts:42`
**当前：** `version: '0.8.0'` 硬编码
**改为：** 从 `package.json` 读取或使用配置值

### 4.4 agents.md 陷阱 #22 修正

**当前：** 引用了不存在的 `DeclarativeContextAcquirer` 类
**修正：** 删除对 `DeclarativeContextAcquirer` 的引用，或标注为"计划中但未实现的类"

### 4.5 goal-runner 添加 checkBudget()

**文件：** `src/cli/goal-runner.ts`
**修复：** 在每步执行后调用 `tracker.checkBudget()`，与 chat-runner.ts 保持一致

### 4.6 chat-runner 传 context 给 classifier

**文件：** `src/cli/chat-runner.ts:73`
**当前：** `classifier.classify({ query: text })`
**改为：** `classifier.classify({ query: text, context: { projectType, recentTools, hasGitChanges } })`

### 验收标准

- [ ] MCP 工具参数类型校验生效
- [ ] MCP 工具描述注入检测生效
- [ ] MCP client 版本号与项目一致
- [ ] agents.md 陷阱 #22 修正
- [ ] goal-runner 调用 checkBudget()
- [ ] chat-runner 传 context 给 classifier
- [ ] ≥ 8 个测试

---

## Task 5：集成测试与文档同步

### 5.1 端到端接线验证测试

1. **统一流水线冒烟测试：** 输入一个 medium 复杂度请求 → 验证经过 TaskOrchestrator → RequirementsGatherer → ComplexityAnalyzer → ExecutionOrchestrator → UnifiedReviewer 全链路
2. **quick_answer 短路测试：** 输入 "你好" → 验证直达 ChatRunner，不进入流水线
3. **unifiedPipeline 开关测试：** 设为 false → 验证回退到当前行为
4. **ReadTracker 拦截测试：** Agent 未读文件就写 → 验证被拦截
5. **ToolResultSanitizer 注入检测测试：** 构造含注入模式的工具返回 → 验证警告前缀
6. **CompletionGate 验证测试：** 模拟 typecheck 失败 → 验证不信任 LLM 的"完成"判断
7. **Token 预算熔断测试：** 模拟 80%/100% 预算 → 验证警告和中止
8. **缓存启用冒烟测试：** 验证 enableCache 被正确传递到 LLM client
9. **Steering Queue 测试：** Agent 执行时用户输入 → 验证排队和交付

### 5.2 文档同步

- **`AGENTS.md`**：
  - 更新陷阱 #23-34 的描述，反映实际接线状态（而非计划中的状态）
  - 新增 Phase 32 陷阱：
    - "enableCache 通过 RoutingResult 全局启用，不需要每个调用方单独设置"
    - "ToolResultSanitizer 同时承担注入检测、智能截断和敏感字段脱敏三项职责"
    - "MCP 工具的 description 在注册前过注入检测，恶意 MCP server 的工具会被跳过"
- **`CODEMAP.md`**：无新文件（Phase 31 模块已在 Phase 31 添加）
- **`CHANGELOG.md`**：新增 v2.4.0 条目
- **`config.example.yaml`**：无需修改（Phase 31 已添加 workflow/safety 配置项）
- **`package.json`**：版本号 v2.3.0 → v2.4.0

### 验收标准

- [ ] 全部集成测试通过
- [ ] AGENTS.md 陷阱描述与实际代码一致
- [ ] 文档更新完成
- [ ] 全量测试零失败
- [ ] ≥ 4 个测试

---

## 执行顺序

```
Task 1（接线）  ─── 最优先，是后续所有任务的前提
    │
    ├── Task 2（缓存激活）  ─── 可与 Task 1 并行（修改不同文件）
    ├── Task 4（安全+细节）  ─── 可与 Task 1 并行
    │
Task 3（Eval）  ─── 依赖 Task 1 完成后才能在真实路径上 eval
    │
Task 5（集成测试）  ─── 最后做
```

---

## 测试要求汇总

| Task | 最低测试数 | 重点测试场景 |
|------|-----------|------------|
| 1 | 15 | App.tsx 分发、ToolResultSanitizer 注入、ReadTracker 拦截、CompletionGate 运行、Token 预算 |
| 2 | 10 | enableCache 传递、cache_control 标记、CacheAwarePromptBuilder 稳定前缀、六层验证 |
| 3 | 8 | 分类器黄金集、降级链、ConflictDetector 盲区记录 |
| 4 | 8 | MCP schema 校验、MCP 描述注入检测、goal-runner checkBudget、classifier context |
| 5 | 4 | 端到端冒烟、回退兼容、文档一致性 |
| **合计** | **≥ 45** | |

---

## Future Work（本 Phase 不做）

以下是 Claude 建议中暂缓的项目，记录以备后续：

- **可观测性数据利用闭环（P1-2）：** 编写离线分析脚本，定期扫描 token-logs/ 和 decisions.log。当前数据收集正常，分析可后续补上。
- **License 确认（P1-3）：** AGPL-3.0 对商业化 SaaS 场景的影响。这是商业决策，需架构师自行判断。
- **安全维护优先级排序（P1-1）：** 企业微信 AES fuzz 测试、shell 黑名单定期复盘。当前安全实现质量高，可按需逐步增强。
- **语义冲突检测：** ConflictDetector 当前只检查文件路径，不检查语义冲突。已在 eval 中记录为已知盲区。
