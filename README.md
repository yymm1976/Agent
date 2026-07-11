# Agent 工作区

本目录是 **RouteDev** 及相关调研/蓝图的工作区。  
**可运行产品代码只在 `routedev/`**，请勿在仓库根目录执行 `pnpm install` / `pnpm test`（旧根脚手架已归档）。

## 快速开始（产品）

```powershell
cd routedev
pnpm install
pnpm dev          # Electron 开发
pnpm test         # 测试
pnpm typecheck    # 类型检查
```

## 目录说明

| 路径 | 说明 |
|------|------|
| [`routedev/`](./routedev/) | **主工程**（Electron + 引擎），开发请进入此目录 |
| [`AGENTS.md`](./AGENTS.md) | 给 AI/Agent 的总约定（codebase MCP + rtk） |
| [`docs/AGENT_TOOLING.md`](./docs/AGENT_TOOLING.md) | MCP / rtk 组合使用手册 |
| [`docs/`](./docs/) | 工作区文档；**路径权威表** [`docs/PATHS.md`](./docs/PATHS.md) |
| [`报告/`](./报告/) | 调研、审查、验证报告 |
| [`蓝图与Phase/`](./蓝图与Phase/) | 产品蓝图与 Phase 文档 |
| [`design-demos/`](./design-demos/) | UI/交互原型 |
| [`refs/`](./refs/) | 外部参考代码（只读，默认不改） |
| [`archive/`](./archive/) | 根目录清理归档（旧 CLI 脚手架、一次性脚本） |
| [`RTK.md`](./RTK.md) | rtk 短指针 |

## Agent 工具约定（摘要）

默认：`codebase MCP 定位` → `精读片段` → `rtk 验证`。  
详情见 [`AGENTS.md`](./AGENTS.md) 与 [`docs/AGENT_TOOLING.md`](./docs/AGENT_TOOLING.md)。

## 归档说明

2026-07-11 根目录整理：

- 删除测试 JSON / 占位文件，移除 `.trae` / `.pilotdeck` / `.workbuddy` / 根 `.routedev`
- 旧根 `package.json` 等 CLI 脚手架 → `archive/root-cli-scaffold/`
- 一次性脚本 → `archive/scripts-once/`
- `sonetto-here-ref` → `refs/sonetto-here-ref/`

需要回滚脚手架时，把 `archive/root-cli-scaffold/` 内文件移回根目录即可。

## 重建代码图谱索引

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs/tools/reindex-codebase.ps1
```

细节与路径对照见 [`docs/PATHS.md`](docs/PATHS.md) §6。
