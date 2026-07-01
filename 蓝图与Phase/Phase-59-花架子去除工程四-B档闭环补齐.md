# Phase 59 — 花架子去除工程（四）：B 档闭环补齐（默认 false Integration 审判）

> **版本目标：** v4.5.3
> **前置依赖：** Phase 58 已完成
> **后继依赖：** Phase 60（A 档打磨）依赖本 Phase 完成的配置审计
> **核心约束：** 每个默认 false 的 Integration 必须二选一：① 补入口（设置页 + 默认策略）② 删除代码。不允许"写了但不接入也不删"的第三种状态。判定优先级：安全相关默认启用 > 实用相关补入口 > 学术/边缘删除

---

## 目标与判定标准

**目标：** 清算 `defaults.ts` 中所有 `*Integration.enabled: false` 字段，每个字段给出明确处置：删除 / 默认启用 / 补设置页入口。消灭"幽灵功能"。

**判定标准：**
1. `pnpm typecheck` + `pnpm test` 通过
2. `defaults.ts` 中每个 `*Integration` 字段都有处置记录（见下表）
3. 所有"补入口"的字段在 `desktop/renderer/src/pages/SettingsPage.tsx` 有对应 Tab 或控件
4. 所有"删除"的字段在 `rg` 扫描中无残留引用
5. 安全相关（policyEngine/auditChain/mcpSecurityScan/skillSecurityGate/configGuard）默认 `true`

---

## Integration 字段审判表

基于 Phase 55 调研结论，逐字段处置如下：

### 批次 1：删除（确认无价值或已被替代）

| 字段 | 文件:行 | 删除依据 |
|------|---------|----------|
| `phase49Integration.routingFunnelEnabled` | `defaults.ts:490` | `routing-funnel.ts` 文件已在 Phase 50 删除（git status 显示 D），字段是僵尸配置 |
| `phase52Integration.processEvaluation.enabled` | `defaults.ts:587` | 学术评估指标，无用户可见产物 |
| `phase52Integration.archAwareMetrics.enabled` | `defaults.ts:619` | 学术指标，无用户可见产物 |
| `phase52Integration.saturationMonitor.enabled` | `defaults.ts:625` | 饱和度监控无消费方 |
| `goalIntegration.promptBuilderEnabled` | `defaults.ts:457` | goal-prompt-builder.ts 装配但无用户感知，与 prompts/manager.ts 职责重叠 |
| `goalIntegration.requirementChangeEnabled` | `defaults.ts:458` | requirement-change.ts 装配但无入口，需求变更流程未产品化 |

### 批次 2：默认启用（安全相关，应有而未启）

| 字段 | 文件:行 | 启用依据 |
|------|---------|----------|
| `phase53Integration.policyEngine.enabled` | `defaults.ts:668` | Intent Guard + Playbook 是安全核心，Phase 53 写了却默认关 |
| `phase53Integration.auditChain.enabled` | `defaults.ts:675` | 审计链路是合规核心，默认关导致操作无记录 |
| `phase53Integration.mcpSecurityScan.enabled` | `defaults.ts:681` | MCP 工具安全扫描，默认关等于不扫描 |
| `phase53Integration.skillSecurityGate.enabled` | `defaults.ts:687` | Skill 安全校验，默认关等于不校验 |
| `phase53Integration.configGuard.enabled` | `defaults.ts:693` | 配置守卫，默认关等于不守护 |

### 批次 3：补设置页入口（实用但需用户显式开启）

| 字段 | 文件:行 | 处置 |
|------|---------|------|
| `phase49Integration.skillFlowEnabled` | `defaults.ts:485` | 保留 false，在设置页 Phase49 Tab 加开关 |
| `phase49Integration.contextUsagePanelEnabled` | `defaults.ts:488` | 保留 false，在设置页加开关 |
| `phase49Integration.evaluationFrameworkEnabled` | `defaults.ts:489` | 保留 false，在设置页加开关 |
| `phase52Integration.skillLifecycle.enabled` | `defaults.ts:580` | 保留 false，在设置页加开关 |
| `phase52Integration.mcpSecurity.enabled` | `defaults.ts:656` | 与 phase53Integration.mcpSecurityScan 重复，**删除本字段**（保留 53 的） |
| `phase53Integration.prefixCache.enabled` | `defaults.ts:699` | 保留 false，在设置页加开关 |
| `phase53Integration.budgetMonitor.enabled` | `defaults.ts:706` | 保留 false，在设置页加开关 |

### 批次 4：保留不动（已有入口或已在用）

| 字段 | 文件:行 | 保留依据 |
|------|---------|----------|
| `orchestrationIntegration.strategyEnabled` | `defaults.ts:464` | Phase 50 已有设置页 Tab，保留 false 待用户启用 |
| `orchestrationIntegration.stateGraphEnabled` | `defaults.ts:465` | 同上 |
| `orchestrationIntegration.branchOrchestrationEnabled` | `defaults.ts:466` | 同上 |

---

## 源码接线点速查

| 接线点 | 文件 | 动作 |
|--------|------|------|
| 批次1 删除的配置字段 | `src/config/defaults.ts` + `src/config/schema.ts` | 删字段 |
| 批次1 删除的源文件 | `src/agent/goal-prompt-builder.ts`, `src/agent/requirement-change.ts` 等 | 删文件 + 清 app-init 装配 |
| 批次2 改默认值 | `src/config/defaults.ts` | false → true |
| 批次3 设置页入口 | `desktop/renderer/src/pages/SettingsPage.tsx` | 加 Tab 或控件 |
| 设置页 Tab 注册 | `desktop/renderer/src/pages/SettingsPage.tsx` | 搜索 tab 注册处 |

**evaluation 文件路径补充（批次1 删除，不在上表"等"中显式列出）：**
- `src/evaluation/process-defect-ontology.ts`
- `src/evaluation/architecture-aware-metrics.ts`
- `src/evaluation/saturation-monitor.ts`
- `src/router/routing-funnel.ts`（Phase 50 已删，若仍存在则删）

---

## Task 1：批次 1 删除无价值 Integration 与对应源文件

**文件：**
- 修改：`src/config/defaults.ts` 删除 6 个字段块
- 修改：`src/config/schema.ts` 删除对应 schema
- 删除：`src/agent/goal-prompt-builder.ts`（若存在）
- 删除：`src/agent/requirement-change.ts`（若存在）
- 修改：`src/cli/app-init.ts` 清理装配
- 删除：相关测试文件

- [ ] **Step 1: 确认源文件存在性并列举完整清单**

运行以下命令列出所有相关文件：
```powershell
rg -l "goal-prompt-builder|requirement-change|routing-funnel|process-defect-ontology|architecture-aware-metrics|saturation-monitor" src/ tests/
```

预期删除的源文件清单（以实际扫描结果为准）：
- `src/agent/goal-prompt-builder.ts`
- `src/agent/requirement-change.ts`
- `src/evaluation/process-defect-ontology.ts`
- `src/evaluation/architecture-aware-metrics.ts`
- `src/evaluation/saturation-monitor.ts`
- `src/router/routing-funnel.ts`（Phase 50 已删，若仍存在则删）

预期删除的测试文件：
- `tests/agent/goal-hook.test.ts`（若含 goal-prompt-builder 引用）
- `tests/agent/requirement-change.test.ts`
- `tests/evaluation/process-defect-ontology.test.ts`
- `tests/evaluation/architecture-aware-metrics.test.ts`
- `tests/evaluation/saturation-monitor.test.ts`
- `tests/router/routing-funnel.test.ts`（Phase 50 已删，若仍存在则删）

- [ ] **Step 2: 删除源文件**

按 Step 1 扫描结果逐个删除确认无引用的文件：
```powershell
Remove-Item src/agent/goal-prompt-builder.ts -ErrorAction SilentlyContinue
Remove-Item src/agent/requirement-change.ts -ErrorAction SilentlyContinue
```
（`routing-funnel.ts` 已在 Phase 50 删除，只需清配置；`process-defect-ontology.ts` / `architecture-aware-metrics.ts` / `saturation-monitor.ts` 在 `src/evaluation/` 下，删除）

- [ ] **Step 3: 清理 app-init.ts 装配**

打开 `src/cli/app-init.ts`，搜索 `goalPromptBuilder|requirementChange|processEvaluation|archAwareMetrics|saturationMonitor|routingFunnel`，删除所有装配块。

- [ ] **Step 4: 清理 defaults.ts 与 schema.ts**

打开 `src/config/defaults.ts`，删除批次 1 的 6 个字段块。打开 `src/config/schema.ts`，删除对应 schema 字段。

- [ ] **Step 5: 清理 service-context.ts**

打开 `src/cli/service-context.ts`，搜索批次 1 的字段，删除对应 deps 字段。

- [ ] **Step 6: 删除相关测试**

```powershell
rg -l "goal-prompt-builder|requirement-change|process-defect-ontology|architecture-aware-metrics|saturation-monitor" tests/
```
删除匹配的测试文件。

- [ ] **Step 7: 类型检查**

运行：`pnpm typecheck`
预期：通过。若报错，根据报错清理残留引用后重新运行直至通过。

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "refactor(phase-59): 删除批次1无价值 Integration（6 个字段 + 对应源文件）

删除字段：routingFunnelEnabled/processEvaluation/archAwareMetrics/saturationMonitor/promptBuilderEnabled/requirementChangeEnabled
删除源文件：goal-prompt-builder.ts/requirement-change.ts/evaluation 下三个学术指标文件
依据：无用户可见产物或已被替代，僵尸配置或与现有模块职责重叠"
```

---

## Task 2：批次 2 安全相关默认启用

**文件：**
- 修改：`src/config/defaults.ts` 5 个字段 false → true

- [ ] **Step 1: 修改 defaults.ts**

打开 `src/config/defaults.ts`，定位 `:668,675,681,687,693`，把以下 5 个 `enabled: false` 改为 `enabled: true`：
- `phase53Integration.policyEngine.enabled`
- `phase53Integration.auditChain.enabled`
- `phase53Integration.mcpSecurityScan.enabled`
- `phase53Integration.skillSecurityGate.enabled`
- `phase53Integration.configGuard.enabled`

每个字段加注释说明启用原因。

- [ ] **Step 2: 确认 app-init.ts 装配逻辑已存在**

搜索 `policyEngine|auditChain|mcpSecurityScan|skillSecurityGate|configGuard` 在 app-init.ts 的装配，确认 `enabled` 判定已接通（应该是 `if (config.phase53Integration.xxx.enabled)` 模式）。若装配缺失，补上。

- [ ] **Step 2.5: 为安全模块装配加 fail-open 守卫**

打开 `src/cli/app-init.ts`，定位 5 个安全模块（policyEngine/auditChain/mcpSecurityScan/skillSecurityGate/configGuard）的装配点。每个装配块用 try-catch 包裹：
```ts
try {
  if (config.phase53Integration.policyEngine.enabled) {
    // 原装配逻辑
  }
} catch (err) {
  logger.warn('Phase 59: policyEngine 装配失败，fail-open 跳过', { error: String(err) });
}
```
5 个模块各加一个 try-catch。安全模块装配失败不阻塞主流程，只记录警告。

- [ ] **Step 3: 类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 4: 全量测试**

运行：`pnpm test`
预期：可能有测试因默认值变化失败，更新测试 mock 配置。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "fix(phase-59): 安全相关 Integration 默认启用（5 个字段）

改默认值：policyEngine/auditChain/mcpSecurityScan/skillSecurityGate/configGuard
依据：Phase 53 写了安全治理却默认关，等于没写。安全能力应默认启用。"
```

---

## Task 3：批次 3 补设置页入口

**文件：**
- 修改：`desktop/renderer/src/pages/SettingsPage.tsx`
- 可能新增：`desktop/renderer/src/components/settings/SettingsAdvancedIntegrationTab.tsx`

- [ ] **Step 1: 调研现有设置页结构**

打开 `desktop/renderer/src/pages/SettingsPage.tsx`，了解 Tab 注册模式。确认是否有现成的"高级"或"实验"Tab 可复用。

- [ ] **Step 2: 创建高级 Integration 设置 Tab**

在 `desktop/renderer/src/components/settings/` 下创建 `SettingsAdvancedIntegrationTab.tsx`，包含批次 3 的 6 个开关（skillFlow/contextUsagePanel/evaluationFramework/skillLifecycle/prefixCache/budgetMonitor）。每个开关绑定对应 config 字段，使用 Toggle 组件。

Toggle 组件从 `desktop/renderer/src/components/ui/` 目录导入（若不存在，用原生 `<input type="checkbox">` 加 tailwind 样式替代）。

- [ ] **Step 3: 在 SettingsPage 注册 Tab**

打开 `SettingsPage.tsx`，在 Tab 注册处加 `'advanced-integration'` Tab，label 为"高级集成"，绑定 Step 2 的组件。

- [ ] **Step 4: 验证 IPC 透传模式并按需补白名单**

先 Read `desktop/shared/ipc-types.ts`，确认 config 更新 IPC 是字段白名单还是全量透传。
- 若全量透传：跳过本步。
- 若字段白名单：把 `phase49Integration` / `phase52Integration` / `phase53Integration` 加入白名单。

- [ ] **Step 5: 类型检查**

运行：`pnpm typecheck` + `pnpm typecheck:desktop`
预期：通过。

- [ ] **Step 5.5: 前端组件测试**

运行：`pnpm test -- tests/cli/phase50-ui-integration.test.ts`
预期：通过。若失败，更新测试 mock 配置以适配新 Tab。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat(phase-59): 补批次3 Integration 设置页入口

新增 SettingsAdvancedIntegrationTab.tsx，6 个开关：
skillFlow/contextUsagePanel/evaluationFramework/skillLifecycle/prefixCache/budgetMonitor
SettingsPage 注册 'advanced-integration' Tab
依据：实用但需用户显式开启的能力，必须有设置页入口，不能是幽灵配置"
```

---

## Task 4：批次 3 重复字段清理 + 全量验证

- [ ] **Step 1: 删除 phase52Integration.mcpSecurity（与 phase53 重复）**

打开 `src/config/defaults.ts:656`，删除 `mcpSecurity` 块。打开 `src/config/schema.ts`，删除对应 schema。搜索 `phase52Integration.mcpSecurity` 在 src/ 的引用，改为引用 `phase53Integration.mcpSecurityScan`。

运行：`rg "phase52Integration.mcpSecurity" src/` 验证无匹配。

- [ ] **Step 2: 残留扫描**

```powershell
rg "routingFunnel|processEvaluation|archAwareMetrics|saturationMonitor|promptBuilderEnabled|requirementChangeEnabled|phase52Integration.mcpSecurity" src/
```
预期：无匹配。

- [ ] **Step 3: 全量类型检查**

运行：`pnpm typecheck` + `pnpm typecheck:desktop`
预期：通过。

- [ ] **Step 4: 全量测试**

运行：`pnpm test`
预期：全绿。

- [ ] **Step 5: 推送**

```powershell
git push origin main
```

---

## 边界条件

**安全相关默认启用的风险：** `policyEngine` / `auditChain` 等默认启用后，若用户旧环境未配置相关模型或路径，可能导致启动报错。需在 app-init.ts 装配时加 fail-open 守卫（try-catch + logger.warn），安全模块装配失败不阻塞主流程，只记录警告。

**设置页 IPC 透传：** 若现有 config 更新 IPC 是字段白名单模式（只透传特定字段），需把 `phase49Integration` / `phase52Integration` / `phase53Integration` 加入白名单。若是全量透传，无需改动。

**批次1 删除的向后兼容：** 用户旧 config 若含删除的字段，Zod safe-parse 会忽略（zod v4 默认忽略未知字段）。不会报错，但需在 CHANGELOG 标注"以下配置字段已移除"。

---

## 验收清单

- [ ] `pnpm typecheck` + `pnpm typecheck:desktop` + `pnpm test` 通过
- [ ] 批次 1 的 6 个字段及对应源文件已删除，残留扫描无匹配
- [ ] 批次 2 的 5 个安全字段默认 `true`
- [ ] 批次 3 的设置页 Tab 已创建并可开关
- [ ] `phase52Integration.mcpSecurity` 重复字段已删除
- [ ] 已推送到 origin/main
- [ ] CHANGELOG 标注：删除字段清单 + 安全字段默认启用 + 新增设置页 Tab
