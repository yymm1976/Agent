# RouteDev 死代码全量审查报告

> **审查模型：** Claude Opus
> **审查日期：** 2026-07-05
> **审查模式：** 全量审查（五维全审 + 跨模块耦合 + 生产可达性分析）
> **审查重点：** 未被介入、未被生产路径调用、功能残缺或未开启的死代码模块
> **审查对象：** 工作区项目 `routedev/`（TypeScript 6.x / Electron 33 / React 19）

---

## 审查总结

**结论：有严重问题（架构层面的死代码与接线脆弱性），但不阻塞运行。**

本次审查以「生产入口可达性」为主线，构建了完整的 import 依赖图（含静态 import + 动态 `import()`），从真实生产入口 `desktop/main/index.ts` 出发做可达性遍历。核心发现：

1. **项目自带的 `dead-code-report.json` 已严重失真**：它是纯正则静态扫描，报告 441 个"死 export" + 215 个"test-only export"，但**误报率极高**——无法识别动态 import、type-only import、re-export，且入口白名单仍指向已删除的 CLI（`src/cli/`、`src/index.tsx`、`src/channels/`）。抽样验证 23 个"test-only 类"，实际仅 2 个真正无引用。
2. **真实死代码规模：360 个非测试文件中，30 个从生产入口不可达**。其中经交叉验证，**9 个为真死代码（TRUE-DEAD，全库仅测试引用或被其他死文件引用）**，其余 21 个是通过"变量路径动态 import"接线的（可达但审计工具与 typecheck 均无法追踪）。
3. **最危险的不是死代码本身，而是大面积采用「变量路径动态 import + fail-open 静默降级」的接线模式**（PolicyEngine、三个 Middleware、Doctor 等）。这种模式让"接线断裂"退化为"运行时静默不生效"，且逃逸所有静态检查——功能是否真正开启，无法通过编译或测试确认。

---

## 审查方法与证据链

| 步骤 | 方法 | 结果 |
|------|------|------|
| 1. 定位生产入口 | 读 `package.json` `main` + `AGENTS.md` | `desktop/main/index.ts → engine-bridge.ts → src/runtime/app-init.ts` |
| 2. 验证自带审计产物 | 读 `dead-code-report.json` + 重跑 `detect-dead-code.ts` | 入口白名单指向已删除的 `src/cli/`，产物失真 |
| 3. 可达性分析 | 自建 import 图遍历（静态 + 动态 import） | 360 文件中 30 个不可达 |
| 4. 交叉验证 | 对 30 个不可达文件全库 grep（含变量路径字符串引用） | 区分 21 个"动态接线可达" vs 9 个 TRUE-DEAD |

> 说明：项目自带的 `scripts/detect-dead-code.ts` 与本次分析都**无法自动追踪变量路径动态 import**（如 `const p = '../policies/intent-guard.js'; import(p)`）。这类接线只能靠人工 grep 字符串常量确认。本报告已对全部 30 个不可达文件逐一人工核验。

---

## Critical（架构级：功能残缺 / 静默失效风险）

### C1. `system-prompt-builder.ts` 及其依赖 `lazy-coder-ladder.ts` —— 消费方已随 CLI 删除，沦为死代码

- **文件：** [system-prompt-builder.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context/system-prompt-builder.ts)、[lazy-coder-ladder.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context/lazy-coder-ladder.ts)
- **证据：** [loop.ts:695](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts#L695) 注释明确写道：*"systemPrompt 已由 system-prompt-builder.ts 静态拼装（chat-runner.ts 接入）"*。但 `chat-runner.ts` 在 CLI 退役时已被删除（`src/cli/` 整目录不存在）。全库搜索 `system-prompt-builder` 的消费方，只剩自身、其测试、`loop.ts` 的一句注释、以及 `phase-71-audit-report.md`。
- **实际生产路径：** [engine-bridge.ts:341](file:///c:/Users/杨铭/Desktop/Agent/routedev/desktop/main/engine-bridge.ts#L341) 用 `this.deps.prompts.render('main.system', ...)`（`PromptTemplateManager`）构造系统提示词，**完全绕过** `system-prompt-builder.ts`。
- **为什么重要：** 这是 Phase 71 Task D1/E3 声称"已接入"的上下文工程纪律模块（lazy-coder 阶梯、上下文纪律 prompt）。消费方删除后，这部分能力**在生产中完全不生效**，而 `phase-71-audit-report.md` 仍记录为"已完成"。这是文档与实际不符的功能残缺。`lazy-coder-ladder.ts` 仅被 `system-prompt-builder.ts` 引用，随之传递性死亡。

### C2. PolicyEngine 安全策略链：全部经「变量路径动态 import + fail-open」接线，静态检查无法验证是否生效

- **文件：** [app-init.ts:1388-1473](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L1388-L1473)，涉及 [intent-guard.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/intent-guard.ts)、[playbook.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/playbook.ts)、[tool-approval.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/tool-approval.ts)、[tool-guide.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/policies/tool-guide.ts)
- **证据：** 这 4 个 builtin 策略文件在可达性图中**全部不可达**。原因是它们经由变量路径动态 import 装载：

  ```typescript
  const guardPath = '../policies/intent-guard.js';
  import(guardPath)
    .then((guardMod) => { if (typeof guardMod.createBuiltinIntentGuardPolicies === 'function') {...} })
    .catch(() => { /* fail-open */ });
  ```

- **为什么是 Critical：** `AGENTS.md` 与 `DEAD_CODE_AUDIT.md`（Phase 59）声称 `policyEngine.enabled` 已**默认启用**，是"Intent Guard + Playbook 安全核心"。但：
  1. 用变量路径（而非字符串字面量）动态 import，TypeScript **无法做静态解析**，注释里自己也写了"避免 typecheck 失败"——意味着如果这些文件被误删或改名，**编译不会报错**，测试也测不到，只会在运行时走进 `.catch(() => {})` 静默跳过。
  2. `loop.ts` 里 `setPolicyEngine` 是通过 `agentLoop as unknown as { setPolicyEngine?: ... }` 做 feature-detect 调用的（[loop.ts:300](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts#L300)），同样绕过类型系统。
  3. 整条安全策略链（越权拦截、危险命令拦截）**是否真正挂载，无法通过任何静态手段确认**，只能靠运行时日志 `PolicyEngine registered`。对于"安全核心"，这是不可接受的验证盲区。
- **建议：** 改用字符串字面量静态 import（`import { createBuiltinIntentGuardPolicies } from '../policies/intent-guard.js'`）。这些文件早已存在于仓库，"由其他子代理创建、避免 typecheck 失败"的历史理由已不成立。恢复静态 import 后，接线断裂会在编译期暴露。

### C3. 插件 SDK 加载器 `sdk-loader.ts` + `sdk.ts` —— `/plugins load` 命令退役后的死岛

- **文件：** [sdk-loader.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/plugins/sdk-loader.ts)、[sdk.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/plugins/sdk.ts)
- **证据：** `PluginLoader` 类全库仅被 `tests/plugins/sdk-loader.test.ts` 引用。`sdk-loader.ts` 头部注释说明它服务于"运行时通过 `/plugins load <path>` 动态加载"，但 CLI 命令系统已退役。生产实际使用的是 [plugin-init.ts:19](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/plugin-init.ts#L19) 的 `createPluginSystem` → 基于 manifest 的 `PluginRegistry`，与 SDK loader 无任何交集。
- **为什么重要：** `sdk.ts`（RouteDevPlugin SDK 接口）仅被 `sdk-loader.ts` 引用，二者构成一个**自封闭死岛**——互相引用但整体从生产不可达。注意：Phase 50 曾记录删除过一个 `src/plugins/sdk.ts`，此文件为后续重新引入，但从未接回生产。

### C4. `consolidation.ts` —— 宿主 `DreamConsolidator` 已在 Phase 56 删除，记忆固化能力残缺

- **文件：** [consolidation.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/consolidation.ts)
- **证据：** 全库搜索仅命中自身、两个测试文件、以及 `context-manager.ts:729` 的一句注释：*"获取内部知识图谱（用于测试和 DreamConsolidator 共享）"*。而 `DEAD_CODE_AUDIT.md` 第 171 行明确记载 `dream-consolidator.ts` 已在 Phase 56 删除。消费方已死，`consolidation.ts`（记忆固化/整合）随之成为孤儿。
- **为什么重要：** `/consolidate-memory` 命令在 Phase 60 被声称为"唯一入口"，但底层 consolidation 模块并未接入任何生产可达路径，属功能残缺。

---

## Important（真死代码 / 冗余，建议清理）

### I1. 确认的 TRUE-DEAD 文件清单（9 个）

以下文件从生产入口**完全不可达**，且全库仅被测试或被其他死文件引用，可安全删除（连同对应测试）：

| # | 文件 | 死亡原因 | 唯一引用来源 |
|---|------|----------|-------------|
| 1 | `src/agent/context/system-prompt-builder.ts` | 消费方 `chat-runner.ts` 已随 CLI 删除 | 测试 + loop.ts 注释 |
| 2 | `src/agent/context/lazy-coder-ladder.ts` | 仅被 #1 引用，传递性死亡 | system-prompt-builder.ts |
| 3 | `src/agent/context/context-discipline-prompt.ts` | 仅测试引用 | 测试 |
| 4 | `src/agent/context/user-profile-loader.ts` | 仅测试引用 | 测试 |
| 5 | `src/agent/memory/consolidation.ts` | 宿主 DreamConsolidator 已删（Phase 56） | 测试 + 注释 |
| 6 | `src/code-map/compression.ts` | `distillContext` 仅测试引用 | 测试 |
| 7 | `src/plugins/sdk-loader.ts` | `/plugins load` 命令退役 | 测试 |
| 8 | `src/plugins/sdk.ts` | 仅被 #7 引用，传递性死亡 | sdk-loader.ts |
| 9 | `src/utils/provider-validator.ts` | `ProviderValidationResult` 仅测试引用 | 测试 |

> 处理建议：删除前先跑 `pnpm test` 确认对应测试可一并移除，再删文件。这 9 个删除不会影响 typecheck 与生产运行（它们本就不在生产可达图中）。

### I2. 21 个"动态接线可达"文件 —— 可达但接线脆弱

以下文件经变量路径动态 import 接线，功能上可达，但与 C2 同类问题：静态检查无法保护。**不建议删除**，但建议逐步收敛为静态 import：

`branch-linkage.ts`、`branch-persistence.ts`、`middleware/code-map-context.ts`、`middleware/expertise-prompt.ts`、`middleware/quality-signal.ts`、`quality-aggregator.ts`、`parallel-experiment.ts`、`multi/score-card.ts`、`code-map/watcher.ts`、`config/expertise-manager.ts`、`hooks/adapter.ts`、`memory/unified-memory.ts`、`observability/integration.ts`、`observability/otel-exporter.ts`、`runtime/doctor.ts`、`skills/progressive-disclosure.ts`、`tools/builtin/browser.ts`、`policies/{intent-guard,playbook,tool-approval,tool-guide}.ts`（已在 C2 列出）。

其中 `Doctor`、三个 Middleware、`browser.ts` 等均在 `app-init.ts` 用 `.then(...).catch(() => {})` 的 fail-open 动态 import 模式接入——同样存在"接线断裂 → 运行时静默降级"的风险。

### I3. 项目自带死代码检测脚本 `detect-dead-code.ts` 存在系统性误报

- **文件：** [detect-dead-code.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/scripts/detect-dead-code.ts)
- **问题：** 该脚本（Phase 71 F1）只做正则匹配 `import { X }`，存在三类系统性漏洞：
  1. **无法识别动态 import**（`import(path)`）→ 把 C2 的策略文件、I2 的全部文件误判为死；
  2. **无法识别 type-only import 与 re-export** → 大量 interface/type 被误报为死（441 项里绝大多数属此类）；
  3. **入口白名单靠 basename 匹配**（`index.ts`/`App.tsx` 等），会把任意目录下的同名文件也当入口跳过。
- **为什么重要：** `phase-71-audit-report.md §4.3` 要求"后续每个 Phase 跑此脚本并附摘要"作为纪律层验收依据。但该脚本 656 项输出里真死代码不足 10 个，**信噪比极低**，会让审计流于形式（Red Flag：只报 Minor 凑数的机器版）。`F1 RISK` 也已记录它与 `audit-dead-code.ts` 双写 `dead-code-report.json` 冲突。

---

## Minor（记录后续处理）

1. **`dead-code-report.json` 已提交入库且失真**：入口白名单含 `src/cli/App.tsx`、`src/index.tsx`、`src/channels/server.ts` 等已删除路径，误导后续审计者。建议要么加入 `.gitignore`，要么随脚本修复后重新生成。
2. **`src/agent/context/lazy-coder-ladder.ts` 与 `context-discipline-prompt.ts` 命名暗示为核心纪律模块**，实际未接入。若这些能力仍在路线图上，应补接线而非留存为死代码；若已废弃，应连同 `phase-71-audit-report.md` 的"已完成"记录一起更正。
3. **release3/win-unpacked 产物入库**：`routedev/release3/` 含打包产物（`resources.pak`、`vulkan-1.dll`），非源码，建议移出版本库。

---

## 做得好的地方

1. **`app-init.ts` 的动态 import 全部带 `.catch()` fail-open**（如 [app-init.ts:1467-1472](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/runtime/app-init.ts#L1467-L1472)）：单个可选模块加载失败不会拖垮整个引擎初始化，这是正确的容错设计——问题只在于用它来接**安全核心**（C2）时降级过于静默。
2. **`engine-bridge.ts` 的 `OmissionChecker` 按需动态 import**（[engine-bridge.ts:587](file:///c:/Users/杨铭/Desktop/Agent/routedev/desktop/main/engine-bridge.ts#L587)）：仅在 `config.plan.omissionCheckEnabled` 开启时才加载，避免主进程启动开销，且配置守卫 + fail-open 完整。这是"按需接线"的正面样板，与 C2 的区别在于它用了明确的配置开关且有兜底返回值。

---

## 用户确认检查点

以上为只读审查结论，**未修改任何生产代码**（仅清理了分析用临时脚本）。请确认后续动作：

1. **C1/C3/C4 + I1 的 9 个 TRUE-DEAD 文件**：是否授权删除（含对应测试）？
2. **C2 PolicyEngine 安全链**：是否需要我把 4 个策略 builtin 从"变量路径动态 import"改回静态 import，让接线断裂在编译期暴露？（这是本次审查风险最高项）
3. **I3 检测脚本**：是否需要增强 `detect-dead-code.ts` 以识别动态 import / type-only import，降低误报？

> 注：本次未发现会导致崩溃或数据丢失的即时性 Critical，故未主动修复任何文件。C1-C4 均为"功能残缺/静默失效"类架构问题，需你确认修复方向后再动手。
