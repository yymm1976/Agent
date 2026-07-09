# RouteDev 贡献指南

> 本指南借鉴 tau 项目的工程规范（issue-driven workflow + scope commit + 串行测试），并结合 RouteDev 实际模块结构整理。
> 任何贡献者在提交 PR 前必须阅读本文档；AI 贡献者额外参见第 7 节。

## 1. Issue-Driven Workflow

**所有 PR 必须先开 issue，PR 必须关联 issue 号。**

- 一个 issue 只解决一个问题；一个问题只对应一个 PR。
- issue 标题使用 `[scope] description` 格式（与 commit 同款），例如：
  - `[router] 分类器对短指令误判为 quick_answer`
  - `[agent] spawn-agent 不继承父 Agent 的 hooks`
  - `[infra] vitest 串行模式失败时无明确日志`
- 不接受无 issue 的"随手 PR"。维护者会直接 close 未关联 issue 的 PR，并要求先补 issue。
- issue 内容必须包含：**复现步骤 / 期望行为 / 实际行为 / 影响范围**。仅有"标题"的 issue 会被标记为 `needs-info` 并暂停处理。

## 2. Scope 列表

issue 标题、commit message、PR 标题的 `scope` 字段必须取自以下白名单（与 `commitlint.config.cjs` 的 `scope-enum` 严格一致）：

| Scope | 涵盖范围 |
|-------|----------|
| `router` | Router 层（分类器路由、TaskOrchestrator intent 判定、降级策略） |
| `agent` | Agent / SubAgent 调度（AgentLoop、spawn_agent、AgentProfileManager） |
| `skill` | Skill 系统（SKILL.md 加载、Skill 匹配、pitfalls-guide） |
| `ui` | 前端 UI（React 组件、Electron renderer、设置页交互） |
| `setting` | 设置页 / 配置系统（ConfigValidationError、env 替换、profile 加载） |
| `cli` | CLI 工具（命令解析、custom-commands 模板、headless 入口） |
| `infra` | 基础设施（构建脚本、CI、vitest 配置、husky、commitlint、perf-gate） |
| `docs` | 文档（AGENTS.md、CODEMAP.md、CHANGELOG.md、README、本文件） |

> 新增 scope 必须先开 `[infra] issue`，PR 通过后同步更新本表 + `commitlint.config.cjs` 的 `scope-enum`。

## 3. Commit Message 规范

RouteDev 同时接受两种格式：

### 格式 A：`[scope] description`（tau 风格，推荐用于 issue-driven 工作）

```
[router] 修复短指令被误判为 quick_answer 的问题
[agent] [TECH-DEBT] spawn-agent model 字段未强制必填，计划 Phase 76 强制，关联 #123
[docs] 补充 CONTRIBUTING.md 中 commitlint 配置说明
```

### 格式 B：Conventional Commits `type(scope): description`

```
feat(router): 新增 intent 兜底分支
fix(agent): 修复 spawn-agent 不继承父 hooks
refactor(ui): 设置页拆分为独立路由
```

`type` 取值（与 `commitlint.config.cjs` 的 `type-enum` 严格一致）：
`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`、`build`、`ci`

### 技术债 commit（强制 tag）

凡是引入技术债的 commit，**必须**在 message 中包含 `[TECH-DEBT]` tag，并写明：

1. **欠债内容**：什么没做 / 哪里偷工
2. **偿还计划**：计划在哪个 Phase / 哪个 issue 中修复
3. **关联 issue**：`#issue-number`

模板：

```
[scope] [TECH-DEBT] <欠债内容简述>，计划 <Phase X / #issue> 偿还，关联 #<issue>
```

示例：

```
[agent] [TECH-DEBT] spawn-agent model 字段未强制必填，计划 Phase 76 强制，关联 #123
[infra] [TECH-DEBT] husky 钩子未在 CI 镜像中验证，计划 Phase 77 加 CI 校验，关联 #145
```

> 不含 `[TECH-DEBT]` tag 的技术债 PR 一律打回；维护者会在 review 时手动检索 `[TECH-DEBT]` 关键字。

### 提交前自查

- ✅ scope 在白名单内
- ✅ description 用中文（与项目风格一致），简洁但能独立看懂
- ✅ 涉及技术债时已加 `[TECH-DEBT]` tag
- ✅ 已关联 issue 号（`#123`）
- ❌ 不要 `update`、`fix bug`、`wip`、`tmp` 这类无信息描述

## 4. 测试规范

### 串行 vs 并行

| 测试类型 | 运行方式 | 命令 |
|----------|----------|------|
| 单元测试（pure function、无 IPC、无 fs 读写） | 可并行 | `npm test` |
| e2e / 集成测试（涉及 Electron 主进程、IPC、sqlite、git 仓库） | **必须串行** | `npm test -- --serial` 或在 `vitest.config` 中 `pool: 'forks'` + `fileParallelism: false` |

借鉴 tau 的 `go test -p 1` 哲学：e2e 测试共享 Electron 会话 / sqlite 文件 / 临时 git 仓库，并行会引入 flaky。**新增 e2e 测试必须能通过 `--serial` 模式**。

### 提交前必跑

- `npm run typecheck` —— TypeScript 严格模式必须通过
- `npm test` —— 至少单测全绿；e2e 用 `--serial` 单独跑一次
- `npm run lint:descriptions` —— 工具 / Skill description lint（过渡期 warning，不阻断，但新增违规会标记）

### 测试文件位置

- 单测：与源文件同目录，`*.test.ts` 命名
- e2e：`tests/e2e/` 下，`*.e2e.test.ts` 命名
- 不要把 e2e 和单测混在同一文件，避免 `--serial` 误伤并行单测

## 5. 代码质量

### TypeScript 严格模式

- `strict: true` 在 `tsconfig.json` 中已开启，新增代码不得使用 `any` / `// @ts-ignore` / `// @ts-expect-error`（确需绕过时必须开 issue + 在 PR 中说明）
- ESM 强制 `.js` 后缀（源文件是 `.ts` 也写 `import './foo.js'`）
- 路径别名 `@/*` → `src/*`，禁止相对路径跨层级（`../../../`）

### 依赖管理

参考 AGENTS.md 第 34 行："不引入新依赖，除非确有必要并在 PR 中说明"。

**新依赖 PR 必须在描述中给出**：

1. 为什么需要这个依赖（解决什么问题）
2. 是否有更轻量替代（评估过的候选列表）
3. 包大小 / 维护活跃度 / License 兼容性
4. 是 `dependencies` 还是 `devDependencies`（理由）

Phase 75-A6 引入 `husky` / `lint-staged` / `@commitlint/cli` / `@commitlint/config-conventional` 的必要性：

| 依赖 | 必要性 |
|------|--------|
| `husky` | 唯一能在 npm install 后自动激活 git hook 的主流方案，替代手写 `.git/hooks/*`（手写 hook 不进版本库，团队成员无法共享） |
| `lint-staged` | 只对暂存文件跑检查，避免全量 typecheck 浪费时间；当前 RouteDev 无 eslint/prettier，先做提示位，后续接入 eslint 时升级 |
| `@commitlint/cli` | 强制 commitlint 在 commit-msg 阶段执行，是 scope 白名单 + TECH-DEBT tag 检查的执行器 |
| `@commitlint/config-conventional` | Conventional Commits 基线规则，RouteDev 在此基础上覆盖 `scope-enum` / `type-enum` |

### 提交前检查清单

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过（e2e 用 `--serial`）
- [ ] 新增 / 修改接口已全局搜索调用点同步更新
- [ ] 新增依赖已在 PR 说明中给出理由
- [ ] commit message 符合第 3 节规范
- [ ] 涉及技术债时已加 `[TECH-DEBT]` tag

## 6. 分支策略

### main 分支保护

- `main` 分支禁止直接 push（管理员也必须走 PR）
- PR 至少 1 人 approve（core 团队成员）
- PR 必须通过 `npm run typecheck` + `npm test`
- PR 标题必须符合第 3 节 commit 规范（与 squash merge 后的 commit 一致）

### 分支命名

```
<scope>/<issue-number>-<short-slug>
```

示例：

```
router/123-fix-quick-answer-misjudgement
agent/145-spawn-agent-hooks-inherit
infra/167-husky-commitlint-setup
```

### Squash Merge

- 默认使用 squash merge，PR 标题作为最终 commit message
- PR 内部的 wip commit 不需要严格符合规范，但最终 squash 后的标题必须合规

## 7. AI 贡献者规范

参考 Superpowers CLAUDE.md "skills are code" 原则，AI 贡献者（Claude / GPT / Gemini 等）必须遵守以下额外规则：

### 7.1 PR 描述必须披露 model / harness

AI 生成的 PR 必须在描述末尾添加：

```
## AI 贡献者披露
- Model: <model-name-and-version>
- Harness: <harness-name-and-version>（如 Trae / Cursor / Cline / Aider）
- Prompt 摘要: <任务核心 prompt 摘要，1-2 句>
- 人工审查: <reviewer-github-handle>
```

> 不披露的 AI PR 一律打回。这是为了后续追溯 AI 生成代码的质量问题，以及统计不同 model 的 PR 通过率。

### 7.2 Skill 修改必须附 eval 证据

修改 `.routedev/skills/**` 下的任何 SKILL.md 或新增 Skill 时，PR 必须包含：

1. **Eval 用例**：至少 3 个测试 prompt + 期望匹配结果
2. **Baseline 对比**：修改前后在相同 prompt 集合上的匹配准确率 / 触发率
3. **回归说明**：是否影响其他 Skill 的触发（特别是 description 关键字重叠的场景）

> Skill 是 code，不是文档。任何 Skill 修改都按代码 PR 标准审查。

### 7.3 禁止批量 PR

- 一个 AI session 只能解决一个 issue
- 禁止在同一个 PR 中混合多个 scope 的改动（除非 issue 本身跨 scope，且在 PR 描述中拆分说明）
- 禁止"顺手清理"——发现的其他问题必须开新 issue，不在当前 PR 中夹带

### 7.4 AI 生成代码的额外要求

- 必须遵守 AGENTS.md 中的"Top 10 核心陷阱"
- 涉及 PermissionEngine / AgentLoop / Checkpoint / spawn_agent 等敏感模块时，PR 必须在描述中说明如何避免对应陷阱
- AI 不得自行 close PR；必须等待人工 reviewer 决定

---

## 附录：相关文件

| 文件 | 用途 |
|------|------|
| `AGENTS.md` | Agent 接手项目必读，含 Top 10 核心陷阱 |
| `CODEMAP.md` | 代码库索引，定位模块前先读 |
| `commitlint.config.cjs` | commit message 校验规则（scope 白名单 + type 白名单） |
| `.lintstagedrc.json` | lint-staged 配置（暂存文件提示） |
| `.husky/pre-commit` | pre-commit hook（触发 lint-staged） |
| `.husky/commit-msg` | commit-msg hook（触发 commitlint） |
| `.routedev/skills/pitfalls-guide/SKILL.md` | 完整 84 条陷阱索引 |
