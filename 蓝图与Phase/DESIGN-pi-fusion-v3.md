# 设计文档：Pi 融合方案 v3

> **日期：** 2026-07-11  
> **状态：** 已确认  
> **输入：** Pi Agent 调研 + 用户确认的产品假设 + 四层架构蓝图 v2  
> **核心哲学：** 默认只有基础功能，有完整且独特的附加 Pack，同时给用户充足的自定义空间

---

## 1. 产品定位（冻结）

**一句话：** 面向个人开发者和小团队的低成本、可靠、可控的桌面编程 Agent。

**核心哲学（Pi 融合）：**

> 默认路径极简到极致 → 附加 Pack 完整且独特 → 用户可自建任何能力

**三句话总结：**
1. **默认只给编程最基础的工具**（≤10 个），省 token、降低模型误选
2. **提供独特的官方 Pack**（Multi-Agent/Goal/对抗审查等），比用户自建更好用
3. **Pack 机制足够强**（Pi Extensions 风格），用户可以自建任何能力

**明确不做（"Core 不做"清单）：**

| 不做 | 理由 | 替代方案 |
|------|------|----------|
| 默认多 Agent 编排 | 实现方式太多，用户需求各异 | `pack.multi-agent` 或用户自建 |
| 默认对抗审查 | 用户可自建跨模型流程 | `pack.adversarial-review` |
| 内置权限弹窗 | 固定规则更可控 | PermissionEngine |
| 自动任务规划 | 用户可写 TODO.md | `pack.goal-advanced` |
| 浏览器自动化 | MCP 更灵活 | `pack.browser-web` |
| 动态信任升级 | 安全风险 | 固定规则 |
| 隐式经验推断 | 无证据 | Freeze |

---

## 2. 四层架构（v3）

```text
┌──────────────────────────────────────────────────┐
│ Core（默认开，极简）                                │
│ 文件/Shell/Git/搜索（≤10 工具）、模型路由/Token、  │
│ 固定权限、Checkpoint、会话分支、项目规则、          │
│ ask_user、plan/todo、MCP 基础连接                  │
├──────────────────────────────────────────────────┤
│ Extended Pack（默认关，中等偏下维护）               │
│ Multi-Agent 协作、Goal 高级编排、对抗审查           │
│ 完整且独特，比用户自建更好用                        │
├──────────────────────────────────────────────────┤
│ Standard Pack（默认关，冷处理）                     │
│ 浏览器/Web、代码地图、Trace/Scorecard、导入生态     │
│ 用户可自建，但预设更方便                            │
├──────────────────────────────────────────────────┤
│ Freeze（停止接线）                                  │
│ 渐进信任、隐式适配、KG 高级算法、/goal 并行调度     │
└──────────────────────────────────────────────────┘
```

### 层级决策原则

| 条件 | 归属 |
|------|------|
| 用户很难通过第三方 Skill/Pack 实现 + 编程场景基础 | **Core** |
| 用户能自建但预设更好用 + 有明确场景 | **Extended Pack** |
| 几乎用不到但有接入接口 + 用户可自建 | **Standard Pack**（冷处理） |
| 价值未证明 + 有更好替代 | **Freeze** |

### Core 能力明细

| 能力 | Pi 对标 | RouteDev 差异化 |
|------|---------|----------------|
| 文件 read/write/edit/search | ✅ 完全对标 | 加 code_search |
| Shell 执行 | ✅ bash 对标 | — |
| Git 操作 | ✅ 通过 bash | 独立 git 工具（更安全） |
| ask_user | ❌ Pi 不做 | 编程场景刚需，留 Core |
| plan/todo | ❌ Pi 不做 | 编程场景刚需，留 Core |
| 会话分支（tree/fork/clone） | ✅ 完全对标 | Electron UI 加持 |
| Checkpoint / 回滚 | ❌ Pi 不做 | 桌面应用特有需求 |
| 模型路由 + Token 可见 | ❌ Pi 不做 | 省钱核心差异化 |
| 固定权限 | ❌ Pi 用容器 | 固定规则更可控 |
| 项目规则 / 上下文压缩 | ✅ AGENTS.md | — |
| MCP 基础连接 | ❌ Pi 不做 | 扩展面基础 |

---

## 3. 会话分支（Core 新增）

### 现状

Checkpoint 是线性快照（`git stash` 式），没有分支。

### Pi 的做法

会话存为 JSONL 树，每条消息有 `id` + `parentId`：
- `/tree` — 导航会话树，跳到任意历史点继续
- `/fork` — 从任意历史消息创建新会话
- `/clone` — 复制当前分支到新会话

### 融合设计

```text
Checkpoint（已有）     Session Tree（新增）
    │                      │
    ▼                      ▼
工作区快照               消息树（id + parentId）
git stash 式             JSONL 树结构
线性回滚                 分支 + fork + 跳回
```

| 能力 | 归属 | 理由 |
|------|------|------|
| Checkpoint（工作区快照/回滚） | Core 保留 | 改坏可恢复 |
| Session Tree（消息分支/tree/fork） | Core 新增 | 用户无法通过 Pack 自建 |
| 会话导出（HTML/JSONL） | Standard Pack | 用户可自建 |

### 实现策略

- 不替换 Checkpoint，与之并存
- 消息存储从线性数组改为树结构（向后兼容：线性消息自动作为单分支树）
- `/tree` `/fork` `/clone` 命令进入 Core
- ChatPage 增加树导航 UI

### 与 Pi 的区别

- Pi 是纯 JSONL 文件 → 我们用 SQLite + JSONL 双写（查询更快）
- Pi 无 Checkpoint → 我们有工作区快照，分支 + Checkpoint 联动
- Pi TUI → 我们 Electron UI 可做更直观的树视图

---

## 4. Pack 扩展能力升级

### 现状

Pack 是配置开关 + 条件装配。用户只能"启用/关闭"官方预设的 Pack。

### Pi Extensions 的做法

TypeScript 模块，可以：
- 注册自定义工具（或替换内置工具）
- 注册命令
- 监听事件钩子（`tool_call`、`message` 等）
- 注册 UI 组件
- 替换 compaction 行为
- 注册自定义 Provider

### 融合设计

```ts
export interface CapabilityPack {
  id: string;           // 'pack.multi-agent'
  layer: 'extended' | 'standard';
  description: string;
  costHint: string;
  defaultEnabled: false;
  register(ctx: PackContext): Promise<void> | void;
  unregister?(ctx: PackContext): Promise<void> | void;
}

export interface PackContext {
  // 工具注册（Pi 式新增）
  tools: ToolRegistry;
  // 命令注册（Pi 式新增）
  commands: CommandRegistry;
  // 事件钩子（Pi 式新增）
  events: PackEventBus;
  // 配置（已有）
  config: AppConfig;
  // 日志（已有）
  logger: Logger;
  // 使用计数（已有）
  usage: UsageCounter;
}
```

### 用户自建能力

用户可以在 `.routedev/packs/` 或项目级 `.routedev/packs/` 放置自定义 Pack：

```text
~/.routedev/
  packs/
    my-custom-pack/
      index.ts          // Pack 入口
      pack.json         // Pack 元数据

项目目录/
  .routedev/
    packs/
      project-pack/
        index.ts
        pack.json
```

自定义 Pack 与官方 Pack 使用相同 API，享有同等能力。

### 与 Pi 的区别

| | Pi Extensions | RouteDev Pack |
|---|---------------|---------------|
| 权限 | 完全信任用户 | 受 PermissionEngine 管控 |
| MCP | 不做 | Core 内置 MCP 连接 |
| UI | TUI 组件 | Electron 设置面板 |
| 安装 | npm/git | npm/git + 本地目录 |
| 安全 | 用户自行负责 | 分层信任 |

---

## 5. "Core 不做"清单（正式化）

写入 AGENTS.md 和产品文档：

```markdown
## Core 不做（设计决策，非缺陷）

| 不做 | 理由 | 替代方案 |
|------|------|----------|
| 默认多 Agent 编排 | 实现方式太多 | pack.multi-agent 或自建 |
| 默认对抗审查 | 用户可自建 | pack.adversarial-review |
| 内置权限弹窗 | 固定规则更可控 | PermissionEngine |
| 自动任务规划 | 写 TODO.md 即可 | pack.goal-advanced |
| 浏览器自动化 | MCP 更灵活 | pack.browser-web |
| 动态信任升级 | 安全风险 | 固定规则 |
| 隐式经验推断 | 无证据 | Freeze |
| 内置工作流模板 | 用户需求各异 | Skill / Pack 生态 |
```

---

## 6. 与蓝图 v2 的变更摘要

| 变更 | v2 | v3 |
|------|----|----|
| 会话分支 | Standard Pack | **Core 新增** |
| ask_user / plan / todo | Core（隐含） | Core（显式确认） |
| "Core 不做"清单 | 无 | **正式化** |
| Pack 扩展能力 | 配置开关 | **Pi Extensions 风格 API** |
| 用户自建 Pack | 无 | **本地目录支持** |
| Core 哲学 | "最小化" | "极简 + 可自建"（Pi 融合） |
