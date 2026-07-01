# Phase 60 — 花架子去除工程（五）：A 档打磨与全量验收发布

> **版本目标：** v4.5.4（统一发版，Phase 56-59 不单独升版本号）
> **前置依赖：** Phase 56-59 全部完成
> **后继依赖：** 无（本 Phase 是花架子去除工程的收尾，发布版本）
> **核心约束：** 本 Phase 不新增功能，只做稳定性补强、文档同步、全量验证、版本发布。任何新功能想法记录到 backlog，不在本 Phase 实现。

---

## 目标与判定标准

**目标：** 完成花架子去除工程的最后一公里：核心模块稳定性测试补强、文档同步、`/dream` deprecated alias 删除、版本发布。

**判定标准：**
1. `pnpm typecheck` + `pnpm typecheck:desktop` + `pnpm test` 全绿
2. `pnpm build` 与 `pnpm dist:electron:safe` 构建成功
3. `package.json` version 升到 `4.5.4`
4. CHANGELOG.md 完整记录 Phase 56-59 的所有 breaking change
5. `rg "dream-to-graph|execution-router|level-path-router|self-evolution|dream-consolidator|eq-detector|EQDetector|GodelProposer|SelfHarnessLoop|SelfEvolutionFramework|persona-templates|routing-funnel|executePlanWithMultiAgent" src/` 无匹配
6. README.md 与 ARCHITECTURE.md 更新反映清理后的架构
7. git tag `v4.5.4` 已打并推送

---

## Task 1：核心模块稳定性测试补强

**目标：** 给 A 档核心模块补充边界测试，确保清理后无回归。

**文件：**
- 修改/新增：`tests/agent/path-router.test.ts` 补边界
- 修改/新增：`tests/memory/compress-enhanced.test.ts` 补 CCR 边界
- 修改/新增：`tests/cli/goal-runner.test.ts`（若无则新建）补路径选择
- 修改/新增：`tests/tools/security-enhanced.test.ts` 补安全默认启用

- [ ] **Step 1: PathRouter 边界测试**

打开 `tests/agent/path-router.test.ts`，补充：
- `mode: 'explicit'` + `explicitRoute: 'compose'` → 直接返回 compose
- `difficultyRoutingEnabled: true` 但 `plan.difficultyAssessment` 为 undefined → 走启发式
- 步骤数 = 0 → 返回 single（防边界崩溃）
- `detectLevelSwitch` contextUsageRatio = 0.84 → 不触发（边界值）

- [ ] **Step 2: CCR 边界测试**

打开 `tests/memory/compress-enhanced.test.ts`，补充：
- CCRCache 超过 maxSize 时的 LRU 淘汰验证
- `retrieveByPrefix` 精确 hash 优先于前缀匹配
- PreCompact 回调在阈值未超时不触发（已有，确认保留）

- [ ] **Step 3: goal-runner 路径选择测试**

若 `tests/cli/goal-runner.test.ts` 不存在，创建。补充：
- PathRouter 未注入 → 默认 single 路径
- `difficultyRouting.enabled: true` + L4 → compose 路径
- 动态升降级触发后重跑验证

基础骨架（若需新建）：

```ts
import { describe, it, expect } from 'vitest';
import { PathRouter } from '../../src/agent/path-router.js';
import type { GoalPlan } from '../../src/agent/goal-types.js';

describe('goal-runner 路径选择（Phase 60）', () => {
  it('PathRouter 未注入时默认 single 路径', () => { /* ... */ });
  it('difficultyRouting.enabled + L4 → compose 路径', () => { /* ... */ });
  it('动态升降级触发后重跑', () => { /* ... */ });
});
```

**前置依赖：** Phase 59 Task 2 Step 2.5 已实现 fail-open 守卫。若未实现，本步跳过并记录到 EXECUTION_REPORTS.md。

- [ ] **Step 4: 安全默认启用测试**

打开 `tests/tools/security-enhanced.test.ts`，补充：
- 默认配置下 `policyEngine` 装配验证
- `configGuard` 启用时拦截非法配置
- fail-open 守卫：安全模块装配失败不阻塞主流程

- [ ] **Step 4.5: 类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 5: 运行全量测试**

运行：`pnpm test`
预期：全绿，新增测试通过。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "test(phase-60): A 档核心模块边界测试补强

新增/补充：PathRouter 边界、CCR LRU、goal-runner 路径选择、安全默认启用
目标：清理后无回归，核心路径有测试保障"
```

---

## Task 2：删除 /dream deprecated alias

**文件：**
- 修改：`src/cli/commands/consolidate-memory.ts` 删除 dream alias
- 修改：`src/cli/commands/index.ts` 删除 dream 注册

- [ ] **Step 1: 删除 alias**

打开 `src/cli/commands/consolidate-memory.ts`，搜索 `dream` alias 注册（Phase 57 加的 deprecated alias），删除。

- [ ] **Step 2: 删除 index.ts 的 dream 注册**

打开 `src/cli/commands/index.ts`，搜索 `dream`，删除命令注册。

- [ ] **Step 3: 残留扫描**

```powershell
rg "commands/dream|alias.*dream" src/
```
预期：无匹配。

- [ ] **Step 4: 类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 4.5: 相关测试**

运行：`pnpm test -- tests/cli/command-registration.test.ts`
预期：通过。若失败，更新命令注册测试。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "refactor(phase-60): 删除 /dream deprecated alias

Phase 57 保留的兼容 alias 现已删除，/consolidate-memory 是唯一入口"
```

---

## Task 3：文档同步

**文件：**
- 修改：`README.md`
- 修改：`routedev/docs/ARCHITECTURE.md`
- 修改：`routedev/docs/ROUTING.md`（Phase 58 已部分更新）
- 修改：`routedev/CHANGELOG.md`
- 修改：`routedev/docs/DEAD_CODE_AUDIT.md`

- [ ] **Step 1: README.md 更新**

先扫描定位需修改的位置：
运行：`rg "self-evolution|dream|persona-templates|execution-router|level-path-router" README.md routedev/README.md -n`

根据扫描结果逐处修改：
- 删除 self-evolution / dream-consolidator / persona-templates / execution-router / level-path-router 的所有提及
- 路由描述改为"统一 PathRouter"
- 模块清单更新（删除已移除模块，新增 optional/ 说明）

- [ ] **Step 2: ARCHITECTURE.md 更新**

打开 `routedev/docs/ARCHITECTURE.md`，更新：
- Agent 层模块清单：删除 self-evolution / dream-consolidator / eq-detector / persona-templates
- 路由层描述：三套路由改为统一 PathRouter
- 新增 optional 目录说明（voice 在 optional/voice/）
- vision 默认关闭说明

- [ ] **Step 3: CHANGELOG.md 编写 v4.5.4 条目**

打开 `routedev/CHANGELOG.md`，新增 `## [4.5.4] - 2026-07-XX` 条目，汇总 Phase 56-60 所有变更。日期在 Task 4 发布时根据实际发布日填入：

```markdown
## [4.5.4] - 2026-07-XX（发布时填入实际日期）

### Breaking Changes
- 删除 `self-evolution/` 模块（selfEvolution/godelProposer/selfHarness 配置字段移除）
- 删除 `dream-consolidator.ts`（无入口模块）
- 删除 `eq-detector.ts`（接口不匹配）
- `/dream` 命令改名为 `/consolidate-memory`（deprecated alias 在 4.5.4 移除）
- `vision` 默认关闭，需显式 `vision.enabled: true`
- `executionRouter.mode: 'legacy'` 配置值移除，未注入路由器回退到 single
- 删除配置字段：routingFunnelEnabled/processEvaluation/archAwareMetrics/saturationMonitor/promptBuilderEnabled/requirementChangeEnabled/phase52Integration.mcpSecurity

### 默认启用
- policyEngine/auditChain/mcpSecurityScan/skillSecurityGate/configGuard（安全相关，原默认 false）

### 新增
- 统一 PathRouter（合并 execution-router + level-path-router）
- SettingsAdvancedIntegrationTab 设置页（7 个高级开关）
- vision.enabled 配置开关
- persona.systemPromptAppend 配置字段

### 移除
- executePlanWithMultiAgent（legacy 路径）
- persona-templates.ts（硬编码人格改为 config 驱动）
- ~3000+ 行死代码与花架子模块
```

- [ ] **Step 4: DEAD_CODE_AUDIT.md 更新**

打开 `routedev/docs/DEAD_CODE_AUDIT.md`，记录本轮清理的统计：删除文件数、删除行数、合并模块数。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "docs(phase-60): 文档同步花架子去除工程全部变更

更新：README.md/ARCHITECTURE.md/ROUTING.md/CHANGELOG.md/DEAD_CODE_AUDIT.md
记录：Phase 56-60 所有 breaking change、默认启用、新增、移除"
```

---

## Task 4：版本发布

**文件：**
- 修改：`routedev/package.json` version
- 修改：`routedev/package-lock.json`（若需要）

- [ ] **Step 1: 升版本号**

打开 `routedev/package.json`，把 `"version": "4.0.1"` 改为 `"version": "4.5.4"`。

- [ ] **Step 2: 全量构建验证**

```powershell
pnpm typecheck
pnpm typecheck:desktop
pnpm test
pnpm build
```
全部必须通过。若 `pnpm build` 失败，定位 tsup 配置问题。

- [ ] **Step 3: Electron 构建验证**

必须运行，若因代码签名/环境问题失败，记录到 EXECUTION_REPORTS.md 但不阻塞发布。

```powershell
pnpm dist:electron:safe
```
预期：构建成功，生成安装包。

- [ ] **Step 4: 残留花架子全量扫描**

```powershell
rg "dream-to-graph|execution-router|level-path-router|self-evolution|dream-consolidator|eq-detector|EQDetector|GodelProposer|SelfHarnessLoop|SelfEvolutionFramework|persona-templates|routing-funnel|executePlanWithMultiAgent" src/ desktop/
```
预期：无任何匹配。

- [ ] **Step 5: 提交版本号**

```powershell
git add -A
git commit -m "release(phase-60): v4.5.4 花架子去除工程收尾版

Phase 56-60 完成：D 档清除 + C 档收窄 + 路由合并 + B 档闭环 + A 档打磨
删除 ~3000 行死代码，统一路由，安全默认启用，文档同步"
```

- [ ] **Step 6: 打 tag 并推送**

```powershell
git tag v4.5.4
git push origin main
git push origin v4.5.4
```

---

## 边界条件

**构建失败回退：** 本 Phase 不改代码逻辑（除删 alias），构建失败大概率是前几个 Phase 的遗留问题。若 `pnpm build` 失败，回查 Phase 56-59 的 tsc 是否真通过。

**Electron 构建环境：** Windows 代码签名需要证书，若无证书 `dist:electron:safe` 可能只生成未签名包。这是预期行为，不阻塞发布。

**tag 冲突：** 若 `v4.5.4` tag 已存在（理论上不会），用 `v4.5.4-phase60` 或升到 `v4.5.5`。

**测试回归：** 若 Task 1 新增测试发现前几个 Phase 的 bug，优先修复 bug 再发布。若 bug 不影响核心路径，记录到 backlog 延后处理，本 Phase 仍按计划发布。

---

## 验收清单

- [ ] `pnpm typecheck` + `pnpm typecheck:desktop` + `pnpm test` 全绿
- [ ] `pnpm build` 成功
- [ ] `package.json` version = `4.5.4`
- [ ] `/dream` alias 已删除
- [ ] CHANGELOG.md 完整记录 Phase 56-60 变更
- [ ] README.md + ARCHITECTURE.md 已更新
- [ ] 残留花架子扫描无匹配
- [ ] git tag `v4.5.4` 已打并推送
- [ ] 已推送到 origin/main

---

## 花架子去除工程总结（Phase 56-60）

| Phase | 主题 | 删除行数 | 主要成果 |
|-------|------|----------|----------|
| 56 | D 档清除 | ~3000 | self-evolution + dream-consolidator + eq-detector |
| 57 | C 档收窄 | ~100（简化） | voice 移 optional、vision 默认关、dream 改名、persona 简化 |
| 58 | 路由合并 | ~200 + legacy 函数 | 统一 PathRouter，删除 executePlanWithMultiAgent |
| 59 | B 档闭环 | ~500（删字段+源文件） | 6 字段删除、5 安全字段默认启、7 字段补入口 |
| 60 | A 档打磨 | 0（只增测试与文档） | 边界测试、文档同步、v4.5.4 发布 |

**工程目标达成度：**
- ✅ 砍掉 D 档：self-evolution / dream-consolidator / eq-detector 全删
- ✅ 收窄 C 档：voice/vision/dream/persona 降级为可选能力
- ✅ 重点补 B 档：默认 false Integration 全部审判，安全默认启，实用补入口
- ✅ A 档打磨稳定：核心模块边界测试覆盖，文档同步，版本发布
