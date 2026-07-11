# RouteDev 整改蓝图 v3：极简 Core + 独特 Pack + 可自建

> **日期：** 2026-07-11（v3 修订：Pi 融合 + 会话分支 + Pack API 升级）  
> **状态：** 执行中  
> **路线：** Core 极简 + 独特附加 Pack + 用户可自建  
> **目标版本区间：** v4.6.0 → v4.9.0  
> **参考：** [Pi Agent](https://github.com/earendil-works/pi) 极简哲学 + [DESIGN-pi-fusion-v3.md](./DESIGN-pi-fusion-v3.md)  
> **原则：** 默认路径极简到极致；附加 Pack 完整且独特；用户可自建任何能力；不删代码

---

## 1. 产品定位（冻结）

**一句话：** 面向个人开发者和小团队的低成本、可靠、可控的桌面编程 Agent。

**核心哲学（Pi 融合）：**

> 默认只有基础功能 → 附加 Pack 完整且独特 → 用户可自建任何能力

**三句话总结：**
1. **默认只给编程最基础的工具**（≤10 个），省 token、降低模型误选
2. **提供独特的官方 Pack**（Multi-Agent/Goal/对抗审查），比用户自建更好用
3. **Pack 机制足够强**（Pi Extensions 风格），用户可以自建任何能力

### "Core 不做"清单（设计决策，非缺陷）

| 不做 | 理由 | 替代方案 |
|------|------|----------|
| 默认多 Agent 编排 | 实现方式太多 | `pack.multi-agent` 或用户自建 |
| 默认对抗审查 | 用户可自建跨模型流程 | `pack.adversarial-review` |
| 内置权限弹窗 | 固定规则更可控 | PermissionEngine |
| 自动任务规划 | 写 TODO.md 即可 | `pack.goal-advanced` |
| 浏览器自动化 | MCP 更灵活 | `pack.browser-web` |
| 动态信任升级 | 安全风险 | 固定规则 |
| 隐式经验推断 | 无证据 | Freeze |
| 内置工作流模板 | 用户需求各异 | Skill / Pack 生态 |

---

## 2. 四层架构

```text
┌──────────────────────────────────────────────────────┐
│ Core（默认开，极简）                                    │
│ 文件/Shell/Git/搜索（≤10 工具）、模型路由/Token、      │
│ 固定权限、Checkpoint、会话分支、项目规则、              │
│ ask_user、plan/todo、MCP 基础连接                      │
├──────────────────────────────────────────────────────┤
│ Extended Pack（默认关，中等偏下维护）                   │
│ Multi-Agent 协作、Goal 高级编排、对抗审查               │
│ 完整且独特，比用户自建更好用                            │
├──────────────────────────────────────────────────────┤
│ Standard Pack（默认关，冷处理）                         │
│ 浏览器/Web、代码地图、Trace/Scorecard、导入生态         │
│ 用户可自建，但预设更方便                                │
├──────────────────────────────────────────────────────┤
│ Freeze（停止接线）                                      │
│ 渐进信任、隐式适配、KG 高级算法、/goal 并行调度         │
└──────────────────────────────────────────────────────┘
```

### 层级决策原则

| 条件 | 归属 |
|------|------|
| 用户很难通过第三方 Skill/Pack 实现 + 编程场景基础 | **Core** |
| 用户能自建但预设更好用 + 有明确场景 | **Extended Pack** |
| 几乎用不到但有接入接口 + 用户可自建 | **Standard Pack**（冷处理） |
| 价值未证明 + 有更好替代 | **Freeze** |

### 层级定义

| 层 | 默认 | 维护策略 | 用户可见 | 删除门槛 |
|----|------|----------|----------|----------|
| **Core** | on | 主动强化、必须有测试 | 主界面 | 不可删 |
| **Extended Pack** | off | 中等偏下、修 bug、不扩新功能 | 设置页"高级"区 | 60 天零启用 |
| **Standard Pack** | off | 冷处理：仅修崩溃 | 设置页"扩展"区 | 90 天零启用 |
| **Freeze** | off | 停止一切接线 | 不出现 | 与清理窗口一起删 |

### 2.1 Core 能力明细

| 能力 | Pi 对标 | RouteDev 差异化 |
|------|---------|----------------|
| 文件 read/write/edit/search | ✅ 对标 | 加 code_search |
| Shell 执行 | ✅ bash 对标 | — |
| Git 操作 | ✅ 通过 bash | 独立 git 工具（更安全） |
| ask_user | ❌ Pi 不做 | 编程场景刚需 |
| plan/todo | ❌ Pi 不做 | 编程场景刚需 |
| 会话分支（tree/fork/clone） | ✅ 对标 | Electron UI 加持 |
| Checkpoint / 回滚 | ❌ Pi 不做 | 桌面应用特有需求 |
| 模型路由 + Token 可见 | ❌ Pi 不做 | **省钱核心差异化** |
| 固定权限 | ❌ Pi 用容器 | 固定规则更可控 |
| 项目规则 / 上下文压缩 | ✅ AGENTS.md | — |
| MCP 基础连接 | ❌ Pi 不做 | 扩展面基础 |

### 2.2 Extended Pack（中等偏下，修 bug 不扩功能）

| 包名 | 包含模块 | 启用方式 | 独特价值（用户自建做不到） |
|------|----------|----------|--------------------------|
| `pack.goal-advanced` | goal-runner 高级编排 + GoalVerifier | `/goal` 按需 | 深度集成 Agent Loop |
| `pack.multi-agent` | orchestrator + blackboard + worker + spawn_agent | 设置开关 | 共享上下文 + 冲突检测 |
| `pack.adversarial-review` | cross-model-reviewer + adversarial 逻辑 | `/review` | 跨 Provider 交叉验证 |

### 2.3 Standard Pack（冷处理，仅修崩溃）

| 包名 | 包含模块 | 启用方式 | 冷处理策略 |
|------|----------|----------|------------|
| `pack.browser-web` | browser / web_search / web_fetch | 设置开关 | 不加新爬取能力 |
| `pack.code-map` | code-map / code_graph_query | 首次启用索引 | 不加新语言 |
| `pack.harness` | trace-replayer / scorecard | `/replay` `/scorecard` | 不加新评分维度 |
| `pack.import-ecosystem` | cite / import / macros | 设置页导入区 | 不加新导入源 |
| `pack.compose` | compose-pipeline | Skill 或模板 | 不加新模板类型 |
| `pack.session-export` | HTML/JSONL 导出 | `/export` | 不加新格式 |

### 2.4 Freeze（停止接线）

| 模块 | 冻结原因 | 处理方式 |
|------|----------|----------|
| Progressive Trust 动态升级 | 安全框架反对 | 停止接线；保留类型 |
| Implicit Feedback | 无证据 | 停止接线；保留类型 |
| KG 高级算法（PageRank/社区检测） | tree-sitter+SQLite 已够 | 默认关；保留存储接口 |
| /goal 并行调度与冲突检测 | 无真实使用 | 冻结代码路径 |
| Compose 自动选择 | 应显式触发 | 移除自动路由 |

---

## 3. 会话分支（Core 新增能力）

> Pi 最有价值的设计之一。用户无法通过 Pack 自建，必须进 Core。

### 设计

```text
Checkpoint（已有）     Session Tree（新增）
    │                      │
    ▼                      ▼
工作区快照               消息树（id + parentId）
git stash 式             JSONL 树结构
线性回滚                 分支 + fork + 跳回
```

### 命令

| 命令 | 行为 | 对标 Pi |
|------|------|---------|
| `/tree` | 导航会话树，跳到任意历史点继续 | ✅ `/tree` |
| `/fork` | 从任意历史消息创建新会话 | ✅ `/fork` |
| `/clone` | 复制当前分支到新会话 | ✅ `/clone` |
| `/checkpoint` | 工作区快照 + 回滚（已有） | ❌ Pi 不做 |

### 实现策略

- 不替换 Checkpoint，与之并存
- 消息存储从线性数组改为树结构（向后兼容）
- ChatPage 增加树导航 UI（配合 Phase-74）

### 与 Pi 的区别

- Pi 纯 JSONL → 我们 SQLite + JSONL 双写（查询更快）
- Pi 无 Checkpoint → 我们分支 + Checkpoint 联动
- Pi TUI → 我们 Electron UI 做树视图

---

## 4. Pack 扩展能力升级（Pi Extensions 风格）

### 现状问题

当前 Pack 只是配置开关 + 条件装配。用户只能"启用/关闭"官方预设 Pack，无法自建。

### 升级设计

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
  tools: ToolRegistry;         // 注册/替换工具（新增）
  commands: CommandRegistry;   // 注册命令（新增）
  events: PackEventBus;        // 事件钩子（新增）
  config: AppConfig;           // 配置（已有）
  logger: Logger;              // 日志（已有）
  usage: UsageCounter;         // 使用计数（已有）
}
```

### 用户自建 Pack

```text
~/.routedev/
  packs/
    my-custom-pack/
      index.ts          // Pack 入口（与官方 Pack 同 API）
      pack.json         // 元数据

项目目录/
  .routedev/
    packs/
      project-pack/
        index.ts
        pack.json
```

自定义 Pack 与官方 Pack 使用完全相同的 API，享有同等能力。

### 与 Pi Extensions 的区别

| | Pi Extensions | RouteDev Pack |
|---|---------------|---------------|
| 权限 | 完全信任用户 | 受 PermissionEngine 管控 |
| MCP | 不做 | Core 内置 MCP 连接 |
| UI | TUI 组件 | Electron 设置面板 |
| 安装 | npm/git | npm/git + 本地目录 |
| 安全 | 用户自行负责 | 分层信任 |

---

## 5. 与 Phase-78 / Phase-79 的关系

### 5.1 Phase-78 落地映射

| Phase-78 建议 | v3 蓝图落地 |
|---------------|------------|
| 工具数量精简 | Core ≤10（Phase-81） |
| 多 Agent 简化 | Extended Pack（Phase-83） |
| KG 简化 | Freeze 高级算法（Phase-81） |
| 花架子移除 | Standard Pack 冷处理（Phase-81+82） |
| /goal 简化 | Extended Pack（Phase-83） |

### 5.2 Phase-79 收口

| TD | 四层归属 | 修正 |
|----|----------|------|
| TD-01 桌面入口集成测试 | Core | 保留 |
| TD-02 goal-runner 拆分 | Core→Extended Pack | 拆完 sequential 进 Pack |
| TD-03 PermissionEngine 接入 | Core | 保留 |
| TD-04 tool:execute 权限 | Core | 保留 |
| TD-05 auto + 子 Agent 确认 | Core(auto) / Extended Pack(subagent) | auto 仅白名单 |
| TD-06 TrustGradient | Freeze | 不做动态升级 |
| TD-07 IPC 校验中间件 | Core | 保留 |

---

## 6. Phase 路线图

| Phase | 主题 | 版本 | 核心目标 |
|-------|------|------|----------|
| **78** | 社区证据与瘦身方向 | — | 方向文档（已完成） |
| **79** | 技术债收尾与权限测试基建 | v4.6.0 | 7 项 TD 收尾；权限闭环；goal-runner 拆分 |
| **80** | 能力分层与使用遥测基线 | v4.6.x | 四层清单 + usage 计数 |
| **81** | 默认路径瘦身 | v4.7.0 | Core 工具 ≤10；路由 2-3 级；Freeze 退出默认 |
| **82** | Pack 机制落地 | v4.7.x | Pi Extensions 风格 API；≥6 个 Pack 迁移；用户自建支持 |
| **83** | Extended Pack 收口 | v4.8.0-rc | Multi-Agent/Goal/对抗审查独立 Pack |
| **84** | 会话分支 Core 落地 | v4.8.x | Session Tree + /tree /fork /clone |
| **85** | 验收基线与发布门禁 | v4.9.0 | 全部门禁通过；文档同步；tag v4.9.0 |

---

## 7. 成功指标（产品级）

| 指标 | 目标 |
|------|------|
| 默认注册工具数 | ≤ 10 |
| 默认启用配置开关数 | 较 v4.5.4 减少 ≥ 50% |
| 默认装配模块数 | 较 v4.5.4 减少 ≥ 30% |
| 单次典型改码 token | 相对 v4.5.4 下降 |
| 任务成功率 | 不下降 |
| Extended Pack 启用后完整 | 100% |
| Standard Pack 接口保留率 | 100% |
| 用户自建 Pack 可行性 | 官方 Pack 同 API |
| 会话分支可用 | /tree /fork /clone 闭环 |

---

## 8. 执行纪律

1. **先量后砍**：无调用日志不删生产模块
2. **冷处理优先于删除**：几乎用不到的进 Standard Pack，不删代码
3. **Core 变更必须有测试**
4. **Extended Pack 修 bug 不扩功能**
5. **Freeze 停止一切接线**
6. **新增功能默认 off 或进 Pack**
7. **Pack API 统一**：官方与自建使用相同接口
8. **禁止**以"看起来高级"为理由把 Freeze 拉回默认路径
9. **审查发现"功能缺失"时**：先查"Core 不做"清单，再决定是否实现

---

## 9. 建议立即停止的行为

- 给 Progressive Trust / Implicit Feedback 加产品化接线
- 扩 multi-agent 编排能力（Extended Pack 只修不扩）
- 给 /goal 加并行/冲突等重型编排（Freeze）
- 在默认工具集继续堆新工具
- 把审查报告里的"功能缺失"自动当成"必须补齐"
- 把 Pi 不做的事（sub-agent/plan/permission popup）当成 RouteDev 的缺陷
