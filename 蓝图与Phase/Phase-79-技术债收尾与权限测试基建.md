# Phase 79 — 技术债收尾与权限测试基建

> **Phase 类型：** 技术债务清理（Technical Debt Resolution）  
> **前置依赖：** Phase 78 + 2026-07-11 排期技术债修复  
> **目标版本：** v4.6.0  
> **核心目标：** 收尾历史排期技术债：权限接线、桌面入口测试、大文件拆分、IPC 校验  
> **战略对齐（2026-07-11 修订）：** 服从 [BLUEPRINT-CORE-CAPABILITY-PACK-v2.md](./BLUEPRINT-CORE-CAPABILITY-PACK-v2.md)。本 Phase **不做功能扩张**；**禁止**把 Progressive Trust 做成动态权限升级产品能力。  
> **技术债跟踪：** `docs/TECH_DEBT_TRACKER.md`

---

## 背景

RouteDev 功能面已过大。审查发现权限“装配未连接”、桌面入口缺集成测试、goal-runner 过大。本 Phase 还债，为 Phase 80–84 瘦身提供安全与测试底座。

---

## 核心原则

1. **权限统一中枢**：IPC / Loop / auto 白名单都走 PermissionEngine  
2. **Fail-closed**：无匹配规则默认拒绝  
3. **固定规则，不动态升级**：TrustGradient 若保留，只作静态档位或删除；**禁止会话内自动提权**  
4. **集成测试优先**  
5. **拆分不改变行为**

---

## 任务总览

| Task | 内容 | 优先级 | 四层归属 | 修订要点 |
|------|------|--------|----------|----------|
| 1 | ChatBridge 入口集成测试 | High | Core | 保留 |
| 2 | goal-runner 拆分 | Medium | Core→Extended Pack | 拆完 sequential 进 `pack.goal-advanced` |
| 3 | PermissionEngine → onActing | High | Core | 保留；固定 allow/confirm/deny |
| 4 | tool:execute 权限校验 | High | Core | 保留 |
| 5 | auto + 子 Agent 确认 | High | Core(auto) / Extended Pack(subagent) | auto 仅 Core 白名单；子 Agent 进 `pack.multi-agent` |
| 6 | TrustGradient | High | Freeze | 不做动态升级；静态档位或删除 |
| 7 | IPC 校验中间件 | Medium | Core | 保留 |

---

## Task 1：ChatBridge 集成测试

- 新建 `desktop/main/__tests__/chat-bridge.integration.test.ts`
- ≥10 用例：并发 requestId、stop、confirm、reloadConfig、超时清理
- 验收：公开方法有回归；可复用后续权限测试

## Task 2：goal-runner 拆分

拆为：
- `goal-runner-core.ts`
- `goal-runner-scheduler.ts`
- `goal-runner-confirm.ts`
- `goal-runner-recovery.ts`
- `goal-runner.ts` 组合入口

验收：行为不变；单文件 import 下降；全量相关测试通过。

## Task 3：PermissionEngine 接入

- Loop `onActing` 调用 `engine.check`
- deny 抛错；confirm 走现有确认通道
- 无规则 fail-closed
- 设置页规则真正生效

## Task 4：IPC tool:execute 校验

- handler 内复用 PermissionEngine
- 无上下文拒绝
- 集成测试覆盖绕过失败

## Task 5：auto 与子 Agent 确认（收窄）

- auto 仅匹配显式白名单工具/模式
- 子 Agent 工具确认委托父会话（若 spawn 仍默认注册；Phase-81/82 后退默认）
- **不做**“历史成功次数提升信任等级”

## Task 6：TrustGradient 处理（修订）

**原计划：** 接到 PermissionEngine 做动态决策。  
**现计划（蓝图强制）：**

1. 审计所有 TrustGradient 调用点  
2. 删除/旁路会话内自动升级  
3. 可选保留静态档位配置（如 project trust level），一次设定、明确展示  
4. 测试：连续成功执行不得改变权限决策

## Task 7：IPC 校验中间件

- `createValidatedHandler` 统一参数校验
- 逐步替换分散 handler 校验
- 与 Task 4 权限层兼容

---

## 验收

- [ ] TD-01~05、07 按表完成；TD-06 按修订完成  
- [ ] 动态信任升级不可达  
- [ ] 入口集成测试存在且通过  
- [ ] goal-runner 拆分后测试不回归  
- [ ] `TECH_DEBT_TRACKER.md` 更新  
- [ ] 为 Phase-80 分层清单预留注释/钩子（可选）

---

## 明确不做

- 新用户功能  
- 多 Agent 增强  
- Progressive Trust 产品化  
- KnowledgeGraph 新算法  
- 默认工具集继续扩张
