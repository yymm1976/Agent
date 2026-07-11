# Phase 84 — 会话分支 Core 落地

> **Phase 类型：** Core 能力新增（Core Feature）  
> **前置依赖：** Phase-83（Extended Pack 收口完成）  
> **目标版本：** v4.8.x  
> **核心目标：** 实现 Pi 风格的会话树（Session Tree），让用户可以在会话中分支、跳回、fork  
> **蓝图参考：** [BLUEPRINT-CORE-CAPABILITY-PACK-v3.md](./BLUEPRINT-CORE-CAPABILITY-PACK-v3.md) §3  
> **设计文档：** [DESIGN-pi-fusion-v3.md](./DESIGN-pi-fusion-v3.md) §3

---

## 可验证目标

| # | 目标 | 验证方式 |
|---|------|----------|
| 1 | 消息存储改为树结构（向后兼容） | `tests/session/session-tree.test.ts` 全绿 |
| 2 | `/tree` 命令可用 | 手动验收：导航 + 跳转 + 继续对话 |
| 3 | `/fork` 命令可用 | 手动验收：从历史消息创建新会话 |
| 4 | `/clone` 命令可用 | 手动验收：复制当前分支到新会话 |
| 5 | Checkpoint 与会话分支联动 | 分支切换后 Checkpoint 回滚正确 |
| 6 | ChatPage 树视图 UI | 手动验收：树导航可视化 |

---

## Task 1：消息树存储模型

**文件：**
- 创建：`src/session/session-tree.ts`
- 创建：`src/session/session-node.ts`
- 修改：`src/session/session-store.ts`（现有）
- 测试：`tests/session/session-tree.test.ts`

- [ ] **Step 1: 定义树节点**

```ts
interface SessionNode {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'toolResult' | 'system';
  content: any;
  timestamp: number;
  children: string[];  // 子节点 ID
  checkpointId?: string;  // 关联 Checkpoint（可选）
}
```

- [ ] **Step 2: 树结构操作**

- `getActiveBranch(): SessionNode[]` — 获取当前活跃分支（从根到叶）
- `fork(nodeId: string): string` — 从指定节点创建新分支，返回新分支 ID
- `clone(): string` — 复制当前分支
- `switchBranch(branchId: string): void` — 切换活跃分支

- [ ] **Step 3: 向后兼容**

- 现有线性消息自动作为单分支树导入
- 旧会话文件格式继续可读
- 新会话使用树结构存储

- [ ] **Step 4: 测试**

1. 线性消息 → 树结构转换正确
2. fork 创建新分支且不影响原分支
3. 分支切换后活跃分支消息序列正确
4. 多分支并发存在时数据隔离

- [ ] **Step 5: 提交**

```powershell
git commit -m "feat(phase-84): Session Tree 存储模型"
```

---

## Task 2：/tree /fork /clone 命令

**文件：**
- 修改：`desktop/main/engine-bridge.ts`（注册命令）
- 创建：`src/session/session-commands.ts`
- 测试：`tests/session/session-commands.test.ts`

- [ ] **Step 1: 实现 /tree 命令**

- 输出当前会话的分支结构（文本模式）
- 标注当前所在节点
- 支持 `--jump <nodeId>` 跳转到指定节点

- [ ] **Step 2: 实现 /fork 命令**

- 从当前消息或指定历史消息创建新分支
- 新分支继承到 fork 点的完整上下文
- fork 后的消息独立于原分支

- [ ] **Step 3: 实现 /clone 命令**

- 复制当前完整活跃分支到新会话
- 新会话包含完整历史

- [ ] **Step 4: Checkpoint 联动**

- 分支切换时，若有 Checkpoint 则提示用户是否回滚工作区
- fork 时可自动创建 Checkpoint（可配置）

- [ ] **Step 5: 测试**

1. /tree 输出正确的分支结构
2. /fork 后新旧分支独立
3. /clone 后新会话完整
4. 分支切换 + Checkpoint 联动正确

- [ ] **Step 6: 提交**

```powershell
git commit -m "feat(phase-84): /tree /fork /clone 命令实现"
```

---

## Task 3：ChatPage 树视图 UI

**文件：**
- 创建：`desktop/renderer/src/components/session/SessionTree.tsx`
- 创建：`desktop/renderer/src/components/session/SessionTreeNode.tsx`
- 修改：`desktop/renderer/src/components/chat/ChatPage.tsx`
- 修改：`desktop/renderer/src/stores/`（Zustand store）

- [ ] **Step 1: 树视图组件**

- 显示会话分支结构（折叠/展开）
- 当前活跃节点高亮
- 点击节点跳转到该位置继续对话
- 支持搜索/筛选（用户消息/助手消息/工具调用）

- [ ] **Step 2: IPC 通道**

- `session:tree` — 获取树结构
- `session:switch-branch` — 切换分支
- `session:fork` — 创建分支
- `session:clone` — 克隆分支

- [ ] **Step 3: 与 ChatPage 集成**

- 侧边栏或面板中显示树视图
- 切换分支时聊天区域平滑过渡
- 分支标记（颜色/标签）

- [ ] **Step 4: 提交**

```powershell
git commit -m "feat(phase-84): Session Tree UI 组件"
```

---

## Task 4：文档

- [ ] **Step 1: 用户文档**

`docs/session-tree.md`：
- 什么是会话分支
- /tree /fork /clone 命令用法
- 与 Checkpoint 的配合方式
- 典型使用场景

- [ ] **Step 2: 提交**

```powershell
git commit -m "docs(phase-84): 会话分支用户文档"
```

---

## 验收

- [ ] Session Tree 存储模型测试全绿
- [ ] /tree /fork /clone 命令手动验收通过
- [ ] ChatPage 树视图 UI 可用
- [ ] Checkpoint 联动正确
- [ ] 向后兼容：旧会话文件可读
- [ ] 文档完成

---

## 与 Pi 的对比

| 方面 | Pi | RouteDev |
|------|-----|----------|
| 存储 | 纯 JSONL 文件 | SQLite + JSONL 双写 |
| Checkpoint | 无 | 分支 + 工作区快照联动 |
| UI | TUI 树视图 | Electron 树视图（更直观） |
| 会话导出 | JSONL/HTML | Standard Pack（Phase-82） |

---

## 风险

- 树结构可能增加存储复杂度：先用简单实现验证，后续优化
- 分支过多时 UI 可能混乱：限制可见分支数 + 折叠策略
- Checkpoint 联动可能冲突：分支切换时明确提示用户选择
