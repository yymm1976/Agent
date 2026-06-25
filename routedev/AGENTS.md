# RouteDev — Agent 全局入口

> 任何 Agent 接手本项目前必读。详细代码索引见 `CODEMAP.md`，完整陷阱速查见 `.routedev/skills/pitfalls-guide/SKILL.md`。

## 技术栈
- **语言：** TypeScript 6.x（strict 模式，ESM）
- **运行时：** Node.js 20+
- **包管理：** pnpm 11+（workspace 已启用）
- **UI：** Ink 7.0.6 + React 19.2.7（终端渲染）
- **测试：** Vitest 4.x（`pnpm test`）
- **构建：** tsup 8.x（`pnpm build`）
- **类型检查：** `pnpm typecheck`（tsc --noEmit）
- **LLM SDK：** @anthropic-ai/sdk、openai
- **其他：** zod（配置校验）、simple-git、winston、yaml、chalk

## 关键入口
| 入口 | 职责 |
|------|------|
| `src/index.tsx` | CLI 主入口，解析参数 → 加载配置 → 渲染 App 或启动 serve |
| `src/cli/App.tsx` | Ink 主组件，管理消息状态与命令分发 |
| `src/cli/chat-runner.ts` | 聊天输入处理（分类→路由→Agent Loop→统计） |
| `src/cli/goal-runner.ts` | `/goal` 命令执行（分解+确认+执行+验证） |
| `src/cli/command-registry.ts` | 命令注册表，所有 `/` 命令在此注册 |
| `src/cli/service-context.ts` | 服务对象容器（config/router/tracker/agents 等），`createServiceContext()` 是 App 装配单一入口 |
| `src/cli/app-init.ts` | App 依赖装配工厂 `createAppDependencies()`，集中创建所有服务实例 |
| `CODEMAP.md` | 代码库索引，定位模块前先读此文件 |
| `scripts/verify.ts` | Phase 17b 验收门脚本（`pnpm tsx scripts/verify.ts`） |

## 项目约定
- **提交格式：** Conventional Commits（`feat:` / `fix:` / `refactor:` / `test:` / `docs:`）
- **测试要求：** 新增/修改功能必须配套测试，`pnpm test` 全绿才能提交
- **接口签名变更：** 修改任何 `types.ts` 中的导出接口后，必须全局搜索调用点并同步更新
- **代码注释：** 中文，简洁但完整
- **依赖：** 不引入新依赖，除非确有必要并在 PR 中说明
- **路径别名：** `@/*` → `src/*`（tsconfig paths）
- **导入后缀：** ESM 强制 `.js` 后缀（即使源文件是 `.ts`）

## Top 10 核心陷阱（生产路径高频触发，违反会导致崩溃或数据丢失）

> 完整 81 条陷阱（编号 1-64 + 126-142）见 `.routedev/skills/pitfalls-guide/SKILL.md`，按 Phase 分章组织。

1. **权限检查走 PermissionEngine 中间件**（#11）：`PermissionChecker` 已删除，所有权限决策由 `PermissionEngine` 通过 `AgentMiddlewarePipeline.onActing` 完成。`ToolExecutor.execute()` 不再做权限检查。新增工具入口必须经过 Agent Loop 中间件链路，不能直接调用 ToolExecutor
2. **命令解析必须走 `parseCommand()` tokenize**（#14）：`SecurityChecker.checkCommand()` 与 `PermissionEngine` 的 deny 规则**必须**用 `parseCommand()` 首 token 精确匹配，**禁止** `includes()`/正则子串匹配（会被 `rmrf.sh` 等绕过）
3. **环境变量替换 fail-fast**（#16）：`replaceEnvVars()` 引用未设置的环境变量时**抛出 `ConfigValidationError`**，不再保留 `${VAR}` 占位符。配置中所有 `${VAR}` 必须在 `.env` 或系统环境变量中定义
4. **Rollback 前置工作区检查**（#18）：`CheckpointManager.rollback()` 在 `git checkout` 前**必须**检查 `git status` 工作区是否干净，有未提交更改时**中止回滚**（强制回滚会丢失用户工作）
5. **TaskOrchestrator 是 App.tsx 的新调度层**（#23）：所有非命令输入先经过它，由它判定 intent（quick_answer/development/explicit_goal/planning）并分发。`quick_answer` 短路直达 ChatRunner，`development` 走完整流水线
6. **ReadTracker 追踪的是绝对路径**（#27）：`file_read` 和 `file_write` 传入的路径必须 `normalize` 后比对。新建文件不受 read-before-write 限制（通过 `fs.access()` 检查存在性）
7. **HookRunner 在 app-init.ts 中必须传入 TraceCollector**（#45）：`new HookRunner()` 后必须调用 `setTraceCollector(trace)`，否则钩子执行不产生 span 记录。`DurableExecutor` 也必须传入同一 `hookRunner` 实例
8. **Tool/Skill 的 description 写法决定 80% 匹配效果**（#54）：description 必须写给模型看（包含触发场景、适用条件），不是简短标题。实测同一工具描述写法差异可达 30 个百分点准确率
9. **中间件阶段顺序不可随意调整**（#60）：`onSystemPrompt → onModelCall → onReasoning → onActing → onAgent` 是 ReAct 循环自然顺序。把 `onAgent` 提前到 `onActing` 之前，会话级 Token 统计会漏掉最后一次工具调用
10. **子 Agent 的 ToolRegistry 是父 Agent 的浅拷贝**（#62）：`spawn_agent` 通过 `registry.clone()` 复制父 Agent 的 ToolRegistry 但移除 `spawn_agent`。子 Agent 工具集在创建时确定，父 Agent 后续注册的新工具子 Agent 看不到

## Phase 47 新增陷阱（#133-142，简版）

> 详细说明见 `.routedev/skills/pitfalls-guide/SKILL.md` Phase 47 章节。

- **#133** AGENTS.md 瘦身后必须保留 Top 10 核心陷阱在正文，完整索引迁移至 SKILL.md
- **#134** description lint 不能阻断开发流程（过渡期 warning，不返回 error）
- **#135** routedev exec 必须设总超时（默认 5 分钟），headless 下 always-ask 自动 deny
- **#136** 沙箱级判断必须在审批级之前（deny 优先于 never-ask）
- **#137** /review 子代理必须用 read-only 沙箱（工具白名单不是确定性兜底）
- **#138** Checkpoint 语义化摘要的 LLM 调用必须设超时（3 秒）与降级（返回原始 description）
- **#139** 自定义命令的模板变量替换必须一次性（不递归，$1 中的 {{...}} 不展开）
- **#140** AGENTS.override.md 的语义是「跳过」而非「合并」（存在 override 时跳过 base）
- **#141** GitHub Action 的 config 必须用 Base64 传输（避免 YAML 多行字符串转义问题）
- **#142** 沙箱级切换需要刷新工具可用性缓存（避免残留的 deny/allow 状态）

## 完整陷阱索引

完整 81 条陷阱（含 Phase 17b/0c/29/30/31/32/33/35/36/37/38/46/47 全部章节）已迁移至：

**`.routedev/skills/pitfalls-guide/SKILL.md`**

涉及 PermissionEngine、AgentLoop、Checkpoint、Blackboard、HookRunner、MCPClientManager、ToolExecutor、TaskOrchestrator、ReadTracker、LoopDetection、ConflictDetector、DurableExecutor、WorkerExecutor、TraceCollector、ToolResultSanitizer、ScheduleEngine、Git Worktree、KnowledgeGraph、spawn_agent 等模块时，务必先查阅该 Skill 文件对应章节。
