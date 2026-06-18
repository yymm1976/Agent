# Phase 23 — 高级 UX 与收尾打磨

**Status**: Draft
**Owner**: @route-dev
**Created**: 2026-04-07
**DependsOn**: Phase 3, Phase 5, Phase 8, Phase 12, Phase 15, Phase 18
**Scope**: cli, channels, agent
**Files**: ~12 new/modified
**Deliverables**: TracePanel, SlackAdapter, SetupWizard, ConfigReloadUI, VersionCleanup, IntegrationTests

---

## 背景

这是 v1.0 发布前的最后一个 Phase。所有核心基础设施已就绪——路由、工具、Agent Loop、多 Agent、记忆、通道、插件——本 Phase 交付剩余的 UX 功能与收尾打磨项。完成后 RouteDev 应具备：完整的 Trace 可视化、三大 IM 通道全覆盖、首次运行引导、配置热更新反馈、版本对齐、以及覆盖主链路的端到端集成测试。

---

## 接口观察表

| 已有 / 新增接口 | 类型 | 位置 | Phase 21 中的角色 |
|---|---|---|---|
| `TraceCollector` | 已有 | `src/observability/` | TracePanel 的数据源——读取 JSONL span 记录 |
| `ChannelAdapter` | 已有 | `src/channels/types.ts` | SlackAdapter 须实现此接口 |
| `ConfigWatcher` | 已有 | `src/config/watcher.ts` | ConfigReloadUI 的触发源——监听文件变更事件 |
| `ChatView` | 已有 | `src/cli/components/ChatView.tsx` | 注入系统消息以提示配置变更 |
| `TracePanel` | **新增** | `src/cli/components/TracePanel.tsx` | Ink 组件，全链路 Trace 可视化 |
| `SlackAdapter` | **新增** | `src/channels/adapters/slack.ts` | Slack 通道适配器 |
| `SetupWizard` | **新增** | `src/cli/wizard.ts` | 首次运行交互式引导 |
| `WizardStep` | **新增** | `src/cli/wizard.ts` | Wizard 步骤定义接口 |
| `TraceTimelineEntry` | **新增** | `src/cli/components/TracePanel.tsx` | Trace 时间线条目类型 |
| `ConfigReloadNotice` | **新增** | `src/cli/components/ConfigReloadUI.tsx` | 配置变更通知组件 |

---

## Task 1：TracePanel 组件

**目标**：在终端中可视化全链路 Trace，替代 `/trace view` 的纯文本输出。

### 数据模型

TracePanel 消费 TraceCollector 产出的 JSONL span 记录。需要一个中间类型来表达时间线视图：

```typescript
/** 单条 Trace 时间线条目 */
interface TraceTimelineEntry {
  stepIndex: number;
  label: string;            // 如 "Routing Decision", "LLM Call (gpt-4o)", "Tool: read_file"
  category: "routing" | "model" | "tool" | "assembly" | "delivery";
  startTimeMs: number;
  durationMs: number;
  metadata: {
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    toolName?: string;
    confidence?: number;
  };
}
```

### 视觉布局（Ink）

```
┌─ Trace: session-abc123 ─────────────────────────────────────┐
│                                                              │
│  #1  Routing Decision        12ms   confidence=0.92         │
│  █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│                                                              │
│  #2  LLM Call (gpt-4o)       1.8s   tokens: 420→180        │
│  ██████████████████████████████████████░░░░░░░░░░░░░░░░░░░░ │
│                                                              │
│  #3  Tool: read_file          45ms   path=./src/index.ts    │
│  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│                                                              │
│  #4  Assembly + Response      8ms                           │
│  █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│                                                              │
│  Total: 1.87s │ Model tokens: 600 │ Steps: 4              │
└──────────────────────────────────────────────────────────────┘
```

**关键设计**：
- 使用 Ink 的 `<Box>` 和 `<Text>` 渲染，条形图用 Unicode block 字符（`███░░`）
- 条形宽度 = `Math.round((entry.durationMs / totalMs) * 40)`，最小 1 格
- 底部汇总行显示总耗时、总 token、步骤数
- 支持纵向滚动（步骤 >20 时自动分页，每页 15 条）

### 集成点

- `/trace view <session-id>` 命令路由到 TracePanel 而非纯文本
- TracePanel 从 `TraceCollector.getSessionSpans(sessionId)` 获取原始数据
- 通过 `parseTimelineEntries(spans)` 转换函数生成 `TraceTimelineEntry[]`

**Executor 注意事项**
1. 先阅读 `src/observability/` 中 TraceCollector 的数据结构，理解 span 字段
2. `parseTimelineEntries` 须处理 span 缺失/乱序的边界情况
3. 若 session-id 不存在，显示 "未找到该会话的 Trace 数据"
4. 颜色编码：routing=蓝色, model=绿色, tool=黄色, assembly=灰色, delivery=品红

---

## Task 2：Slack 通道适配器

**目标**：补全第三个 IM 通道，对齐 WeChatWork / Telegram 已有的能力。

### 架构

```
Slack Events API (HTTP POST)
  → SlackAdapter.handleWebhook(req, res)
    → 验证签名 (signingSecret)
    → 解析事件 → SlackMessage
      → ChannelRouter.route(message)
        → AgentLoop 处理
          → response
            → SlackAdapter.sendResponse(channelId, text)
              → Slack Web API (chat.postMessage)
```

### 核心类型

```typescript
/** SlackAdapter 配置 */
interface SlackAdapterConfig {
  botToken: string;         // xoxb-...
  signingSecret: string;    // 用于验证 Events API 请求
  appToken?: string;        // xapp-... 用于 Socket Mode（可选）
}

/** SlackAdapter 实现 ChannelAdapter */
class SlackAdapter implements ChannelAdapter {
  readonly platform = "slack";
  // 实现 send / receive / formatInbound / formatOutbound
}
```

### 消息格式转换

| 方向 | 转换 | 说明 |
|---|---|---|
| Inbound | Slack mrkdwn → plain text | 去除 `<!here>`, `<@U123>` 转为 `@username`，`*bold*` → `**bold**` |
| Outbound | plain text → Slack blocks | Markdown 代码块 → `section` block with `mrkdwn`，长文分段 |

### 配置

`config.yaml` 新增节：

```yaml
channels:
  slack:
    enabled: true
    botToken: "${SLACK_BOT_TOKEN}"
    signingSecret: "${SLACK_SIGNING_SECRET}"
    appToken: "${SLACK_APP_TOKEN}"  # 可选，Socket Mode
```

### Executor 注意事项

1. 参考 `src/channels/adapters/wechat-work.ts` 和 `telegram.ts` 的实现模式
2. Slack 签名验证使用 HMAC-SHA256，注意时间戳防重放（>5 分钟拒绝）
3. URL Verification 挑战（`challenge` 字段）须直接返回
4. 消息去重：Slack 会重试，用 `event_id` 做幂等判断
5. 依赖：需要 `@slack/web-api` 和 `@slack/bolt`（或自行实现 HTTP 层）
6. 测试：mock Slack 的 webhook payload 和 Web API 响应

---

## Task 3：首次运行 Setup Wizard

**目标**：新用户首次运行时，通过交互式向导完成基础配置。

### 流程

```
启动 RouteDev
  → 检查 config.yaml 是否存在
    → 不存在 → 启动 SetupWizard
      → Step 1: 语言偏好
      → Step 2: Provider 配置
      → Step 3: 模型分级选择
      → Step 4: 预算偏好
      → Step 5: 自主模式默认值
    → 写入 config.yaml
    → 显示 "配置完成！开始使用 RouteDev" 并进入正常流程
```

### 步骤定义

```typescript
interface WizardStep {
  id: string;
  title: string;
  prompt: string;
  type: "select" | "multiselect" | "input";
  options?: { label: string; value: string }[];
  validate?: (value: string) => string | null; // 返回 null 表示通过
  default: string;
}
```

### 五个步骤详情

| 步骤 | ID | 类型 | 选项 | 写入 config 路径 |
|---|---|---|---|---|
| 语言偏好 | `lang` | select | `zh-CN`, `en-US` | `ui.language` |
| Provider | `providers` | multiselect | OpenAI, Anthropic, DeepSeek, Qwen, Ollama | `providers[].name` |
| 模型分级 | `models` | input (per tier) | 提示用户为 simple/medium/complex/reasoning 各指定模型 | `routing.modelAssignments` |
| 预算偏好 | `budget` | select | `saving`, `balanced`, `premium` | `budget.mode` |
| 自主模式 | `autonomy` | select | `auto`, `semi`, `manual` | `agent.autonomyMode` |

### UI 设计（Ink）

```
┌─ RouteDev Setup Wizard ──────────────────────────────────┐
│                                                           │
│  Step 1/5: 语言偏好                                       │
│                                                           │
│  ❯ 中文 (zh-CN)                                          │
│    English (en-US)                                       │
│                                                           │
│  ↑↓ 选择  Enter 确认                                      │
└───────────────────────────────────────────────────────────┘
```

- 使用 `@ink/select` 或自行实现选择组件
- 进度条：`Step X/5: title`
- 支持 Ctrl+C 退出（保留已填内容，下次继续）

### Executor 注意事项

1. Wizard 仅在 `config.yaml` 不存在时触发
2. 模型分级步骤：若用户留空，使用 provider 的默认推荐模型
3. 生成的 `config.yaml` 须包含注释（YAML 注释说明各字段用途）
4. API Key 不在 Wizard 中收集——引导用户通过环境变量或 `route config set` 设置
5. 最后写入文件前做一次 schema 校验（使用已有的 config schema）

---

## Task 4：配置热更新 UI 集成

**目标**：将 Phase 18 的 ConfigWatcher 与 CLI 界面打通，用户能感知配置变更。

### 架构

```
ConfigWatcher.on("change", (diff) => {
  → 判断变更类别
    → hot-reloadable → 立即应用 + 显示通知
    → cold-reloadable → 仅显示通知（"下次生效"）
  → ChatView 插入系统消息
})
```

### 变更分类

| 配置路径 | 热更新? | 通知文案 |
|---|---|---|
| `agent.autonomyMode` | **是** | "自主模式已切换为 {mode}" |
| `budget.*` | **是** | "预算设置已更新" |
| `ui.*` | **是** | "界面设置已更新" |
| `providers.*` | 否 | "Provider 配置已变更，将在下次会话生效" |
| `routing.modelAssignments` | 否 | "模型分配已更新，将在下次对话时生效" |
| `channels.*` | 否 | "通道配置已变更，需要重启以生效" |

### ConfigReloadNotice 组件

```typescript
/** 配置变更通知——嵌入 ChatView 消息流 */
interface ConfigReloadNoticeProps {
  changes: Array<{
    path: string;       // 如 "agent.autonomyMode"
    hot: boolean;
    message: string;
  }>;
  timestamp: Date;
}
```

视觉：在 ChatView 消息流中显示为灰色斜体系统消息，前缀 `[配置]`：

```
[配置] 自主模式已切换为 semi（已立即生效）
[配置] 模型分配已更新，将在下次对话时生效
```

### Executor 注意事项

1. 先阅读 `src/config/watcher.ts` 了解 ConfigWatcher 的事件模型和 diff 结构
2. 热更新通过重新读取 config 对象实现（配置是引用传递的 singleton）
3. 冷更新仅通知，不重启服务——避免中断进行中的对话
4. 多条变更在 500ms 内到达时合并为一条通知
5. 不要在测试中实际触发文件变更——用 mock 的 ConfigWatcher 事件

---

## Task 5：版本对齐与代码清理

**目标**：消除技术债，统一版本号，清理遗留代码。

### 5.1 版本对齐

| 位置 | 当前值 | 目标值 | 操作 |
|---|---|---|---|
| `package.json` `version` | `0.17c.0` | `1.0.0` | 修改（Phase 17c 已统一版本号读取方式） |
| `args.ts` | 从 package.json 读取 | `1.0.0` | 自动同步 |
| `splash.ts` | 从 package.json 读取 | `1.0.0` | 自动同步 |
| CLI `--version` 输出 | — | `1.0.0` | 验证 |

> **注意：** Phase 17c 已将 args.ts 和 splash.ts 改为从 package.json 动态读取版本号，只需修改 package.json 即可。

### 5.2 遗留代码清理

| 文件 | 清理项 | 说明 |
|---|---|---|
| `src/agent/executor.ts` | ~~移除 `NoOpToolExecutor`~~ | **已在 Phase 17c 删除**，测试内联 NoOpToolExecutor |
| `src/agent/types.ts` | 移除重复 `CheckpointData` 类型 | 保留 `src/agent/memory/types.ts` 中的 11 字段版本 |
| 全局 | `console.log` 调用 | 替换为 Logger 调用（`src/observability/logger.ts`） |
| 全局 | 缺失 license header 的文件 | 补充 MIT license 头 |

### Executor 注意事项

1. 移除 `NoOpToolExecutor` 前，确认没有任何 import 引用它（用 `grep -r "NoOpToolExecutor"` 验证）
2. 移除 `CheckpointData` 重复定义前，确认所有引用指向保留的类型
3. `console.log` 清理——`grep -rn "console.log" src/` 找出所有调用点
4. 每个文件顶部检查 license header 格式是否与项目其他文件一致
5. 版本修改后运行 `npm run build` 确认构建通过

---

## Task 6：端到端集成测试 + v1.0 Tag

**目标**：覆盖三条主链路的集成测试，确保 v1.0 发布信心。

### 6.1 集成测试矩阵

| 测试场景 | 主链路 | 关键断言 |
|---|---|---|
| 完整对话流 | input → classify → route → LLM → tool → response | 响应非空，tool 被调用，trace 有记录 |
| `/goal` 流程 | parse → plan → execute → verify | plan 步骤 >0，execute 有结果，verify 通过 |
| 通道消息流 | webhook → adapter → route → respond | adapter 正确解析，响应格式匹配平台 |
| 性能基线 | 简单分类任务 | classify <1s，端到端简单任务 <5s |

### 6.2 测试文件

创建 `tests/integration/` 目录（与现有 `tests/unit/` 并列）：

```
tests/integration/
  conversation-flow.test.ts
  goal-flow.test.ts
  channel-flow.test.ts
  performance-benchmark.test.ts
```

### 6.3 性能基准测试设计

```typescript
describe("Performance Benchmarks", () => {
  it("classify should complete within 1 second", async () => {
    const start = performance.now();
    await classifier.classify("帮我读一下 index.ts");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it("end-to-end simple task should complete within 5 seconds", async () => {
    const start = performance.now();
    await agentLoop.run("hello");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
```

### 6.4 v1.0 Tag

- 所有集成测试通过后，创建 git tag `v1.0.0`
- 更新 CHANGELOG.md（如果存在）添加 v1.0.0 条目

### Executor 注意事项

1. 集成测试使用 mock LLM provider（不要调用真实 API）
2. 通道测试构造各平台的 webhook payload 并验证 adapter 行为
3. 性能测试标记为 `@benchmark`，CI 中可选执行（不作为阻断条件）
4. 确保现有 39 个测试文件全部通过后再运行集成测试
5. v1.0 tag 仅在本地创建，不推送（留给用户决定）

---

## 执行顺序

```
Task 5 (版本对齐/清理) ─── 先做，消除噪音
  ↓
Task 1 (TracePanel) ────── 并行 ─┐
Task 2 (SlackAdapter) ──── 并行 ─┤
Task 3 (SetupWizard) ───── 并行 ─┤
Task 4 (ConfigReloadUI) ── 并行 ─┘
  ↓
Task 6 (集成测试 + Tag) ─── 最后做，验证所有功能
```

Task 1-4 之间无依赖，可并行执行。Task 5 先行清理避免后续干扰。Task 6 最后验证全链路。