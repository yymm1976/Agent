# Phase 58 — 花架子去除工程（三）：路由合并与 legacy 路径删除

> **版本目标：** v4.5.2
> **前置依赖：** Phase 57 已完成
> **后继依赖：** Phase 59（B 档闭环）依赖本 Phase 完成的统一路由
> **核心约束：** 路由合并必须保持现有 `/goal` 命令的所有路径可达；legacy 删除前必须确认 `executionRouter` 未注入时不再走 legacy 而是回退到 single；合并后的路由器必须有单一真相源

---

## 目标与判定标准

**目标：** 解决"三套路由并存 + legacy 死代码"的技术债。合并 `execution-router.ts`（54 行）与 `level-path-router.ts`（55 行）为统一路由器，删除 `executePlanWithMultiAgent`（legacy 路径，`goal-runner.ts:1735` 起）。

**判定标准：**
1. `pnpm typecheck` + `pnpm test` 通过
2. `goal-runner.ts` 的 `case 'legacy'` 分支删除，未注入路由器时回退到 `'single'`
3. `execution-router.ts` 与 `level-path-router.ts` 合并为单一文件 `path-router.ts`，原两文件删除
4. `rg "executePlanWithMultiAgent" src/` 无匹配
5. 难度路由（L1-L5）与 router 模式（auto/explicit）在 ROUTING.md 中有 PathRouter 优先级章节（explicit > 难度路由 > 启发式）

---

## 现状与问题

**三套路由并存（Phase 55 调研结论）：**
```
goal-runner.ts:1027-1037 路径选择逻辑：
1. 若 difficultyRouting.enabled && plan.difficultyAssessment → levelPathRouter.selectPath() 优先
2. 否则 → executionRouter.route() 判定
3. executionRouter 未注入时 → 'legacy'
```

**问题：**
- `execution-router.ts`（54 行）和 `level-path-router.ts`（55 行）职责重叠：都是"输入条件 → 路径字符串"
- `level-path-router.ts:2` import `ExecutionRoute` 类型自 execution-router，强耦合
- `executePlanWithMultiAgent`（legacy 路径）有删除注释（`goal-runner.ts:1722`）但未执行
- `executionRouter` 未注入时落入 legacy 是隐患（用户不配路由器就走最老路径）

**合并后目标架构：**
```
统一 PathRouter（path-router.ts）：
  输入：plan + config + executionSignals
  输出：'single' | 'dag' | 'compose'
  逻辑：
    1. 若 difficultyRouting.enabled && plan.difficultyAssessment → L1-L5 映射
    2. 否则 → 旧 auto 模式（按步骤数/领域数判定）
    3. 未配置 → 默认 'single'
  动态升降级：detectLevelSwitch() 保留
```

---

## 源码接线点速查

| 接线点 | 文件 | 关键位置 | 动作 |
|--------|------|----------|------|
| ExecutionRouter 类 | `src/agent/execution-router.ts` | 全文件 | 合并到 path-router.ts 后删除 |
| LevelPathRouter 类 | `src/agent/level-path-router.ts` | 全文件 | 合并到 path-router.ts 后删除 |
| ExecutionRoute 类型 | `src/agent/execution-router.ts:7` | 类型定义 | 移到 path-router.ts，更新所有 import |
| 路径选择主逻辑 | `src/cli/goal-runner.ts:1027-1037` | if-else 链 | 改为 `pathRouter.selectPath()` 单一调用 |
| case 'legacy' | `src/cli/goal-runner.ts:1057-1058` | switch 分支 | 删除，default 改为回退 'single' |
| executePlanWithMultiAgent | `src/cli/goal-runner.ts:1735` 起 | 整个函数 | 删除 |
| legacyIterativeLoop | `src/cli/goal-runner.ts:759` | 降级 fallback | 保留（DualLoop 异常降级用，非 legacy 路径） |
| GoalRunnerDeps.executionRouter | `src/cli/goal-runner.ts` | deps 字段 | 改为 `pathRouter` |
| GoalRunnerDeps.levelPathRouter | `src/cli/goal-runner.ts` | deps 字段 | 删除，合并到 pathRouter |
| app-init.ts 装配 | `src/cli/app-init.ts` | 搜索 executionRouter\|levelPathRouter | 改为装配 PathRouter |
| 测试 | `src/agent/execution-router.test.ts`（若存在） | 整个文件 | 合并到 path-router.test.ts |
| 测试 | `tests/agent/execution-router.test.ts`（若存在） | 整个文件 | 合并到 path-router.test.ts |
| 测试 | `src/agent/level-path-router.test.ts`（若存在） | 整个文件 | 合并到 path-router.test.ts |
| 测试 | `tests/agent/level-path-router.test.ts`（若存在） | 整个文件 | 合并到 path-router.test.ts |

---

## Task 1：创建统一 PathRouter

**文件：**
- 创建：`src/agent/path-router.ts`
- 创建：`tests/agent/path-router.test.ts`（合并两测试）

- [ ] **Step 1: 创建 path-router.ts**

创建 `src/agent/path-router.ts`，合并两文件逻辑：

```ts
// src/agent/path-router.ts
// Phase 58：统一路径路由器，合并 execution-router + level-path-router
// 单一真相源：所有路径判定走这里

import type { GoalPlan } from './goal-types.js';
import type { DifficultyAssessment } from './difficulty-assessor.js';

export type ExecutionRoute = 'single' | 'dag' | 'compose';

export interface PathRouterConfig {
  mode: 'auto' | 'explicit';
  explicitRoute?: ExecutionRoute;
  singleAgentMaxSteps: number;
  dagMaxDomains: number;
  // 难度路由
  difficultyRoutingEnabled: boolean;
  dynamicLevelSwitchEnabled: boolean;
  confidenceThreshold: number;
}

export interface LevelSwitchSignals {
  failureCount: number;
  blockedSteps: number;
  contextUsageRatio: number;
}

export interface LevelSwitchSuggestion {
  from: number;
  to: number;
  reason: string;
}

export class PathRouter {
  constructor(private config: PathRouterConfig) {}

  /** 主入口：plan + 可选难度评估 → 路径 */
  selectPath(plan: GoalPlan): ExecutionRoute {
    if (this.config.mode === 'explicit' && this.config.explicitRoute) {
      return this.config.explicitRoute;
    }
    // 难度路由优先
    if (this.config.difficultyRoutingEnabled && plan.difficultyAssessment) {
      return this.selectByLevel(plan.difficultyAssessment.level);
    }
    // 旧 auto 模式（按步骤数/领域数）
    return this.selectByHeuristic(plan);
  }

  /** L1-L5 → 路径映射 */
  private selectByLevel(level: number): ExecutionRoute {
    if (level <= 2) return 'single';
    if (level === 3) return 'dag';
    return 'compose'; // L4-L5
  }

  /** 旧 auto 模式：按步骤数与领域数判定 */
  private selectByHeuristic(plan: GoalPlan): ExecutionRoute {
    const stepCount = plan.steps.length;
    const domains = new Set(plan.steps.map(s => s.domain || 'default')).size;
    if (stepCount <= this.config.singleAgentMaxSteps && domains <= 1) {
      return 'single';
    }
    if (domains <= this.config.dagMaxDomains) {
      return 'dag';
    }
    return 'compose';
  }

  /** 动态升降级检测（保留 level-path-router 原逻辑） */
  detectLevelSwitch(
    currentLevel: number,
    signals: LevelSwitchSignals,
  ): LevelSwitchSuggestion | null {
    if (!this.config.dynamicLevelSwitchEnabled) return null;
    if (signals.failureCount >= 2) {
      return { from: currentLevel, to: Math.min(5, currentLevel + 1), reason: '失败次数≥2' };
    }
    if (signals.blockedSteps > 0) {
      return { from: currentLevel, to: Math.min(5, currentLevel + 1), reason: '存在阻塞步骤' };
    }
    if (signals.contextUsageRatio >= 0.85) {
      return { from: currentLevel, to: Math.min(5, currentLevel + 1), reason: '上下文使用率≥85%' };
    }
    return null;
  }
}
```

- [ ] **Step 2: 合并测试到 path-router.test.ts**

创建 `tests/agent/path-router.test.ts`，把 `execution-router.test.ts` 和 `level-path-router.test.ts` 的测试用例合并，更新 import 到 `PathRouter`。覆盖：
- explicit 模式直接返回
- 难度路由 L1-L5 映射
- auto 模式按步骤数/领域数
- detectLevelSwitch 三种触发条件
- 未配置时默认 single

- [ ] **Step 3: 类型检查（此步只创建新文件，不删旧文件）**

运行：`pnpm typecheck`
预期：通过（新文件独立，不影响旧文件）。

- [ ] **Step 4: 运行新测试**

运行：`npx vitest run tests/agent/path-router.test.ts`
预期：全绿。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat(phase-58): 创建统一 PathRouter 合并 execution-router + level-path-router

合并逻辑：难度路由优先 > explicit > auto 启发式。
保留：detectLevelSwitch 动态升降级。
此步只新增，不删旧文件，下一 Task 切换接线后再删。"
```

---

## Task 2：goal-runner.ts 切换到 PathRouter

**文件：**
- 修改：`src/cli/goal-runner.ts:1027-1037` 路径选择逻辑
- 修改：`src/cli/goal-runner.ts` 的 GoalRunnerDeps 类型
- 修改：`src/cli/goal-runner.ts` 的 switch case

- [ ] **Step 1: 更新 GoalRunnerDeps**

打开 `src/cli/goal-runner.ts`，搜索 `GoalRunnerDeps` 接口定义。把 `executionRouter?: ExecutionRouter` 和 `levelPathRouter?: LevelPathRouter` 合并为 `pathRouter?: PathRouter`。删除两个旧 import，加 `import { PathRouter, PathRouterConfig } from '../agent/path-router.js'`。

- [ ] **Step 2: 更新路径选择逻辑**

定位 `:1027-1037` 的 if-else 链，替换为单一调用：
```ts
const defaultPathConfig: PathRouterConfig = {
  mode: config.goal.executionRouter.mode,
  explicitRoute: config.goal.executionRouter.explicitRoute,
  singleAgentMaxSteps: config.goal.executionRouter.singleAgentMaxSteps,
  dagMaxDomains: config.goal.executionRouter.dagMaxDomains,
  difficultyRoutingEnabled: config.goal.difficultyRouting?.enabled ?? false,
  dynamicLevelSwitchEnabled: config.goal.difficultyRouting?.dynamicLevelSwitchEnabled ?? false,
  confidenceThreshold: config.goal.difficultyRouting?.confidenceThreshold ?? 0.6,
};
const route: ExecutionRoute = (pathRouter ?? new PathRouter(defaultPathConfig)).selectPath(plan);
```

- [ ] **Step 3: 删除 case 'legacy'**

定位 `:1057-1058` 的 `case 'legacy':` 分支，删除。switch 的 `default:` 改为回退到 `'single'`：
```ts
default:
  await executePlanWithSingleAgent(plan);
```

- [ ] **Step 4: 删除 executePlanWithMultiAgent 函数**

定位 `:1735` 起的 `executePlanWithMultiAgent` 函数，整函数删除。搜索函数内是否有被其他地方调用（应该只有 case 'legacy' 调用，已删）。

- [ ] **Step 5: 更新动态升降级调用**

搜索 `levelPathRouter.detectLevelSwitch` 在 goal-runner.ts 中的调用，改为 `pathRouter.detectLevelSwitch`。参数类型适配 `LevelSwitchSignals`。

旧调用 `levelPathRouter.detectLevelSwitch(plan.difficultyAssessment.level, { failureCount, blockedSteps, contextUsageRatio })` 的参数结构与新 `LevelSwitchSignals` 接口字段一致（failureCount/blockedSteps/contextUsageRatio），直接改方法名为 `pathRouter.detectLevelSwitch` 即可，无需重构参数。

- [ ] **Step 6: 类型检查**

运行：`pnpm typecheck`
预期：通过。若报错，根据报错清理残留 import 后重新运行直至通过。

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "refactor(phase-58): goal-runner 切换到 PathRouter，删除 legacy 路径

改动：
- GoalRunnerDeps: executionRouter + levelPathRouter 合并为 pathRouter
- 路径选择: if-else 链改为 pathRouter.selectPath() 单一调用
- 删除 case 'legacy' 分支，default 回退到 single
- 删除 executePlanWithMultiAgent 函数（legacy 路径实现）
- detectLevelSwitch 改调 pathRouter"
```

---

## Task 3：app-init.ts 装配 PathRouter + 删除旧路由文件

**文件：**
- 修改：`src/cli/app-init.ts` 装配逻辑
- 修改：`src/cli/service-context.ts` 字段
- 删除：`src/agent/execution-router.ts`
- 删除：`src/agent/level-path-router.ts`
- 删除：`src/agent/execution-router.test.ts`（若存在）
- 删除：`src/agent/level-path-router.test.ts`（若存在）
- 删除：`tests/agent/execution-router.test.ts`（若存在）
- 删除：`tests/agent/level-path-router.test.ts`（若存在）

- [ ] **Step 1: 更新 app-init.ts 装配**

打开 `src/cli/app-init.ts`，搜索 `executionRouter` 和 `levelPathRouter` 的装配点。改为：

注意：配置字段名 `executionRouter` 保留不变（向后兼容），仅类名改为 PathRouter。用户旧 config 的 `goal.executionRouter` 字段无需改动。

```ts
import { PathRouter } from '../agent/path-router.js';
// ...
const pathRouter = new PathRouter({
  mode: config.goal.executionRouter.mode,
  explicitRoute: config.goal.executionRouter.explicitRoute,
  singleAgentMaxSteps: config.goal.executionRouter.singleAgentMaxSteps,
  dagMaxDomains: config.goal.executionRouter.dagMaxDomains,
  difficultyRoutingEnabled: config.goal.difficultyRouting?.enabled ?? false,
  dynamicLevelSwitchEnabled: config.goal.difficultyRouting?.dynamicLevelSwitchEnabled ?? false,
  confidenceThreshold: config.goal.difficultyRouting?.confidenceThreshold ?? 0.6,
});
// 注入到 goalRunner deps
```

- [ ] **Step 2: 更新 service-context.ts**

打开 `src/cli/service-context.ts`，把 `executionRouter` 和 `levelPathRouter` 字段合并为 `pathRouter`。

- [ ] **Step 2.5: 更新 state-migration.ts 的 import 路径**

打开 `src/agent/state-migration.ts`，搜索 `LevelSwitchSuggestion|level-path-router`，把 import 路径从 `'./level-path-router.js'` 改为 `'./path-router.js'`。若还有 `ExecutionRoute` 类型引用，同样改为从 `'./path-router.js'` 导入。

- [ ] **Step 3: 删除旧路由文件与测试**

```powershell
Remove-Item src/agent/execution-router.ts
Remove-Item src/agent/level-path-router.ts
Remove-Item src/agent/execution-router.test.ts -ErrorAction SilentlyContinue
Remove-Item src/agent/level-path-router.test.ts -ErrorAction SilentlyContinue
Remove-Item tests/agent/execution-router.test.ts -ErrorAction SilentlyContinue
Remove-Item tests/agent/level-path-router.test.ts -ErrorAction SilentlyContinue
```

- [ ] **Step 4: 残留扫描**

```powershell
rg "execution-router|level-path-router|ExecutionRouter|LevelPathRouter" src/ desktop/
```
预期：无匹配（path-router.ts 内部不引用旧名）。若有匹配，更新 import。

- [ ] **Step 5: 类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 6: 全量测试**

运行：`pnpm test`
预期：全绿。

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "refactor(phase-58): 删除 execution-router + level-path-router，统一到 PathRouter

删除：execution-router.ts(54行) + level-path-router.ts(55行) + 两测试文件
更新：app-init.ts 装配 PathRouter；service-context.ts 字段合并
结果：路由单一真相源，legacy 路径彻底移除"
```

---

## Task 4：全量验证与文档更新

- [ ] **Step 1: 全量类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 2: 全量测试**

运行：`pnpm test`
预期：全绿。

- [ ] **Step 3: 更新 ROUTING.md**

打开 `routedev/docs/ROUTING.md`，更新路由章节，删除"三套路由并存"描述，改为"统一 PathRouter"架构图与优先级文档。

- [ ] **Step 4: 推送**

```powershell
git push origin main
```

---

## 边界条件

**legacy 删除的回退安全：** `executePlanWithMultiAgent` 删除后，`executionRouter` 未注入时回退到 `'single'`。`single` 路径（`executePlanWithSingleAgent`）是稳定的兜底，所有 plan 都能走。但需确认 `legacyIterativeLoop`（`:759`）不是 legacy 路径专属——它是 DualLoop 异常降级用，保留。

**动态升降级状态迁移：** `state-migration.ts` 的 `migrate()` 仍依赖 `LevelSwitchSuggestion` 类型。合并后该类型从 `path-router.ts` 导出，`state-migration.ts` 的 import 路径需更新。

**配置字段保留：** `config.goal.executionRouter.mode` 仍保留（auto/explicit），但 `mode: 'legacy'` 值在 Zod schema 中移除（改为 enum `['auto', 'explicit']`）。用户旧 config 若有 `mode: 'legacy'`，Zod 报错，需手动改为 `'auto'`。在 CHANGELOG 标注。

---

## 验收清单

- [ ] `pnpm typecheck` + `pnpm test` 通过
- [ ] `execution-router.ts` 与 `level-path-router.ts` 已删除
- [ ] `executePlanWithMultiAgent` 已删除
- [ ] `case 'legacy'` 分支已删除
- [ ] `rg "execution-router|level-path-router|executePlanWithMultiAgent" src/` 无匹配
- [ ] ROUTING.md 已更新
- [ ] 已推送到 origin/main
- [ ] CHANGELOG 标注 `mode: 'legacy'` 配置值移除
