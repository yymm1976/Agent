# Phase 47 — 开发者工作流产品化与体验闭环

> **版本目标：** v3.8.0
> **前置依赖：** Phase 46（v3.7.0 死代码清零与接线收尾）完成
> **新增测试要求：** ≥ 40 个
> **研究依据：** 2026-06-25 对 `https://coding.stormzhang.ai/`（Claude Code 53 篇 + Codex 39 篇）系统性调研；RouteDev 当前 `AGENTS.md`、`src/tools/permission-engine.ts`、`src/cli/command-registry.ts`、`src/harness/checkpoint-manager.ts`、`src/agent/multi/`、`src/config/loader.ts` 实现
> **核心命题：** RouteDev 经过 46 个 Phase 的迭代，在工具调用、多 Agent 编排、代码地图、记忆系统等功能层面已相当完整，但「能力」与「好用」之间存在断层：AGENTS.md 膨胀到 64 条陷阱挤占上下文、Skill/Tool 的 description 写法参差不齐导致匹配率低、缺少非交互模式无法接入 CI、权限模型只有「是否询问」一个旋钮、子代理审查与主执行共享上下文导致自我偏袒、Checkpoint 不可视、Slash 命令不可自定义。本 Phase 不新增底层能力，而是把已有能力「产品化」——让 Agent 自主帮用户完成配置、引导用户走通流程、而非只提一嘴「建议怎么做」。每个 Task 都要求落到具体代码改动，不允许停留在「建议」层面。

---

## 项目现状审计与可行性结论

### 1. 已具备的实现基础

| 模块 | 当前状态 | 本 Phase 可复用度 |
|------|---------|------------------|
| `AGENTS.md` | 64 条陷阱警告 + 技术栈 + 关键入口，约 400 行 | 高（Task 1 瘦身的对象） |
| `src/tools/permission-engine.ts` | deny > confirm > auto 三层决策 | 高（Task 4 扩展为沙箱+审批双旋钮） |
| `src/cli/command-registry.ts` | 所有 `/` 命令硬编码注册 | 高（Task 7 扩展为支持自定义命令） |
| `src/harness/checkpoint-manager.ts` | Checkpoint 创建/回滚/列表，含工作区干净检查 | 高（Task 6 可视化的数据源） |
| `src/agent/multi/orchestrator.ts` + `WorkerExecutor` | 多 Agent 编排 + Blackboard | 高（Task 5 独立审查会话的基础） |
| `src/agent/unified-reviewer.ts` | 内置 reviewer Worker | 高（Task 5 对抗性审查的复用基础） |
| `src/config/loader.ts` | YAML 加载 + Zod 校验 + 环境变量替换 | 高（Task 8 fallback 文件名支持） |
| `src/skills/` + `src/tools/builtin/` | Skill 注册 + 内置工具 | 高（Task 2 description 审计对象） |
| `desktop/renderer/src/components/` | 桌面端组件体系 | 高（Task 6 时间轴组件） |
| `src/cli/args.ts` + `src/index.tsx` | CLI 参数解析与入口 | 高（Task 3 exec 子命令入口） |

### 2. 尚未落地的关键缺口

| 缺口 | 影响 | 本 Phase 处理方式 |
|------|------|------------------|
| AGENTS.md 64 条陷阱常驻上下文 | 挤占 token、关键信息被淹没、模型注意力分散 | Task 1 自动拆分 + 按需加载 |
| Skill/Tool description 写法无规范 | 匹配率低（实测 60% vs 92%），用户需手动点名 | Task 2 制定规范 + 自动审计 + 批量改写 |
| 无非交互模式 | 无法接入 CI/脚本/批量任务 | Task 3 新增 `routedev exec` |
| 权限只有「是否询问」单旋钮 | 无法区分「能做多少」与「要不要问」 | Task 4 引入沙箱级 + 审批级双旋钮 |
| 审查与执行共享上下文 | 模型偏袒自己刚写的代码 | Task 5 独立子代理会话审查 |
| Checkpoint 不可视 | 用户不知道有哪些检查点、不敢回滚 | Task 6 桌面端时间轴 + 语义化摘要 |
| Slash 命令不可自定义 | 高频操作无法固化为快捷入口 | Task 7 `.routedev/commands/` 自定义命令 |
| 不兼容 CLAUDE.md / 无 local 覆盖 | 从 Claude Code 生态迁移成本高、个人偏好污染团队文件 | Task 8 fallback 文件名 + local 覆盖 |
| 无官方 CI 集成模板 | 用户需自行摸索 GitHub Action 接入 | Task 9 提供 action.yml + 示例 workflow |

### 3. 可行性总评

- **AGENTS.md 瘦身（Task 1）：** 高度可行。纯文档重组 + Skill 生成，无代码逻辑风险。
- **description 规范与审计（Task 2）：** 高度可行。lint 检查 + 正则匹配改写，不涉及运行时逻辑。
- **`routedev exec`（Task 3）：** 可行。复用现有 GoalRunner / TaskOrchestrator，新增参数解析层 + 结构化输出层。
- **权限双旋钮（Task 4）：** 可行。在 PermissionEngine 现有三层决策之上增加沙箱级概念，向后兼容。
- **独立子代理审查（Task 5）：** 可行。复用 spawn_agent 机制，关键是不共享 conversationHistory。
- **Checkpoint 可视化（Task 6）：** 可行。数据源已存在，新增桌面端组件 + 可选 LLM 摘要。
- **自定义 Slash 命令（Task 7）：** 可行。文件加载 + 模板变量替换，参考 Skill 加载机制。
- **fallback 兼容（Task 8）：** 高度可行。配置项 + 加载顺序调整。
- **GitHub Action（Task 9）：** 高度可行。纯新增文件，不改动现有代码。

---

## 核心设计原则

### 原则 1：自主完成优先于引导，引导优先于建议

每个 Task 必须落到代码改动：能自动做的（如 AGENTS.md 拆分、description 改写、权限默认值）由 Agent 自主完成；需要用户决策的（如审查结果采纳、Checkpoint 回滚确认）提供清晰引导；绝不允许只写「建议用户 xxx」而不提供实现。

### 原则 2：不引入新依赖

本 Phase 是产品化收尾，不引入新依赖。GitHub Action 使用 Node 18+ 内置能力；Checkpoint 摘要复用现有 LLM 客户端；自定义命令模板替换用正则实现。

### 原则 3：向后兼容

权限模型扩展不破坏现有 `security.*` 配置；AGENTS.md 瘦身后原内容不丢失（迁移到 Skill/docs）；自定义命令不覆盖内置命令（命名空间隔离）。

### 原则 4：每一步都可独立验证

每个 Task 完成后都能独立通过 typecheck + test 验证。Task 之间无强耦合，可并行执行（除 Task 10 集成测试需在所有代码改动后进行）。

### 原则 5：文档与代码同步

任何配置项、命令、文件名变更，必须在同一 Task 内同步更新 AGENTS.md、config.example.yaml、CODEMAP.md。

---

## Task 1：AGENTS.md 瘦身与按需加载（≥ 5 测试）

### 1.1 问题定位

**位置**：`routedev/AGENTS.md`

当前 AGENTS.md 约 400 行，包含 64 条「陷阱警告」（Phase 17b ~ Phase 38），每条 3-10 行。这些陷阱作为常驻上下文每轮对话自动加载，但：

- 64 条陷阱约占 3000-4000 tokens，挤占上下文窗口
- 大部分陷阱是历史特定 Phase 的执行经验，与当前任务相关性低
- 关键的「技术栈、关键入口、项目约定」被陷阱淹没
- 模型注意力分散，反而可能忽略真正重要的约定

**stormzhang 调研发现**：`CLAUDE.md` / `AGENTS.md` 应只放 AI 猜不到的内容，写每一行都问「删除这个会导致 AI 犯错吗？」大块或偶尔才用的细则做成 Skill 按需加载。

### 1.2 实现方案

#### 1.2.1 拆分 AGENTS.md 为三层

```markdown
# AGENTS.md（瘦身后，目标 ≤ 120 行）

## 技术栈
（保留，~15 行）

## 关键入口
（保留，~15 行）

## 项目约定
（保留，~20 行）

## 核心陷阱（Top 10，当前最易踩的）
（从 64 条中筛选仍在影响生产的 10 条，~30 行）

## 完整陷阱索引
详见 `.routedev/skills/pitfalls-guide/SKILL.md`，按 Phase 分章，需要时自动加载。
```

#### 1.2.2 生成 pitfalls-guide Skill

新增 `.routedev/skills/pitfalls-guide/SKILL.md`，将 64 条陷阱按 Phase 分章组织：

```markdown
---
name: pitfalls-guide
description: 当开发者要修改 PermissionEngine、AgentLoop、CheckpointManager、Blackboard、HookRunner、MCPClientManager、ToolExecutor 等核心模块时，或遇到权限、安全、上下文压缩、多 Agent 编排、Hook 执行相关问题时，加载此 Skill 获取历史踩坑经验。覆盖 Phase 17b 至 Phase 38 的 64 条陷阱警告。
---

# RouteDev 陷阱全索引

## Phase 17b + Phase 0c（陷阱 1-13）
1. ModelRouter.route() 接受 ClassificationResult...
（完整迁移 64 条，按 Phase 分章）
```

#### 1.2.3 筛选 Top 10 核心陷阱

保留在 AGENTS.md 正文的标准：当前生产路径仍高频触发、违反会导致崩溃或数据丢失。筛选结果（示例）：

- #11 权限检查走 PermissionEngine 中间件
- #14 命令解析必须走 parseCommand() tokenize
- #16 环境变量替换 fail-fast
- #18 Rollback 前置工作区检查
- #23 TaskOrchestrator 是 App.tsx 的新调度层
- #27 ReadTracker 追踪的是绝对路径
- #45 HookRunner 必须传入 TraceCollector
- #54 Tool/Skill 的 description 写法决定 80% 匹配效果
- #60 中间件阶段顺序不可随意调整
- #62 子 Agent 的 ToolRegistry 是父 Agent 的浅拷贝

#### 1.2.4 自动加载逻辑

在 `src/memory/project-memory.ts` 中，AGENTS.md 加载逻辑不变（仍自动加载）。pitfalls-guide Skill 通过 SkillsRouter 的 description 匹配自动触发——当用户任务涉及核心模块修改时，Skill 被加载，陷阱按需进入上下文。

### 1.3 测试要求

- 瘦身后的 AGENTS.md ≤ 120 行
- pitfalls-guide SKILL.md 包含全部 64 条陷阱，无遗漏
- SKILL.md 的 description 包含触发场景关键词（PermissionEngine/AgentLoop/Checkpoint 等）
- SkillsRouter 能根据任务描述匹配到 pitfalls-guide
- AGENTS.md 正文 Top 10 陷阱与 SKILL.md 内容一致（无矛盾）

---

## Task 2：Skill/Tool description 规范与自动审计（≥ 6 测试）

### 2.1 问题定位

**位置**：`src/tools/builtin/*.ts`、`src/skills/`、`src/tools/mcp/mcp-tool.ts`

AGENTS.md 陷阱 #54 已记录：同一个工具，description 写「获取天气」→ 准确率 60%，写「当用户询问某个城市的当前温度、天气状况或未来预报时，使用此工具」→ 准确率 92%。但当前代码库中：

- `file_read` 的 description 可能只是 "Read a file"
- `code_search` 的 description 可能只是 "Search code"
- Skill 的 description 参差不齐
- 没有自动检查机制，新增工具/Skill 时 description 质量无保障

### 2.2 实现方案

#### 2.2.1 制定 description 书写规范

新增 `docs/DESCRIPTION_GUIDE.md`：

```markdown
# Skill/Tool Description 书写规范

## 核心原则
description 是写给模型看的，不是写给人看的标题。它决定 80% 的匹配效果。

## 句式模板
「当用户 [触发场景] 时，使用此 [工具/Skill]。[适用条件]。」

## 示例

### 差
- file_read: "Read a file"
- code_search: "Search code"

### 好
- file_read: "当用户需要查看某个文件的内容、理解现有代码实现、或在修改前确认当前代码时，使用此工具。支持指定行号范围。"
- code_search: "当用户需要按语义查找代码、定位某个功能的实现位置、或理解代码库结构时，使用此工具。基于嵌入模型语义匹配，非精确文本搜索。"

## 检查清单
- [ ] 包含触发场景（用户什么时候需要它）
- [ ] 包含适用条件（能做什么、不能做什么）
- [ ] 长度 ≥ 20 字符
- [ ] 不是纯英文单词堆砌
- [ ] 包含至少一个动词（查看/查找/修改/执行...）
```

#### 2.2.2 实现 description lint 检查器

新增 `scripts/lint-descriptions.ts`：

```typescript
// scripts/lint-descriptions.ts
// description 质量审计脚本，可在 CI 中运行

import { glob } from 'glob';
import { readFileSync } from 'node:fs';

interface DescriptionIssue {
  file: string;
  name: string;
  issue: string;
  suggestion: string;
}

const MIN_LENGTH = 20;
const TRIGGER_KEYWORDS = ['当', '需要', '时', '使用', 'when', 'need', 'use'];

async function lintDescriptions(): Promise<DescriptionIssue[]> {
  const issues: DescriptionIssue[] = [];

  // 检查内置工具
  const toolFiles = await glob('src/tools/builtin/*.ts');
  for (const file of toolFiles) {
    const content = readFileSync(file, 'utf-8');
    // 提取 description 字段
    const match = content.match(/description:\s*['"`]([^'"`]+)['"`]/);
    if (!match) continue;
    const desc = match[1];
    const name = file.split('/').pop()?.replace('.ts', '') ?? file;

    if (desc.length < MIN_LENGTH) {
      issues.push({
        file, name,
        issue: `description 过短（${desc.length} 字符 < ${MIN_LENGTH}）`,
        suggestion: '补充触发场景与适用条件，参考 docs/DESCRIPTION_GUIDE.md',
      });
    }
    if (!TRIGGER_KEYWORDS.some(kw => desc.toLowerCase().includes(kw))) {
      issues.push({
        file, name,
        issue: '缺少触发场景关键词',
        suggestion: '使用「当用户...时，使用此工具」句式',
      });
    }
  }

  // 检查 Skill 的 SKILL.md
  const skillFiles = await glob('**/SKILL.md');
  for (const file of skillFiles) {
    const content = readFileSync(file, 'utf-8');
    const match = content.match(/^description:\s*(.+)$/m);
    if (!match) continue;
    const desc = match[1].trim();
    // 同上检查...
  }

  return issues;
}

lintDescriptions().then(issues => {
  if (issues.length === 0) {
    console.log('[ok] 所有 description 符合规范');
    process.exit(0);
  }
  console.error(`[fail] 发现 ${issues.length} 个 description 问题：`);
  issues.forEach(i => console.error(`  ${i.name}: ${i.issue}`));
  process.exit(1);
});
```

#### 2.2.3 批量改写现有 description

对 `src/tools/builtin/` 下所有工具的 description 做一次审计改写。示例：

```typescript
// 修改前
export const fileReadTool = {
  name: 'file_read',
  description: 'Read a file',
  // ...
};

// 修改后
export const fileReadTool = {
  name: 'file_read',
  description: '当用户需要查看某个文件的内容、理解现有代码实现、或在修改前确认当前代码时，使用此工具。支持指定行号范围与编码自动检测。',
  // ...
};
```

需改写的工具清单（基于 `src/tools/builtin/`）：
- `file-read.ts` → file_read
- `file-write.ts` → file_write
- `file-search.ts` → file_search
- `code-search.ts` → code_search
- `shell-exec.ts` → shell_exec
- `git-op.ts` → git_op
- `list-directory.ts` → list_directory
- `web-fetch.ts` → web_fetch
- `web-search.ts` → web_search
- `notes-tool.ts` → notes
- `repo-map.ts` → repo_map
- `todo-write.ts` → todo_write
- `spawn-agent.ts` → spawn_agent
- `ask-user.ts` → ask_user

#### 2.2.4 接入验收门

在 `scripts/verify.ts` 中增加 description lint 检查：

```typescript
// scripts/verify.ts 追加
import { execSync } from 'node:child_process';

function checkDescriptions() {
  try {
    execSync('npx tsx scripts/lint-descriptions.ts', { stdio: 'pipe' });
    return { pass: true };
  } catch (err) {
    return { pass: false, message: 'description 审计未通过，运行 npx tsx scripts/lint-descriptions.ts 查看详情' };
  }
}
```

### 2.3 测试要求

- lint 脚本能正确提取工具和 Skill 的 description
- 过短的 description 被标记为问题
- 缺少触发关键词的 description 被标记为问题
- 改写后的 14 个内置工具 description 全部通过 lint
- `pnpm tsx scripts/verify.ts` 包含 description 检查
- 现有测试不受 description 文本变更影响（description 不参与逻辑判断）

---

## Task 3：`routedev exec` 非交互模式（≥ 6 测试）

### 3.1 问题定位

**位置**：`src/index.tsx`、`src/cli/args.ts`

当前 RouteDev 只有交互式 CLI（Ink UI）和服务器模式（`--serve`），缺少非交互模式。用户无法：

- 在 CI 中运行 RouteDev 执行目标
- 用脚本批量调用
- 将 RouteDev 嵌入管道（stdin → 处理 → stdout）

**stormzhang 调研发现**：Claude Code 的 `claude -p "提示"` 无头模式 + `--allowedTools` 工具白名单 + GitHub Action 集成是工程化的关键能力。

### 3.2 实现方案

#### 3.2.1 新增 exec 子命令

在 `src/cli/args.ts` 中增加 exec 参数解析：

```typescript
// src/cli/args.ts 新增
export interface ExecArgs {
  prompt: string;
  allowedTools?: string[];    // 工具白名单
  outputFormat: 'text' | 'json';
  outputFile?: string;        // 输出文件路径
  maxSteps: number;           // 最大步数，防止无限循环
  timeout: number;            // 总超时（毫秒）
  workMode: 'read-only' | 'workspace-write' | 'full-access';
}

export function parseExecArgs(argv: string[]): ExecArgs | null {
  // routedev exec "prompt" --allowedTools file_read,file_search --json --timeout 300000
  if (argv[0] !== 'exec') return null;
  const prompt = argv[1];
  if (!prompt) throw new Error('exec 需要一个 prompt 参数');

  const allowedTools = parseFlag(argv, '--allowedTools')?.split(',');
  const outputFormat = argv.includes('--json') ? 'json' : 'text';
  const outputFile = parseFlag(argv, '--output') ?? parseFlag(argv, '-o');
  const maxSteps = parseInt(parseFlag(argv, '--maxSteps') ?? '50', 10);
  const timeout = parseInt(parseFlag(argv, '--timeout') ?? '300000', 10);
  const workMode = (parseFlag(argv, '--workMode') ?? 'workspace-write') as ExecArgs['workMode'];

  return { prompt, allowedTools, outputFormat, outputFile, maxSteps, timeout, workMode };
}
```

#### 3.2.2 实现 exec 执行器

新增 `src/cli/exec-runner.ts`：

```typescript
// src/cli/exec-runner.ts
// 非交互模式执行器：进度走 stderr，结果走 stdout

import { createServiceContext } from './app-init.js';
import type { ExecArgs } from './args.js';
import type { ServiceContext } from './service-context.js';

export async function runExec(args: ExecArgs): Promise<number> {
  const exitCode = await withTimeout(args.timeout, async () => {
    // 装配服务（复用 app-init，但不渲染 Ink UI）
    const deps = await createServiceContext({
      cwd: process.cwd(),
      headless: true,  // 新增标志：禁用 UI 交互、自动确认
    });

    // 应用工具白名单
    if (args.allowedTools) {
      deps.toolRegistry.restrictToWhitelist(args.allowedTools);
    }

    // 应用工作模式权限
    deps.permissionEngine.setSandboxLevel(args.workMode);

    // 进度输出到 stderr
    process.stderr.write(`[exec] 开始执行: ${args.prompt.slice(0, 80)}...\n`);

    const result = await deps.taskOrchestrator.run({
      input: args.prompt,
      maxSteps: args.maxSteps,
      onStep: (step) => {
        process.stderr.write(`[exec] 步骤 ${step.index}/${args.maxSteps}: ${step.description}\n`);
      },
    });

    // 结果输出到 stdout
    if (args.outputFormat === 'json') {
      const json = JSON.stringify({
        success: result.success,
        steps: result.steps,
        output: result.output,
        tokenUsage: result.tokenUsage,
        duration: result.duration,
      }, null, 2);
      if (args.outputFile) {
        await writeFileSync(args.outputFile, json);
      } else {
        process.stdout.write(json);
      }
    } else {
      process.stdout.write(result.output);
    }

    return result.success ? 0 : 1;
  });

  return exitCode;
}

async function withTimeout(ms: number, fn: () => Promise<number>): Promise<number> {
  return Promise.race([
    fn(),
    new Promise<number>((resolve) => setTimeout(() => {
      process.stderr.write(`[exec] 超时（${ms}ms）\n`);
      resolve(2);
    }, ms)),
  ]);
}
```

#### 3.2.3 在 index.tsx 中接入

```typescript
// src/index.tsx 修改入口
import { parseExecArgs } from './cli/args.js';
import { runExec } from './cli/exec-runner.js';

async function main() {
  const argv = process.argv.slice(2);

  // 优先检查 exec 子命令
  const execArgs = parseExecArgs(argv);
  if (execArgs) {
    const code = await runExec(execArgs);
    process.exit(code);
  }

  // 原有逻辑：交互式 UI 或 serve
  // ...
}
```

#### 3.2.4 headless 模式下的权限与确认

`createServiceContext` 增加 `headless` 参数：

```typescript
// src/cli/app-init.ts 修改 createServiceContext
export async function createServiceContext(deps: ServiceContextDeps) {
  // ...
  if (deps.headless) {
    // headless 模式：所有 confirm 自动按最保守策略处理
    // - read-only: 所有写入工具 deny
    // - workspace-write: 文件操作 auto，网络/shell/git push confirm→deny
    // - full-access: 全部 auto（仅在隔离环境使用）
    permissionEngine.setHeadlessMode(true);
  }
  // ...
}
```

### 3.3 测试要求

- `routedev exec "hello"` 在非交互环境执行并返回 0
- `--json` 输出合法 JSON，含 success/steps/output/tokenUsage 字段
- `--allowedTools file_read,file_search` 限制后，调用其他工具被拒绝
- `--timeout` 超时后返回退出码 2
- 进度信息输出到 stderr，不污染 stdout 的结果
- `--output result.json` 将结果写入文件

---

## Task 4：沙箱级与审批级分离的权限模型（≥ 8 测试）

### 4.1 问题定位

**位置**：`src/tools/permission-engine.ts`、`config.example.yaml` 的 `security` 段

当前权限模型是 `deny > confirm > auto` 三层决策，只有一个旋钮：「是否询问用户」。无法表达：

- 「文件读取可以自动，但网络请求必须问」——当前能做到
- 「整个会话只读，禁止任何写入」——当前需要逐条配 deny
- 「允许改代码，但 git push 永远问」——当前能做到但语义不清晰

**stormzhang 调研发现**：Codex 把权限拆成两个独立旋钮——沙箱（read-only / workspace-write / danger-full-access，决定能动多大）+ 审批（untrusted / on-request / never，决定问不问）。两个旋钮正交，表达力更强。

### 4.2 实现方案

#### 4.2.1 扩展权限模型

```typescript
// src/tools/permission-engine.ts 新增类型

// 沙箱级：决定工具能做多少
export type SandboxLevel = 'read-only' | 'workspace-write' | 'full-access';

// 审批级：决定是否询问用户
export type ApprovalLevel = 'always-ask' | 'on-request' | 'never-ask';

// 工具分类（决定在哪个沙箱级可用）
export type ToolCategory =
  | 'read'           // file_read, list_directory, code_search
  | 'write'          // file_write, file_edit
  | 'shell'          // shell_exec
  | 'network'        // web_fetch, web_search
  | 'git-read'       // git status, git log, git diff
  | 'git-write'      // git add, git commit, git push
  | 'agent'          // spawn_agent
  | 'mcp';           // MCP 工具

// 沙箱级 → 允许的工具类别
const SANDBOX_ALLOWED: Record<SandboxLevel, ToolCategory[]> = {
  'read-only': ['read', 'git-read'],
  'workspace-write': ['read', 'write', 'shell', 'git-read'],
  'full-access': ['read', 'write', 'shell', 'network', 'git-read', 'git-write', 'agent', 'mcp'],
};

// 工具类别 → 默认审批级
const DEFAULT_APPROVAL: Record<ToolCategory, ApprovalLevel> = {
  'read': 'never-ask',
  'write': 'on-request',
  'shell': 'always-ask',
  'network': 'always-ask',
  'git-read': 'never-ask',
  'git-write': 'always-ask',
  'agent': 'on-request',
  'mcp': 'on-request',
};
```

#### 4.2.2 扩展 PermissionEngine

```typescript
// src/tools/permission-engine.ts 扩展

export class PermissionEngine {
  private sandboxLevel: SandboxLevel = 'workspace-write';
  private approvalOverrides: Map<ToolCategory, ApprovalLevel> = new Map();
  private headless: boolean = false;

  // 设置沙箱级
  setSandboxLevel(level: SandboxLevel): void {
    this.sandboxLevel = level;
  }

  // 覆盖某类工具的审批级
  setApproval(category: ToolCategory, level: ApprovalLevel): void {
    this.approvalOverrides.set(category, level);
  }

  // 核心决策：沙箱级先判断，审批级后判断
  decide(toolName: string, args: unknown): PermissionDecision {
    const category = this.categorize(toolName);

    // 第一旋钮：沙箱级判断（确定性，不询问）
    if (!SANDBOX_ALLOWED[this.sandboxLevel].includes(category)) {
      return { action: 'deny', reason: `沙箱级 ${this.sandboxLevel} 不允许 ${category} 类工具` };
    }

    // 第二旋钮：审批级判断
    const approval = this.approvalOverrides.get(category) ?? DEFAULT_APPROVAL[category];

    if (approval === 'never-ask') {
      return { action: 'auto' };
    }
    if (approval === 'always-ask') {
      if (this.headless) {
        // headless 模式下 always-ask 自动 deny
        return { action: 'deny', reason: 'headless 模式不交互，always-ask 工具自动拒绝' };
      }
      return { action: 'confirm' };
    }
    // on-request：根据具体参数判断（如 shell_exec 的命令危险性）
    return this.decideOnRequest(category, toolName, args);
  }

  private categorize(toolName: string): ToolCategory {
    // 工具名 → 类别映射
    if (['file_read', 'list_directory', 'code_search', 'file_search', 'repo_map'].includes(toolName)) return 'read';
    if (['file_write', 'file_edit'].includes(toolName)) return 'write';
    if (toolName === 'shell_exec') return 'shell';
    if (['web_fetch', 'web_search'].includes(toolName)) return 'network';
    if (toolName.startsWith('git_')) {
      return ['git_push', 'git_commit', 'git_add'].includes(toolName) ? 'git-write' : 'git-read';
    }
    if (toolName === 'spawn_agent') return 'agent';
    if (toolName.startsWith('mcp__')) return 'mcp';
    return 'shell'; // 未知工具归入最严格类别
  }
}
```

#### 4.2.3 配置扩展

```yaml
# config.example.yaml 扩展 security 段
security:
  # 沙箱级（第一旋钮）：决定工具能做多少
  sandbox: workspace-write    # read-only / workspace-write / full-access

  # 审批级覆盖（第二旋钮）：决定是否询问，覆盖默认值
  approval:
    write: on-request         # 文件写入：按需询问
    shell: always-ask         # shell 命令：总是询问
    network: always-ask       # 网络请求：总是询问
    git-write: always-ask     # git 写操作：总是询问
    agent: on-request         # 子 Agent：按需询问
    mcp: on-request           # MCP 工具：按需询问

  # 向后兼容：原有配置项保留
  directoryBoundary: true
  commandBlacklist: ["rm -rf", "format", "del /s"]
  sensitiveFiles: [".env", "credentials.json", "*.key"]
  sensitiveFilePolicy: readonly
  networkConfirm: true
```

#### 4.2.4 桌面端权限切换 UI

在 `SettingsPage.tsx` 增加权限快速切换：

```tsx
// 桌面端设置页新增权限段
<div className="space-y-3">
  <Label>沙箱级别</Label>
  <Select
    value={config.security.sandbox}
    onChange={(v) => updateConfig('security.sandbox', v)}
    options={[
      { value: 'read-only', label: '只读（仅查看，不修改）' },
      { value: 'workspace-write', label: '工作区写入（可改代码，网络/git 需确认）' },
      { value: 'full-access', label: '完全访问（所有工具可用，谨慎使用）' },
    ]}
  />
</div>
```

### 4.3 测试要求

- `read-only` 沙箱下 file_write 被 deny，file_read 被 auto
- `workspace-write` 沙箱下 web_fetch 被 deny（不在允许列表）
- `full-access` 沙箱下所有类别可用
- 审批覆盖：`write: never-ask` 后 file_write 不再询问
- headless 模式下 always-ask 工具自动 deny
- 向后兼容：不配置 `sandbox` 时默认 `workspace-write`
- 原有 `commandBlacklist` / `sensitiveFiles` 仍生效
- 桌面端切换沙箱级后立即生效（无需重启）

---

## Task 5：`/review` 独立子代理对抗性审查（≥ 6 测试）

### 5.1 问题定位

**位置**：`src/agent/unified-reviewer.ts`、`src/agent/multi/`

当前 `UnifiedReviewer` 是内置 reviewer Worker，与执行 Worker 共享 Blackboard 和部分上下文。问题：

- 审查者能看到执行者的思考过程，产生「自我偏袒」
- 审查结果与执行结果混在同一 Blackboard，难以独立追溯
- 用户无法主动触发对当前 diff 的独立审查

**stormzhang 调研发现**：推荐 Writer + Reviewer 模式——一个会话写代码，另一个新会话审 diff，避免自我偏袒。审查者不共享 Writer 的上下文。

### 5.2 实现方案

#### 5.2.1 新增 /review 命令

新增 `src/cli/commands/review.ts`：

```typescript
// src/cli/commands/review.ts
// /review 命令：启动独立子代理会话对当前 diff 做对抗性审查

import type { Command } from '../command-registry.js';

export const reviewCommand: Command = {
  name: 'review',
  description: '启动独立子代理会话，对当前未提交的代码变更做对抗性审查',
  aliases: ['rv'],
  async execute({ args, deps, sendMessage }) {
    // 1. 获取当前 diff
    const diff = await deps.git.getDiff();  // git diff HEAD
    if (!diff.trim()) {
      sendMessage('当前没有未提交的代码变更，无需审查。');
      return;
    }

    // 2. 获取变更文件列表
    const changedFiles = await deps.git.getChangedFiles();

    // 3. 启动独立子代理会话（不共享 conversationHistory）
    sendMessage(`启动独立审查会话，审查 ${changedFiles.length} 个文件的变更...`);

    const reviewResult = await deps.subAgentLifecycle.spawn({
      profile: 'reviewer',  // 使用 reviewer 人格模板
      task: buildReviewPrompt(diff, changedFiles, args),
      // 关键：不传入主会话的 conversationHistory
      context: {
        diff,
        changedFiles,
        reviewFocus: args[0] ?? 'correctness',  // correctness / security / performance / style
      },
      // 审查子代理的工具白名单：只读 + code_search，不能修改文件
      allowedTools: ['file_read', 'code_search', 'file_search', 'list_directory'],
      // 审查子代理的权限：read-only 沙箱
      sandboxLevel: 'read-only',
    });

    // 4. 输出审查结果
    sendMessage(formatReviewResult(reviewResult));
  },
};

function buildReviewPrompt(diff: string, files: string[], args: string[]): string {
  const focus = args[0] ?? 'correctness';
  const focusMap: Record<string, string> = {
    correctness: '逻辑正确性、边界条件、错误处理',
    security: '安全漏洞、注入风险、敏感信息泄露',
    performance: '性能问题、不必要的计算、内存泄漏',
    style: '代码风格、命名规范、注释完整性',
  };
  return `你是独立代码审查员，请审查以下代码变更。

审查重点：${focusMap[focus]}

变更文件：${files.join(', ')}

要求：
1. 只指出影响正确性的问题，不提风格偏好
2. 每个问题给出文件名、行号、问题描述、建议修复
3. 如果没有发现问题，明确说"未发现问题"
4. 不要赞美代码写得好，只关注问题

代码变更：
${diff}`;
}
```

#### 5.2.2 注册命令

在 `src/cli/App.tsx` 的命令注册数组中追加：

```typescript
import { reviewCommand } from './commands/review.js';
// ...
[/* 已有命令 */, reviewCommand].forEach(c => commandRegistryRef.current.register(c));
```

#### 5.2.3 reviewer 人格模板

在 `src/agents/profiles/builtin-templates.ts` 中新增 reviewer 模板：

```typescript
export const reviewerProfile: AgentProfile = {
  id: 'reviewer',
  name: '独立审查员',
  description: '对抗性代码审查，只关注问题不赞美，使用只读工具',
  systemPrompt: `你是独立代码审查员，与代码作者无上下文共享。

审查原则：
1. 假设代码可能有错，你的职责是找出错误
2. 只报告影响正确性、安全性、性能的问题
3. 不报告风格偏好、命名喜好等主观问题
4. 每个问题必须可验证：给出文件名、行号、具体描述
5. 如果没发现问题，明确说"未发现问题"，不要编造问题
6. 你只有只读工具，不能修改任何文件`,
  defaultTools: ['file_read', 'code_search', 'file_search', 'list_directory'],
  sandboxLevel: 'read-only',
};
```

#### 5.2.4 审查结果格式化

```typescript
function formatReviewResult(result: SubAgentResult): string {
  if (!result.issues || result.issues.length === 0) {
    return '✅ 独立审查完成，未发现影响正确性的问题。';
  }
  const lines = [`⚠️ 独立审查完成，发现 ${result.issues.length} 个问题：`, ''];
  result.issues.forEach((issue, i) => {
    lines.push(`${i + 1}. [${issue.severity}] ${issue.file}:${issue.line}`);
    lines.push(`   ${issue.description}`);
    lines.push(`   建议：${issue.suggestion}`);
    lines.push('');
  });
  return lines.join('\n');
}
```

### 5.3 测试要求

- `/review` 在有未提交变更时启动审查
- `/review` 在无变更时提示「无需审查」
- 审查子代理不接收主会话的 conversationHistory
- 审查子代理只有只读工具，file_write 被拒绝
- `/review security` 聚焦安全审查
- 审查结果格式化正确，含问题数量与详情

---

## Task 6：Checkpoint 可视化时间轴与语义化摘要（≥ 5 测试）

### 6.1 问题定位

**位置**：`src/harness/checkpoint-manager.ts`、`desktop/renderer/src/components/`

当前 Checkpoint 只有 CLI 的 `/checkpoint list` 文本列表，桌面端无可视化。用户：

- 不知道有哪些检查点
- 不知道每个检查点做了什么（描述只是 `description + timestamp`）
- 不敢回滚，怕丢失工作

**stormzhang 调研发现**：Checkpoint 是交互式会话的安全网，`/rewind` 或双击 Esc 回退。描述应语义化，让用户一眼看懂每个检查点。

### 6.2 实现方案

#### 6.2.1 Checkpoint 语义化摘要

在 `CheckpointManager.create()` 中，增加 LLM 生成一句话摘要：

```typescript
// src/harness/checkpoint-manager.ts 修改 create 方法

async create(description: string): Promise<Checkpoint> {
  const checkpoint: Checkpoint = {
    id: generateId(),
    description,
    timestamp: Date.now(),
    // 新增：语义化摘要
    summary: await this.generateSummary(description),
    // 新增：变更文件数与 token 统计
    stats: {
      filesChanged: await this.countChangedFiles(),
      tokensUsed: this.tokenTracker?.getStats().total ?? 0,
    },
  };
  // ... 持久化逻辑
}

private async generateSummary(description: string): Promise<string> {
  if (!this.llmClient) return description;
  try {
    const result = await this.llmClient.complete({
      prompt: `用一句话（≤20字）概括这个检查点的内容：${description}`,
      maxTokens: 50,
    });
    return result.text.slice(0, 30);
  } catch {
    return description;  // LLM 失败时降级为原始描述
  }
}
```

#### 6.2.2 桌面端 Checkpoint 时间轴组件

新增 `desktop/renderer/src/components/CheckpointTimeline.tsx`：

```tsx
// CheckpointTimeline.tsx
// Checkpoint 可视化时间轴，支持点击回滚

import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

interface Checkpoint {
  id: string;
  summary: string;
  timestamp: number;
  stats: { filesChanged: number; tokensUsed: number };
}

export function CheckpointTimeline({ projectId }: { projectId: string }) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    // 通过 IPC 获取检查点列表
    window.api.checkpoint.list(projectId).then(setCheckpoints);
  }, [projectId]);

  const handleRollback = async (id: string) => {
    const confirmed = await confirm('确定回滚到此检查点？当前未提交的变更将丢失。');
    if (!confirmed) return;
    await window.api.checkpoint.rollback(id);
    // 刷新列表
  };

  return (
    <div className="flex flex-col gap-2 p-4">
      <h3 className="text-sm font-medium text-rd-text">检查点时间轴</h3>
      <div className="relative pl-4 border-l border-rd-border/20">
        {checkpoints.map((cp) => (
          <div
            key={cp.id}
            className={`mb-3 cursor-pointer rounded-lg p-2 transition-colors ${
              selectedId === cp.id ? 'bg-rd-accent/10' : 'hover:bg-rd-muted/30'
            }`}
            onClick={() => setSelectedId(cp.id)}
          >
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-rd-accent -ml-[21px]" />
              <span className="text-xs text-rd-textMuted">
                {new Date(cp.timestamp).toLocaleTimeString()}
              </span>
              <Badge variant="secondary" className="text-xs">
                {cp.stats.filesChanged} 文件
              </Badge>
            </div>
            <p className="mt-1 text-sm text-rd-text">{cp.summary}</p>
            {selectedId === cp.id && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={(e) => { e.stopPropagation(); handleRollback(cp.id); }}
              >
                回滚到此点
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

#### 6.2.3 IPC 桥接

在 `desktop/main/index.ts` 中新增 IPC handler：

```typescript
ipcMain.handle('checkpoint:list', async (_event, projectId: string) => {
  if (!engine) return [];
  return engine.listCheckpoints(projectId);
});

ipcMain.handle('checkpoint:rollback', async (_event, checkpointId: string) => {
  if (!engine) return { success: false, error: '引擎未初始化' };
  return engine.rollbackCheckpoint(checkpointId);
});
```

#### 6.2.4 在 ChatPage 侧边栏接入

在 `desktop/renderer/src/pages/ChatPage.tsx` 的右侧面板增加 Checkpoint 时间轴 Tab：

```tsx
<Tabs defaultValue="trace">
  <TabsList>
    <TabsTrigger value="trace">执行轨迹</TabsTrigger>
    <TabsTrigger value="checkpoints">检查点</TabsTrigger>
  </TabsList>
  <TabsContent value="trace"><TracePanel /></TabsContent>
  <TabsContent value="checkpoints"><CheckpointTimeline projectId={projectId} /></TabsContent>
</Tabs>
```

### 6.3 测试要求

- Checkpoint 创建时生成语义化摘要（LLM 可用时）
- LLM 不可用时降级为原始描述
- 时间轴组件正确渲染检查点列表
- 点击检查点高亮并显示回滚按钮
- 回滚前弹出确认对话框

---

## Task 7：自定义 Slash 命令（≥ 5 测试）

### 7.1 问题定位

**位置**：`src/cli/command-registry.ts`

当前所有 `/` 命令硬编码在 `command-registry.ts` 中，用户无法自定义。高频操作（如「生成 commit message」「解释当前 diff」「按团队模板写 API」）无法固化为快捷入口。

**stormzhang 调研发现**：Claude Code 支持在 `.claude/commands/name.md` 自定义命令，带 frontmatter，用 `$ARGUMENTS` 传参，可预填 `git diff`、`git status` 等现场数据。

### 7.2 实现方案

#### 7.2.1 自定义命令文件格式

在 `.routedev/commands/` 下放置 Markdown 文件，例如 `.routedev/commands/commit.md`：

```markdown
---
description: 生成符合 Conventional Commits 的提交信息
arguments: [scope]
---

请基于以下代码变更生成提交信息：

当前分支：{{git_branch}}
变更文件：
{{git_status}}

变更内容：
{{git_diff}}

要求：
- 遵循 Conventional Commits 格式（feat/fix/refactor/test/docs）
- scope 从参数获取：$1
- 提交信息不超过 50 字符
- 中文描述
```

#### 7.2.2 命令加载器

新增 `src/cli/custom-commands.ts`：

```typescript
// src/cli/custom-commands.ts
// 从 .routedev/commands/ 加载自定义 slash 命令

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Command } from './command-registry.js';

interface CommandFrontmatter {
  description: string;
  arguments?: string[];
}

export function loadCustomCommands(commandsDir: string): Command[] {
  let files: string[];
  try {
    files = readdirSync(commandsDir).filter(f => f.endsWith('.md'));
  } catch {
    return [];  // 目录不存在时返回空
  }

  return files.map(file => parseCommandFile(join(commandsDir, file), file));
}

function parseCommandFile(filePath: string, fileName: string): Command {
  const content = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = splitFrontmatter(content);
  const name = fileName.replace('.md', '');

  return {
    name,
    description: frontmatter.description,
    aliases: [],
    async execute({ args, deps, sendMessage }) {
      // 预填现场数据
      const prompt = await renderTemplate(body, args, deps);
      // 自定义命令本质是发送一个预填好的 prompt 给 Agent
      await deps.taskOrchestrator.run({ input: prompt });
    },
  };
}

async function renderTemplate(template: string, args: string[], deps: ServiceContext): Promise<string> {
  let result = template;

  // 替换 $1, $2 等位置参数
  args.forEach((arg, i) => {
    result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), arg);
  });

  // 替换 {{git_diff}} {{git_status}} {{git_branch}} 等变量
  result = result.replace(/\{\{git_diff\}\}/g, () => runGit('diff'));
  result = result.replace(/\{\{git_status\}\}/g, () => runGit('status', '--short'));
  result = result.replace(/\{\{git_branch\}\}/g, () => runGit('branch', '--show-current'));
  result = result.replace(/\{\{current_file\}\}/g, deps.editor?.getCurrentFile() ?? '');

  return result;
}

function runGit(...args: string[]): string {
  try {
    return spawnSync('git', args, { encoding: 'utf-8', timeout: 5000 }).stdout ?? '';
  } catch {
    return '';
  }
}
```

#### 7.2.3 在 App.tsx 中注册自定义命令

```typescript
// src/cli/App.tsx 修改命令注册段
import { loadCustomCommands } from './custom-commands.js';
import { join } from 'node:path';

// 在命令注册后追加
const customCommandsDir = join(process.cwd(), '.routedev', 'commands');
const customCommands = loadCustomCommands(customCommandsDir);
customCommands.forEach(c => commandRegistryRef.current.register(c));
logger.info('自定义命令已加载', { count: customCommands.length });
```

#### 7.2.4 命名空间隔离

自定义命令与内置命令同名时，内置命令优先（自定义命令被忽略并警告）：

```typescript
customCommands.forEach(c => {
  if (commandRegistryRef.current.has(c.name)) {
    logger.warn(`自定义命令 /${c.name} 与内置命令冲突，已忽略`);
    return;
  }
  commandRegistryRef.current.register(c);
});
```

### 7.3 测试要求

- `.routedev/commands/commit.md` 被正确加载为 `/commit` 命令
- frontmatter 的 description 被正确解析
- `{{git_diff}}` 变量被替换为实际 diff 输出
- `$1` 位置参数被替换为用户输入的第一个参数
- 自定义命令与内置命令同名时被忽略并记录警告

---

## Task 8：AGENTS.local.md 与 CLAUDE.md fallback 兼容（≥ 4 测试）

### 8.1 问题定位

**位置**：`src/memory/project-memory.ts`、`src/config/loader.ts`

当前 RouteDev 只加载 `AGENTS.md`。问题：

- 从 Claude Code 生态迁移过来的项目用 `CLAUDE.md`，需手动改名
- 个人临时偏好只能改 `AGENTS.md`，污染团队共享文件
- 无 `.override.md` 机制做临时盖章

**stormzhang 调研发现**：
- Claude Code：`CLAUDE.md` + `CLAUDE.local.md`（个人变体，不提交 git）
- Codex：`AGENTS.md` + `AGENTS.override.md`（临时覆盖，跳过同级 AGENTS.md）
- Codex 支持 `project_doc_fallback_filenames` 配置兼容旧文件名

### 8.2 实现方案

#### 8.2.1 加载优先级

```typescript
// src/memory/project-memory.ts 修改加载逻辑

const DOC_LOAD_ORDER = [
  'AGENTS.md',           // 团队共享（最高优先级）
  'AGENTS.local.md',     // 个人本地（不提交 git，覆盖团队）
  'AGENTS.override.md',  // 临时覆盖（跳过 AGENTS.md，仅临时）
  'CLAUDE.md',           // fallback（Claude Code 生态兼容）
  'CLAUDE.local.md',     // fallback 个人本地
];
```

加载规则：
1. `AGENTS.override.md` 存在时，**跳过** `AGENTS.md`，只加载 override + local
2. 否则加载 `AGENTS.md` + `AGENTS.local.md`（合并，local 覆盖同名段）
3. 以上都不存在时，fallback 到 `CLAUDE.md` + `CLAUDE.local.md`

#### 8.2.2 配置支持

```yaml
# config.example.yaml 新增
projectDoc:
  filenames:                   # 按顺序尝试加载
    - AGENTS.md
    - AGENTS.local.md
    - AGENTS.override.md
  fallbackFilenames:           # 以上都不存在时尝试
    - CLAUDE.md
    - CLAUDE.local.md
  maxBytes: 32768              # 最大字节数（超出截断，对齐 Codex 32KiB）
```

#### 8.2.3 实现

```typescript
// src/memory/project-memory.ts

export async function loadProjectDoc(cwd: string, config: ProjectDocConfig): Promise<string | null> {
  // 1. 检查 override
  const overridePath = join(cwd, 'AGENTS.override.md');
  if (await pathExists(overridePath)) {
    const override = await readFile(overridePath, 'utf-8');
    const local = await tryRead(join(cwd, 'AGENTS.local.md'));
    return mergeDocs(override, local);
  }

  // 2. 加载 AGENTS.md + AGENTS.local.md
  const agentsPath = join(cwd, 'AGENTS.md');
  if (await pathExists(agentsPath)) {
    const agents = await readFile(agentsPath, 'utf-8');
    const local = await tryRead(join(cwd, 'AGENTS.local.md'));
    const merged = mergeDocs(agents, local);
    return truncateDoc(merged, config.maxBytes);
  }

  // 3. fallback 到 CLAUDE.md
  for (const name of config.fallbackFilenames) {
    const path = join(cwd, name);
    if (await pathExists(path)) {
      logger.info(`项目说明文件 fallback 到 ${name}`);
      const content = await readFile(path, 'utf-8');
      return truncateDoc(content, config.maxBytes);
    }
  }

  return null;
}

function mergeDocs(base: string, local?: string): string {
  if (!local) return base;
  // 简单拼接，local 在后（覆盖语义）
  return `${base}\n\n## 个人本地覆盖\n\n${local}`;
}

function truncateDoc(doc: string, maxBytes: number): string {
  if (Buffer.byteLength(doc, 'utf-8') <= maxBytes) return doc;
  logger.warn(`项目说明文件超过 ${maxBytes} 字节，已截断`);
  return Buffer.from(doc, 'utf-8').subarray(0, maxBytes).toString('utf-8');
}
```

#### 8.2.4 .gitignore 建议

在 `.gitignore` 模板中追加：

```
# RouteDev 个人本地覆盖（不提交）
AGENTS.local.md
CLAUDE.local.md
```

### 8.3 测试要求

- `AGENTS.md` 存在时正常加载
- `AGENTS.local.md` 存在时与 `AGENTS.md` 合并
- `AGENTS.override.md` 存在时跳过 `AGENTS.md`
- `AGENTS.md` 不存在时 fallback 到 `CLAUDE.md`
- 超过 `maxBytes` 时截断并警告

---

## Task 9：官方 GitHub Action 与 CI 集成模板（≥ 4 测试）

### 9.1 问题定位

用户想在 GitHub Actions 中使用 RouteDev，但需自行摸索接入方式。无官方 action.yml，无示例 workflow。

**stormzhang 调研发现**：Claude Code 和 Codex 都提供官方 GitHub Action，支持在 PR/issue 中 `@claude` 触发，API key 走 Secrets。

### 9.2 实现方案

#### 9.2.1 创建 action.yml

新增 `routedev/action.yml`：

```yaml
# routedev/action.yml
# RouteDev 官方 GitHub Action

name: 'RouteDev AI Coding'
description: '在 GitHub Actions 中运行 RouteDev 执行 AI 编程任务'
inputs:
  prompt:
    description: '要执行的任务描述'
    required: true
  work-mode:
    description: '工作模式：read-only / workspace-write / full-access'
    required: false
    default: 'workspace-write'
  allowed-tools:
    description: '工具白名单（逗号分隔），留空允许所有'
    required: false
    default: ''
  config:
    description: 'RouteDev config.yaml 内容（Base64 编码）'
    required: false
    default: ''
outputs:
  result:
    description: '执行结果（JSON 格式）'
    value: ${{ steps.exec.outputs.result }}

runs:
  using: 'node20'
  main: 'dist/index.js'
```

#### 9.2.2 Action 入口脚本

新增 `routedev/scripts/action-entry.ts`：

```typescript
// routedev/scripts/action-entry.ts
// GitHub Action 入口：读取 inputs，调用 routedev exec

import { getInput, setOutput, setFailed } from '@actions/core';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function main() {
  const prompt = getInput('prompt', { required: true });
  const workMode = getInput('work-mode') || 'workspace-write';
  const allowedTools = getInput('allowed-tools') || '';
  const configBase64 = getInput('config') || '';

  // 写入配置文件
  if (configBase64) {
    const configContent = Buffer.from(configBase64, 'base64').toString('utf-8');
    const configPath = join(tmpdir(), 'routedev-action-config.yaml');
    writeFileSync(configPath, configContent);
    process.env.ROUTEDEV_CONFIG = configPath;
  }

  // 构造命令
  const args = ['exec', prompt, '--json', '--workMode', workMode, '--timeout', '600000'];
  if (allowedTools) {
    args.push('--allowedTools', allowedTools);
  }

  // 执行
  try {
    const output = execSync(`npx routedev ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf-8',
      timeout: 600000,
      maxBuffer: 10 * 1024 * 1024,
    });
    setOutput('result', output);
  } catch (err) {
    setFailed(`RouteDev 执行失败: ${err}`);
  }
}

main();
```

#### 9.2.3 示例 workflow

新增 `routedev/.github/workflows/routedev-example.yml`：

```yaml
# 示例：在 PR 中自动运行 RouteDev 代码审查
name: RouteDev Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: RouteDev 审查
        uses: routedev/routedev-action@v1
        with:
          prompt: |
            审查此 PR 的代码变更，重点关注：
            1. 逻辑正确性与边界条件
            2. 安全漏洞
            3. 性能问题
            输出审查结果，不要修改文件。
          work-mode: read-only
          allowed-tools: file_read,code_search,file_search,list_directory
        env:
          ROUTEDEV_API_KEY: ${{ secrets.ROUTEDEV_API_KEY }}

      - name: 发布审查评论
        uses: actions/github-script@v7
        with:
          script: |
            const result = JSON.parse('${{ steps.routedev.outputs.result }}');
            await github.rest.issues.createComment({
              ...context.repo,
              issue_number: context.issue.number,
              body: `## RouteDev 代码审查\n\n${result.output}`,
            });
```

#### 9.2.4 CI 安全规范

在 `docs/CI_SECURITY.md` 中明确：

```markdown
# RouteDev CI 集成安全规范

## 密钥管理
- API Key 必须存储在 GitHub Secrets，禁止明文写入 workflow
- 使用 `secrets.ROUTEDEV_API_KEY` 引用，不出现在日志中

## 权限最小化
- PR 审查场景：`work-mode: read-only`，`allowed-tools: file_read,code_search`
- 自动修复场景：`work-mode: workspace-write`，禁止 `full-access`
- 禁止在 CI 中使用 `full-access`（等同于无人值守裸奔）

## 输出处理
- `--json` 输出可能含代码内容，注意敏感信息脱敏
- 审查评论发布前检查是否含 API Key 等敏感字符串
```

### 9.3 测试要求

- action.yml 的 inputs/outputs 定义完整
- 入口脚本能正确解析 inputs 并构造 exec 命令
- config Base64 解码正确写入临时文件
- 示例 workflow 语法合法（可用 actionlint 验证）

---

## Task 10：集成测试与文档同步（≥ 5 测试）

### 10.1 端到端验证

1. **AGENTS.md 瘦身端到端**：启动 RouteDev → AGENTS.md 加载 ≤ 120 行 → 修改 PermissionEngine 相关代码 → pitfalls-guide Skill 自动加载 → 陷阱按需进入上下文
2. **exec 非交互端到端**：`routedev exec "解释这个项目的架构" --json --workMode read-only` → 输出合法 JSON → 退出码 0
3. **权限双旋钮端到端**：设置 `sandbox: read-only` → file_write 被 deny → 切换为 `workspace-write` → file_write 需 confirm
4. **/review 端到端**：修改文件 → `/review correctness` → 独立子代理审查 → 输出问题列表（或「未发现问题」）→ 审查子代理无法 file_write
5. **自定义命令端到端**：创建 `.routedev/commands/commit.md` → `/commit api` → 预填 git diff + scope=api → 生成 commit message
6. **Checkpoint 可视化端到端**：桌面端执行任务 → 侧边栏检查点 Tab 显示时间轴 → 点击检查点 → 显示回滚按钮 → 确认回滚

### 10.2 文档同步

- **AGENTS.md**：同步本 Phase 新增的陷阱警告（#133-#142）
- **CODEMAP.md**：新增 `src/cli/exec-runner.ts`、`src/cli/custom-commands.ts`、`desktop/renderer/src/components/CheckpointTimeline.tsx` 条目
- **config.example.yaml**：新增 `security.sandbox`、`security.approval`、`projectDoc` 配置段
- **CHANGELOG.md**：v3.8.0 条目
- **docs/DESCRIPTION_GUIDE.md**：新增 description 书写规范
- **docs/CI_SECURITY.md**：新增 CI 集成安全规范

### 10.3 回归测试

- 所有现有测试仍通过
- 桌面应用启动正常，无新增 console error
- CLI 所有原有命令仍可用
- `pnpm tsx scripts/verify.ts` 全绿（含新增的 description lint）

---

## 新增陷阱警告

**133. AGENTS.md 瘦身后必须保留 Top 10 核心陷阱在正文：** 完整 64 条陷阱迁移到 pitfalls-guide Skill 后，AGENTS.md 正文必须保留当前生产路径仍高频触发的 10 条（如权限中间件、命令解析 tokenize、环境变量 fail-fast 等）。不能全部迁移到 Skill，否则低相关性任务中模型完全看不到陷阱。筛选标准：违反会导致崩溃或数据丢失。

**134. description lint 不能阻断开发流程：** `scripts/lint-descriptions.ts` 在 CI 中应作为 warning 而非 error（首次引入时），给现有工具留改写缓冲期。只有新增工具/Skill 的 description 不合规时才 fail。已在 Task 2 中通过 `verify.ts` 接入，但建议设置过渡期。

**135. `routedev exec` 必须设总超时：** 非交互模式无人工中断，`--timeout` 默认 5 分钟，超时后强制退出并返回退出码 2。不能依赖 Agent 自己判断是否该停止。headless 模式下 always-ask 工具自动 deny，不能卡在等待确认。

**136. 沙箱级判断必须在审批级之前：** PermissionEngine.decide() 先判断沙箱级（确定性 deny），再判断审批级（confirm/auto）。顺序反了会导致：read-only 沙箱下 file_write 走到 confirm，用户确认后仍被沙箱 deny，体验混乱。

**137. `/review` 子代理必须用 read-only 沙箱：** 审查子代理的工具白名单只有只读工具，且沙箱级强制 `read-only`。不能只靠工具白名单限制——MCP 工具可能动态注册，白名单可能漏网。沙箱级是确定性兜底。

**138. Checkpoint 语义化摘要的 LLM 调用必须设超时与降级：** `generateSummary()` 调用 LLM 时设 3 秒超时，超时或失败时降级为原始 description。不能让摘要生成阻塞 Checkpoint 创建——Checkpoint 是安全网，创建失败比摘要缺失严重得多。

**139. 自定义命令的模板变量替换必须转义：** `{{git_diff}}` 替换的 diff 内容可能含 `$1`、`{{` 等特殊字符，导致二次替换。必须先替换位置参数 `$1`，再替换 `{{变量}}`，且替换后的内容不再参与后续替换（一次性替换，不递归）。

**140. AGENTS.override.md 的语义是「跳过」而非「合并」：** `AGENTS.override.md` 存在时跳过 `AGENTS.md`，不是合并。这与 `AGENTS.local.md`（合并覆盖）语义不同。混淆会导致用户以为 override 是补充，实际是替换，丢失 AGENTS.md 中的团队约定。

**141. GitHub Action 的 config 必须用 Base64 传输：** config.yaml 含 API Key 和多行 YAML，直接作为 input 会被 GitHub Actions 的字符串转义破坏。必须 Base64 编码后在 Action 内解码写入临时文件。API Key 仍走 Secrets 环境变量，不写入 config。

**142. 沙箱级切换需要刷新工具可用性缓存：** PermissionEngine 的 `setSandboxLevel()` 后，已注册的工具不会自动重新判断可用性。ToolRegistry 若缓存了工具可用性，切换沙箱级后必须清缓存。桌面端切换沙箱级后 UI 的工具列表需刷新。

---

## 思考引导总结

1. **为什么 AGENTS.md 瘦身是 Task 1 而不是最后做？** 64 条陷阱挤占上下文是当前最影响模型注意力的因素。先瘦身能让后续 Task 的实现质量更高——模型在修改 PermissionEngine 时不会被 60 条无关陷阱分散注意力。

2. **`routedev exec` 为什么复用 TaskOrchestrator 而不是直接调 AgentLoop？** TaskOrchestrator 已封装 intent 判定、需求确认、分解、执行、审查的完整流水线。exec 模式下禁用交互式确认（headless），其余流程复用，保证交互式与非交互式的行为一致性。

3. **权限双旋钮为什么不破坏向后兼容？** 原有 `security.commandBlacklist` / `sensitiveFiles` 等配置保留，新增 `sandbox` / `approval` 是叠加而非替换。不配置 `sandbox` 时默认 `workspace-write`，行为与当前 `deny > confirm > auto` 一致。

4. **`/review` 为什么强调「不共享 conversationHistory」？** 共享上下文时，审查者能看到执行者的思考过程（「我这样写是因为...」），产生同理心偏袒。独立会话的审查者只看 diff，不带执行者的辩解，审查更客观。这是 stormzhang 调研中反复强调的对抗性审查要点。

5. **自定义命令为什么不支持嵌套调用？** `/commit` 调用 `/review` 会导致上下文混乱与潜在无限递归。自定义命令本质是「预填 prompt 发给 Agent」，不是「调用其他命令」。需要组合操作时，用户应顺序执行多个命令。

6. **Checkpoint 语义化摘要为什么用 LLM 而不是规则提取？** 规则提取（如取 description 前 20 字）对「Step 3 of 5: 执行 file_write」这类描述无效——用户看不懂。LLM 能生成「添加了权限检查中间件」这样的人话摘要。但 LLM 必须降级，不能阻塞 Checkpoint 创建。

7. **执行顺序建议：** Task 1（AGENTS.md 瘦身，立即提升后续 Task 质量） → Task 2（description 规范，独立无依赖） → Task 4（权限双旋钮，Task 5 依赖） → Task 5（/review，依赖 Task 4 的沙箱级） → Task 3（exec 模式，依赖 Task 4 的 headless 权限） → Task 7（自定义命令，独立） → Task 8（fallback 兼容，独立） → Task 6（Checkpoint 可视化，独立） → Task 9（GitHub Action，依赖 Task 3） → Task 10（集成测试）。Task 1/2/7/8 可并行，Task 6 可并行。
