# Phase 56 — 花架子去除工程（一）：D 档清除

> **版本目标：** v4.5.0
> **前置依赖：** Phase 55 已完成并推送（commit `0efa20d`）
> **后继依赖：** Phase 57（C 档收窄）依赖本 Phase 完成的清理
> **核心约束：** 删除前必须确认无运行时引用；每步提交后 `tsc --noEmit` 必须通过；删除的测试不补回；删除的配置字段不保留 deprecated 兼容层
> **本 Phase 不做：** 不收窄 C 档（voice/vision/persona），不合并路由（Phase 58），不动默认 false 的 Integration（Phase 59）

---

## 目标与判定标准

**目标：** 删除三组确认无价值或接口不匹配的"真花架子"模块，减少 ~3000 行死代码与一个接口不匹配的隐患。

**判定标准（三个必须同时满足）：**
1. `pnpm typecheck` 通过
2. `pnpm test` 全绿（删除的测试不计）
3. `rg "self-evolution|dream-consolidator|eq-detector|EQDetector|GodelProposer|SelfHarnessLoop|SelfEvolutionFramework" src/ desktop/` 无任何匹配（确认无残留引用）

---

## 删除清单与依据

| # | 模块 | 行数 | 删除依据 |
|---|------|------|----------|
| 1 | `src/agent/self-evolution/` 全目录 | 2387 | 内部默认 `enabled: false`（`self-evolution/types.ts:142`）与外部接线 `enabled: true`（`defaults.ts:603,632,643`）矛盾；无独立 CLI 入口；`dual-loop-orchestrator.ts` 内部消费但无用户可见产物；研究性模块，生产价值低 |
| 2 | `src/agent/dream-consolidator.ts` | 359 | 无独立命令入口（仅 app-init 装配）；功能与 `memory/dream-to-graph.ts` 重叠；"梦境整合"拟人化命名无产品价值 |
| 3 | `src/agent/eq-detector.ts` | 221 | 接口不匹配：`app-init.ts:1644` 期望 `getHandler()` 方法但类中不存在（`eq-detector.ts:51`），运行时未实际接入中间件管线；编程场景情绪检测价值低 |

**保留：** `src/agent/memory/dream-to-graph.ts`（236 行）—— 有 `/dream` 命令入口，Phase 57 改名收窄，本 Phase 不动。

---

## 源码接线点速查

| 接线点 | 文件 | 关键位置 | 动作 |
|--------|------|----------|------|
| self-evolution 静态 import | `src/cli/app-init.ts` | `:112-114` | 删除 import 与装配块 |
| self-evolution 在 dual-loop 消费 | `src/agent/dual-loop-orchestrator.ts` | `:77-81` | 删除 import 与所有 `framework`/`godelProposer`/`selfHarness` 调用 |
| dream-consolidator import | `src/cli/app-init.ts` | `:55` | 删除 import 与装配 |
| dream-consolidator 类型 | `src/cli/service-context.ts` | `:18` | 删除 type import 与字段 |
| eq-detector 动态 import | `src/cli/app-init.ts` | `:1642-1660` | 删除动态 import 块与 `setEQDetector` 注入 |
| EQDetector setter | `src/agent/loop.ts` | 搜索 `setEQDetector` | 删除 setter 方法与相关字段 |
| phase52Integration 配置字段 | `src/config/defaults.ts` | `:603,632,643` | 删除 selfEvolution/godelProposer/selfHarness 三块 |
| phase52Integration schema | `src/config/schema.ts` | 搜索 `selfEvolution\|godelProposer\|selfHarness` | 删除对应 schema 字段 |
| 测试文件 | `tests/agent/self-evolution/` | 整个目录 | 删除 |

---

## Task 1：删除 self-evolution 目录与所有引用

**文件：**
- 删除：`src/agent/self-evolution/framework.ts`
- 删除：`src/agent/self-evolution/godel-proposer.ts`
- 删除：`src/agent/self-evolution/self-harness-loop.ts`
- 删除：`src/agent/self-evolution/types.ts`
- 删除：`tests/agent/self-evolution/` 整个目录
- 修改：`src/cli/app-init.ts:112-114` 及装配块
- 修改：`src/agent/dual-loop-orchestrator.ts:77-81` 及所有消费点
- 修改：`src/config/defaults.ts:603,632,643`
- 修改：`src/config/schema.ts` 对应字段

- [ ] **Step 1: 删除 self-evolution 目录与测试**

```powershell
Remove-Item -Recurse -Force src/agent/self-evolution
Remove-Item -Recurse -Force tests/agent/self-evolution
```

- [ ] **Step 2: 清理 app-init.ts 的静态 import 与装配**

打开 `src/cli/app-init.ts`，定位 `:112-114` 的三行 import：
```ts
import { SelfEvolutionFramework } from '../agent/self-evolution/framework.js';
import { GodelProposer } from '../agent/self-evolution/godel-proposer.js';
import { SelfHarnessLoop } from '../agent/self-evolution/self-harness-loop.js';
```
删除这三行。然后搜索 `SelfEvolutionFramework|GodelProposer|SelfHarnessLoop` 在本文件的所有使用点，删除装配块（if 判定 + new + setter 注入）。

- [ ] **Step 3: 清理 dual-loop-orchestrator.ts 的消费**

打开 `src/agent/dual-loop-orchestrator.ts`，定位 `:77-81` 的 import 块，删除。搜索 `framework|godelProposer|selfHarness|EvolutionSignal` 在本文件的所有使用，删除调用点（保留外循环主流程逻辑，self-evolution 只是旁路调用，删除不影响主路径）。

- [ ] **Step 4: 清理 defaults.ts 的 phase52Integration 字段**

打开 `src/config/defaults.ts`，定位 `:603` 附近的 `selfEvolution` 块、`:632` 附近的 `godelProposer` 块、`:643` 附近的 `selfHarness` 块，整块删除。

- [ ] **Step 5: 清理 schema.ts 的对应字段**

打开 `src/config/schema.ts`，搜索 `selfEvolution|godelProposer|selfHarness`，删除对应 schema 字段定义。

- [ ] **Step 6: 局部残留扫描**

运行：`rg "SelfEvolutionFramework|GodelProposer|SelfHarnessLoop|self-evolution" src/`
预期：无匹配。若有匹配，定位并清理。

- [ ] **Step 7: 类型检查**

运行：`pnpm typecheck`
预期：通过。若报错，根据报错定位残留引用并清理。

- [ ] **Step 8: 相关测试**

运行：`pnpm test -- tests/agent/dual-loop-orchestrator.test.ts tests/cli/app-init.test.ts`
预期：通过。若失败，根据报错清理残留引用。

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "refactor(phase-56): 删除 self-evolution 模块（2387 行死代码）

依据：内部默认 enabled:false 与外部接线 enabled:true 矛盾；无独立 CLI 入口；dual-loop 内部消费无用户可见产物；研究性模块生产价值低。
删除：src/agent/self-evolution/ 全目录 + tests/agent/self-evolution/
清理：app-init.ts 装配、dual-loop-orchestrator.ts 消费、defaults.ts/schema.ts 配置字段"
```

---

## Task 2：删除 dream-consolidator.ts 与所有引用

**文件：**
- 删除：`src/agent/dream-consolidator.ts`
- 修改：`src/cli/app-init.ts:55`
- 修改：`src/cli/service-context.ts:18` 及对应字段
- 保留：`src/agent/memory/dream-to-graph.ts`（Phase 57 处理）

- [ ] **Step 1: 删除源文件**

```powershell
Remove-Item src/agent/dream-consolidator.ts
```

- [ ] **Step 2: 清理 app-init.ts**

打开 `src/cli/app-init.ts`，定位 `:55` 的 import，删除。搜索 `DreamConsolidator` 在本文件的所有使用，删除装配块。

- [ ] **Step 3: 清理 service-context.ts**

打开 `src/cli/service-context.ts`，定位 `:18` 的 type import，删除。搜索 `dreamConsolidator|DreamConsolidator` 在本文件的所有字段定义，删除。

- [ ] **Step 4: 验证 dream-to-graph.ts 是否引用 dream-consolidator**

运行：`rg "dream-consolidator" src/agent/memory/dream-to-graph.ts`
根据结果处理：
- 若有 `import type { DreamResult } from '../../agent/dream-consolidator.js'`，将 DreamResult 类型内联到 dream-to-graph.ts。DreamResult 字段定义从 dream-consolidator.ts 读取后内联为本地 interface。
- 若无匹配，跳过本步。

- [ ] **Step 5: 局部残留扫描**

运行：`rg "DreamConsolidator|dream-consolidator" src/`
预期：无匹配。若有匹配，定位并清理。

- [ ] **Step 6: 类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "refactor(phase-56): 删除 dream-consolidator.ts（359 行无入口模块）

依据：无独立命令入口（仅 app-init 装配）；功能与 memory/dream-to-graph.ts 重叠；拟人化命名无产品价值。
保留：dream-to-graph.ts（有 /dream 命令入口，Phase 57 改名收窄）"
```

---

## Task 3：删除 eq-detector.ts 与所有引用

**文件：**
- 删除：`src/agent/eq-detector.ts`
- 修改：`src/cli/app-init.ts:1642-1660`
- 修改：`src/agent/loop.ts` 的 `setEQDetector` 方法

- [ ] **Step 1: 删除源文件**

```powershell
Remove-Item src/agent/eq-detector.ts
```

- [ ] **Step 2: 清理 app-init.ts 的动态 import 块**

打开 `src/cli/app-init.ts`，定位 `:1642-1660` 的动态 import 块。该块结构为：
```ts
if (config?.eq?.enabled !== false) {
  await import('../agent/eq-detector.js').then(m => {
    const detector = new m.EQDetector(...);
    agentLoop.setEQDetector(detector);
  }).catch(...);
}
```
（实际字段名以文件为准，先 Read 确认）整块删除。

- [ ] **Step 3: 清理 loop.ts 的 setter**

打开 `src/agent/loop.ts`，搜索 `setEQDetector|eqDetector|EQDetector`，删除 setter 方法、字段定义、以及 run() 中对 eqDetector 的调用（若有）。

- [ ] **Step 4: 局部残留扫描**

运行：`rg "EQDetector|eq-detector|setEQDetector" src/`
预期：无匹配。若有匹配，定位并清理。

- [ ] **Step 5: 类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "refactor(phase-56): 删除 eq-detector.ts（221 行接口不匹配模块）

依据：app-init.ts:1644 期望 getHandler() 方法但 EQDetector 类不存在该方法；运行时未实际接入中间件管线；编程场景情绪检测价值低。"
```

---

## Task 4：全量验证与残留扫描

- [ ] **Step 1: 残留引用扫描**

```powershell
rg "self-evolution|dream-consolidator|eq-detector|EQDetector|GodelProposer|SelfHarnessLoop|SelfEvolutionFramework" src/ desktop/
```
预期：无任何匹配。若有匹配，定位并清理。

- [ ] **Step 2: 全量类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 3: 全量测试**

运行：`pnpm test`
预期：全绿（删除的测试不计）。

- [ ] **Step 4: 统计删除行数**

```powershell
git diff --stat HEAD~3 HEAD
```
记录删除行数到 EXECUTION_REPORTS.md。

- [ ] **Step 5: 推送**

```powershell
git push origin main
```

---

## 边界条件

**构建失败回退：** 每个 Task 独立提交，失败时 `git revert HEAD` 回到上一稳定态。Task 1 最大（2387 行删除），若 dual-loop-orchestrator.ts 清理后外循环主流程报错，优先检查是否误删了外循环核心逻辑（self-evolution 应该只是旁路调用）。

**接口不匹配隐患：** eq-detector.ts 的删除理论上无运行时影响（接口本就不匹配），但若 `setEQDetector` 在 loop.ts 中有非空实现（不只是空 setter），需确认其内部状态是否被其他路径读取。

**配置向后兼容：** 删除 schema 字段后，用户旧 config.yaml 若含这些字段会被 Zod 拒绝。不保留 deprecated 兼容层（约束明确），用户需手动清理 config。在 CHANGELOG.md 标注 breaking change。

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿
- [ ] 残留引用扫描无匹配
- [ ] 三个 Task 各自独立提交，commit message 清晰
- [ ] 已推送到 origin/main
- [ ] CHANGELOG.md 标注 breaking change（删除的配置字段）
