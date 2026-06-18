# Phase 25 — UI 与交互优化

> **Phase 类型：** UI/UX 专项优化
> **前置依赖：** Phase 0c 完成（839 测试通过，v1.0.1）
> **并行说明：** 可与 Phase 24 并行执行。Phase 24 Task 1（CLI 设计系统）提供共享的视觉基础（颜色语义、消息样式），本 Phase 所有 UI 组件使用该设计系统。Phase 24 Task 1 完成后即可开始本 Phase 全部 Task。
> **目标版本：** v1.2.0
> **蓝图引用：** Section 四（CLI 组件：BranchSwitcher、DiffView、ConfirmDialog）、design-spec Section UI/UX 部分
> **设计哲学：** 用户是飞行员（Pilot），AI 是副驾驶（Copilot）——用户始终掌握控制权，AI 负责建议和执行

---

## 背景

Phase 24 补齐了 RouteDev 的功能缺口。但一个"功能完整"的 CLI 工具和一个"用起来舒服"的 CLI 工具之间，差距往往比想象中大。本 Phase 聚焦三件事：

1. **补齐蓝图规定的缺失 UI 组件**——BranchSwitcher（分支切换器）、DiffView（差异视图）、ConfirmDialog（确认对话框）
2. **引入产品交互哲学**——Progressive Disclosure（渐进披露）、Pilot/Copilot（飞行员/副驾驶）、注意力管理、Anti-Yes-Engineer（反"好好好"机器人）
3. **视觉打磨**——通知分级、任务完成摘要、进度可视化、空闲提示

### 灵感来源

这些设计理念来自对大量 AI 工具交互模式的总结（包括 Obsidian 知识库中收录的多个 AI 产品设计方法论）：

- **Progressive Disclosure（渐进披露）**：不要一次把所有信息扔给用户。先给摘要，感兴趣再展开细节。路由决策、Trace 数据、权限规则都适用这个原则。
- **Pilot/Copilot（飞行员/副驾驶）**：用户是决策者，AI 是执行者。AI 提出建议但用户做决定。即使在全自动模式下，AI 也应该让用户知道"我准备做什么"而不是"我已经做了"。
- **Attention as Scarce Resource（注意力是稀缺资源）**：人的注意力呈 U 型曲线——开始和结束时最集中，中间最容易走神。重要信息放在开头和结尾，中间放常规信息。
- **Anti-Yes-Engineer（反"好好好"机器人）**：AI 不应该永远点头。当发现潜在风险、静默回退、或不确定时，应该主动标记而不是默认通过。

---

## 接口对齐观察表

以下签名已通过架构师代码级验证：

| 接口 / 类 | 当前签名 | 文件位置 | 本 Phase 引用方式 |
|---|---|---|---|
| `StatusBar` props | `{ currentModel, currentTier, isDegraded, todayTokensUsed, autonomyMode, workMode }` | `src/cli/components/StatusBar.tsx` | Task 7 StatusBar 增强 |
| `ChatView` | 消息流渲染组件，支持系统消息和用户消息 | `src/cli/components/ChatView.tsx` | Task 3 Progressive Disclosure |
| `InputBox` | 用户输入组件 | `src/cli/components/InputBox.tsx` | Task 6 输入增强 |
| `StepCard` | /goal 步骤卡片 | `src/cli/components/StepCard.tsx` | Task 4 进度可视化 |
| `StepEditor` | /goal 步骤编辑器 | `src/cli/components/StepEditor.tsx` | Task 4 编辑交互 |
| `TracePanel` | Trace 时间线可视化 | `src/cli/components/TracePanel.tsx` | Task 3 渐进披露改造 |
| `ConfigReloadUI` | 配置变更通知 | `src/cli/components/ConfigReloadUI.tsx` | Task 7 统一通知样式 |
| `CommandBridge` | 10 方法（addSystemMessage 等） | `src/cli/service-context.ts` | Task 2 ConfirmDialog 通过 requestConfirm 调用 |
| `BranchManager` | 分支管理 | `src/agent/memory/` | Task 1 BranchSwitcher 数据源 |
| `design-system.ts` | Phase 24 Task 1 创建的颜色语义和消息样式 | `src/cli/design-system.ts` | 全部 Task 使用 |

---

## Task 1：BranchSwitcher 组件

**目标**：让用户在 CLI 中可视化和管理对话分支。

### 设计

#### 1.1 触发方式

`/branch` 命令已有（`src/cli/commands/branch.ts`），但缺少可视化。BranchSwitcher 作为 `/branch` 的可视化增强：

```
用户输入: /branch
RouteDev:
┌─ 对话分支 ──────────────────────────────────────┐
│                                                   │
│  ● main (当前) ─── 12 条消息 ──── 2分钟前活跃    │
│  │                                                │
│  ├─ ○ feature-auth ─── 5 条消息 ── 10分钟前      │
│  │                                                │
│  └─ ○ bugfix-login ─── 3 条消息 ── 1小时前       │
│                                                   │
│  操作: /branch switch <name> | /branch create <n> │
│        /branch delete <name> | /branch merge <n>  │
└───────────────────────────────────────────────────┘
```

#### 1.2 可视化规则

- 当前分支用 `●` 实心圆标记，其他分支用 `○` 空心圆
- 分支树用 `├─` `└─` 字符绘制（类似 git log --graph）
- 每条分支显示：名称、消息数、最后活跃时间
- 分支数 >10 时分页显示

#### 1.3 与 BranchManager 集成

- `BranchManager` 提供分支数据（列表、创建、切换、删除）
- BranchSwitcher 是纯展示组件，用户操作通过已有的 `/branch` 子命令触发
- 切换分支时 ChatView 清空并加载目标分支的消息历史

#### 1.4 Executor 注意事项

1. 先阅读 `src/agent/memory/` 中的 BranchManager（或 `src/agent/branch.ts`）了解数据模型
2. BranchSwitcher 渲染为 Ink 组件，嵌入 ChatView 或独立弹出
3. 使用 Phase 24 Task 1 的设计系统颜色（当前分支 primary，其他 info）
4. 分支名支持中文和英文
5. 测试：分支列表渲染、当前分支高亮、空分支处理

---

## Task 2：ConfirmDialog 组件

**目标**：实现蓝图规定的确认对话框组件，用于权限确认和安全确认。

### 设计

蓝图 Section 四文件列表中明确列出：`ConfirmDialog.tsx — 确认对话框（权限确认、安全确认）`

#### 2.1 对话框布局

```
┌─ ⚠️ 确认操作 ──────────────────────────────────┐
│                                                   │
│  操作: 删除文件 src/old-module.ts                 │
│  影响: 该文件将被永久删除，无法恢复               │
│  风险: 中等                                       │
│                                                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
│  │ [Y] 确认 │  │ [N] 拒绝 │  │ [D] 详情 │          │
│  └─────────┘  └─────────┘  └─────────┘          │
│                                                   │
│  ⏱ 30秒后自动拒绝（安全策略）                     │
└───────────────────────────────────────────────────┘
```

#### 2.2 交互规则

- 支持键盘快捷键：`y` 确认、`n` 或 `Esc` 拒绝、`d` 展开详情
- 30 秒超时自动拒绝（安全策略，防止用户走开后误操作）
- 详情模式展示完整的命令/操作内容和影响范围
- 拒绝后通过 `CommandBridge.addSystemMessage()` 通知"操作已取消"

#### 2.3 与 CommandBridge 集成

`CommandBridge.requestConfirm(prompt: string): Promise<boolean>` 已存在。ConfirmDialog 是此方法的可视化实现：

```typescript
// 当前：requestConfirm 可能只是简单的 y/n 提示
// 改造后：requestConfirm 渲染 ConfirmDialog 组件
```

#### 2.4 Executor 注意事项

1. ConfirmDialog 是受控组件，通过 props 接收确认内容和回调
2. 超时计时器用 `setTimeout`，组件卸载时清除
3. "详情"展开区域支持多行文本，高度自适应
4. 使用设计系统的 `warning` 和 `error` 颜色
5. 测试：键盘快捷键、超时自动拒绝、详情展开/收起

---

## Task 3：Progressive Disclosure（渐进披露）

**目标**：让复杂信息按需展开，不一次性淹没用户。

### 比喻

像洋葱一样，信息分层。最外层是"一句话摘要"，剥开一层是"关键细节"，再剥开是"完整数据"。用户想看多少就剥多少层。

### 设计

#### 3.1 统一 DisclosureProps 组件

```typescript
// src/cli/components/DisclosureLevel.tsx — 新建

interface DisclosureProps {
  level: 1 | 2 | 3;            // 当前披露层级
  content: {
    l1: string;                 // 一句话摘要（必须有）
    l2?: string;                // 关键细节（可选）
    l3?: string;                // 完整数据（可选）
  };
  defaultLevel?: 1 | 2 | 3;    // 默认显示层级（可配置）
}
```

全局配置 `ui.disclosureLevel: 1 | 2 | 3` 控制默认层级。

#### 3.2 TracePanel 渐进披露改造

当前 TracePanel 一次显示所有 span 的时间线条目。改造为：

- **L1**：只显示总耗时和步骤数 — `Total: 1.87s | Steps: 4`
- **L2（默认）**：显示每个步骤的一行摘要 — `#1 Routing 12ms | #2 LLM 1.8s | #3 Tool 45ms`
- **L3（/trace expand）**：完整时间线条形图（当前 TracePanel 的完整视图）

#### 3.3 路由决策披露

路由通知的三级披露（需 Phase 24 Task 7 的路由通知基础）：

- **L1（默认显示）**：`[路由] complex → gpt-4o`
- **L2（/route detail 或 verbose 模式）**：加上置信度和原因 — `置信度 0.89 | 原因: 多文件修改需求`
- **L3（/route full）**：完整的分类输入输出、候选模型对比、token 预算计算

> **并行说明**：如 Phase 24 Task 7 尚未完成路由通知的 `addSystemMessage()` 调用，则先建 DisclosureProps 组件和 TracePanel 三级披露。路由决策披露层级在 Phase 24 Task 7 完成后接入（在路由通知调用点包装 DisclosureProps）。

#### 3.4 错误消息渐进披露

- **L1**：`[错误] 无法连接 API 服务`
- **L2**：加上原因 — `可能原因: API Key 过期或网络不通`
- **L3（/error detail 或自动展开）**：完整错误栈 + 建议操作

> **并行说明**：如 Phase 24 Task 7 尚未创建 `src/utils/error-messages.ts`，则 DisclosureProps 组件先支持路由和 Trace 场景。错误消息披露在 Phase 24 Task 7 完成后接入。

#### 3.5 交互方式

- 展开/收起用 `Tab` 键或 `/detail` 命令
- L1 内容必须有，L2/L3 可选——没有 L2/L3 时直接显示 L1 不带展开箭头

#### 3.6 Executor 注意事项

1. `DisclosureProps` 是通用组件，TracePanel、路由通知、错误消息都使用它
2. 先实现 TracePanel 三级披露（无跨 Phase 依赖），路由/错误披露标记为 deferred 或条件接入
3. 测试：三级内容渲染、默认层级配置、层级切换、L2/L3 缺失时降级显示

---

## Task 4：/goal 进度可视化增强

**目标**：让 `/goal` 任务的执行进度更直观，用户一眼就知道"到哪了"。

### 设计

#### 4.1 进度总览（任务开始时显示）

```
┌─ 目标: 重构认证模块 ─── 进度 3/8 ──── ETA 5min ──┐
│                                                    │
│  ✅ 1. 分析现有认证代码           完成  45s        │
│  ✅ 2. 设计新接口                 完成  1m20s      │
│  ✅ 3. 实现 JWT 验证              完成  2m10s      │
│  🔄 4. 实现 OAuth 集成            进行中 0m30s     │
│  ⬚ 5. 编写单元测试                待执行           │
│  ⬚ 6. 编写集成测试                待执行           │
│  ⬚ 7. 更新文档                    待执行           │
│  ⬚ 8. 代码审查                    待执行           │
│                                                    │
│  ████████████████░░░░░░░░░░░░░░░░░  37%            │
└────────────────────────────────────────────────────┘
```

#### 4.2 实时更新

- 每完成一步，StepCard 状态从 `⬚` 变为 `✅`，进度条更新
- 当前执行步骤用 `🔄` 标记并显示已用时间
- 失败步骤用 `❌` 标记，附带错误摘要
- ETA 基于已完成步骤的平均耗时估算

#### 4.3 ProgressBar 通用组件

```typescript
// src/cli/components/ProgressBar.tsx — 新建

interface ProgressBarProps {
  current: number;
  total: number;
  width?: number;        // 条形宽度（默认 35 字符）
  color?: SemanticColor; // 使用设计系统语义色
  showPercent?: boolean;
}
```

ProgressBar 是通用组件，Compose 管线和 DurableExecutor 也可以复用。

#### 4.4 与 StepCard/StepEditor 集成

- `StepCard` 增强状态图标和耗时显示
- 进度条是新增组件 `ProgressBar`，可复用
- `StepEditor` 保持不变——编辑交互已完善

#### 4.5 Executor 注意事项

1. `ProgressBar` 使用 Unicode block 字符（`██░`），颜色使用设计系统 `primary` 色
2. ETA 算法：`averageStepTime * remainingSteps`，简单但有效
3. 进度总览在 `/goal` 开始时显示，后续通过 `CommandBridge.addSystemMessage()` 推送更新
4. 测试：进度条渲染、状态图标、ETA 计算、空进度处理

---

## Task 5：Anti-Yes-Engineer 机制（反"好好好"机器人）

**目标**：让 RouteDev 在不确定时主动标记风险，而不是默认点头。

### 背景

"Yes Engineer"是 AI 工具的常见问题——用户说什么 AI 都照做，即使发现了风险也不说。比如用户要求删除一个关键文件，AI 默默执行而不提醒"这个文件好像还在用"。

### 设计

#### 5.1 静默回退标记

当 RouteDev 内部发生"静默回退"时，必须显式通知用户：

```
[警告] 分类器置信度过低(0.32)，回退到 conservative 模式。
  原因: 无法确定任务类型
  影响: 将使用最高能力模型处理，可能消耗更多 token
```

需要标记的静默回退场景：
- 分类器置信度 < 阈值时的回退
- 模型降级（首选模型不可用时的 fallback）
- 工具执行失败后的策略切换
- 上下文压缩导致的信息丢失
- 记忆召回为空时的默认行为

#### 5.2 风险预检

在用户请求可能导致不可逆操作时，RouteDev 主动提醒：

```
[提醒] 你要求删除 src/auth/ 目录下的所有文件。
  这会影响 3 个正在使用的模块（auth-service, login-handler, session-manager）。
  确认要继续吗？(y/n)
```

#### 5.3 不确定性透明

当 AI 对结果不确定时，显式标注置信度：

```
[回答] 这个 bug 最可能是由竞态条件引起的（置信度: 中等）。
  备选原因: 内存泄漏（置信度: 低）
  建议: 运行 /trace 查看详细执行链路以确认
```

#### 5.4 实现方式

- **prompt 层面**：在 `ReActAgentLoop` 的 system prompt 中注入 Anti-Yes-Engineer 指令（"当你不确定时，必须显式标注置信度；当发现潜在风险时，必须主动提醒"）
- **代码层面**：在已知的 fallback 路径上加 `CommandBridge.addSystemMessage()` 通知
  - `ContextCompactor` 压缩后通知信息丢失（已有 `onCompression` 回调，确认是否通知用户）
  - 工具执行器的 fallback 路径增加通知
- **路由降级通知**：如 Phase 24 Task 7 已完成路由通知基础，则在此基础上增加模型降级场景的 `warning` 级别通知。如未完成，则本 Task 仅在 `ModelRouter` 的 fallback 路径上加 `addSystemMessage()` 通知。

#### 5.5 Executor 注意事项

1. 大部分改动是 prompt 层面的——在 system prompt 中加入 Anti-Yes-Engineer 指令
2. 代码层面主要是"通知插入点"——在已知的 fallback 路径上加 `addSystemMessage()`
3. 使用设计系统的 `MESSAGE_STYLES.warning` 样式
4. 不改变任何核心逻辑，只增加透明度
5. 测试：静默回退通知触发条件、风险预检触发条件、prompt 指令存在性

---

## Task 6：DiffView 组件

**目标**：在终端中可视化代码变更差异，让用户直观看到 AI 修改了什么。

### 设计

#### 6.1 布局

```
┌─ 变更: src/auth/handler.ts ─── +12 -5 ──────────┐
│                                                    │
│  15 │   const token = req.headers.authorization;  │
│  16 │-  if (!token) {                             │
│  17 │-    return res.status(401).send();           │
│  18 │-  }                                         │
│  16 │+  if (!token) {                             │
│  17 │+    logger.warn('Missing auth token');       │
│  18 │+    return res.status(401).json({            │
│  19 │+      error: 'UNAUTHORIZED',                │
│  20 │+      message: '缺少认证令牌'               │
│  21 │+    });                                     │
│  22 │+  }                                         │
│                                                    │
│  显示: [A] 全部接受 | [R] 全部拒绝 | [S] 逐行审查 │
└────────────────────────────────────────────────────┘
```

#### 6.2 颜色编码

- 删除行（`-`）：设计系统 `error` 颜色背景
- 新增行（`+`）：设计系统 `success` 颜色背景
- 上下文行：默认颜色
- 行号：`info` 颜色

#### 6.3 触发场景

- `/goal` 步骤中的代码修改操作完成后
- Compose 模式 coding 阶段完成后（如 Phase 24 ComposePipeline 已就绪）
- 用户请求 `/diff` 查看最近变更

#### 6.4 Executor 注意事项

1. DiffView 消费标准 unified diff 格式输出
2. 使用 Ink 的 `<Box>` + `<Text>` 渲染，行号 + 颜色区分
3. 长 diff 支持分页（每页 20 行）
4. "逐行审查"模式允许用户对每个 hunk 选择接受/拒绝
5. 测试：diff 解析、颜色渲染、分页、逐行审查

---

## Task 7：通知系统与视觉打磨

**目标**：统一所有通知的样式，增加完成音效（终端 bell）、空闲提示等细节。

### 7.1 通知分级

| 级别 | 样式 | 触发场景 |
|------|------|---------|
| `critical` | 红色加粗 + terminal bell | 权限拒绝、致命错误 |
| `important` | 黄色加粗 | 模型降级、配置变更、阶段切换 |
| `normal` | 灰色斜体 | 路由决策、记忆保存、检查点 |
| `subtle` | 暗灰色 | 调试信息（仅 verbose 模式显示） |

通知样式基于 Phase 24 Task 1 的设计系统 `SemanticColor` 扩展，新增 `NotificationLevel` 类型：

```typescript
// src/cli/notification.ts — 新建

type NotificationLevel = 'critical' | 'important' | 'normal' | 'subtle';

interface NotificationOptions {
  level: NotificationLevel;
  bell?: boolean;    // 是否触发 terminal bell（默认仅 critical）
  message: string;
}
```

### 7.2 任务完成提示

当 `/goal` 或 Compose 管线完成时：

```
┌─ ✅ 目标完成 ────────────────────────────────────┐
│                                                    │
│  目标: 重构认证模块                                │
│  步骤: 8/8 完成                                    │
│  耗时: 12分30秒                                    │
│  Token: 15,420 (输入) / 8,230 (输出)               │
│  费用: ¥0.42                                       │
│                                                    │
│  📋 运行 /trace view 查看完整执行链路              │
│  📊 运行 /cost 查看本次会话费用详情                │
└────────────────────────────────────────────────────┘
```

### 7.3 空闲提示

当 RouteDev 等待用户输入超过 30 秒时，显示微妙的提示：

```
💡 提示: 输入 /help 查看可用命令
```

仅显示一次，不重复打扰。

### 7.4 StatusBar 增强

在现有 StatusBar 基础上增加上下文信息：

- Compose 模式下显示当前阶段：`[编排: coding 2/4]` — 数据来源：`ComposePipeline.getSummary()`（Phase 24 Task 2）
- DurableExecutor 运行时显示进度：`[执行: 3/8]` — 数据来源：`DurableExecutor.getSnapshot()`（Phase 24 Task 3）

> **并行说明**：如 Phase 24 的 ComposePipeline 和 DurableExecutor 尚未完成，StatusBar 增强部分标记为 deferred。先实现通知分级、任务完成提示和空闲提示。StatusBar 的 Compose/Durable 指标在 Phase 24 对应 Task 完成后接入（仅需添加数据读取，组件框架已就位）。

### 7.5 Executor 注意事项

1. 通知组件使用 Phase 24 Task 1 的设计系统颜色
2. terminal bell 使用 `\x07` 字符，可配置关闭（`ui.bell: false`）
3. 空闲提示计时器在用户输入时重置
4. 任务完成摘要使用 `CommandBridge.addSystemMessage()` 注入
5. StatusBar Compose/Durable 指标为条件渲染——对应的数据源不存在时不渲染，不报错
6. 测试：通知分级渲染、bell 字符输出、空闲提示触发、StatusBar 条件渲染

---

## 执行顺序

```
Task 1 (BranchSwitcher) ──┐
Task 2 (ConfirmDialog) ───┤── 并行，三个独立 UI 组件
Task 6 (DiffView) ────────┘
  ↓
Task 4 (进度可视化) ────── ProgressBar 通用组件
Task 3 (渐进披露) ──────── DisclosureProps 组件
  ↓
Task 5 (Anti-Yes) ──────── prompt + 通知插入点
Task 7 (通知系统+打磨) ── 最后做，整合所有视觉改进
```

Task 1/2/6 完全独立可并行。Task 4 产出 ProgressBar 通用组件。Task 7 最后整合。

---

## 验收标准

| # | 验收标准 | 验证方式 |
|---|---------|---------|
| 1 | BranchSwitcher 正确渲染分支树 | 创建多个分支，验证显示 |
| 2 | ConfirmDialog 键盘快捷键和超时工作正常 | 手动测试 y/n/d 和 30 秒超时 |
| 3 | DiffView 正确渲染 unified diff | 触发代码修改，验证 diff 显示 |
| 4 | Progressive Disclosure 三级内容可切换 | /trace expand 验证三级显示 |
| 5 | /goal 进度条实时更新 | 运行多步 goal，验证进度可视化 |
| 6 | Anti-Yes-Engineer 静默回退标记触发 | 触发模型降级，验证警告通知 |
| 7 | 通知分级样式正确 | 触发各级通知，验证颜色和 bell |
| 8 | 任务完成摘要显示完整信息 | 完成一个 goal，验证摘要内容 |
| 9 | 所有 UI 组件使用设计系统颜色 | grep 验证无硬编码颜色值 |
| 10 | 全量测试通过 | `pnpm vitest run` |
| 11 | 构建通过 | `pnpm build && pnpm typecheck` |
| 12 | 新增测试 ≥ 25 个 | 测试计数 |

---

## 对下一阶段的提醒

1. **ThemePlugin 渲染接入**：设计系统已就绪，但 ThemePlugin 的 `renderStatusBar` 和 `colors` 尚未被消费
2. **RouterPlugin 集成**：`ModelRouter.route()` 尚未检查 RouterPlugin
3. **插件热加载**：当前仅启动时加载插件
4. **插件状态持久化**：enable/disable 状态仅内存，重启丢失
5. **Compose 管线可视化美化**：ComposePipeline 的阶段指示器可进一步美化为独立动画组件
6. **DurableExecutor 恢复选择 UI**：`/resume` 命令的选择界面可升级为交互式列表
7. **国际化**：当前所有 UI 文案硬编码中文，远期可抽取为 i18n 资源文件
