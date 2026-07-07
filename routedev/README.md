# RouteDev

按任务复杂度自动路由模型的桌面端开发助手。支持多 LLM Provider、ReAct Agent Loop、MCP 工具集成、目标分解与验证、统一工作流编排（Phase 31）。

## 快速开始

```powershell
pnpm install
cp config.example.yaml %APPDATA%\RouteDev\config.yaml
# 编辑 config.yaml 填入你的 API Key
pnpm build
pnpm start
```

## 项目结构

```
routedev/
├── src/
│   ├── agent/         # Agent 引擎（ReAct Loop + 目标分解 + 记忆 + 多 Agent + 工作模式 + 统一工作流编排）
│   ├── runtime/       # 运行时（app-init + doctor + goal-runner + graceful-shutdown + 插件初始化）
│   ├── config/        # 配置系统（YAML 加载 + Zod 校验 + 热重载）
│   ├── harness/       # 可观测性（Trace + Audit + Checkpoint）
│   ├── memory/        # 项目记忆（.routedev/ 目录管理）
│   ├── plugins/       # 插件系统（types + registry + sdk）
│   ├── prompts/       # Prompt 模板系统（三级优先级）
│   ├── router/        # 模型路由（分类 + 路由 + LLM 客户端 + Token 追踪）
│   ├── tools/         # 工具框架（注册表 + 执行器 + 权限引擎 + 内置工具 + MCP + 安全防护）
│   └── utils/         # 通用工具（日志 + 路径 + 重试 + Token 估算）
├── desktop/           # Electron 桌面端（main 主进程 + preload + renderer 渲染进程）
├── tests/             # 单元测试 + 集成测试
├── scripts/verify.ts  # 验收门脚本
└── config.example.yaml
```

## 架构概览

```
用户输入 → TaskOrchestrator（Phase 31 统一调度）
         ├─ quick_answer → ChatRunner（简单问题直达）
         ├─ development → 完整流水线
         │   ├─ RequirementsGatherer（需求确认）
         │   ├─ GoalParser + TaskComplexityAnalyzer（分解+复杂度评估）
         │   ├─ ExecutionOrchestrator（单/多 Agent 自适应）
         │   │   ├─ 单 Agent：串行执行
         │   │   └─ 多 Agent：Orchestrator + WorkerExecutor + Blackboard
         │   └─ UnifiedReviewer（GoalVerifier + 代码审查）
         ├─ explicit_goal → GoalRunner（/goal 命令）
         └─ planning → 规划模式（/plan 命令）
```

> **入口说明：** CLI 已在 Phase 72 退役，Electron 桌面端为主要入口。上述流水线在桌面端 chat 输入框中触发，`/goal`、`/plan` 等命令在桌面端 chat 中输入即可。

### 统一工作流编排（Phase 31）

Phase 31 把三条互不相通的执行路径合并为一条智能流水线：

- **TaskOrchestrator**：所有非命令输入的调度中心，判定 intent 并分发
- **RequirementsGatherer**：需求确认阶段，自动确认或主动追问
- **TaskComplexityAnalyzer**：规则层+LLM层混合复杂度评估
- **ExecutionOrchestrator**：单/多 Agent 自适应执行
- **UnifiedReviewer**：两层审查（GoalVerifier + 代码审查）
- **生产安全防护**：ReadTracker（先读后写）、ToolResultSanitizer（注入检测）、CompletionGate（独立验证）、Token 熔断

## 开发命令

```powershell
pnpm test              # 运行测试（Vitest）
pnpm build             # 构建（electron-vite）
pnpm typecheck         # 类型检查（tsc --noEmit）
pnpm tsx scripts/verify.ts  # 验收门检查
```

## 版本

v4.5.4

## 许可证

AGPL-3.0
