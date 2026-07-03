# 子 Agent 独立审计流程

> Phase 71 Task F2 · 纪律层文档
>
> 本文档规范"子 Agent 审计"环节：当某个子 Agent 完成开发 Task 后，由另一个独立子 Agent 对其改动进行结构化审查，目的是把"严禁死代码 + 自审"从隐式约定固化为可执行流程。
>
> 派发流程（如何派子 Agent、如何分任务、如何隔离上下文）由 `subagent-driven-development` skill 覆盖，本文档不重复。

---

## 1. 审计触发时机

审计采用"两轮交叉"模型，覆盖单 Task 与整 Phase 两个粒度。

### 1.1 第一轮：Task 完成后自审 + 独立审计

触发条件：开发者声明 Task 完成、提交 commit 之前。

| 步骤 | 执行者 | 范围 | 产物 |
|------|--------|------|------|
| 自审 | 完成该 Task 的子 Agent | 仅本 Task 改动的文件 | 自审 checklist（见 1.3） |
| 独立审计 | 另一个独立子 Agent | 本 Task 改动 + 直接上下游文件 | CONCERN 索引（见第 4 章） |

两轮审计都必须完成，独立审计不得由完成 Task 的同一子 Agent 执行。

### 1.2 第二轮：Phase 完成后交叉审查

触发条件：Phase 内所有 Task 全部提交后。

| 步骤 | 执行者 | 范围 | 产物 |
|------|--------|------|------|
| 交叉审查 | 多个独立子 Agent 互相复审他人 Task | 全 Phase 改动 + Phase 边界文件 | Phase 审计报告（如 `docs/phase-{N}-audit-report.md`） |
| 死代码全量扫描 | 单个子 Agent | `src/` 全目录 | `dead-code-report.json` |

交叉审查的核心价值：单 Task 视角看不到跨 Task 的接线断层（如 D3 的 `setToolOutputPipeline` 直到 D7 才接入），交叉审查能补齐。

### 1.3 自审 checklist（提交前必走）

开发者子 Agent 在声明 Task 完成前，必须自查以下 5 项：

1. 新增 export 是否都被消费（不是只被自己 import）
2. 新增配置字段是否在 `defaults.ts` 注册并被消费方读取
3. 新增模块是否在入口（`app-init.ts` / `loop.ts` / `index.ts`）接线
4. 新增/修改逻辑是否有对应测试，且测试通过
5. 删除/重命名符号后，所有调用方是否同步更新

自审不通过不得声明完成；自审通过后才能触发独立审计。

---

## 2. 审计维度（5 维）

每个独立审计子 Agent 必须按以下 5 个维度逐项检查，缺一不可。

| # | 维度 | 检查问题 | 典型违规 |
|---|------|----------|----------|
| 1 | **死代码** | 新增/修改的 export 是否被其他文件 import？ | Phase 50 删除的 22 个未调用函数（见 `DEAD_CODE_AUDIT.md`） |
| 2 | **配置僵尸** | 新增配置字段是否有消费方读取？老字段删除后消费方是否清理？ | Phase 59 删除的 7 个 `phase49Integration.*` 字段 |
| 3 | **孤立模块** | 新增模块是否在入口接线？是否仅被测试 import？ | Phase 50 接入的 14 个"仅测试使用"文件 |
| 4 | **测试覆盖** | 新增逻辑是否有测试？测试是否真的覆盖行为（不是只调一次）？ | Phase 49 Skill 质量门的 3 场景验证 |
| 5 | **调用方完整性** | 删除/重命名符号后，所有调用方是否同步更新？类型是否对得上？ | Phase 50 修复的 `convertFromClaudeConfig` bug |

5 维必须独立报告，不可合并。即使某维度"无问题"也要显式写"无 CONCERN"。

---

## 3. 审计步骤

每个维度的具体操作步骤如下，命令必须可直接复制执行。

### 3.1 死代码检测

```bash
# 运行死代码检测脚本（fail-open，异常不阻塞）
node --import tsx/esm scripts/detect-dead-code.ts

# 查看报告
# 控制台会输出摘要，详细报告写入项目根的 dead-code-report.json
```

判定规则（见 `scripts/detect-dead-code.ts`）：
- `deadExports`：src + tests 中均无 import → 死代码
- `testOnlyExports`：仅 tests 中有 import → 警告（孤立模块嫌疑）
- 入口文件白名单（`index.ts` / `app-init.ts` / `main.tsx` 等）的 export 不算死代码

针对本 Task 改动的判定：把本 Task 新增的 export 与 `dead-code-report.json` 中的 `deadExports` 取交集，任何命中项均为 FATAL。

### 3.2 调用方完整性（grep）

针对本 Task 新增/删除/重命名的每个符号，逐一 grep 调用方：

```bash
# 例：本 Task 新增了函数 recallToPromptWithEpisodes
# 查找所有调用方（src + tests）
rg "recallToPromptWithEpisodes" src/ tests/

# 仅查 src（生产调用方）
rg "recallToPromptWithEpisodes" src/

# 查 import 语句
rg "^import.*recallToPromptWithEpisodes" src/ tests/
```

判定规则：
- 删除/重命名的符号：grep 结果必须为空，否则 FATAL（残留 broken import）
- 新增的符号：src 中至少有 1 个非入口文件 import，否则 RISK（孤立模块嫌疑）
- 仅 tests 中有 import：SUGGEST（test-only，需评估是否应接入生产）

> 命令行中优先使用 `rg`（ripgrep）。在 TRAE IDE 内可通过 Grep 工具等效执行，不必落到 shell。

### 3.3 配置消费链检查

针对本 Task 新增/删除/修改的每个配置字段：

```bash
# 1. 检查字段是否在 defaults.ts 注册
rg "fieldName" src/config/defaults.ts

# 2. 检查字段是否有消费方读取（非定义文件）
rg "config\.path\.to\.fieldName" src/ --glob "!src/config/defaults.ts"

# 3. 检查字段是否在 schema 中声明（如有 schema）
rg "fieldName" src/config/schema.ts
```

判定规则：
- 新增字段：3 步必须全有（defaults + 消费方 + schema）→ 缺任一即 RISK
- 删除字段：3 步必须全空 → 任何残留即 FATAL（配置僵尸）
- 修改字段类型：消费方读取处的类型注解必须同步更新 → 不一致即 FATAL

### 3.4 测试覆盖验证

```bash
# 跑全量测试（typecheck + 单测 + e2e）
npm run typecheck
npm test

# 仅跑本 Task 相关测试（按文件名匹配）
npm test -- --grep "本Task改动文件名"
```

判定规则：
- 本 Task 改动的每个新函数/分支必须有至少 1 个测试覆盖
- 全量测试必须 0 失败 → 任何失败即 FATAL
- 仅修改注释/格式 → 可跳过测试，但需在报告中说明

### 3.5 调用方完整性（git diff 复核）

```bash
# 查看本 Task 的完整改动
git diff HEAD~1 HEAD

# 仅看本 Task 涉及文件的调用方变更
git diff HEAD~1 HEAD -- src/agent/loop.ts src/agent/spawn-agent.ts
```

判定规则：本 Task 改动文件列表中的"删除符号"必须在其同 commit 中有对应的"调用方更新"。跨 commit 拆分（如 D3 删除符号、D7 才接入）必须在 Task 报告中显式声明 RISK。

---

## 4. 审计报告格式

审计报告以 `CONCERN 索引` 形式输出，每条 CONCERN 包含：级别、维度、文件、描述、建议。

### 4.1 CONCERN 级别

| 级别 | 含义 | 阻塞合入 |
|------|------|----------|
| FATAL | 死代码 / 配置僵尸 / broken import / 测试失败 | 是（必须修复） |
| RISK | 孤立模块嫌疑 / test-only / 跨 commit 拆分 | 否（记录后可合入） |
| SUGGEST | 命名建议 / 注释补充 / 微优化 | 否（可选） |

### 4.2 报告模板

```markdown
## 审计报告：[Task 编号 + 标题]

- 审计对象：commit `<hash>` · 改动文件 N 个
- 审计子 Agent：独立子 Agent（非 Task 开发者）
- 审计时间：YYYY-MM-DD

### CONCERN 索引

| # | 级别 | 维度 | 文件 | 描述 | 建议 |
|---|------|------|------|------|------|
| 1 | FATAL | 死代码 | src/foo.ts | export bar() 无任何调用方 | 删除或接入 |
| 2 | RISK | 孤立模块 | src/baz.ts | 仅 tests 中有 import | 评估是否接入生产 |
| 3 | SUGGEST | 命名 | src/qux.ts | 函数名 parseX 不够清晰 | 改为 parseY |

### 维度小结

- 死代码：1 FATAL / 0 RISK / 0 SUGGEST
- 配置僵尸：0 FATAL / 0 RISK / 0 SUGGEST
- 孤立模块：0 FATAL / 1 RISK / 0 SUGGEST
- 测试覆盖：0 FATAL / 0 RISK / 0 SUGGEST
- 调用方完整性：0 FATAL / 0 RISK / 0 SUGGEST

### 阻塞合入结论

[ ] 可合入（无 FATAL）
[ ] 不可合入（FATAL 数：N）

签字：审计子 Agent ID
```

每条 CONCERN 必须给出可执行建议（"删除或接入"而非"建议处理"）。

---

## 5. 阻塞合入标准

合入判定只看 FATAL 数量：

| FATAL 数 | RISK 数 | 判定 |
|----------|---------|------|
| 0 | 任意 | 可合入（RISK 记录到 Phase 审计报告） |
| ≥1 | 任意 | 不可合入（必须修复后重新审计） |

RISK 不阻塞合入，但必须记录到 `docs/phase-{N}-audit-report.md` 的"已知 RISK 清单"，供后续 Phase 评估是否需修复。

SUGGEST 完全可选，开发者可忽略。

### 5.1 修复后复审

修复 FATAL 后必须重新触发独立审计（不可仅自审）。复审范围：仅复审上次 FATAL 涉及的文件 + 其直接上下游。

### 5.2 RISK 升级为 FATAL 的条件

某个 RISK 在连续 2 个 Phase 内未解决，且：
- 仍未接入生产调用方 → 升级为 FATAL
- 仍存在跨 commit 拆分未补齐 → 升级为 FATAL

升级规则由 Phase 完成时的交叉审查子 Agent 应用。

---

## 6. 工具链

| 工具 | 用途 | 命令 |
|------|------|------|
| `scripts/detect-dead-code.ts` | 死代码全量扫描 | `node --import tsx/esm scripts/detect-dead-code.ts` |
| `scripts/audit-dead-code.ts` | Phase 53 老版死代码扫描（含 desktop/） | `node --import tsx/esm scripts/audit-dead-code.ts` |
| Grep 工具（rg） | 调用方 grep / 配置消费链检查 | `rg "symbolName" src/ tests/` |
| `git diff` | 改动复核 | `git diff HEAD~1 HEAD -- <file>` |
| `git log` | commit 历史核查 | `git log --oneline \| rg "Phase N"` |

### 6.1 detect-dead-code.ts 关键行为

- 范围：仅扫 `src/`（不扫 `desktop/`，与 `audit-dead-code.ts` 区分）
- 入口白名单：`index.ts` / `app-init.ts` / `main.tsx` / `App.tsx` / `server.ts` / `args.ts` 的 export 不算死代码
- test-only 区分：仅 tests 中有 import 的 export 标 warning，不计入 dead
- fail-open：扫描异常时退出码 0，不阻塞流程
- 输出：`dead-code-report.json` + 控制台摘要（前 20 死代码 / 前 10 test-only）

### 6.2 与 audit-dead-code.ts 的冲突

`audit-dead-code.ts`（Phase 53）也写 `dead-code-report.json`，两脚本双写冲突。审计时优先以 `detect-dead-code.ts` 的输出为准（覆盖更新），`audit-dead-code.ts` 仅在需要扫 `desktop/` 时使用。

> F1 Task 已识别此双写冲突为 RISK，后续 Phase 应统一为单一脚本。

---

## 7. 示例（真实审计案例）

### 案例：Phase 71 Task B2 @-mention 协议

- 审计对象：commit `967fe4f` · `feat(agent): @-mention 统一引用协议`
- 审计子 Agent：独立子 Agent
- 改动范围：新增 `@-mention` 解析器 + 接入 `loop.ts`

#### 审计步骤执行

```bash
# 1. 死代码检测
node --import tsx/esm scripts/detect-dead-code.ts
# 输出：dead-code-report.json（本 Task 新增符号未命中 deadExports）

# 2. 调用方 grep
rg "parseAtMention" src/ tests/
# 命中：src/agent/loop.ts（生产调用方）+ tests/agent/loop.test.ts（测试）

# 3. 配置消费链
rg "atMention" src/config/defaults.ts
# 命中：defaults.ts 注册了 atMention.enabled = true
rg "config.*atMention\.enabled" src/ --glob "!src/config/defaults.ts"
# 命中：src/agent/loop.ts 读取 atMention.enabled

# 4. 测试覆盖
npm test -- --grep "at-mention"
# 通过：3 个测试用例（normal / boundary / adversarial）

# 5. git diff 复核
git diff HEAD~1 HEAD -- src/agent/loop.ts
# 确认：loop.ts 在 parseUserInput 后调用 parseAtMention，接线完整
```

#### CONCERN 索引

| # | 级别 | 维度 | 文件 | 描述 | 建议 |
|---|------|------|------|------|------|
| 1 | RISK | 调用方完整性 | src/agent/loop.ts | `@-mention` 协议仅在 loop.ts 接入，未覆盖 spawn-agent.ts 的子 Agent 输入路径 | 后续 Task 评估是否在子 Agent 输入也启用 @-mention |

#### 维度小结

- 死代码：0 FATAL / 0 RISK / 0 SUGGEST
- 配置僵尸：0 FATAL / 0 RISK / 0 SUGGEST
- 孤立模块：0 FATAL / 0 RISK / 0 SUGGEST
- 测试覆盖：0 FATAL / 0 RISK / 0 SUGGEST
- 调用方完整性：0 FATAL / 1 RISK / 0 SUGGEST

#### 阻塞合入结论

[x] 可合入（无 FATAL，1 RISK 记录到 Phase 71 审计报告）

---

## 相关文档

- [DEAD_CODE_AUDIT.md](./DEAD_CODE_AUDIT.md) — Phase 50 死代码全量审计结果
- [QUALITY_GATE.md](./QUALITY_GATE.md) — Skill 质量门（3 场景验证）
- [phase-71-audit-report.md](./phase-71-audit-report.md) — Phase 71 各 Task 审计结论汇总
- `subagent-driven-development` skill — 子 Agent 派发流程（本文档不覆盖）
