# RouteDev 功能完整度审查提示词

> **版本：** v1.2（2026-07-11）  
> **适用项目：** RouteDev（Electron 桌面 AI 编程助手）  
> **审查类型：** 功能完整度审查（非代码质量审查）  
> **审查基线代码版本：** v4.5.4 + Phase 79–84 整改路线  
> **产品路线：** Core 最小化 + Capability Pack 按需加载  
> **必读：** `../蓝图与Phase/BLUEPRINT-CORE-CAPABILITY-PACK-v3.md`；若存在则读 `docs/CAPABILITY_LAYERS.md` 与 `docs/SLIMDOWN_BOARD.md`

---

## 审查目标

本次审查聚焦于 **"功能是否完整"**，并同时回答：

1. **声称已实现的功能是否真的都有完整实现？**
2. **每个 Core 用户场景是否能从头到尾走通？**
3. **已实现的代码功能是否都有与其分层匹配的入口？**
4. **配置项、IPC、Schema 是否都有消费方？**
5. **文档是否与 Core/Pack/Experimental 分层一致？**
6. **（v1.2）非 Core 能力是否错误地占据默认路径？**

### 与现有审查的区别

| 审查类型 | 关注点 | 不关注 |
|---------|--------|--------|
| 全量审查提示词 | 类型/架构/性能/安全等代码质量 | 功能是否完整 |
| 死代码审查提示词 | 未使用的代码 | 入口可达性 |
| **本审查** | **完整性 / 场景闭环 / 入口 / 配置消费 / 分层合规** | **代码写得好不好** |

### 不评判

- 代码风格、性能、类型严格度、更优雅写法（归全量审查）
- 死代码清理本身（归死代码审查）
- “功能很多但默认关闭”本身不是缺陷

---

## 分层判定（v1.2 强制）

审查任何功能前，先判定其层：

| 层 | 完整度要求 | 默认关闭是否算问题 |
|----|------------|--------------------|
| **Core** | 必须入口可达 + 主路径通 + 错误路径可恢复 | 默认关 = Broken/Missing |
| **Pack** | 开启后完整；关闭时有明确开关/文档 | 默认关 = 设计，不算 Missing |
| **Experimental/Freeze** | 可不承诺；若有入口需标注实验 | 默认关/无入口可接受 |
| **Retired** | 应从文档消失 | 文档仍声称 = 文档漂移 |

**禁止：** 把 Pack/Experimental 的“默认不可达”直接报成 Orphan/Missing。  
**应该报：** Pack 开启后仍断链；Core 缺失；文档把 Freeze 写成核心卖点。

---

## 审查前置准备

### 必读文件

| 顺序 | 文件 | 用途 |
|-----|------|------|
| 1 | `../蓝图与Phase/BLUEPRINT-CORE-CAPABILITY-PACK-v3.md` | 产品分层 |
| 2 | `docs/CAPABILITY_LAYERS.md`（若有） | 模块分层权威表 |
| 3 | `docs/SLIMDOWN_BOARD.md` | 去留看板（四区：Core 膨胀点 / Extended Pack 候选 / Standard Pack 冷处理队列 / Freeze 清单） |
| 4 | `AGENTS.md` | 入口与陷阱 |
| 5 | `CODEMAP.md` | 模块索引 |
| 6 | `CHANGELOG.md` 近 7 个版本 | 声称变更 |
| 7 | `desktop/preload/index.ts` | IPC 暴露面 |
| 8 | `desktop/main/index.ts` | IPC 实现面 |
| 9 | `desktop/main/engine-bridge.ts` | 命令分发 |
| 10 | `src/config/schema.ts` + `defaults.ts` | 配置与默认 |
| 11 | `ChatPage` / `SettingsPage` | UI 入口 |

读完后建立：
- Core 功能清单
- Pack 功能清单
- Experimental 清单
- preload API / schema 字段 / slash 命令清单

---

## Core 场景基线（必须完整）

> Pack 场景只在“启用后”检查闭环。

### Core A：对话与改码

| 编号 | 功能 | 入口 |
|-----|------|------|
| A1 | 普通对话流式输出 | ChatPage |
| A2 | 工具调用确认 | chat:confirm-tool |
| A3 | 停止生成 | chat:stop |
| A4 | 核心文件/Shell/Git 工具 | ToolRegistry core profile |
| A5 | Checkpoint 列表/回滚 | checkpoint:* |
| A6 | Token/预算可见 | tracker + UI |
| A7 | 项目规则/上下文压缩 | /compact 等 |
| A8 | 固定权限 allow/confirm/deny | PermissionEngine |

### Core B：配置与扩展接口

| 编号 | 功能 | 说明 |
|-----|------|------|
| B1 | 配置读写热重载 | 必须 |
| B2 | MCP 连接与工具注册 | 扩展面，默认可不装具体服务器 |
| B3 | Skill 列表/启用 | 扩展面 |

### Pack 场景（启用后才要求完整）

| Pack | 关键检查 |
|------|----------|
| browser-web | 开关 on 后工具注册 + 可调用 |
| code-map | 开关 on 后索引/查询入口 |
| subagent | spawn_agent 可达；off 时不可达 |
| harness | /replay /scorecard |
| compose | 仅显式启用触发 |
| import-ecosystem | 导入入口 |

### Freeze（不要求产品完整）

- multi orchestrator / blackboard / conflict 默认路径
- progressive trust 动态升级
- implicit experience adaptation
- /goal 重型并行与冲突检测

---

## 审查维度

### 维度 1：设计文档 vs 实现一致性

- [ ] 1.1 CODEMAP 路径存在
- [ ] 1.2 模块有装配（import type 不算）
- [ ] 1.3 CHANGELOG Added 有代码
- [ ] 1.4 CHANGELOG Removed 已消失
- [ ] 1.5 AGENTS 入口职责正确
- [ ] 1.6 文档对 Core/Pack/Freeze 描述一致
- [ ] 1.7 未把 Freeze 宣称为默认核心能力

证据：声称来源 + 代码位置 + 分层标签。

### 维度 2：用户场景闭环（Core 优先）

- [ ] 2.1 普通对话闭环
- [ ] 2.2 工具确认同意/拒绝闭环
- [ ] 2.3 Checkpoint 回滚闭环
- [ ] 2.4 配置变更闭环
- [ ] 2.5 MCP 基础连接闭环
- [ ] 2.6 `/goal` **顺序**执行 + 验证闭环（Core/简化后）
- [ ] 2.7 Pack 场景：仅抽查“开启后闭环 / 关闭后不可达”
- [ ] 2.8 **分层违规**：默认路径误入 multi/compose/动态信任

> 旧版“多 Agent 默认协作闭环完整”不再作为 Core 必选项。

### 维度 3：入口可达性（按层）

- [ ] 3.1 Core 功能必须有 UI/命令入口
- [ ] 3.2 Pack 功能必须有开关；on 后有入口
- [ ] 3.3 Freeze 无入口可接受；有入口须标实验
- [ ] 3.4 preload/API/IPC 对称性
- [ ] 3.5 默认工具集是否符合 Core profile（目标 ≤10）

### 维度 4：错误路径

- [ ] 4.1 LLM 失败反馈与降级
- [ ] 4.2 工具失败回注 Agent
- [ ] 4.3 权限拒绝可理解
- [ ] 4.4 abort/停止路径
- [ ] 4.5 Pack 加载失败 fail-open 且可观测
- [ ] 4.6 `/goal` 失败报告

### 维度 5：配置完整性

- [ ] 5.1 schema 字段有消费
- [ ] 5.2 defaults 与 schema 对齐
- [ ] 5.3 Core 配置默认正确开启
- [ ] 5.4 Pack 配置默认 false，且 enable 有装配点
- [ ] 5.5 Freeze 配置若存在须标注实验/不承诺
- [ ] 5.6 动态信任相关配置不得在默认路径生效

### 维度 6：IPC 完整性

- [ ] 6.1 preload ↔ main 配对
- [ ] 6.2 事件双向完整（stream done/error）
- [ ] 6.3 tool:execute 若暴露则有权限校验（Phase-79）
- [ ] 6.4 Pack 专用 IPC 在 Pack off 时安全失败

### 维度 7：测试覆盖

- [ ] 7.1 Core 场景有测试
- [ ] 7.2 权限/停止/回滚有测试
- [ ] 7.3 Pack enable/disable 有测试（若 Pack 机制已落地）
- [ ] 7.4 `/goal` sequential 有集成测试
- [ ] 7.5 不要求 Freeze 有完整产品测试，但若代码仍在须有冻结边界测试更佳

### 维度 8：文档完整性

- [ ] 8.1 README/AGENTS 以 Core 承诺为主
- [ ] 8.2 Pack 有迁移/开关说明
- [ ] 8.3 Freeze 不出现在“核心卖点”
- [ ] 8.4 审查排除项与分层一致

### 维度 9：分层合规（v1.2 新增）

- [ ] 9.1 默认注册工具是否 Core-only
- [ ] 9.2 多 Agent 是否默认装配
- [ ] 9.3 Compose 是否默认自动选择
- [ ] 9.4 Progressive Trust 是否仍动态升级权限
- [ ] 9.5 新功能是否默认 enabled:false 或进 Pack
- [ ] 9.6 文档/设置是否诱导用户以为 Freeze 是稳定能力

级别补充：
- **Layer-Violation**：功能活着，但放错层/错误默认开启（高优先级）

---

## 输出格式

```yaml
- id: F-001
  level: Complete|Partial|Missing|Broken|Orphan|Layer-Violation
  layer: Core|Pack|Experimental|Retired
  dimension: 维度X-...
  location:
    file: ...
    line: ...
  title: ...
  problem: |
    ...
  evidence:
    claim_source: ...
    code_location: ...
    search_performed: ...
  impact: ...
  recommendation: ...
  status: open
```

### 汇总必须包含

1. 按级别统计（含 Layer-Violation）  
2. 按维度统计  
3. 按层统计（Core/Pack/Experimental）  
4. Top 5（Core 断链与分层违规优先）

---

## 级别定义

| 级别 | 含义 |
|------|------|
| Complete | 对应该层的完整性要求已满足 |
| Partial | 主路径可用但有缺口 |
| Missing | 文档/清单声称有，代码无 |
| Broken | 有代码但闭环断 |
| Orphan | Core 无入口；或 Pack 开启后仍无入口 |
| Layer-Violation | 放错层或错误占据默认路径 |

优先级：Missing/Broken(Core) > Layer-Violation > Orphan(Core) > Pack 启用后 Broken > Partial

---

## 已知排除项

### 有意默认关闭（不是 Missing）

- Pack 能力默认 off
- vision / conciseThinking / adversarial 等实验开关
- Trace Panel 默认 off
- 调度器预留 UI

### 整改后不再作为 Core 必达

- 默认多 Agent 剧场完整
- 默认 compose 自动编排
- 动态渐进信任
- 隐式经验适配
- /goal 并行冲突检测完整

### 已退役

- CLI 交互层
- self-evolution / dream-consolidator / eq-detector 等花架子删除项

---

## 审查者自检

- [ ] 已读整改蓝图与分层清单（若有）
- [ ] 已读 `docs/SLIMDOWN_BOARD.md` 去留看板，按四区核对模块去向
- [ ] Core/Pack/Freeze 分开评判
- [ ] 未把 Pack 默认关报 Missing
- [ ] 未把 Freeze 无入口报 Orphan（除非文档宣称核心）
- [ ] 未把看板中 Extended Pack 候选 / Standard Pack 冷处理队列的"默认不可达"报为 Orphan
- [ ] 每条 finding 有证据与分层标签
- [ ] Top 5 优先 Core 与 Layer-Violation
- [ ] 未混入纯代码质量问题

---

## 推荐执行顺序

1. 分层基线  
2. Core 场景闭环  
3. 分层合规（维度 9）  
4. IPC/配置  
5. Pack 抽查  
6. 文档一致性  

---

**审查提示词版本：** v1.2  
**最后更新：** 2026-07-11  
**维护者：** RouteDev 审查提示词 / 整改蓝图同步
