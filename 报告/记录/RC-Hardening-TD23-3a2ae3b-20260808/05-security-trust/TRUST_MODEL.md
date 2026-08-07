# TRUST_MODEL — PHASE H

> 区分各输入源的信任级别。任何模型生成内容不得因"来自内部 Agent"自动升级为高权限指令。

| Source | trusted as instruction? | trusted as data? | may request tools? | may modify security policy? | may grant confirmation? |
|---|---|---|---|---|---|
| system framework policy | 是 | — | 否（框架规则） | 否 | 否 |
| developer/framework instruction | 是（配置层） | — | 按配置 | 否 | 否 |
| real user instruction | 是 | — | 是 | 经确认 | 经确认 |
| framework synthetic instruction | 是（系统注入） | — | 按上下文 | 否 | 否 |
| repository content（README/comment） | 否（untrusted context） | 是 | 否 | 否 | 否 |
| tool result | 否 | 是 | 否 | 否 | 否 |
| MCP result | 否 | 是 | 否 | 否 | 否 |
| web result | 否 | 是 | 否 | 否 | 否 |
| sub-agent output | 否（同 untrusted） | 是 | 否 | 否 | 否 |
| planner output | 否 | 是 | 否 | 否 | 否 |
| compaction summary | 否（降级数据） | 是 | 否 | 否 | 否 |
| retrieved memory/context | 否 | 是 | 否 | 否 | 否 |

## H1 分析（Aider architect→editor handoff）

RouteDev 对应链路：goal-runner（planner）→ sub-agent（executor）→ main。检查：planner/worker 输出进入主循环时是否有"角色提升"路径？
- spawn_agent 工具：required 只有 description/prompt——子 Agent 输出以 tool_result 进入（untrusted data）✓
- goal-runner 的 addSystemMessage：以 system 角色注入——**framework synthetic instruction 类别**（系统生成，非模型生成）✓
- 结论：无角色提升路径（模型生成内容均以 tool_result/data 进入）

## H2/H3

- H2 adversarial repo fixture + H3 compaction provenance：见 PHASE H 代码项（adversarial 测试）
