# RouteDev Harness Eval（B-00 基线）

12 个本地、无网络、可重复的 Flash 基础任务 + 基线 runner。

## 结构

```
tests/evals/
  tasks.ts            12 个任务定义（fixture、prompt、工作区校验、回答关键词、权限拒绝策略）
  summarize.ts        指标聚合（纯函数）
  fs-utils.ts         递归复制助手（规避受限环境 cpSync EIO）
  fixtures/           零依赖纯 Node fixture（CommonJS，无需 npm install）
  tasks.test.ts       任务定义/红态/聚合测试
  eval-config.yaml    评测固定配置（DEEPSEEK_API_KEY 环境变量注入）
scripts/run-harness-eval.mjs   基线 runner（消费现有 Kernel/EventV1）
```

## 任务矩阵

| 类别 | 数量 | 任务 |
|---|---|---|
| 只读定位 | 2 | readonly-locate-1（sumRange）、readonly-locate-2（maxRetries） |
| 单文件修复 | 4 | fix-single-1（循环边界）、fix-single-2（缺 require）、fix-single-3（比较边界）、fix-single-4（输出格式） |
| 多文件修复 | 2 | fix-multi-1（跨文件函数名）、fix-multi-2（共享常量抽取） |
| 测试失败诊断 | 2 | test-debug-1（FizzBuzz 分支序）、test-debug-2（async 丢失 return） |
| 权限拒绝 | 1 | permission-deny-1（rm 被拒后优雅处理） |
| 子 Agent 探索 | 1 | subagent-explore-1（spawn_agent 探索并汇报） |

## 运行

```bash
# 单元测试（不依赖模型）
pnpm test:evals

# 基线运行（需要 DEEPSEEK_API_KEY；国内网络需代理）
DEEPSEEK_API_KEY=sk-xxx pnpm eval:baseline
# 固定模型、只跑部分任务、自定义输出
DEEPSEEK_API_KEY=sk-xxx node --import tsx/esm scripts/run-harness-eval.mjs \
  --tasks fix-single-1,fix-single-2 --pin-model deepseek-v4-flash --out eval-results.jsonl
```

## 指标

每个任务记录：是否完成、是否通过、工具调用数、无效工具调用数、轮数（LLM 调用次数）、
输入/输出/总 token、工具 schema 估算 token、默认暴露工具数、耗时、失败定位（checkWorkspace/answer/tool/escalation/env）。

退出码：0 全部通过；1 存在失败；2 环境阻塞（无可用 provider）。

## 约定

- 8 个修复/诊断 fixture 的 `test.js` 在修复前必须处于失败态（红态测试守护，防止"测了个寂寞"）。
- 只读任务校验最终回答关键词；权限拒绝任务由 runner 的 `onConfirmTool` 拒绝并校验文件仍在。
- runner 不新增代理逻辑：只消费 `NativeAgentKernel.runReAct` 的 ReActEvent 流。
