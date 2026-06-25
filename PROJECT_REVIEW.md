> ⚠️ **已过期** — 本报告标注 v2.9.0 / 2025-07-16，当前项目已迭代至 v3.8.0 / 2026-06-25（Phase 1–47）。
> 报告中提到的 "60KB App.tsx"、"src/tools/permission.ts 仍存在" 等结论与当前状态不符。
> 请参阅 `报告/RouteDev全量代码审查报告.md`（2026-06-25 交叉验证版）获取最新审查结果。

# RouteDev 项目审查报告

**生成日期：** 2025-07-16  
**审查范围：** 全项目源码、配置、测试、文档、蓝图  
**项目版本：** v2.9.0（routedev 子目录）/ v0.14.0（根目录 index.tsx）

---

## 一、项目概览

**RouteDev** 是一个按任务复杂度自动路由模型的 CLI 开发助手。用户提问后，系统通过分类器判断任务复杂度（simple / medium / complex / reasoning），自动选择最合适的 LLM 模型进行回答，实现成本与质量的平衡。

### 技术栈

| 类别 | 技术选型 |
|------|----------|
| 语言 | TypeScript 6.x（strict 模式，ESM） |
| 运行时 | Node.js 20+ |
| 包管理 | pnpm 11+（workspace 已启用） |
| CLI 渲染 | Ink 7 + React 19 |
| 测试框架 | Vitest 4.x |
| 构建工具 | tsup 8.x |
| LLM SDK | @anthropic-ai/sdk + openai |
| 配置校验 | zod 4.x |
| 日志 | winston |
| 桌面端 | Electron（electron-vite + electron-builder） |

---

## 二、项目结构

```
Agent/
├── src/                      # 主项目源码
│   ├── agent/                # Agent 核心逻辑
│   │   ├── loop.ts           # 主 ReAct 循环
│   │   ├── branch.ts         # 分支对话
│   │   ├── vision.ts         # 视觉/多模态
│   │   ├── goal-parser.ts    # 目标解析
│   │   ├── goal-verifier.ts  # 目标验证
│   │   ├── init-analyzer.ts  # 初始化分析
│   │   └── memory/           # 记忆系统（checkpoint-writer, context-manager）
│   │   └── multi/            # 多 Agent 编排（orchestrator, blackboard, conflict）
│   ├── channels/             # 渠道集成层
│   │   ├── manager.ts        # 渠道管理器
│   │   ├── server.ts         # 消息服务器
│   │   └── adapters/         # 适配器（telegram, wechat-work）
│   ├── cli/                  # CLI 界面
│   │   ├── App.tsx           # Ink 主组件（~60KB，核心 UI）
│   │   ├── service-context.ts # 服务装配工厂
│   │   └── commands/         # 命令注册（help, config, memory, trace 等）
│   ├── config/               # 配置管理
│   │   ├── schema.ts         # 配置校验 schema
│   │   ├── loader.ts         # 配置加载器
│   │   ├── defaults.ts       # 默认值
│   │   └── watcher.ts        # 热重载监听
│   ├── harness/              # 可观测性层
│   │   ├── trace-collector.ts # 追踪收集
│   │   ├── audit-logger.ts   # 审计日志
│   │   ├── checkpoint-manager.ts # 检查点管理
│   │   └── tracing-executor.ts # 追踪执行器
│   ├── memory/               # 项目记忆
│   │   └── project-memory.ts # 项目记忆管理
│   ├── prompts/              # Prompt 模板系统
│   │   ├── manager.ts        # 模板管理器
│   │   └── types.ts          # 类型定义
│   ├── router/               # 智能路由核心
│   │   ├── classifier.ts     # 任务复杂度分类器
│   │   ├── router.ts         # 模型路由器
│   │   ├── tracker.ts        # Token 追踪
│   │   ├── token-counter.ts  # Token 计数器
│   │   └── llm/              # LLM 客户端（anthropic, openai）
│   ├── tools/                # 工具系统
│   │   ├── registry.ts       # 工具注册表
│   │   ├── executor.ts       # 工具执行器
│   │   ├── adapter.ts        # 工具适配器
│   │   ├── permission.ts     # 权限管理
│   │   ├── security.ts       # 安全检查
│   │   ├── builtin/          # 内置工具（file-read, file-write, shell-exec 等）
│   │   └── mcp/              # MCP 协议支持
│   ├── utils/                # 工具函数
│   └── index.tsx             # CLI 入口
├── tests/                    # 测试（与 src 结构镜像）
├── routedev/                 # 旧版/发布目录（含多个 release-v* 历史版本）
├── 蓝图与Phase/              # 完整蓝图与 37 个 Phase 文档
├── 深度研究报告/              # 竞品分析与功能研究报告
├── docs/                     # 文档（MCP 协议等）
├── desktop/                  # Electron 桌面端源码
├── scripts/                  # 脚本（perf-gate, verify）
├── config.example.yaml       # 配置模板
└── package.json              # 项目配置
```

---

## 三、核心架构分析

### 3.1 智能路由系统（核心价值）

```
用户输入 → ScenarioClassifier → ModelRouter → LLM 执行 → 返回
                │                    │
                ▼                    ▼
          simple/medium       deepseek-v4-flash
          complex             qwen3.7-plus
          reasoning           kimi-k2.7
```

- **四级分类**：simple → medium → complex → reasoning
- **降级机制**：reasoning 级配置了 `fallbackModelId: deepseek-v4-pro`
- **Token 预算**：支持 track_only / enforce 两种模式
- **用户偏好**：saving / balanced / premium 三级

### 3.2 Agent Loop（执行核心）

- 主循环实现了 ReAct（Reasoning + Acting）模式
- 支持工具调用、错误恢复、超时处理
- 集成 Checkpoint 系统（增量 + 压缩）
- 支持分支对话（Branch）
- 多 Agent 编排（Orchestrator + Blackboard + Conflict Resolution）

### 3.3 工具系统

- 注册表模式：工具通过 `registerBuiltinTools()` 注册
- 权限中间件：PermissionEngine 做权限检查
- 安全检查：目录边界、命令黑/白名单、敏感文件保护
- MCP 协议支持：可接入外部 MCP 服务器

### 3.4 多模态与渠道

- VisionAssistant：支持图片理解
- 渠道适配：Telegram、企业微信
- 服务器模式：支持 `routedev serve` 启动消息服务器

---

## 四、开发阶段（Phase）进度

项目采用 37 个 Phase 的渐进式开发模式，当前已全部规划完成：

| 阶段范围 | 核心内容 | 状态推断 |
|----------|----------|----------|
| Phase 1 | 项目骨架 + 配置系统 | ✅ 完成 |
| Phase 2 | 核心类型 + LLM 客户端 | ✅ 完成 |
| Phase 3 | Router 层（分类器、路由、Token 追踪） | ✅ 完成 |
| Phase 4 | 基础 CLI 对话 | ✅ 完成 |
| Phase 5 | Agent Loop 核心 ReAct 循环 | ✅ 完成 |
| Phase 6-8 | 工具框架、进阶工具、MCP 客户端 | ✅ 完成 |
| Phase 9-10 | 自主模式、检查点系统 | ✅ 完成 |
| Phase 11-12 | 增量 Checkpoint、多模态视觉 | ✅ 完成 |
| Phase 13-14 | 渠道集成、多 Agent | ✅ 完成 |
| Phase 15-16 | 可观测性、Prompt 模板系统 | ✅ 完成 |
| Phase 17-19 | App 重构、缺陷修复、CLI 增强 | ✅ 完成 |
| Phase 20-23 | 工作模式、Guardrails、Plugin 系统、UX 打磨 | ✅ 完成 |
| Phase 24-30 | 功能补全、UI 优化、技术债务、安全加固、可观测性 | ✅ 完成 |
| Phase 31-37 | 工作流编排、接线验证、交互重塑、上下文增强、自动化 | ✅ 完成 |

> 注：项目代码量极大（src 目录约 80+ 源文件），蓝图完整，基本覆盖了从 CLI 工具到桌面 GUI 的全链路。

---

## 五、测试覆盖

测试文件位于 `tests/` 目录，与 `src/` 结构镜像，覆盖：

| 模块 | 测试文件数 | 覆盖内容 |
|------|-----------|----------|
| agent | 7 | loop、goal、branch、dream、vision、multi、init |
| channels | 4 | message-router、server、telegram、wechat-work |
| cli | 3 | args、command-registry、completion |
| config | 1 | loader |
| harness | 4 | audit-logger、checkpoint、trace-collector、tracing-executor |
| memory | 3 | checkpoint-writer、context-manager、project-memory |
| prompts | 1 | manager |
| router | 6 | classifier、config、llm、router、token-counter、tracker |
| tools | 10+ | adapter、advanced、builtin、mcp、permission、registry、security 等 |
| utils | 2 | retry、paths |

**测试命令：** `pnpm test`（vitest 全量运行）

---

## 六、关键文件速览

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/cli/App.tsx` | ~60KB | 核心 UI 组件，消息状态管理 |
| `src/agent/loop.ts` | ~14KB | Agent 主循环 |
| `src/prompts/manager.ts` | ~14KB | Prompt 模板管理 |
| `src/config/schema.ts` | ~13KB | 配置校验 schema |
| `src/harness/trace-collector.ts` | ~12KB | 追踪收集器 |
| `src/router/llm/anthropic.ts` | ~10KB | Anthropic 客户端 |
| `src/router/llm/openai.ts` | ~11KB | OpenAI 客户端 |
| `config.example.yaml` | ~2.6KB | 配置模板 |

---

## 七、安全与风险

### 已实现的安全机制
- 目录边界检查（`directoryBoundary: true`）
- 命令黑名单（`rm -rf`, `format`, `del /s`）
- 敏感文件只读/拒绝策略
- 网络操作确认（`networkConfirm: true`）
- 权限中间件（PermissionEngine）

### 潜在风险
1. **敏感文件残留**：`p12-dump*.txt` 等文件虽已加入 `.gitignore`，但仍在工作目录中，建议清理
2. **API Key 管理**：依赖环境变量注入，需确保 `.env` 不被提交
3. **代码体积膨胀**：`App.tsx` 达 60KB，建议考虑拆分

---

## 八、建议与改进方向

1. **重构 `App.tsx`**：该文件 60KB，建议拆分为多个子组件
2. **CI/CD 缺失**：未发现 GitHub Actions 或其他 CI 配置
3. **集成测试**：当前测试以单元测试为主，缺少端到端集成测试
4. **文档完善**：`README.md` 内容简短，建议补充 API 文档和架构图
5. **清理历史版本**：`routedev/release-v*` 目录保留了大量历史构建，建议归档
6. **监控告警**：建议添加 LLM 调用错误率监控

---

## 九、总结

**RouteDev 是一个功能完整、架构清晰的智能路由开发助手**。项目经过 37 个 Phase 的系统性开发，已具备：

- ✅ 成熟的智能路由系统
- ✅ 完整的 Agent Loop 与工具框架
- ✅ 多渠道集成（CLI、Telegram、企业微信、Electron GUI）
- ✅ 可观测性（Tracing、Audit、Checkpoint）
- ✅ 多 Agent 编排能力
- ✅ 安全防护体系
- ✅ 详尽的蓝图与文档（37 个 Phase 文档）

项目整体处于**功能完善阶段**，核心能力已就绪，下一步可聚焦于 CI/CD 建设、测试增强、代码重构、以及生产环境部署。

---

*本报告由 RouteDev 自动生成*
