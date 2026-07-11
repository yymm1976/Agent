# 会话分支（Session Tree）

> **Phase 84** 引入的会话树能力，支持在单一会话内创建多条分支，实现"假设探索"与"方案对比"。
> **相关源码：** `src/session/session-tree.ts` / `src/session/session-node.ts` / `src/session/session-commands.ts`

---

## 1. 什么是会话分支

会话分支把原本线性的对话历史组织成一棵**树**：

- 每条消息是一个节点（`SessionNode`），有零或一个父节点。
- 从任意节点可以**分叉（fork）**出新分支，新旧分支共享分叉点之前的所有节点。
- 可以**克隆（clone）**当前分支到独立的新会话树，用于跨会话复用。
- 可以**切换分支（switchBranch）**在多条探索路径之间来回对比。

典型价值：
- 尝试一种方案前先"留个档"，失败后可回到分叉点尝试另一条路。
- 同一问题并行探索两种思路，互不污染。
- 把某次成功的完整对话克隆出去作为模板复用。

> **向后兼容：** 旧线性消息可通过 `SessionTree.fromLinear()` 导入为单分支树，无需迁移。

---

## 2. 命令用法

### `/tree` — 查看会话树

展示当前会话的树结构，包括所有分支、分叉点、活跃分支高亮。

```
/tree
```

输出示例：

```
root
├── user: 帮我重构 auth 模块
└── assistant: 好的，我先看一下…
    ├── user: 试试 JWT 方案  [main]
    └── →user: 试试 session 方案  [a1b2c3d4]
```

- `→` 标记当前活跃节点
- 方括号内为分支标签（`main` 为初始分支，其余为 fork 生成的分支 ID 前缀）

### `/fork [nodeId]` — 从指定节点创建新分支

从 `nodeId` 处分叉出新分支，创建后自动切换到新分支。

```
/fork                          # 从当前活跃分支的最后一条用户消息 fork
/fork <nodeId>                 # 从指定节点 fork
```

- 不传 `nodeId` 时默认从当前活跃分支的**最后一条用户消息**分叉。
- 分叉后，新分支的初始叶节点就是 `nodeId`，后续消息将从这里延伸。

### `/clone` — 克隆当前分支到新会话树

深拷贝当前活跃分支（从根到叶的完整路径）到一个**新的 SessionTree 实例**。

```
/clone
```

- 新树所有节点 ID 重新生成，内容保持一致。
- 用于把当前探索路径独立保存为模板，或在另一个会话中继续推进。
- 原会话树不受影响。

### 切换分支

切换分支通过 `switchBranch(branchId)` 方法或对应 UI 完成（详见 ChatPage 树视图）。切换后，活跃分支变为目标分支，后续消息追加到目标分支末尾。

---

## 3. 与 Checkpoint 的配合

SessionNode 可携带 `checkpointId` 字段，关联到 CheckpointManager 的工作区快照：

- **fork 时**：新分支继承分叉点的 `checkpointId`，回滚时能还原到分叉前的工作区状态。
- **回滚到某节点**：若节点带 `checkpointId`，回滚会同时还原工作区文件；否则仅回滚对话历史。
- **clone 时**：`checkpointId` 一并复制到新树，但新树与原树共享同一份磁盘快照（不会重复创建 checkpoint）。

> **建议：** 在进行破坏性探索前，先确保当前叶节点带 checkpoint（可手动 `/checkpoint` 创建），这样 fork 后任一分支失败都能干净回滚。

---

## 4. 典型使用场景

### 场景一：方案 A/B 对比

```
用户：帮我优化这个数据库查询
Agent：（分析后给出方案 A）
/fork <方案A之前的节点>
用户：试试 B-tree 索引
Agent：（给出方案 B）
/tree            # 对比两条分支的最终方案
/switch <方案B分支ID>   # 采纳方案 B
```

### 场景二：安全探索破坏性重构

```
用户：把这个单体重构拆成微服务
/fork safe-point        # 先 fork 一个安全点
用户：尝试拆分 user 服务
Agent：（开始修改文件）
# 如果改崩了：
/switch <安全点分支ID>   # 回到安全点，文件也随 checkpoint 还原
```

### 场景三：克隆成功会话作为模板

```
# 当前会话完成了一次漂亮的 bug 排查流程
/clone                  # 克隆到新会话树
# 在新会话中继续基于这个模板排查类似 bug
```

### 场景四：多思路并行推进

```
/fork <思路1节点>       # 分叉思路 1
用户：用正则解决
/fork <根节点>          # 从根分叉思路 2
用户：用 parser 解决
/fork <根节点>          # 从根分叉思路 3
用户：用 AST 解决
# 三条分支独立推进，随时 /tree 查看 / /switch 切换
```

---

## 5. 与 Pi 的对比

RouteDev 的 Session Tree 借鉴了 Pi 的会话树概念，但在定位与实现上有差异：

| 维度 | Pi | RouteDev |
|------|----|----------|
| 定位 | 框架级核心抽象 | 编程 Agent 的探索辅助工具 |
| 持久化 | 内存为主 | JSONL + checkpoint 双轨 |
| 与工作区联动 | 无 | 通过 `checkpointId` 关联文件快照 |
| Clone 语义 | 分支复制 | 独立新树（跨会话复用） |
| 命令入口 | API | `/tree` `/fork` `/clone` slash 命令 + UI |

**核心差异：** RouteDev 的会话分支不仅管理对话历史，还通过 Checkpoint 联动工作区文件状态，使"方案探索"对代码文件也是可回滚的——这是编程场景特有的需求。

---

## 6. 相关文档

- `docs/CAPABILITY_LAYERS.md` — Session Tree 模块归属 Core 层（C-68 / C-69 / C-70）
- `CHANGELOG.md` — Phase 84 条目
- 源码：`src/session/session-tree.ts` / `session-node.ts` / `session-commands.ts`
