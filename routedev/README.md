# RouteDev

按任务复杂度自动路由模型的 CLI 开发助手。支持多 LLM Provider、ReAct Agent Loop、MCP 工具集成、目标分解与验证、多渠道接入（企业微信/Telegram/Slack）。

## 快速开始

```powershell
pnpm install
cp config.example.yaml %APPDATA%\RouteDev\config.yaml
# 编辑 config.yaml 填入你的 API Key
pnpm build
pnpm start
```

服务器模式（渠道集成）：

```powershell
pnpm start -- serve
```

## 项目结构

```
routedev/
├── src/
│   ├── agent/         # Agent 引擎（ReAct Loop + 目标分解 + 记忆 + 多 Agent + 工作模式）
│   ├── channels/      # 渠道集成（Webhook 服务器 + 企业微信/Telegram/Slack 适配器）
│   ├── cli/           # CLI 界面（Ink UI + 命令系统 + 运行器 + 插件初始化）
│   ├── config/        # 配置系统（YAML 加载 + Zod 校验 + 热重载）
│   ├── harness/       # 可观测性（Trace + Audit + Checkpoint）
│   ├── memory/        # 项目记忆（.routedev/ 目录管理）
│   ├── plugins/       # 插件系统（types + registry + sdk）
│   ├── prompts/       # Prompt 模板系统（三级优先级）
│   ├── router/        # 模型路由（分类 + 路由 + LLM 客户端 + Token 追踪）
│   ├── tools/         # 工具框架（注册表 + 执行器 + 权限引擎 + 内置工具 + MCP）
│   ├── utils/         # 通用工具（日志 + 路径 + 重试 + Token 估算）
│   └── index.tsx      # CLI 主入口
├── tests/             # 单元测试 + 集成测试
├── scripts/verify.ts  # 验收门脚本
└── config.example.yaml
```

## 架构概览

```
用户输入 → ScenarioClassifier（规则+LLM 分类）
         → ModelRouter（按 tier 选模型 + 降级策略）
         → ReActAgentLoop（think → act → observe 循环）
            ├─ AgentMiddlewarePipeline（onActing: 权限引擎拦截）
            ├─ ToolExecutor（安全检查 → 执行）
            └─ ContextManager（token 监控 → 压缩 → checkpoint）
         → 响应输出
```

## 开发命令

```powershell
pnpm test              # 运行测试（Vitest）
pnpm build             # 构建（tsup）
pnpm typecheck         # 类型检查（tsc --noEmit）
pnpm tsx scripts/verify.ts  # 验收门检查
```

## 版本

v0.0.1

## 许可证

AGPL-3.0
