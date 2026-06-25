# Phase 33 — 设置补全与默认值校准

> **版本目标：** v2.5.0
> **前置依赖：** Phase 32 完成（v2.4.0）
> **新增测试要求：** ≥ 15 个
> **蓝图引用：** BLUEPRINT.md §用户偏好（"Requires common settings to be directly modifiable within the application's settings interface"）
> **核心问题：** SettingsPage 有 12 个标签页，覆盖了约 73% 的配置项，但存在 4 个功能性残缺（MCP 表单缺字段、渠道表单缺凭据、模型编辑缺降级 ID、Checkpoint 触发器不可编辑）和 4 个完整模块零入口（goalVerifier / adversarial / updates / prompts）。此外，部分默认值直接影响 Agent 质量，需要执行人理解取舍后再定稿。

---

## 现状审计

### SettingsPage 结构（12 个标签页）

| 标签页 | 覆盖度 | 问题 |
|--------|:---:|------|
| Provider & 模型 | 90% | 模型编辑模态缺 `fallbackModelId` |
| 路由规则 | 100% | — |
| 安全设置 | 100% | — |
| 命令与工具 | 100% | — |
| 可观测性 | 100% | Phase 30-31 全部 6 个 Card 已集成 |
| 记忆 & 检查点 | 85% | Checkpoint `triggers[]` 不可编辑 |
| 插件 & MCP | 60% | 添加表单缺 `args/env/cwd`（stdio）和 `headers`（http）；已有服务器缺编辑能力 |
| 渠道集成 | 50% | 添加表单缺各渠道凭据字段（`options`）；Discord 无适配器实现 |
| 外观 | 100% | — |
| 提示音 | 100% | — |
| 归档对话 | 100% | — |
| 关于 | 100% | 版本号硬编码 `2.2.0`，应从 `package.json` 读取 |

### 完全缺失的配置模块（schema.ts 已定义，SettingsPage 零入口）

| 模块 | 字段数 | 影响 |
|------|:---:|------|
| `goalVerifier` | 4 | 用户无法开关目标验证、无法调整验证模型和 Token 预算 |
| `adversarial` | 3 | Phase 21 对抗性验证功能完全不可见 |
| `updates` | 2 | 自动更新开关无 UI，用户只能改 YAML |
| `prompts` | 3 | 提示词模板系统不可配置 |

### 功能性残缺（有入口但不完整）

| 残缺项 | 缺失字段 | 后果 |
|--------|----------|------|
| MCP stdio 添加 | `args[]`, `env{}`, `cwd` | `npx @mcp/server-fs /path` 这类带参数的命令无法配置 |
| MCP http 添加 | `headers{}` | 需要认证头的 MCP 服务无法连接 |
| MCP 已有服务器 | 全部配置字段 | 只能开关和删除，无法编辑 |
| 渠道添加 | `options{}` 各渠道凭据 | 添加渠道后仍无法使用，必须改 YAML 填凭据 |
| 模型编辑模态 | `fallbackModelId` | 路由规则级的降级模型已集成，但模型级的降级 ID 无法设置 |
| Checkpoint | `triggers[]` | 只能开关和改模型，三级触发阈值（20/45/70）无法调整 |

---

## Task 1：MCP 服务器表单补全（4 测试）

### 1.1 添加表单扩展

**stdio 传输方式**需要新增三个字段：

| 字段 | 类型 | UI 形式 | 说明 |
|------|------|---------|------|
| `args` | `string[]` | 逗号分隔 Input | 命令参数，如 `@mcp/server-fs, /home/user/project` |
| `env` | `Record<string,string>` | key=value 键值对列表，支持增删 | 环境变量，常用于传递 API Key（如 `ANTHROPIC_API_KEY=sk-...`） |
| `cwd` | `string` | Input | 工作目录，多数 MCP 服务不需要，可放在折叠区域 |

**http 传输方式**需要新增一个字段：

| 字段 | 类型 | UI 形式 | 说明 |
|------|------|---------|------|
| `headers` | `Record<string,string>` | key=value 键值对列表，支持增删 | HTTP 请求头，用于认证（如 `Authorization: Bearer xxx`） |

**通用字段（两种传输都需要）：**

| 字段 | 类型 | UI 形式 | 说明 |
|------|------|---------|------|
| `connectTimeout` | `number \| undefined` | 数字 Input（可选） | 连接超时毫秒，留空使用默认值 |

**设计建议：**
- `args` 和 `env` 是 stdio 最常用的字段，放在 command 下方显眼位置
- `cwd` 和 `connectTimeout` 放在"高级选项"折叠区域内
- `env` 和 `headers` 的 key=value 列表可参考安全设置中敏感文件 pattern 的输入模式，但需要独立成行（一个 key 一行），因为 value 可能很长

### 1.2 已有服务器编辑能力

当前 MCP 服务器列表只显示 id/name/transport/enabled 四个只读字段加删除按钮。需要为每个已有服务器增加编辑能力：

- 方案 A：点击服务器卡片展开编辑区域（inline expand）
- 方案 B：点击编辑按钮弹出模态框（modal）

两种方案都可行，选与现有 UI 风格更一致的。编辑表单复用添加表单的字段结构，预填现有值。

### 1.3 状态管理

当前 `newMcp` 的 useState 需要扩展，加入 `args`、`env`（数组形式）、`cwd`、`headers`（数组形式）、`connectTimeout` 字段。`addMcpServer()` 函数构造 `MCPServerEntryConfig` 时，根据 transport 类型组装正确的 `config` 对象。

---

## Task 2：渠道选项表单补全（4 测试）

### 2.1 按渠道类型动态渲染 options 表单

`ChannelEntryConfig.options` 是 `Record<string, string>`，但不同渠道类型需要不同的 key。SettingsPage 应根据 `entry.type` 动态渲染对应的凭据输入表单：

**Telegram（2 必填 + 1 可选）：**

| key | 标签 | 说明 | 必填 |
|-----|------|------|:---:|
| `botToken` | Bot Token | 从 @BotFather 获取，格式 `123456:ABC-DEF...` | ✅ |
| `allowedUserIds` | 允许的用户 ID | 逗号分隔的 Telegram user ID，留空不限制 | — |
| `pollIntervalMs` | 轮询间隔(ms) | 长轮询间隔，默认 1000 | — |

**企业微信（3 必填 + 2 可选）：**

| key | 标签 | 说明 | 必填 |
|-----|------|------|:---:|
| `corpId` | 企业 ID | 企业微信管理后台获取 | ✅ |
| `corpSecret` | 应用密钥 | 与 corpId 配合，用于获取 access_token | ✅ |
| `token` | 验证 Token | 用于签名验证（生产模式必须配置） | ✅ |
| `encodingAESKey` | AES 密钥 | 43 字符 EncodingAESKey，启用消息加解密 | — |
| `agentId` | 应用 AgentId | 发送消息时需要 | — |

**Slack（1 必填 + 2 可选）：**

| key | 标签 | 说明 | 必填 |
|-----|------|------|:---:|
| `botToken` | Bot Token | 格式 `xoxb-...`，从 Slack App 获取 | ✅ |
| `signingSecret` | Signing Secret | 用于请求签名验证（生产模式必须配置） | — |
| `appToken` | App Token | 格式 `xapp-...`，Socket Mode 需要 | — |

**Discord：**

Discord 适配器尚未实现（`ChannelManager.createAdapter()` 的 switch 中无 `case 'discord'`，会抛 `"Unsupported channel type: discord"` 错误）。两个处理方案：

- 方案 A（推荐）：从渠道类型的 Select 下拉列表中移除 Discord 选项，在底部加一行灰色文字提示"Discord 适配器开发中"
- 方案 B：保留选项但添加后显示警告卡片"此渠道类型尚未实现"

### 2.2 凭据安全

`corpSecret`、`botToken`、`signingSecret` 等是敏感凭据。UI 上应与 Provider API Key 同等对待：

- 输入框类型默认为 `password`
- 提供显示/隐藏切换按钮（复用 `showApiKeys` 的模式）
- 提示文字说明支持 `${ENV_VAR}` 环境变量引用

### 2.3 添加与编辑流程

添加渠道的表单应从当前的"id + type 两个字段"扩展为"id + type + 该类型对应的 options 字段"。用户选完 type 后动态渲染 options 表单。

已有渠道的 options 编辑：点击渠道卡片展开 options 编辑区域，预填现有值。

---

## Task 3：缺失模块与字段补全（4 测试）

### 3.1 四个缺失模块的 UI 入口

以下模块在 `schema.ts` 中已定义、在 `defaults.ts` 中有合理默认值，但 SettingsPage 完全没有入口。每个模块字段很少（2-4 个），不值得单独开标签页，建议作为 Card 插入现有标签页：

**goalVerifier → 插入"记忆 & 检查点"标签页**

放在 Checkpoint Card 和 项目记忆 Card 之间，因为目标验证是"任务完成后的验证"流程，与 Checkpoint 是同一类功能。

| 字段 | UI 形式 | 说明 |
|------|---------|------|
| `enabled` | Switch | 是否启用 /goal 完成后的独立验证 |
| `modelId` | Input | 验证用的模型 ID，留空跟随路由默认模型 |
| `maxTokensPerVerification` | number Input | 单次验证 Token 上限 |
| `autoVerify` | Switch | /goal 完成后是否自动触发验证 |

**adversarial → 插入"安全设置"标签页**

作为新 Card 放在安全设置底部。对抗性验证是安全增强层，放安全标签页最自然。

| 字段 | UI 形式 | 说明 |
|------|---------|------|
| `enabled` | Switch | 是否启用对抗性验证（实验性功能） |
| `threshold` | 数字 Input 或 slider (0-1) | 严重度阈值，低于此值的输出会被标记 |
| `modelTier` | Select (fast/main) | 验证使用的模型层级 |

**updates → 插入"外观"标签页的"通用" Card 内**

只有 2 个布尔字段，不值得单独 Card。在外观标签页的"通用" Card 底部追加两个 Switch：

| 字段 | UI 形式 | 说明 |
|------|---------|------|
| `checkOnStartup` | Switch | 启动时检查是否有新版本 |
| `autoUpdate` | Switch | 自动下载并安装更新（关闭则仅提示） |

**prompts → 插入"可观测性"标签页或新增"提示词"标签页**

3 个字段。如果不想新增标签页，可以在可观测性标签页底部加一个"提示词模板" Card。如果认为提示词系统是核心功能，可以单独开标签页。

| 字段 | UI 形式 | 说明 |
|------|---------|------|
| `projectOverrides` | Switch | 是否允许项目级提示词覆盖内置模板 |
| `cacheTtlSeconds` | number Input | 模板缓存 TTL 秒数，0 表示不缓存 |
| `userTemplatesDir` | Input（可选） | 用户自定义模板目录路径，留空使用默认路径 |

### 3.2 模型编辑模态补字段

当前模型编辑模态（`modelEditor` state 驱动）有 id/name/tier/contextWindow/capabilities 五个字段，缺少 `fallbackModelId`。

在模态底部（capabilities 下方）增加一行：

| 字段 | UI 形式 | 说明 |
|------|---------|------|
| `fallbackModelId` | Input（可选） | 此模型不可用时自动降级到的备选模型 ID |

### 3.3 Checkpoint 触发器编辑

当前"增量 Checkpoint" Card 只有 enabled/modelId/maxTokensPerCheckpoint 三个字段。`triggers[]` 是一个数组，默认三级触发（20%/initial, 45%/incremental, 70%/compress）。

建议用表格形式展示，每行一个触发器，支持编辑 level 和 action：

| level (%) | action | 操作 |
|:---------:|:------:|:----:|
| 20 | initial | 删除 |
| 45 | incremental | 删除 |
| 70 | compress | 删除 |
| [添加触发器] | | |

action 用 Select 下拉（initial / incremental / compress）。level 用 number Input。

### 3.4 版本号修复

`SettingsPage.tsx` 第 74 行硬编码了 `const APP_VERSION = '2.2.0'`。应改为从 `package.json` 读取或通过 IPC 从主进程获取版本号。

---

## Task 4：默认值校准——写给执行人的思考引导

> **本 Task 不是实现任务，是思考任务。**
> 
> 以下每个问题都直接影响 Agent 的工作质量和用户体验。我不给出标准答案，因为你需要结合代码实现来判断。但我会把每个问题的关键考量列出来，请你思考后做出选择，并在 commit message 或 PR 说明中记录你的决策理由。

### 问题 1：goalVerifier.modelId 应该用什么模型？

**当前默认值：** `'kimi-k2.7'`（reasoning 级模型，较贵）

**思考角度：**

目标验证器的工作是：读一遍执行结果，判断是否达成了用户目标。这需要理解能力，但不需要生成代码。相当于"批改作业"而不是"写作业"。

- 如果用 reasoning 级模型：验证质量高，但每次 /goal 完成都额外消耗一笔 token。如果用户频繁跑 /goal，成本累积快。
- 如果用 simple 级模型（如 deepseek-v4-flash）：便宜快速，但可能漏判"看起来完成了但实际没完成"的情况。
- 如果用 `'auto'`（跟随路由器选择）：路由器会根据当前 tier 选模型。但这意味着验证用的模型和被验证的执行用的是同一级模型，"自己评自己"的感觉。

**需要你决定的：** 验证器应该比执行器更聪明（用更高级模型）、一样聪明（auto）、还是可以笨一点（用最便宜的模型）？这取决于你在 `goal-verifier.ts` 中实现的验证逻辑有多复杂——如果验证只是读 step results 做关键词匹配，便宜模型够用；如果需要 LLM 做语义理解判断目标是否达成，需要更好的模型。

### 问题 2：safety.maxToolOutputChars 16000 够不够？

**当前默认值：** `16000`

**思考角度：**

16000 字符大约对应 4000 tokens。一个典型的 `file_read` 返回一个 500 行的源文件可能有 20000+ 字符。一次 `shell_exec` 跑测试可能输出 50000+ 字符。

- 截断太多 → Agent 看不到错误信息 → 修不好 bug → 用户体验差
- 截断太少 → 超长输出占满上下文窗口 → 挤压对话空间 → 被迫提前压缩 → 丢失历史信息

Phase 31 Task 6 实现了"智能截断"（`findErrorRegions` 优先保留错误区域），这意味着截断不是简单砍头砍尾。但 `findErrorRegions` 是基于关键词匹配的（'error', 'exception', 'fail'），如果错误信息不包含这些关键词（比如编译错误可能是 `TS2345: Argument of type...`），智能截断也帮不上忙。

**需要你决定的：** 看看你实现的 `ToolResultSanitizer.smartTruncate()` 的实际行为——对于常见的工具输出（TypeScript 编译错误、测试失败、shell 输出），16000 字符是否足够保留关键信息？如果不够，调大到多少合理？如果太大，是否有更优雅的解决方案（比如按工具类型区分截断长度）？

### 问题 3：safety.gateTimeout 180000（3 分钟）对大型项目够不够？

**当前默认值：** `180000`（typecheck 60s + lint 60s + tests 60s 的总和）

**思考角度：**

RouteDev 定位是面向开发者的 AI 助手，用户可能在任何规模的项目中使用它。一个中型 TypeScript 项目（200+ 文件）跑一次 `tsc --noEmit` 可能需要 20-30 秒。但如果是一个 monorepo 或者有大量类型推断的项目，可能 60 秒不够。

CompletionGate 的超时策略是：超时视为 `skipped` 而非 `failed`，不阻断任务完成。所以设短了的后果是"验证跳过"而不是"任务失败"——代价是可能放行有 bug 的代码。

**需要你决定的：** 看看 `CompletionGate.runChecks()` 的实现——超时后的 `skipped` 状态是否会给用户提示？如果用户不知道验证被跳过了，可能需要加一个通知。另外，超时值是否应该根据项目大小动态调整（比如读 `tsconfig.json` 的 `include` 文件数量来估算）？

### 问题 4：safety.gateRetry 1 次重试够不够？

**当前默认值：** `1`

**思考角度：**

CompletionGate 失败后允许 Agent 修复并重新验证。1 次重试意味着：验证失败 → Agent 修复 → 再验证一次 → 如果还失败就交付。

- 对于简单错误（少了一个 import），1 次通常够。
- 对于连锁错误（修了 A 引入 B），1 次可能不够，需要 2-3 轮。
- 但重试太多会导致 Agent 陷入修复循环，消耗更多 token。

**需要你决定的：** 看看 CompletionGate 重试时，Agent 是否能看到上一次验证的具体错误信息？如果能看到，1 次重试大概率够用。如果是盲修（只看到"验证失败"但不知道具体哪里错了），可能需要更多次。这取决于你在 `completion-gate.ts` 中如何把结果返回给 Agent。

### 问题 5：workflow.reviewStrictness 默认 medium 是否合适？

**当前默认值：** `'medium'`

**思考角度：**

- `low`：只阻断严重问题（如编译错误）。用户体验流畅，但可能放行代码风格问题。
- `medium`：阻断中等以上问题。平衡体验和质量。
- `high`：任何警告都需修复。质量最高，但可能频繁中断用户工作流。

**需要你决定的：** 看看你实现的 review 逻辑中，`strictness` 实际影响哪些判断条件？如果 `medium` 的判断标准模糊（什么算"中等"问题？），可能需要在代码中明确定义，否则不同模型对"中等"的理解不同，行为不一致。

### 问题 6：adversarial.threshold 默认 0.5 是否合理？

**当前默认值：** `0.5`

**思考角度：**

对抗性验证的 threshold 控制"多严重的输出会被标记"。0.5 意味着中等严重度就触发。

- 设高了（如 0.8）：只标记最严重的问题，可能漏掉隐蔽的攻击。
- 设低了（如 0.3）：标记太多，频繁打断用户，产生"警告疲劳"。

**需要你决定的：** 看看 `AdversarialVerifier`（如果存在）的评分逻辑——它是基于关键词还是 LLM 评分？如果是关键词匹配，误判率可能较高，threshold 应该设高一些。如果是 LLM 评分，可以更精准，threshold 可以设低。这个决定直接影响功能可用性。

### 问题 7：checkpoint.triggers 的三级阈值是否需要调整？

**当前默认值：** `[{20, initial}, {45, incremental}, {70, compress}]`

**思考角度：**

这三级触发意味着：上下文使用 20% 时做初始 Checkpoint，45% 时增量 Checkpoint，70% 时压缩。

- 20% 的 initial 触发很早，可能对话刚开始就压缩了，但初始压缩只是轻量摘要，代价低。
- 70% 的 compress 触发很晚，此时上下文已经快满了，压缩可能丢失大量细节。

**需要你决定的：** 看看 `ContextCompactor` 在三个级别分别做什么——如果 `initial` 只是做个摘要（不丢信息），20% 触发合理；如果 `compress` 会大幅删减内容（L4 合并 + L5 LLM 摘要），70% 可能太晚了，50-60% 触发更安全。这直接影响长对话的记忆保留质量。

### 总结

以上 7 个问题没有标准答案。我希望你：

1. **先读相关代码**，理解每个参数在运行时实际影响什么
2. **做出你的判断**，记录在 commit message 或代码注释中
3. **如果某个问题你觉得当前默认值合理**，直接说明理由即可，不需要改
4. **如果你发现某个参数需要动态调整**（比如根据项目规模），可以在代码中实现自适应逻辑，而不是硬编码一个固定值

---

## Task 5：集成测试与文档同步（3 测试）

### 5.1 SettingsPage 渲染测试

- MCP 添加表单：选择 stdio → 应显示 args/env/cwd 字段
- MCP 添加表单：选择 http → 应显示 headers 字段
- 渠道添加表单：选择 telegram → 应显示 botToken 字段
- 渠道添加表单：选择 wechat-work → 应显示 corpId/corpSecret/token 字段
- goalVerifier Card 应出现在记忆 & 检查点标签页

### 5.2 配置保存测试

- 添加一个带 args 和 env 的 MCP stdio 服务器 → 保存后 draft.mcp.servers 包含正确配置
- 添加一个带 botToken 的 Telegram 渠道 → 保存后 draft.channels.entries 包含 options.botToken

### 5.3 文档同步

- **AGENTS.md：** 新增陷阱 #41：SettingsPage 中 MCP `env` 和渠道 `options` 中的凭据字段支持 `${ENV_VAR}` 环境变量引用，配置保存时不展开环境变量（保持占位符），运行时由 `replaceEnvVars()` 展开
- **CODEMAP.md：** 新增 SettingsPage.tsx 条目说明
- **CHANGELOG.md：** v2.5.0 条目
- **package.json：** 版本号升级 v2.5.0
- **SettingsPage 关于页版本号：** 修复硬编码 `2.2.0`，从 package.json 或 IPC 获取

---

## 测试计数

| Task | 测试要求 |
|------|:---:|
| Task 1（MCP 表单补全） | ≥ 4 |
| Task 2（渠道选项补全） | ≥ 4 |
| Task 3（缺失模块与字段） | ≥ 4 |
| Task 5（集成测试与文档） | ≥ 3 |
| **总计** | **≥ 15** |

---

## AGENTS.md 陷阱（预判）

| # | 陷阱 |
|---|------|
| 41 | MCP 添加表单的 `env` 和 `headers` 是 `Record<string, string>`，不是数组。UI 上用 key=value 列表形式输入，提交时转为 object。空行和只有 key 没有 value 的行应被过滤 |
| 42 | 渠道 `options` 中的凭据字段使用 `password` 类型 Input。`corpSecret`、`botToken`、`signingSecret` 等值不应出现在 SettingsPage 的 console.log 或错误消息中 |
| 43 | Discord 渠道类型在 `ChannelTypeSchema` 中存在但无适配器实现。SettingsPage 中不应让用户成功添加 Discord 渠道后期望它能工作——要么隐藏选项，要么添加后显示警告 |
| 44 | `SettingsPage` 的 `APP_VERSION` 不应硬编码。应通过 IPC 从主进程读取 `package.json` 的 version 字段，或定义一个构建时常量 |

---

## 不在本 Phase 范围内

以下内容经评估不需要 UI 入口或不属于本 Phase：

| 项目 | 理由 |
|------|------|
| `models[].latencyMs` | 运行时自动统计的数据，不应由用户手动填写 |
| `general.theme` (dark/light) | CLI 残留字段，GUI 用 `appearanceTheme` 替代，无需暴露 |
| `general.setupSkipped` | 系统内部状态，不需要用户主动切换 |
| `prompts.userTemplatesDir` UI 入口 | 已包含在 Task 3 的 prompts Card 中，但注意这是高级用户配置，可放在折叠区域 |
| 可观测性标签页重命名 | 当前名称"可观测性"涵盖 Token 追踪 + 实验性优化 + 工作流编排 + 安全防护，虽然不完全准确但改名影响太大（涉及 TabId 类型、所有引用），留到后续重构 |
