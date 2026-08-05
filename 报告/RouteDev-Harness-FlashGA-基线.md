# RouteDev Harness FlashGA 基线（B-00）

> 日期：2026-08-05（首次基线记录）
> 状态：**环境阻塞** —— 本机未配置 `DEEPSEEK_API_KEY`，真实模型运行待凭据就绪后执行。
> 任务集与 runner 已完成并通过单元测试，本条基线记录"任务定义/事件格式/汇总字段"的稳定契约，不把未运行项标为通过。

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `routedev/tests/evals/tasks.ts` | 12 个任务定义（fixture/prompt/工作区校验/回答关键词/权限拒绝策略） |
| `routedev/tests/evals/summarize.ts` | 指标聚合（纯函数，含 Markdown 输出） |
| `routedev/tests/evals/fs-utils.ts` | 递归复制助手（规避受限环境 cpSync EIO） |
| `routedev/tests/evals/fixtures/` | 12 个零依赖纯 Node fixture（8 个带红态 `test.js`） |
| `routedev/tests/evals/tasks.test.ts` | 8 个单测：任务完整性、**红态守护**、权限策略、聚合正确性 |
| `routedev/tests/evals/eval-config.yaml` | 评测固定配置（`${DEEPSEEK_API_KEY}` 注入） |
| `routedev/scripts/run-harness-eval.mjs` | 基线 runner（只消费现有 Kernel/EventV1） |
| `routedev/package.json` | 新增 `test:evals`、`eval:baseline` 脚本 |

## 2. 任务矩阵

| 类别 | 数量 | 任务 id | 通过判定 |
|---|---|---|---|
| 只读定位 | 2 | `readonly-locate-1/2` | 最终回答含关键词（sumRange/55、maxRetries/3） |
| 单文件修复 | 4 | `fix-single-1..4` | `node test.js` 通过 |
| 多文件修复 | 2 | `fix-multi-1/2` | `node test.js` 通过（含跨文件引用断言） |
| 测试失败诊断 | 2 | `test-debug-1/2` | `node test.js` 通过 |
| 权限拒绝 | 1 | `permission-deny-1` | 文件仍在 + 回答含拒绝语义关键词 |
| 子 Agent 探索 | 1 | `subagent-explore-1` | 事件流含 `spawn_agent` + 回答含两个模块函数名 |

## 3. 指标契约（每条 JSONL 记录的字段）

`taskId / name / category / completed / passed / toolCalls / invalidToolCalls / turns / inputTokens / outputTokens / totalTokens / toolSchemaTokens / toolCount / durationMs / failStage / verifyDetail / error`

- `turns` = `token_profile` 事件数（每次 LLM 调用前发射）
- `invalidToolCalls` = `isError` 的工具结果数
- `failStage` ∈ checkWorkspace / answer / tool / escalation / env / unknown —— 失败可定位到具体阶段（验收要求）
- 退出码：0 全通过 / 1 存在失败 / 2 环境阻塞

## 4. 当前验证结果

| 检查 | 结果 |
|---|---|
| `pnpm test:evals`（vitest） | ✅ 1 文件 / 8 测试通过（含 8 个修复类 fixture 红态守护） |
| `pnpm typecheck` | ✅ 0 错误 |
| runner env-blocked 路径 | ✅ 无 API key 时输出 JSONL 错误并退出码 2（不崩溃、不假装通过） |
| 真实模型基线（12 任务 × 2 次） | ⚠️ 环境阻塞：`DEEPSEEK_API_KEY` 未配置（含代理配置提示） |

## 5. 运行方式（凭据就绪后）

```bash
cd routedev
DEEPSEEK_API_KEY=sk-xxx pnpm eval:baseline                      # 全量 12 任务，路由模式
DEEPSEEK_API_KEY=sk-xxx node --import tsx/esm scripts/run-harness-eval.mjs \
  --tasks fix-single-1,test-debug-1 --pin-model deepseek-v4-flash  # 固定模型小批量
```

验收口径（来自计划 §B-00）：同一固定配置连续运行两次，任务定义、事件格式与汇总字段稳定；失败能定位到具体阶段。首次只记录基线，不设通过线。

## 6. 备注

- runner 使用与 desktop 相同的装配（`createAppDependencies` + classifier/router/tracker），不新增代理逻辑；`--pin-model` 时跳过分类器，保证基线可复现。
- fixture 全部零依赖 CommonJS，`node test.js` 离线可跑；8 个修复类 fixture 由测试守护"修复前必须失败"。
- 本报告是基线占位文档：**未运行的指标不得标记为通过**，真实数值在首次运行后回填。
