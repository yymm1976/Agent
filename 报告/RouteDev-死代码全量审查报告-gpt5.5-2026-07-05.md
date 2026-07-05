# RouteDev 死代码/未接入模块全量审查报告（gpt5.5审查）

审查时间：2026-07-05  
审查对象：`C:\Users\杨铭\Desktop\Agent\routedev`  
审查模式：全量审查，重点关注未被介入、未被生产路径调用、功能残缺或未开启的死代码模块  
审查标识：gpt5.5审查

## 审查总结

RouteDev 当前并非单纯“有少量未用导出”的问题，而是存在若干生产入口、配置开关与运行时接线不一致的结构性死代码风险。最严重的是 CLI 入口仍指向已不存在的 `src/index.tsx`，这会使 `pnpm build` / `pnpm start` / npm bin 这条生产形态不可用；另外 Phase 49/68/69/70 的部分模块属于“有配置、有实例、无生产效果”或“观测-only”的半接入状态。结论：**不建议直接发布；需先修复 Critical，并对 Important 中的僵尸配置和半接入模块做取舍或补接线。**

> 验证限制：当前执行环境中 `pnpm` 不在 PATH，运行 `pnpm run detect-dead-code` 失败，无法在本机完成项目脚本级验证。本文结论基于仓库文件、构建配置、生产入口、运行时装配链、执行编排链与代码搜索的静态全量审查。

## 审查范围与方法

- 识别项目类型：TypeScript/JavaScript，Node.js 20+，Electron + React，tsup/electron-vite 构建。
- 核对入口：`package.json`、`tsup.config.ts`、`electron.vite.config.mjs`、Desktop `engine-bridge`、`createAppDependencies`。
- 核对生产链：Desktop 主进程 → `RouteDevEngine` → `createAppDependencies` → `TaskOrchestrator` / `ExecutionOrchestrator` / `createGoalRunner`。
- 核对配置链：`src/config/defaults.ts`、`src/config/schema.ts` 与实际读取点。
- 核对死代码方向：未存在文件、未公开页面入口、仅 defaults/schema 出现的字段、仅构造/返回但无主流程消费的模块、只记录日志不改变结果的观测-only 接线。

---

## Critical（提交前必须修）

### C1. CLI 生产入口指向不存在的 `src/index.tsx`，导致 CLI 构建/启动链路断裂

位置：
- [package.json:L7-L9](file:///c:/Users/杨铭/Desktop/Agent/routedev/package.json#L7-L9)
- [package.json:L15-L19](file:///c:/Users/杨铭/Desktop/Agent/routedev/package.json#L15-L19)
- [tsup.config.ts:L11-L13](file:///c:/Users/杨铭/Desktop/Agent/routedev/tsup.config.ts#L11-L13)
- [ARCHITECTURE.md:L220-L224](file:///c:/Users/杨铭/Desktop/Agent/routedev/docs/ARCHITECTURE.md#L220-L224)

证据：

```json
"bin": {
  "routedev": "./dist/index.js"
}
```

```json
"scripts": {
  "build": "tsup",
  "dev": "tsup --watch",
  "start": "node dist/index.js"
}
```

```ts
export default defineConfig({
  entry: ['src/index.tsx'],
```

但实际 `src/index.tsx` 不存在，且 `src/` 下没有入口文件；同时架构文档明确 Phase 72 后“终端 UI 退役，desktop 成为唯一前端”。这说明项目已经收敛到 Desktop 生产形态，但包级 CLI 构建与启动脚本仍保留旧入口。

为什么重要：
- `pnpm build` 会尝试从不存在的入口构建。
- `pnpm start` 与 npm bin 依赖 `dist/index.js`，而该产物来自不存在的源入口。
- 这不是普通死代码，而是发布/安装后用户可触达的生产入口静默失效。

建议修复方向：二选一，必须明确产品形态。

```json
{
  "scripts": {
    "build": "electron-vite build",
    "start": "electron ."
  }
}
```

或恢复一个真实 CLI 入口并让它只做受支持的事情，例如打印 Desktop 迁移提示、启动 Electron、或转发到正式 runtime API。

---

## Important（继续前建议修）

### I1. Phase 69 `parallelExecution.enabled/maxConcurrency` 是僵尸开关，实际并发控制仍读取 `execution.maxConcurrency`

位置：
- [defaults.ts:L917-L929](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L917-L929)
- [execution-orchestrator.ts:L618-L625](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts#L618-L625)

证据：

```ts
phase69Integration: {
  parallelExecution: {
    enabled: false,
    maxConcurrency: 3,
    workerTimeoutMs: 10 * 60 * 1000,
  },
}
```

```ts
const maxConcurrency = this.deps.config?.execution?.maxConcurrency ?? 3;
const semaphore = new Semaphore(maxConcurrency);
```

为什么重要：
用户如果启用或调整 `phase69Integration.parallelExecution`，生产执行链不会采用该配置。该字段看起来控制 Phase 69 并行执行，实际上没有效果，属于典型“功能开关存在但未接入”的死配置。

建议修复：

```ts
const phase69Parallel = this.deps.config?.phase69Integration?.parallelExecution;
const maxConcurrency = phase69Parallel?.enabled
  ? phase69Parallel.maxConcurrency
  : this.deps.config?.execution?.maxConcurrency ?? 3;
const workerTimeoutMs = phase69Parallel?.enabled
  ? phase69Parallel.workerTimeoutMs
  : this.deps.config?.execution?.workerTimeoutMs ?? 300_000;
```

---

### I2. Phase 69 `ResultComparator` 被实例化并执行比较，但比较结果只写日志，不参与结果选择

位置：
- [defaults.ts:L930-L933](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L930-L933)
- [app-init.ts:L1993-L2016](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L1993-L2016)
- [execution-orchestrator.ts:L974-L993](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts#L974-L993)
- [execution-orchestrator.ts:L1013-L1041](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts#L1013-L1041)

证据：

```ts
if (p69Cfg.resultComparator) {
  p69ResultComparator = new ResultComparator({
    ...DEFAULT_COMPARATOR_CONFIG,
    autoSelect: p69Cfg.resultComparator.autoSelect,
```

```ts
const comparison = this.deps.resultComparator.compare(outcomes);
logger.info('Phase 69: ResultComparator 结果比较', {
  winnerId: comparison.winnerId,
  reason: comparison.reason,
  needsHumanReview: comparison.needsHumanReview,
});
```

随后所有 `workerResults` 仍被逐个加入最终 `results`：

```ts
for (let i = 0; i < workerResults.length; i++) {
  const wr = workerResults[i];
  results.push({
    stepId: wr.stepId,
    success: wr.success,
    conclusion: wr.conclusion,
```

为什么重要：
`ResultComparator` 的核心价值应是仲裁、排序或自动选择最优结果；当前实现只是观测日志。用户看到 `autoSelect` 和权重配置，会误以为比较器已经影响执行结果，但生产行为没有变化。

建议修复：

```ts
const comparison = this.deps.resultComparator.compare(outcomes);
const selectedWorkerIds = comparison.winnerId && this.deps.config?.phase69Integration?.resultComparator?.autoSelect
  ? new Set([comparison.winnerId])
  : new Set(outcomes.map(o => o.workerId));
const effectiveWorkerResults = workerResults.filter(wr =>
  selectedWorkerIds.has(`worker-${wr.stepId}-${wr.role}`),
);
```

若暂不打算让它影响行为，应把配置与日志文案改为“diagnosticComparator”或明确标注只观测。

---

### I3. Phase 69 `CLIAdapterRegistry` 可启用并注册 Claude Code Adapter，但不会用于执行 Worker

位置：
- [defaults.ts:L934-L940](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L934-L940)
- [app-init.ts:L2017-L2027](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L2017-L2027)
- [execution-orchestrator.ts:L643-L651](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts#L643-L651)
- [execution-orchestrator.ts:L1104-L1117](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts#L1104-L1117)

证据：

```ts
if (p69Cfg.cliAdapters?.enabled) {
  p69CliAdapterRegistry = new CLIAdapterRegistry();
  const claudeCodeAdapter = new ClaudeCodeAdapter({
    ...DEFAULT_CLAUDE_CODE_CONFIG,
```

实际执行仍固定走内部 `WorkerExecutor`：

```ts
return await workerExecutor.execute(
  task,
  llmClient,
  routeDecision,
```

而 CLI Adapter 阶段只列出适配器并记录日志：

```ts
const adapters = this.deps.cliAdapterRegistry.list();
logger.info('Phase 69: CLIAdapterRegistry 适配器状态', {
  registeredAdapters: adapters.length,
  adapterNames: adapters.map(a => a.name),
});
```

为什么重要：
这是“UI/配置可开启，但生产路径不执行”的功能残缺。启用 `cliAdapters.enabled` 后不会把任务交给 Claude Code 等外部 CLI，用户会得到与开关含义不一致的行为。

建议修复：

```ts
const adapter = this.deps.cliAdapterRegistry?.select?.(task.role);
if (adapter) {
  return await adapter.execute(task, {
    conversationHistory,
    routeDecision,
    signal: workerController.signal,
  });
}
return await workerExecutor.execute(...);
```

---

### I4. Phase 68 模块默认全关闭；启用后只创建对象并返回依赖，未发现主流程消费点

位置：
- [defaults.ts:L887-L915](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L887-L915)
- [app-init.ts:L2808-L2875](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L2808-L2875)

证据：

```ts
phase68Integration: {
  operationClassification: { enabled: false },
  provenanceGraph: { enabled: false },
  rejectedAlternativeStore: { enabled: false },
  kanObstacleChecker: { enabled: false },
  quantitativeGate: { enabled: false },
}
```

```ts
if (p68Cfg.quantitativeGate?.enabled) {
  const quantitativeGate = new QuantitativeGate({
    enabled: p68Cfg.quantitativeGate.enabled,
```

这些对象最终只是放入 `AppDependencies`：

```ts
return result as Partial<AppDependencies>;
```

在审查范围内没有看到 `provenanceGraph` / `agentRejectedAlternativeStore` / `kanObstacleChecker` / `quantitativeGate` 被 `goal-runner`、`task-orchestrator` 或 `execution-orchestrator` 主流程调用。

为什么重要：
这类模块不是传统未导入死代码，而是“半接入模块”：开关、构造、日志都存在，但不会改变执行、路由、验证或阻断策略。尤其 `quantitativeGate.blockOnObstacle` 这类语义如果未来出现在配置/UI 中，会让用户误以为有硬门控。

建议修复：
- 若确认为实验保留：从默认配置主路径移到 `experimental` 命名空间，并在 UI/文档明确“仅构造，未参与执行”。
- 若要接入生产：把 `quantitativeGate` 接入 `CompletionGate` 或 `UnifiedReviewer`，把 `kanObstacleChecker` 接入计划/执行前门控，把 `provenanceGraph` 接入工具结果、文件变更和引用追踪。

---

### I5. Phase 49 多个字段只存在于 schema/defaults，没有生产读取点

位置：
- [schema.ts:L1420-L1439](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts#L1420-L1439)
- [defaults.ts:L499-L507](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L499-L507)

涉及字段：
- `phase49Integration.skillFlowEnabled`
- `phase49Integration.contextUsagePanelEnabled`
- `phase49Integration.evaluationFrameworkEnabled`

证据：

```ts
const Phase49IntegrationConfigSchema = z.preprocess((v) => v ?? {}, z.object({
  skillFlowEnabled: z.boolean().default(false),
  dualLoopEnabled: z.boolean().default(true),
  qualityGateEnabled: z.boolean().default(true),
  contextUsagePanelEnabled: z.boolean().default(false),
  evaluationFrameworkEnabled: z.boolean().default(false),
}));
```

代码搜索显示这些字段除 `schema.ts` / `defaults.ts` 外没有生产读取点；相对地，`dualLoopEnabled` 有实际接线：

- [app-init.ts:L2448-L2492](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L2448-L2492)

为什么重要：
这是僵尸配置。特别是字段注释称“SkillFlow 引擎接入”“上下文占用率面板接入”“评估集框架接入”，但实际运行时不读取，会误导配置用户和维护者。

建议修复：
- 如果模块已删除，移除 schema/defaults 字段，并写迁移说明。
- 如果模块仍计划接入，至少在 `createAppDependencies` 或相关 manager 中读取并明确 fail-open 日志。

---

### I6. `boundedRecovery` 存在顶层与 `phase52Integration.boundedRecovery` 双配置，生产只消费后者

位置：
- [defaults.ts:L574-L600](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L574-L600)
- [schema.ts:L1601-L1601](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts#L1601-L1601)
- [schema.ts:L2022-L2022](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts#L2022-L2022)
- [app-init.ts:L2458-L2470](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L2458-L2470)
- [app-init.ts:L2523-L2528](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L2523-L2528)

证据：

```ts
boundedRecovery: {
  enabled: true,
  maxBacktrack: 3,
  artifactBinding: true,
  validateConsistency: true,
},
phase52Integration: {
  boundedRecovery: { enabled: true, maxBacktrack: 3, artifactBinding: true, validateConsistency: true },
}
```

实际注入只读：

```ts
if (config.phase52Integration?.boundedRecovery?.enabled) {
  orchestrator.setBoundedRecovery(config.phase52Integration.boundedRecovery);
```

为什么重要：
用户修改顶层 `boundedRecovery` 时不会影响生产行为，容易造成“我已开启/调整但不生效”的配置错觉。双配置也会增加后续维护者误接线概率。

建议修复：

```ts
const boundedRecoveryConfig = config.phase52Integration?.boundedRecovery ?? config.boundedRecovery;
if (boundedRecoveryConfig?.enabled) {
  orchestrator.setBoundedRecovery(boundedRecoveryConfig);
}
```

更彻底的做法是删除顶层字段，仅保留聚合配置并提供迁移。

---

### I7. Phase 67 `EpistemicPreservingSummarizer` 默认启用，但执行链只记录“就绪”，没有实际调用

位置：
- [defaults.ts:L879-L882](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L879-L882)
- [app-init.ts:L2048-L2053](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L2048-L2053)
- [execution-orchestrator.ts:L1087-L1102](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/execution-orchestrator.ts#L1087-L1102)

证据：

```ts
epistemicPreservingSummarizer: {
  enabled: true,
  maxTokens: 500,
},
```

```ts
logger.info('Phase 67: EpistemicPreservingSummarizer 就绪', {
  successfulSteps: successfulResults.length,
  maxTokens: this.deps.config.reasoningQualityDiagnostics.epistemicPreservingSummarizer.maxTokens,
});
```

为什么重要：
默认启用会让人以为“认知保留摘要”已经参与生产链路，但当前只记录 readiness log，没有摘要、压缩、校验或回写结果。这是默认开启的功能残缺，优先级高于普通实验开关。

建议修复：

```ts
const summary = await this.deps.epistemicPreservingSummarizer.summarize(
  successfulResults.map(r => r.conclusion).join('\n\n'),
  { maxTokens: this.deps.config.reasoningQualityDiagnostics.epistemicPreservingSummarizer.maxTokens },
);
this.deps.addSystemMessage?.(summary.content);
```

如果当前类没有对应方法，应把配置默认值改为 `false` 并标注未接入。

---

### I8. Desktop `TokenPage` / `TracePage` 有渲染分支，但当前 Layout 没有公开导航入口

位置：
- [App.tsx:L23-L26](file:///c:/Users/杨铭/Desktop/Agent/routedev/desktop/renderer/src/App.tsx#L23-L26)
- [App.tsx:L248-L263](file:///c:/Users/杨铭/Desktop/Agent/routedev/desktop/renderer/src/App.tsx#L248-L263)
- [Layout.tsx:L13-L22](file:///c:/Users/杨铭/Desktop/Agent/routedev/desktop/renderer/src/components/Layout.tsx#L13-L22)
- [Layout.tsx:L127-L133](file:///c:/Users/杨铭/Desktop/Agent/routedev/desktop/renderer/src/components/Layout.tsx#L127-L133)

证据：

```ts
type PageId = 'chat' | 'newtask' | 'settings' | 'token' | 'trace';
```

```tsx
{page === 'token' && <TokenPage {...routeDev} />}
{page === 'trace' && <TracePage {...routeDev} />}
```

但 `LayoutProps` 只暴露：

```ts
onOpenSettings: () => void;
onOpenNewTask: (projectId?: string) => void;
onNavigateToChat: () => void;
```

为什么重要：
`TokenPage` / `TracePage` 不是未编译代码，但从当前主 UI 状态看没有进入路径。页面代码会持续腐化，用户也无法访问相关功能。若另有隐藏快捷键或外部事件入口，建议显式化；否则应删除分支或加入导航。

建议修复：

```tsx
<Layout
  onOpenSettings={() => setSettingsOpen(true)}
  onOpenNewTask={handleOpenNewTask}
  onNavigateToChat={() => setPage('chat')}
  onNavigateToToken={() => setPage('token')}
  onNavigateToTrace={() => setPage('trace')}
  messages={routeDevMessages}
>
```

---

### I9. Phase 70 `sessionMemory.persistPath` 配置未被实际用于持久化路径

位置：
- [defaults.ts:L975-L979](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts#L975-L979)
- [schema.ts:L2283-L2283](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts#L2283-L2283)
- [app-init.ts:L477-L490](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L477-L490)
- [app-init.ts:L2921-L2931](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L2921-L2931)

证据：

```ts
sessionMemory: {
  enabled: false,
  persistPath: '.routedev/session-memory.json',
  maxMemories: 100,
},
```

实际创建时使用 `config.memory.sessionMemoryPath`：

```ts
const persistentPath = persistentEnabled
  ? path.resolve(cwd, memCfg?.sessionMemoryPath ?? '.routedev/session-memory.jsonl')
  : undefined;
const store = new SessionMemoryStore(maxMemories, persistentPath);
```

但日志仍输出 `p70Cfg?.sessionMemory?.persistPath`：

```ts
sessionMemoryPersistPath: p70Cfg?.sessionMemory?.persistPath,
```

为什么重要：
这是配置和日志双重误导：日志显示的是 Phase 70 配置路径，真实写入路径却来自 `memory.sessionMemoryPath`。排查持久化问题时会直接指错文件。

建议修复：

```ts
const persistentPath = persistentEnabled
  ? path.resolve(cwd, memCfg?.sessionMemoryPath ?? p70Cfg?.sessionMemory?.persistPath ?? '.routedev/session-memory.jsonl')
  : undefined;
```

同时日志应输出实际 `persistentPath`。

---

## Minor（记录后续处理）

### M1. README 与当前目录结构明显不一致

位置：
- [README.md:L21-L40](file:///c:/Users/杨铭/Desktop/Agent/routedev/README.md#L21-L40)
- [ARCHITECTURE.md:L218-L224](file:///c:/Users/杨铭/Desktop/Agent/routedev/docs/ARCHITECTURE.md#L218-L224)

README 仍描述 `src/channels/`、`src/cli/`、`src/index.tsx`、服务器模式 `pnpm start -- serve`，但仓库实际没有 `src/channels/`、`src/cli/` 和 `src/index.tsx`，架构文档又明确 Phase 72 已删除 channels 并退役终端 UI。文档会误导开发者按旧生产形态排查。

### M2. `scripts/detect-dead-code.ts` 只扫描 `src/`，不扫描 Desktop

位置：
- [detect-dead-code.ts:L15-L19](file:///c:/Users/杨铭/Desktop/Agent/routedev/scripts/detect-dead-code.ts#L15-L19)
- [audit-dead-code.ts:L4-L11](file:///c:/Users/杨铭/Desktop/Agent/routedev/scripts/audit-dead-code.ts#L4-L11)

当前 `detect-dead-code` 脚本说明“不扫 desktop/”，而旧 `audit-dead-code.ts` 扫 `src + desktop`。由于 Phase 72 后 Desktop 是唯一前端，死代码审计如果只扫 `src` 会漏掉 Desktop 不可达页面、IPC 残留、Renderer 组件孤岛。

### M3. `dead-code-report.json` 中存在大量导出级告警，但报告本身不能区分“外部 API 导出”和“生产不可达模块”

位置：
- [dead-code-report.json:L1-L20](file:///c:/Users/杨铭/Desktop/Agent/routedev/dead-code-report.json#L1-L20)

现有报告显示 `totalExports: 1530` 并列出大量 `deadExports`，其中很多是类型、接口或潜在公共 API。该报告可作为线索，但不适合作为删除依据；真正需要优先处理的是本文列出的生产入口断裂、僵尸配置、半接入模块。

---

## 做得好的地方

1. 核心依赖装配集中在 [app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts)，使“模块是否真正接入生产链”可以从一个中心位置追踪。比如 `TaskOrchestrator`、`ExecutionOrchestrator`、`createGoalRunner` 都从这里组装，便于做全量审查。

2. Desktop 与 runtime 的边界较清晰，架构文档明确 [ARCHITECTURE.md:L226-L236](file:///c:/Users/杨铭/Desktop/Agent/routedev/docs/ARCHITECTURE.md#L226-L236) 中 `desktop/main/engine-bridge.ts` 是 Desktop 与 `src/runtime/` 的唯一连接点。这降低了多入口并存导致的审查复杂度，也说明 CLI 旧入口更应该被明确删除或恢复。

3. 多数实验模块采用 fail-open 方式，不会因可选模块缺失直接拖垮主流程。例如 `DualLoopOrchestrator`、Hook Registry、BranchPersistence 等动态接入都带失败降级。这个策略对 Agent 项目是合理的，但需要配套清晰的配置语义，避免“fail-open + 有开关”变成静默无效。

---

## 建议处理顺序

1. **立即修 C1：** 明确 CLI 是否退役。若退役，删除或改写 `bin`、`start`、`tsup` CLI 入口；若保留，恢复 `src/index.tsx` 并补测试。
2. **清理僵尸配置：** Phase 49 三字段、顶层 `boundedRecovery`、Phase 70 `sessionMemory.persistPath` 至少要做到“配置即生效”或“配置不存在”。
3. **明确 Phase 68/69 状态：** 若只是实验观测，改名并默认隐藏；若是生产功能，补真正消费点。
4. **修 Desktop 不可达页面：** 给 `TokenPage` / `TracePage` 添加导航入口，或删除页面分支。
5. **更新死代码检测脚本：** Phase 72 后 Desktop 是唯一前端，建议让正式死代码审计覆盖 `desktop/`，并区分导出级死代码、页面不可达、配置僵尸、观测-only 接入四类。

## 确认检查点

以上审查结果是否确认？需要我继续修复 Critical 问题（CLI 生产入口断裂）吗？
