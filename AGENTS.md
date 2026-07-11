# Agent 工作区 — 全局 Agent 约定

> 任何大模型 / Agent 接手本仓库前必读。  
> 主工程代码在 `routedev/`；详细代码索引见 `routedev/CODEMAP.md`；完整陷阱见 `routedev/.routedev/skills/pitfalls-guide/SKILL.md`（若本地存在）或 `routedev/AGENTS.md`。
> **路径权威表：** [docs/PATHS.md](docs/PATHS.md)（整理后旧路径已失效，禁止再引用根 CLI 脚手架 / 根级 sonetto）。

## 0. 30 秒决策树

```
任务是什么？
├─ 理解代码 / 找符号 / 调链路 / 评估改动影响
│   └─ 用 codebase MCP（codegraph 或 codebase-memory-mcp）
│       禁止一上来全库 grep / 盲读大文件
├─ 跑 shell（git / test / build / typecheck / 日志）
│   └─ 用 rtk 压缩输出，再读结果
│       禁止直接 dump 完整 vitest/tsc/pnpm 日志进上下文
├─ 字符串字面量 / 配置值 / 非代码文件 / MCP 结果不够
│   └─ 再允许 rtk grep 或受限文件读取
└─ 必须看完整原始输出（排障）
    └─ rtk proxy <cmd> 或裸命令，并说明原因
```

**默认组合：** `codebase MCP 定位` → `精确读代码` → `rtk 跑验证` → `必要时再搜字符串`。

---

## 1. 工具分层（必须遵守）

| 层级 | 工具 | 用途 | 不用于 |
|------|------|------|--------|
| L1 代码发现 | `codegraph` / `codebase-memory-mcp` | 符号、调用链、架构、影响面 | 查纯字符串、YAML/JSON 值 |
| L2 精确阅读 | Read / 打开 MCP 返回的文件片段 | 确认实现细节 | 漫无目的扫全文件 |
| L3 命令输出 | `rtk ...` | 压缩 git/test/build/log | 交互式 TTY、需要完整原始日志时 |
| L4 兜底搜索 | `rtk grep` / 项目内搜索 | 字面量、报错文案、配置键 | 当 L1 的替代品（能图就不搜） |

### 1.1 codebase MCP：何时用、怎么用

本机通常同时有：

- **codegraph**（stdio: `codegraph serve --mcp`）
- **codebase-memory-mcp**（stdio 二进制，图谱 + 索引）

**优先场景：**

1. 「X 在哪 / 怎么工作 / 谁调用谁」
2. 改函数/模块前的影响分析
3. 快速建立模块地图（比瞎读目录快）

**推荐调用顺序：**

1. `index_repository` / 确认索引可用（codebase-memory；首次或大改后）
2. `search_graph` / `codegraph_search` / `codegraph_explore` — 找符号或区域
3. `trace_path` / `codegraph_callers` / `codegraph_callees` — 调用关系
4. `get_code_snippet` / `codegraph_node` — 读关键函数体
5. `get_architecture` / `codegraph_impact` — 架构或改动波及面
6. 仍不够 → 再 `rtk grep` 或读具体文件

**不要：**

- 为找 `createAppDependencies` 这类符号去全库 `grep`
- 把整个 `src/` 目录树读进上下文
- 在 MCP 明确返回路径后，仍重复搜索同一符号

**要：**

- 用 MCP 结果里的 `file:line` 做后续精读
- 大改前先 impact / callers，再动手
- MCP 不可用时，在回复里说明，再降级到 `CODEMAP.md` + 受限搜索

### 1.2 rtk：何时用、怎么用

`rtk`（Rust Token Killer）= 命令输出过滤器，历史可省约 60–90% shell 输出 token。

**必须优先 rtk 的命令：**

```bash
rtk git status
rtk git diff
rtk git log
rtk err pnpm test
rtk err npm test
rtk vitest
rtk tsc --noEmit
rtk npm run build
rtk pnpm typecheck
rtk grep -n "exact-string" path
rtk docker ps
```

在本仓库（RouteDev / Electron + pnpm + vitest）尤其高价值：

| 命令意图 | 推荐 | 原因 |
|----------|------|------|
| 看改动 | `rtk git status` / `rtk git diff` | 文件多、diff 大 |
| 跑测 | `rtk err pnpm test` 或 `rtk vitest` | 日志极长，只要失败 |
| 类型检查 | `rtk tsc --noEmit` 或包一层 `rtk err pnpm typecheck` | 错误可压缩分组 |
| 构建 | `rtk npm run build` / 对应 pnpm 脚本 | 刷屏输出 |
| 字符串搜 | `rtk grep ...` | 仅 L4 兜底 |

**不要用 rtk 时：**

- 需要完整原始日志定位罕见 bug → `rtk proxy <cmd>`
- 交互式程序 / TUI
- 输出本来就很短（`node -v` 等）
- 过滤可能藏关键一行时，先 proxy 复核

**Codex 注意：** Codex 不会像 Claude Code 那样自动 hook 改写命令；你必须**主动**写 `rtk ...` 前缀。

**元命令：**

```bash
rtk gain              # 查看节省统计
rtk rewrite "git status"  # 预览改写
rtk proxy pnpm test   # 不压缩执行
```

---

## 2. 标准工作流（教会下一任模型）

### A. 实现功能 / 修 bug

```
1. codebase MCP：定位模块与调用链
2. 精读 1–3 个关键文件片段（不是整仓）
3. 小步修改
4. rtk 跑验证：typecheck / 相关测试
5. rtk git diff 自审
6. 需要提交时再按 Conventional Commits 处理
```

### B. 代码审查

```
1. rtk git status / rtk git diff（或 PR diff）
2. 对每个高风险改动点：MCP callers/impact
3. 只深读风险相关实现
4. 结论按严重级别输出（正确性 > 安全 > 回归 > 风格）
```

### C. 调查「为什么挂了」

```
1. rtk err <原测试/构建命令>   # 先压缩失败信号
2. 从报错符号/文件 → MCP 定位定义与调用方
3. 精读 + 最小复现
4. 修复后再次 rtk err 验证
```

### D. 陌生模块上手

```
1. 读 routedev/AGENTS.md + CODEMAP.md 对应章节
2. MCP get_architecture / explore 该目录
3. 再进具体文件
```

---

## 3. 反模式（禁止）

1. **先 grep 后思考**：符号/架构问题先 MCP。  
2. **整份 vitest 日志进上下文**：用 `rtk err` / `rtk vitest`。  
3. **无目标 `Read` 大文件**：先 snippet / node / 限定行号。  
4. **MCP 与 rtk 混用目标反了**：MCP 不负责压缩 shell；rtk 不负责理解架构。  
5. **隐藏工具失败**：MCP/rtk 不可用要明确说，并降级，不要假装查过。  

---

## 4. 仓库地图（给模型定向）

| 路径 | 含义 |
|------|------|
| `routedev/` | **唯一主工程**（TypeScript / Electron / pnpm） |
| `routedev/AGENTS.md` | 工程约定、陷阱、Core 不做清单 |
| `routedev/CODEMAP.md` | 模块索引 |
| `routedev/src/` | 引擎与运行时核心 |
| `routedev/desktop/` | Electron 主进程 + 渲染层 |
| `docs/` | 工作区文档；`docs/AGENT_TOOLING.md`、`docs/tools/` |
| `蓝图与Phase/` | 设计与 Phase 文档（非运行时） |
| `报告/` | 分析 / 审查 / 验证报告 |
| `design-demos/` | 原型 HTML |
| `refs/sonetto-here-ref/` | 外部参考实现，**只读**，不要当主开发树改 |
| `archive/` | 根目录清理归档（旧 CLI 脚手架、一次性脚本），非产品代码 |
| `README.md` | 人类可读的工作区导航 |

路径细节与旧→新对照见 [docs/PATHS.md](docs/PATHS.md)。

**工作目录：始终优先 `routedev/`。**  
禁止在仓库根执行 `pnpm install` / `pnpm test`（根脚手架已迁到 `archive/root-cli-scaffold/`）。

## 5. 验证命令速查（一律倾向 rtk）

索引重建见 [docs/PATHS.md](docs/PATHS.md) §6。codebase-memory 项目名：`C-tmp-routedev-idx`（junction `C:/tmp/routedev-idx` → `routedev/`）。


```bash
# 在 routedev 目录
rtk err pnpm test
rtk err pnpm typecheck
rtk git status
rtk git diff

# 仅看失败信号的通用包法
rtk err <any-noisy-command>
```

---

## 6. 给下一任模型的最小检查清单

开始改代码前：

- [ ] 已读本文件 + `routedev/AGENTS.md` 相关部分  
- [ ] 代码定位走了 MCP，而不是全库搜  
- [ ] 噪声命令走了 rtk  
- [ ] 知道如何 `rtk proxy` 拿全文  
- [ ] 改完用压缩后的 test/typecheck 验证  

结束任务前：

- [ ] 说明用了哪些 MCP 工具 / 关键路径  
- [ ] 验证命令与结果（可用 rtk 摘要）  
- [ ] 未把无关大日志粘进最终回复  

---

## 7. 与全局 Codex 配置的关系

用户全局可能还有：

- `~/.codex/AGENTS.md`（codebase-memory 提醒 + RTK 引用）
- `~/.codex/RTK.md`
- MCP：`codegraph`、`codebase-memory-mcp`

**本文件是仓库级强制约定**；与全局冲突时，**以本仓库 `AGENTS.md` + `routedev/AGENTS.md` 为准**。