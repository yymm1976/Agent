# RouteDev — Agent 全局入口

> 任何 Agent 接手本项目前必读。详细代码索引见 `CODEMAP.md`。

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

## 陷阱警告（Phase 17b + Phase 0c 执行经验）
1. `ModelRouter.route()` 接受 `ClassificationResult`，不是 `ScenarioTier`
2. `LLMClientManager.listAll()` 返回 `Map<string, ILLMClient>`，不是数组
3. `Checkpoint` 用 `description + timestamp`，没有 `tag + createdAt`
4. `BranchManager.switchBranch()`，不是 `switchToBranch()`
5. `DreamConsolidator.consolidate()` 需要传 `CheckpointData` 参数
6. `TokenTracker.getStats()` 返回 `TokenStats`，没有 `getTodayUsage()`
7. `src/tools/executor.ts` 是 `ToolExecutor` 实现类（含 SecurityChecker 调用与 executeSafe），实际工具执行走 `ToolRegistryAdapter`；Phase 0c 后**不再**做权限检查（权限已迁移到 PermissionEngine 中间件）
8. `AuditLogger.log()` 签名是 `(action, target, details, result?, agentId?, confirmation?)`，不是单对象参数
9. `VisionAssistant` 是 class（值导入），不能用 `import type`
10. `createServiceContext()` 是 App 装配单一入口（Phase 0c 后已激活，不再是死代码），接受 `ServiceContextDeps` 对象参数；服务实例由 `createAppDependencies()` 工厂集中创建

## Phase 0c 新增陷阱
11. **权限检查走 PermissionEngine 中间件**：`PermissionChecker`（`src/tools/permission.ts`）已删除，所有权限决策由 `PermissionEngine` 通过 `AgentMiddlewarePipeline.onActing` 中间件完成。`ToolExecutor.execute()` 不再做权限检查，仅保留 `SecurityChecker`（路径/命令黑名单等安全检查 ≠ 权限检查）。新增工具入口必须经过 Agent Loop 的中间件链路，不能直接调用 ToolExecutor
12. **Provider 路由优先从配置读取**：`ModelRouter.inferProviderId()` 拆为两步 — `findProviderFromConfig()` 优先遍历 `providers[].models[]` 匹配，`heuristicInferProviderId()` 仅作后备。新增 provider 时务必在配置 `providers[].models[]` 中声明 model.id/model.name，否则会落入启发式推断（关键词：gpt/claude/gemini/o4/tongyi/kimi/moonshot/glm/chatglm）
13. **App.tsx 装配已收敛**：服务实例创建移至 `src/cli/app-init.ts` 的 `createAppDependencies()`，App.tsx 只负责 React 状态与 UI 渲染（≤300 行）。新增服务应扩展 `AppDependencies` 接口与 `createAppDependencies()` 工厂，不要在 App.tsx 内联初始化

## Phase 29 新增陷阱（安全加固）
14. **命令解析必须走 `parseCommand()` tokenize**：`src/tools/command-parser.ts` 提供 `parseCommand(command: string): ParsedCommand`，将 shell 命令解析为结构化 `{ command, args, hasPipe, hasSubstitution, hasRedirect, raw }`。`SecurityChecker.checkCommand()` 与 `PermissionEngine` 的 deny 规则（rm -rf /、find -delete、dd of=/dev/）**必须**使用 `parseCommand()` 的首 token 精确匹配，**禁止**用 `includes()`/正则子串匹配（会被 `rmrf.sh`、`find-delete.sh` 等绕过）。新增命令类 deny 规则时，先 `parseCommand` 再判断 `parsed.command` 与 `parsed.args`
15. **签名验证生产模式拒绝降级**：`WeChatWorkAdapter.verifySignature()` 与 `SlackAdapter.verifySignature()` 在 `NODE_ENV=production` 时，token/signingSecret 未配置**必须返回 false**（拒绝处理），仅在开发模式放行并 `logger.warn`。新增渠道适配器必须遵循此模式，禁止"未配置即放行"的降级
16. **环境变量替换 fail-fast**：`src/config/loader.ts` 的 `replaceEnvVars()` 在引用了未设置的环境变量时**抛出 `ConfigValidationError`**，不再保留 `${VAR}` 占位符。配置文件中所有 `${VAR}` 必须在 `.env` 或系统环境变量中定义，否则配置加载失败
17. **Shell 子进程环境变量白名单**：`src/tools/builtin/shell-exec.ts` 通过 `ALLOWED_ENV_KEYS` 白名单过滤 `context.environment`，仅允许 `NODE_ENV/PATH/HOME/USER/LANG/LC_ALL/TERM/SHELL/EDITOR/PAGER/GIT_*` 等安全变量。`LD_PRELOAD`/`NODE_OPTIONS`/`ELECTRON_RUN_AS_NODE` 等危险变量会被静默忽略并 `logger.warn`。新增需要向子进程传递环境变量的工具，必须先加入白名单
18. **Rollback 前置工作区检查**：`CheckpointManager.rollback()` 在执行 `git checkout` 前**必须**检查 `git status` 工作区是否干净（modified/not_added/deleted 全为空），有未提交更改时**中止回滚**并 `logger.error`。禁止在有未提交更改时强制回滚（会丢失用户工作）
19. **LLM 客户端 API Key 缺失时 client=null**：`OpenAIClient`/`AnthropicClient` 在 `apiKey` 为空时**不构造客户端**（`this.client = null`，`this._isReady = false`），`complete()`/`stream()` 调用时抛 `LLMError`。禁止用 `'placeholder'` 构造假客户端。`ModelRouter.isModelAvailable()` 检查 `provider.apiKey` 非空且非 `'placeholder'`
