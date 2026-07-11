# Phase 81 — 默认路径瘦身与核心工具集

> **Phase 类型：** 产品瘦身（Default Path Slimdown）  
> **前置依赖：** Phase-80（四层清单 + 使用计数）  
> **目标版本：** v4.7.0  
> **核心目标：** 把默认路径压到"省钱好用"的最小闭环；非 Core 模块退出默认装配，进入冷处理外置包  
> **策略：冷处理不删除** —— 退注册 / 关配置 / 保留接口，代码不删  
> **蓝图参考：** [BLUEPRINT-CORE-CAPABILITY-PACK-v3.md](./BLUEPRINT-CORE-CAPABILITY-PACK-v3.md) §1 "Core 不做"清单

---

## 可验证目标

| # | 目标 | 验证方式 |
|---|------|----------|
| 1 | 默认注册工具 ≤ 10 | `pnpm test -- tests/tools/registry.test.ts` 断言 |
| 2 | 路由简化为 2–3 级 | 路由分类器测试覆盖 simple/complex/override |
| 3 | Freeze 模块退出默认装配 | app-init 无静态/动态 import Freeze 模块 |
| 4 | Standard Pack 模块退出默认装配 | 同上，但保留配置开关 |
| 5 | Extended Pack 模块退出默认装配 | 同上 |
| 6 | Core 场景回归不回归 | `pnpm test` 核心套件全绿 |

---

## Task 1：工具默认注册收口

**目标：** 默认 Core profile ≤ 10 个工具

**文件：**
- 修改：`src/runtime/app-init-tools.ts`
- 修改：`src/config/schema.ts` / `defaults.ts`
- 测试：`tests/tools/registry.test.ts`

- [ ] **Step 1: 定义工具 profile**

```ts
type ToolProfile = 'core' | 'full';
// core: ≤10 个，默认
// full: 兼容旧行为，仅调试用
```

- [ ] **Step 2: 依据 Phase-80 使用数据选择 Core 工具**

候选（最终以 usage 数据为准）：
1. file_read  
2. file_write（或 file_edit 二选一）  
3. file_search  
4. shell_exec  
5. git_op  
6. todo_write  
7. code_search（轻量）  
8. ask_user  
9. web_fetch（若 usage 高则留 Core，否则退 Pack）  
10. list_directory  

退 Pack 候选：`browser`、`code_graph_query`、`notes-tool`、`spawn_agent`、`repo-map`

- [ ] **Step 3: 默认只注册 Core profile 工具**

非 Core 工具保留源码，不删，但不出现在默认 ToolRegistry。

- [ ] **Step 4: 兼容开关 `tools.profile: core | full`**

`full` 可恢复旧注册面。不在 UI 主推。

- [ ] **Step 5: 测试**

- 默认 profile 工具数 ≤ 10  
- full profile 可恢复  
- 未注册工具调用返回明确错误

- [ ] **Step 6: 提交**

```powershell
git commit -m "refactor(phase-81): 默认工具集收口为 core profile ≤10"
```

---

## Task 2：路由简化

**目标：** 5 级优先级链 → 2–3 级

**文件：**
- 修改：`src/router/router.ts` / `classifier.ts` / `deterministic-rules.ts`
- 测试：`tests/router/` 相关

- [ ] **Step 1: 定义三级路由**

```text
simple   → 便宜模型
complex  → 强模型
override → 用户指定（最高优先级）
```

- [ ] **Step 2: 砍掉间接层**

- 置信度阈值微调层 → 简化或旁路  
- LLM 兜底分类器 → 旁路（除非 usage 数据证明有价值）

- [ ] **Step 3: 用户手动覆盖不被路由覆盖**

- [ ] **Step 4: 提交**

```powershell
git commit -m "refactor(phase-81): 路由简化为 2-3 级"
```

---

## Task 3：Freeze 模块退出默认装配

**目标：** Progressive Trust / Implicit Feedback / KG 高级算法停止接线

**文件：**
- 修改：`src/runtime/app-init*.ts`（移除/旁路 Freeze 模块装配）
- 修改：`src/config/defaults.ts`（相关配置强制 off 或标注 deprecated）

- [ ] **Step 1: TrustGradient 动态升级路径旁路**

保留 `src/tools/trust-gradient.ts` 文件与类型，但：
- 移除生产装配点
- 移除 Loop/PermissionEngine 中的消费调用
- 保留静态档位配置（可选）

- [ ] **Step 2: Implicit Feedback / Experience Adaptation 旁路**

同上：保留文件，移除装配。

- [ ] **Step 3: KnowledgeGraph 高级算法默认关**

- PageRank / 社区检测 / 置信衰减 → 配置门控，默认 off  
- 保留基础存储/查询接口

- [ ] **Step 4: 提交**

```powershell
git commit -m "refactor(phase-81): Freeze 模块退出默认装配"
```

---

## Task 4：Standard Pack / Extended Pack 模块退出默认装配

**目标：** 非 Core 模块全部退默认，保留接口

**文件：**
- 修改：`src/runtime/app-init*.ts`
- 修改：`src/config/defaults.ts`

**冷处理策略（不删代码）：**

| 模块 | 处理方式 |
|------|----------|
| browser/web_search/web_fetch | 保留文件 + 配置开关，默认不 register |
| code-map / code_graph_query | 保留文件 + 配置开关，默认不装配 |
| trace-replayer / scorecard | 保留文件 + 命令触发，默认不装配 |
| cite / import / macros | 保留文件 + 配置开关，默认不装配 |
| compose-pipeline | 保留文件 + 配置开关，默认 off |
| multi/* (orchestrator/blackboard) | 保留文件 + 配置开关，默认不装配 |
| cross-model-reviewer (adversarial) | 保留文件 + 配置开关，默认不装配 |
| spawn_agent | 保留文件，默认不注册到 ToolRegistry |

- [ ] **Step 1: 逐模块退注册**

每个模块：
1. 保留源文件与类型导出
2. 在 `app-init` 中改为条件装配（`if (config.packs.xxx.enabled)`）
3. `defaults.ts` 中对应配置默认 `false`
4. 配置 schema 中增加 `@deprecated` 注释或 `pack` 分组

- [ ] **Step 2: 测试**

- 默认启动后上述工具/命令不可达
- 配置 `enabled: true` 后可恢复
- Core 场景不受影响

- [ ] **Step 3: 提交**

```powershell
git commit -m "refactor(phase-81): 非 Core 模块退出默认装配（冷处理）"
```

---

## Task 5：设置页分层展示

**文件：**
- 修改：Settings 相关 Tab

- [ ] **Step 1: 分组**

- 基础区：模型、预算、权限、项目目录（Core）
- 高级区：Extended Pack 开关（goal-advanced / multi-agent / adversarial-review）
- 扩展区：Standard Pack 开关（browser / code-map / harness 等）
- 实验区：Freeze 项标注"不保证稳定，不推荐"

- [ ] **Step 2: 提交**

```powershell
git commit -m "feat(phase-81): 设置页按四层分组展示"
```

---

## 验收

- [ ] 默认工具 ≤ 10
- [ ] 路由 ≤ 3 级
- [ ] Freeze 模块无默认装配
- [ ] Standard/Extended Pack 模块无默认装配，接口保留
- [ ] Core 场景回归通过
- [ ] 设置页分层可见
- [ ] `CAPABILITY_LAYERS.md` + `SLIMDOWN_BOARD.md` 更新
- [ ] CHANGELOG 记录 breaking change

---

## 回滚策略

- `tools.profile: full` 一键恢复旧工具集
- 每个 Pack 配置 `enabled: true` 可恢复
- 本 Phase 不物理删除任何代码
