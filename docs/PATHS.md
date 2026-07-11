# 工作区路径约定（2026-07-11 整理后）

> **权威路径表。** 任何文档、脚本、Agent 指令引用仓库路径时，以本文件为准。  
> 相关：根目录 [`AGENTS.md`](../AGENTS.md)、[`README.md`](../README.md)。

## 1. 根目录布局（当前）

```text
Agent/                          ← 工作区根（git root）
├── AGENTS.md                   ← AI 总约定
├── README.md                   ← 人类导航
├── RTK.md                      ← rtk 短指针
├── .gitignore
├── .routedev.yaml              ← RouteDev 项目级覆盖配置（保留在根）
├── routedev/                   ← 【唯一】可运行产品工程
├── docs/                       ← 工作区文档
│   ├── AGENT_TOOLING.md
│   ├── PATHS.md                ← 本文件
│   ├── tools/                  ← 安装/运维脚本（非产品运行时）
│   │   └── codebase-memory-mcp-install.ps1
│   ├── plans/
│   └── specs/
├── 报告/                        ← 调研/审查/验证报告
├── 蓝图与Phase/                  ← Phase 与蓝图文档
├── design-demos/               ← 设计原型
├── refs/                       ← 外部参考代码（只读）
│   └── sonetto-here-ref/
└── archive/                    ← 清理归档（非产品）
    ├── root-cli-scaffold/      ← 旧根 CLI package/tsconfig/vitest…
    └── scripts-once/           ← 一次性 ps1
```

## 2. 旧路径 → 新路径

| 旧路径（已失效） | 新路径 / 状态 |
|------------------|---------------|
| `/package.json`（根，v0.4.0 CLI） | `archive/root-cli-scaffold/package.json`（归档，勿当产品） |
| `/pnpm-lock.yaml`、`/pnpm-workspace.yaml` | `archive/root-cli-scaffold/` |
| `/tsconfig.json`、`/tsup.config.ts`、`/vitest.config.ts` | `archive/root-cli-scaffold/` |
| `/config.example.yaml`（根副本） | 使用 **`routedev/config.example.yaml`**；根副本在 archive |
| `/sonetto-here-ref/` | **`refs/sonetto-here-ref/`** |
| `/Agent工具开发综合报告.md` | **`报告/Agent工具开发综合报告.md`**（根副本已删） |
| `/phase-61-70-final-report.md` | **`报告/phase-61-70-final-report.md`** |
| `/PROJECT_REVIEW.md` | **`报告/PROJECT_REVIEW.md`**（过期报告） |
| `/codebase-memory-mcp-install.ps1` | **`docs/tools/codebase-memory-mcp-install.ps1`** |
| `/__read_lines.ps1` 等一次性脚本 | `archive/scripts-once/` |
| `/test_results.json`、`test_results2.json` | **已删除**；以后勿提交 |
| `/.trae/`、`/.pilotdeck/`、`/.workbuddy/`、根 `/.routedev/` | **已删除**；`.gitignore` 已忽略同类目录 |

## 3. 开发与工具应使用的路径

| 用途 | 正确路径 |
|------|----------|
| 安装依赖 / 测试 / 开发 | `routedev/` 内执行 `pnpm …` |
| 产品配置模板 | `routedev/config.example.yaml` → 复制到 `%APPDATA%\RouteDev\config.yaml` |
| 工程 Agent 约定 | `routedev/AGENTS.md`、`routedev/CODEMAP.md` |
| 工作区 Agent 约定 | 根 `AGENTS.md`、`docs/AGENT_TOOLING.md` |
| 报告类 Markdown | `报告/` |
| Phase / 蓝图 | `蓝图与Phase/` |
| 外部参考实现 | `refs/sonetto-here-ref/`（只读） |
| CBM 安装脚本 | `docs/tools/codebase-memory-mcp-install.ps1` |
| codebase 索引目标（推荐） | **`…/Agent/routedev`**（产品代码）；工作区文档可选另索引 |

## 4. 禁止事项

1. 不要在 **工作区根** 执行 `pnpm install` / `pnpm test` / `pnpm dev`。  
2. 不要把 `archive/` 或 `refs/` 当成 RouteDev 产品源码修改。  
3. 不要引用已删除的 `test_results*.json`、根级 CLI `package.json` 作为当前工程入口。  
4. 文档里写「根目录 package.json」时，若指 **当前产品**，应写 **`routedev/package.json`**。

## 5. 给 codebase MCP 的索引建议

- 主索引：`repo_path = <workspace>/routedev`  
- 若需要连文档一起搜：可对整个 `<workspace>` 索引，但会包含 `报告/`、`蓝图与Phase/` 噪声；**默认只索引 routedev**。  
- 索引失效或目录大搬家后：重新 `index_repository`。

## 6. Codebase 索引（2026-07-11 重建）

### codebase-memory-mcp

- 二进制：`%LOCALAPPDATA%\Programs\codebase-memory-mcp\codebase-memory-mcp.exe`
- **CLI 注意（Windows）：** 直接传含中文的 `repo_path` JSON 在 PowerShell 下常失败。
  - 已建立 junction：`C:\tmp\routedev-idx` → `<workspace>\routedev`
  - 推荐索引命令：

```powershell
# 转义写法（PowerShell）
& "$env:LOCALAPPDATA\Programs\codebase-memory-mcp\codebase-memory-mcp.exe" `
  cli index_repository '{\"repo_path\":\"C:/tmp/routedev-idx\",\"mode\":\"fast\"}'
```

- 当前索引项目名：`C-tmp-routedev-idx`
- 规模（fast）：约 **5279 nodes / 14865 edges**
- MCP 工具调用时如需指定 project，使用 `project: "C-tmp-routedev-idx"`（或工具默认当前工作区映射）

### codegraph

- 在 **`routedev/`** 目录执行：

```powershell
cd <workspace>\routedev
codegraph init    # 若尚未初始化
codegraph index   # 全量重建
codegraph status
```

- 索引目录：`routedev/.codegraph/`（已在 `.gitignore`）
- 工作区根不要 `codegraph init`（会指到错误根）

### 搬家后必做

1. 更新 `docs/PATHS.md`（本文件）旧→新表  
2. `codebase-memory-mcp` 重新 `index_repository`  
3. `codegraph index`（在 `routedev/`）  
4. 新开 Agent 会话，确认 MCP 已连接  

