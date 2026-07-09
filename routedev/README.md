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
│   ├── agent/         # Agent 引擎（ReAct Loop + 目标分解 + 记忆 + 多 Agent + 工作模式）
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
用户输入(desktop renderer) → IPC → engine-bridge.sendChat
                              → ScenarioClassifier → ModelRouter → ReActAgentLoop → LLM → 响应渲染

/goal 命令 → engine-bridge.executeCommand
            → GoalParser → GoalPlan → 逐步执行(ReActAgentLoop) → GoalVerifier → 完成
```

> **入口说明：** Electron 桌面端为主要入口。所有交互经 `desktop/main/engine-bridge.ts` 的 `sendChat`（对话）与 `executeCommand`（命令）进入运行时层。多步任务通过 `/goal` 命令触发，由 `goal-runner` 执行器逐步执行并经 `GoalVerifier` 验证。

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
