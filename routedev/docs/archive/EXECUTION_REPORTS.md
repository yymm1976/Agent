# RouteDev — 执行报告

## Phase 33 — 设置补全与默认值校准（v2.5.0）

**执行时间：** 2026-06-20
**状态：** ✅ 全部完成
**版本：** v2.5.0

### 验收指标

| 指标 | 结果 |
|------|------|
| typecheck:desktop | ⚠️ 5 错误（均为预先存在的 Phase 34/35 迁移遗留，Phase 33 未引入新错误） |
| pnpm build (tsup) | ✅ 成功（dist/index.js 730.04 KB） |
| pnpm build:electron | ✅ 成功（main 1103.86 KB + renderer 3065.25 KB） |
| 全量测试 | ⚠️ 9 失败（均为预先存在的 Phase 31 测试，Phase 33 新增 17 测试全绿） |
| 新增测试 | 17 个（1 个文件，超额完成 ≥15 要求） |
| 版本号 | v2.4.0 → v2.5.0 |

### Task 完成情况

| Task | 内容 | 测试 | 状态 |
|------|------|------|------|
| 1 | MCP 服务器表单补全 — args/env/cwd/headers/connectTimeout + 已有服务器编辑能力 | — | ✅ |
| 2 | 渠道选项表单补全 — 动态凭据字段 + Discord 隐藏 + 凭据安全 + 已有渠道编辑 | — | ✅ |
| 3 | 缺失模块与字段补全 — goalVerifier/adversarial/updates/prompts + fallbackModelId + Checkpoint triggers + 版本号修复 | — | ✅ |
| 4 | 默认值校准思考 — 3 个死配置发现（gateTimeout/gateRetry/reviewStrictness），决策保持默认值不变 | — | ✅ |
| 5 | 集成测试与文档同步 — settings-helpers.ts 纯函数提取 + 17 测试 + AGENTS/CODEMAP/CHANGELOG | 17 | ✅ |

### 主要变更

**新建文件（2 个）：**
- `desktop/renderer/src/pages/settings-helpers.ts` — SettingsPage 纯函数辅助模块（269 行）
  - `parseStringList`/`parseKeyValuePairs`/`keyValueToText` — 通用解析
  - `constructMcpServer`/`mcpServerToForm` — MCP 配置构造与回填
  - `getChannelOptionFields`/`isChannelTypeSupported`/`constructChannelOptions`/`constructChannelEntry` — 渠道配置
  - `getAppVersion` — 版本号读取
- `tests/phase33/settings-helpers.test.ts` — 纯函数单元测试（17 个测试）

**修改文件（关键）：**
- `desktop/renderer/src/pages/SettingsPage.tsx` — Phase 33 核心 UI 改动
  - MCP 表单：state 简化为 `mcpForm`+`mcpEditingId`，新增 args/env/cwd/headers/connectTimeout 字段 + 编辑能力
  - 渠道表单：动态渲染凭据字段 + password 类型 + 显示/隐藏 + Discord 移除选项 + 已有渠道编辑
  - 记忆标签页：Checkpoint triggers 表格编辑 + goalVerifier Card（4 字段）
  - 安全标签页：adversarial Card（enabled/threshold slider/modelTier select）
  - 外观标签页：updates 两个 Switch（checkOnStartup/autoUpdate）
  - 可观测性标签页：prompts Card（projectOverrides/cacheTtlSeconds/userTemplatesDir）
  - 模型编辑模态：新增 fallbackModelId 字段
  - 版本号：硬编码 `2.2.0` → `getAppVersion()`
- `package.json` — 版本号 v2.4.0 → v2.5.0
- `AGENTS.md` — 新增 Phase 33 陷阱 #41-44
- `CODEMAP.md` — 新增 desktop/ 模块详解 + tests/phase33/ 条目 + 更新日期
- `CHANGELOG.md` — 新增 v2.5.0 条目

### 测试覆盖明细（17 个测试）

| 函数 | 测试数 | 覆盖场景 |
|------|:---:|------|
| `parseStringList` | 2 | 正常逗号分隔 + 空值过滤 |
| `parseKeyValuePairs` | 2 | 正常 key=value + 空行/无=过滤 |
| `keyValueToText` | 1 | 对象转文本 + undefined/空对象 |
| `constructMcpServer` | 3 | stdio 带 args/env + http 带 headers + connectTimeout 合法/空/非法 |
| `mcpServerToForm` | 2 | stdio 回填 + http 回填 |
| `getChannelOptionFields` | 3 | telegram 字段数 + wechat-work 必填字段 + discord 空数组 |
| `isChannelTypeSupported` | 1 | discord false + 其他 true |
| `constructChannelOptions` | 1 | 过滤空值 |
| `constructChannelEntry` | 1 | 完整构造 |
| `getAppVersion` | 1 | 从 package.json 读取版本号 |

### 关键设计决策

1. **纯函数提取测试策略**：项目 vitest 配置为 `environment: 'node'`，无 React 渲染依赖（`@testing-library/react`/`jsdom`）。将 SettingsPage 的配置构造逻辑提取到独立 `.ts` 模块，绕过 React 组件测试环境限制，同时保持 SettingsPage.tsx 的 UI 逻辑清晰
2. **MCP 表单添加/编辑共用**：通过 `mcpForm: McpFormState | null` + `mcpEditingId: string | null` 双 state 设计，添加模式 mcpEditingId=null，编辑模式 mcpEditingId=原始 server id，复用同一表单 UI。避免三态联合类型（`McpFormState | 'add' | null`）导致的复杂三元判断
3. **Discord 处理方案 A**：从 Select 下拉列表移除 Discord 选项（方案 B 保留选项但显示警告会导致用户困惑），底部加灰色提示文字"Discord 适配器开发中，暂不可选"。通过 `isChannelTypeSupported()` 函数封装判断逻辑
4. **死配置不补全**：Task 4 研究发现 `gateTimeout`/`gateRetry`/`reviewStrictness` 三个配置在 schema/defaults 中定义但实际代码中未消费。决策：保持默认值不变，不在此 Phase 补全消费逻辑（避免范围蔓延），记录为后续优化项
5. **凭据安全**：sensitive 字段使用 password 类型 Input + 显示/隐藏切换按钮，支持 `${ENV_VAR}` 环境变量引用，配置保存时保持占位符不展开，运行时由 `replaceEnvVars()` 展开

### 预先存在的问题（非 Phase 33 引入）

**typecheck:desktop 5 个错误：**
- `SettingsPage.tsx:2212` / `SetupWizard.tsx:169` — `disclosureLevel` 不存在（Phase 34 迁移到 `outputStyle` 时遗留，SettingsPage/SetupWizard 未同步更新）
- `SetupWizard.tsx:170` / `defaults.ts:105` — `workerContext` 缺失（Phase 35 Task 1 新增 schema 字段时 defaults/SetupWizard 未同步）
- `app-init.ts:381` — `WorkerExecutorOptions` 缺少 `agentLoop`（Phase 35 接口变更未同步）

**全量测试 9 个失败：**
- `tests/agent/task-orchestrator.test.ts` — 1 失败（Phase 31 测试）
- `tests/router/tracker-task-budget.test.ts` — 8 失败（Phase 31 测试）

以上问题均经确认非 Phase 33 修改引入（Phase 33 未修改 src/ 下任何文件，未修改 SettingsPage.tsx 的 UI 配置 disclosureLevel 部分）。

### Phase 33 陷阱（AGENTS.md #41-44）

41. **MCP `env`/`headers` 是 Record 不是数组**：UI 上用 key=value 文本框输入，提交时通过 `parseKeyValuePairs()` 转为 object，回填时通过 `keyValueToText()` 转回文本
42. **渠道凭据字段使用 password 类型 Input**：`corpSecret`/`botToken`/`signingSecret` 等敏感凭据标记 `sensitive: true`，支持 `${ENV_VAR}` 环境变量引用
43. **Discord 渠道类型无适配器实现**：通过 `isChannelTypeSupported('discord') === false` 从 Select 下拉列表移除
44. **SettingsPage 版本号不可硬编码**：通过 `getAppVersion()` 从 `package.json` 读取，降级返回 `'0.0.0'`

---

## Phase 30 — 可观测性与提示词工程（v2.2.0）

**执行时间：** 2026-06-18
**状态：** ✅ 全部完成
**版本：** v2.2.0

### 验收指标

| 指标 | 结果 |
|------|------|
| typecheck | ✅ 0 错误 |
| 全量测试 | ✅ 132 文件 / 1532 passed / 1 skipped |
| 新增测试 | 79 个（5 个文件，超额完成 ≥40 要求） |
| build | ✅ 564.46 KB |
| 版本号 | v2.2.0 |

### Task 完成情况

| Task | 内容 | 测试 | 状态 |
|------|------|------|------|
| 1 | Token 可观测性 — TokenProfiler 五分表 + /token 命令 + loop 埋点 + goal-runner 修复 | 19 | ✅ |
| 2 | 结构化实体状态（实验性）— EntityManager + toPromptBlock < 200 tokens | 19 | ✅ |
| 3 | 声明式上下文获取（实验性）— DeclarativeContextAcquirer 两步调用 + 5秒超时降级 | 13 | ✅ |
| 4 | 简洁思考约束（实验性）— CONCISE_THINKING_BLOCK + trimToolResult + shouldSkipConcise | 17 | ✅ |
| 5 | 系统提示词重构 — main.system 8 区块 + PromptTemplateManager 接入 + systemPromptRef | 11 | ✅ |
| 6 | 集成测试与文档同步 — AGENTS.md/CODEMAP.md/CHANGELOG.md/config.example.yaml/package.json | — | ✅ |

### 主要变更

**新建文件（5 个）：**
- `src/agent/token-profiler.ts` — TokenProfiler 五分表
- `src/agent/entity-state.ts` — EntityManager 结构化实体状态
- `src/agent/declarative-context.ts` — DeclarativeContextAcquirer 声明式上下文
- `src/agent/concise-thinking.ts` — 简洁思考约束
- `src/cli/commands/token.ts` — /token 命令

**修改文件（关键）：**
- `src/prompts/manager.ts` — main.system 模板重写为 8 区块 XML 结构
- `src/cli/App.tsx` — systemPrompt 改为 systemPromptRef + useEffect 异步渲染
- `src/cli/chat-runner.ts` / `goal-runner.ts` — 接收 systemPromptRef + profiler 注入
- `src/agent/loop.ts` — TokenProfiler 埋点 + token_profile 事件
- `src/config/schema.ts` / `defaults.ts` — 新增 optimization 配置节
- `src/agent/goal-verifier.ts` — onUsage 回调记录验证 token

### 关键设计决策

1. **tokenTracking 默认开启**（可观测性不应是实验性），其余三项实验性功能默认关闭
2. **systemPrompt ref 模式**：支持 PromptTemplateManager 异步渲染后热更新，渲染失败保留 fallback
3. **TokenProfiler 会话级累计**：不因上下文压缩重置（借鉴 Reasonix Layer 5）
