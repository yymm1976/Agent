# Phase 85 — 验收基线与发布门禁

> **Phase 类型：** 发布门禁（Release Gate）  
> **前置依赖：** Phase-79 至 84 全部完成  
> **目标版本：** v4.9.0  
> **核心目标：** 把"省钱好用"变成可重复验证的发布标准，防止复杂度回潮  
> **蓝图参考：** [BLUEPRINT-CORE-CAPABILITY-PACK-v3.md](./BLUEPRINT-CORE-CAPABILITY-PACK-v3.md)  
> **不做：** 不新增功能

---

## 可验证目标

| # | 目标 | 验证方式 |
|---|------|----------|
| 1 | 全部门禁脚本通过 | `pnpm verify:slimdown` 退出 0 |
| 2 | 场景验收清单全绿 | 手动/自动验收记录 |
| 3 | 指标对比 Phase-80 基线有记录 | 指标报告文件存在 |
| 4 | 文档与四层架构 + Pi 融合设计同步 | README/AGENTS/CODEMAP/CHANGELOG 一致性 |
| 5 | tag v4.9.0 | git tag 存在 |

---

## Task 1：自动化门禁

**文件：**
- 创建/修改：`scripts/verify-slimdown.ts`
- 修改：`package.json` 增加 `verify:slimdown` 脚本

门禁项：

| # | 检查项 | 阈值 | 四层对应 |
|---|--------|------|----------|
| 1 | `pnpm typecheck` + `pnpm typecheck:desktop` | 退出 0 | 全局 |
| 2 | `pnpm test` 核心套件 | 0 失败 | Core |
| 3 | 默认注册工具数 | ≤ 10 | Core |
| 4 | 默认 packs.* 全 false | 全 false | Extended + Standard |
| 5 | Freeze 模块无默认装配 | 0 个 Freeze 模块在 app-init 默认路径 | Freeze |
| 6 | Extended Pack 启用后功能完整 | 三个 Pack 各跑通冒烟测试 | Extended |
| 7 | Standard Pack 接口保留 | 所有 Standard Pack 模块文件存在 | Standard（冷处理不删） |
| 8 | 动态信任升级不可达 | 无 TrustGradient 生产调用 | Freeze |
| 9 | 会话分支可用 | /tree /fork /clone 冒烟测试通过 | Core |
| 10 | 用户自建 Pack 可加载 | 示例 Pack 加载成功 | Core（Pack API） |
| 11 | "Core 不做"清单写入 AGENTS.md | 文件检查 | Core |

- [ ] **Step 1: 实现脚本**
- [ ] **Step 2: 接入 package.json**
- [ ] **Step 3: 提交**

```powershell
git commit -m "chore(phase-85): v4.9.0 瘦身发布门禁脚本"
```

---

## Task 2：场景验收清单

**文件：**
- 创建：`routedev/docs/RELEASE_CHECKLIST_v4.9.md`

### Core 场景（必须通过）

| # | 场景 | 验收标准 |
|---|------|----------|
| 1 | 普通对话 + 流式输出 | 端到端可用 |
| 2 | 读文件 → 编辑 → 运行测试 → 解释 | 单 Agent 闭环 |
| 3 | 工具确认同意/拒绝 | 双向 IPC 正确 |
| 4 | Checkpoint 回滚 | 工作区干净检查 + git checkout |
| 5 | Token/预算可见 | 设置页 + 对话页均可见 |
| 6 | 权限固定规则 | deny/confirm/allow 按配置生效 |
| 7 | /tree 会话分支导航 | 跳转 + 继续对话 |
| 8 | /fork 创建新分支 | 新旧分支独立 |
| 9 | ask_user 交互 | 用户输入正确注入 |
| 10 | plan/todo 管理 | 任务列表闭环 |

### Extended Pack 场景（启用后必须通过）

| # | 场景 | Pack |
|---|------|------|
| 11 | /goal sequential 执行 | goal-advanced |
| 12 | spawn_agent 子 Agent | multi-agent |
| 13 | /review 对抗审查 | adversarial-review |

### Standard Pack 场景（启用后冒烟测试）

| # | 场景 | Pack |
|---|------|------|
| 14 | 浏览器工具可用 | browser-web |
| 15 | 代码地图索引 | code-map |
| 16 | Trace 回放 | harness |
| 17 | 会话导出 | session-export |

### 用户自建 Pack 场景

| # | 场景 | 标准 |
|---|------|------|
| 18 | 示例 Pack 加载 | 注册工具后在对话中可用 |
| 19 | Pack 加载失败 | fail-open + 日志记录 |

### Freeze 验证

| # | 检查项 | 标准 |
|---|--------|------|
| 20 | TrustGradient 动态升级不可达 | 无生产调用路径 |
| 21 | Implicit Feedback 不可达 | 无生产调用路径 |
| 22 | /goal 并行调度不可达 | 无生产调用路径 |

---

## Task 3：文档与审查基线同步

**文件：**
- `README.md` / `AGENTS.md` / `CODEMAP.md` / `CHANGELOG.md`
- `docs/CAPABILITY_LAYERS.md` / `SLIMDOWN_BOARD.md`
- `报告/RouteDev-*-审查提示词.md`

- [ ] **Step 1: README/AGENTS 更新**

产品描述：
- Core 极简 + 独特 Pack + 用户可自建
- 写入"Core 不做"清单
- 说明 Pack 扩展机制

- [ ] **Step 2: CODEMAP 同步**

每个模块标注四层归属。新增会话分支模块。

- [ ] **Step 3: CHANGELOG v4.9.0**

```markdown
## [4.9.0] - 2026-07-XX

### Breaking Changes
- 默认工具集从 26+ 收口至 ≤10（`tools.profile: core`）
- 路由简化为 2-3 级
- Multi-Agent / Goal 高级编排 / 对抗审查 默认关闭（Extended Pack）
- 浏览器/代码地图/Trace 等默认关闭（Standard Pack）
- Progressive Trust / Implicit Feedback / KG 高级算法冻结

### New
- 会话分支：/tree /fork /clone（Pi 风格）
- CapabilityPack API 升级（Pi Extensions 风格：工具/命令/事件钩子）
- 用户自建 Pack 支持（~/.routedev/packs/ 或 .routedev/packs/）
- 本地使用计数遥测（/usage）
- 设置页四层分组（基础/高级/扩展/实验）
- "Core 不做"清单正式化

### Removed from default
- 详见 SLIMDOWN_BOARD.md
```

- [ ] **Step 4: 审查提示词最终同步**

确保三份审查提示词引用 v4.9 的四层清单 + 会话分支 + Pack API。

- [ ] **Step 5: 提交**

```powershell
git commit -m "docs(phase-85): v4.9.0 文档与审查基线同步"
```

---

## Task 4：版本发布

- [ ] version → `4.9.0`
- [ ] `pnpm build` 成功
- [ ] `pnpm verify:slimdown` 全绿
- [ ] git tag `v4.9.0`

```powershell
git commit -m "release(phase-85): v4.9.0 极简 Core + 独特 Pack + 可自建"
git tag v4.9.0
```

---

## 指标报告

发布前记录以下指标，与 Phase-80 基线对比：

| 指标 | Phase-80 基线 | v4.9.0 目标 | 实际 |
|------|--------------|-------------|------|
| 默认注册工具数 | 26+ | ≤ 10 | |
| 默认启用配置开关数 | 记录值 | 减少 ≥ 50% | |
| 默认装配模块数 | 记录值 | 减少 ≥ 30% | |
| 单次典型改码 token | 记录值 | 下降 | |
| Extended Pack 数 | 0 | 3 | |
| Standard Pack 数 | 0 | ≥ 3 | |
| Freeze 模块数 | 0 | 明确记录 | |
| 会话分支可用 | 无 | /tree /fork /clone 闭环 | |
| 用户自建 Pack | 无 | 示例 Pack 可加载 | |

---

## 防回潮规则

写入 `AGENTS.md`：

1. 新功能默认 `enabled: false` 或进入 Pack
2. 想进 Core 必须提供：用户场景、费用影响、测试、为何不能 Pack
3. 审查发现"功能缺失"时先查"Core 不做"清单，再决定是否实现
4. Extended Pack 修 bug 不扩功能
5. Standard Pack 仅修崩溃
6. Freeze 模块停止一切接线
7. Pack API 统一：官方与自建使用相同接口
8. 用户自建 Pack 受 PermissionEngine 管控
