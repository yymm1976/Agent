# 开发工具手册：codebase MCP + rtk

本文是 `AGENTS.md` 的展开版，教后续 Agent **组合使用**图谱类 MCP 与 rtk。

## 一句话

- **codebase MCP** = 省「读代码」的 token + 提高定位正确率  
- **rtk** = 省「跑命令」的 token + 突出错误信号  
- 两者互补，不要互相替代

## 决策表

| 你想做的事 | 第一步 | 第二步 | 避免 |
|------------|--------|--------|------|
| 找函数/类/路由 | MCP search/explore | snippet/node | 全库 grep |
| 谁调用了 X | MCP callers / trace_path | 精读调用方 | 手工搜名字 |
| 改 X 会影响谁 | MCP impact | 列回归点 | 只靠感觉 |
| 看工作区状态 | `rtk git status` | 需要时 `rtk git diff` | 裸 `git status` 刷屏也无所谓，但优先 rtk |
| 测试失败原因 | `rtk err pnpm test` | 对失败符号走 MCP | 贴完整测试 log |
| 类型错误 | `rtk tsc` / `rtk err pnpm typecheck` | 打开报错文件 | 忽略 rtk 分组直接重跑裸命令 |
| 搜报错原文/配置键 | `rtk grep` | 回到 MCP 理解上下文 | 用 grep 替代架构理解 |
| 要完整日志 | `rtk proxy cmd` | 只摘关键段进回复 | 把 5 千行 log 留在对话里 |

## codebase MCP 工具速记

### codegraph（若可用）

- `codegraph_explore`：一片区域 / 流程，优先用  
- `codegraph_search`：按名找位置  
- `codegraph_node`：单符号全文  
- `codegraph_callers` / `codegraph_callees`：调用方向  
- `codegraph_impact`：改动波及  
- `codegraph_files`：目录结构  

### codebase-memory-mcp（若可用）

- `index_repository`：项目未索引时先跑  
- `search_graph` / `query_graph` / `trace_path`  
- `get_code_snippet` / `get_architecture` / `search_code`  
- `detect_changes` / `index_status`  

**策略：** 哪个 MCP 响应快、结果准就用哪个；不要两个各扫一遍同一问题（除非结果冲突）。

## rtk 命令速记

```bash
rtk <git|grep|err|test|vitest|tsc|npm|pnpm|docker|...> ...
rtk err <noisy-command>     # 只留 error/warning
rtk proxy <command>         # 不过滤
rtk rewrite "raw command"   # 看会映射成什么
rtk gain                    # 节省统计
```

### 本仓库高频模板

```bash
cd routedev

# 日常验证
rtk err pnpm test
rtk err pnpm typecheck

# 变更审阅
rtk git status
rtk git diff

# 失败后再定位
# 1) 从 rtk 输出拿 Error / 文件路径
# 2) MCP 查符号
# 3) 小修
# 4) 再 rtk err 验证
```

## 组合示例

### 例 1：修 `engine-bridge` 相关 bug

1. MCP：`explore "engine-bridge createAppDependencies"`  
2. MCP：`callers` / `trace_path` 看桌面层谁连引擎  
3. 精读返回的 1–2 个文件片段  
4. 修改  
5. `rtk err pnpm test` + 必要时针对性 vitest 文件  
6. `rtk git diff` 自查  

### 例 2：新增配置字段是否被消费

1. MCP：`search` 配置 schema / loader 符号  
2. MCP：`impact` 或 callers 看读取路径  
3. 若文档/字符串键名不确定 → `rtk grep -n "fieldName" routedev`  
4. 补测试后 `rtk err pnpm test`  

### 例 3：测试炸了但看不懂 log

1. `rtk err pnpm test`（或失败的具体 vitest 目标）  
2. 只保留首个失败栈  
3. 栈里的符号 → MCP node/callers  
4. 修复 → 再 rtk 验证  

## 失败与降级

| 路径搬家后图谱为空 | 按 docs/PATHS.md §6 重建 CBM + codegraph 索引 |

| 情况 | 处理 |
|------|------|
| MCP 未连接 | 读 `routedev/CODEMAP.md` + `routedev/AGENTS.md`，再受限搜索；并告知用户 |
| 索引过期 | `index_repository` 或 codegraph 重索引后再查 |
| rtk 不在 PATH | 使用 `C:\Users\<user>\bin\rtk.exe` 或提示用户安装；暂用裸命令但主动截断输出 |
| rtk 过滤掉关键信息 | `rtk proxy` 重跑一次 |

## 输出礼仪

- 最终回复给用户：结论 + 关键文件路径 + 验证摘要  
- 不要粘贴 MCP 全量 JSON / 完整测试日志  
- 引用代码时给 `路径` + 符号名，便于下一轮继续用 MCP  

## 相关文件

- 路径权威表：docs/PATHS.md（旧路径迁移对照）

- 仓库约定入口：`/AGENTS.md`  
- 工程约定：`routedev/AGENTS.md`  
- 全局 rtk：`~/.codex/RTK.md`  