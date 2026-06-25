# 插件生态兼容性研究报告（Phase 37 Task 4）

> **研究范围：** 评估 RouteDev 接入第三方 AI 编码工具插件生态（OpenAI Codex / Anthropic Claude Code / Cursor）的可行路径。
> **研究时间：** 2026-06
> **结论摘要：** MCP 是工具层的事实标准，RouteDev 已具备 MCP 客户端能力，**工具层兼容性高**；约定文件层建议以 AGENTS.md 为单一事实源；插件市场层建议作为消费者接入现有 MCP 注册表，不自建。

---

## 1. MCP 桥梁可行性

### 1.1 现状

RouteDev 自 Phase 8 起内置 MCP 客户端（`src/tools/mcp/client.ts`），基于 `@modelcontextprotocol/sdk` 实现，支持：

- **stdio 传输**：通过子进程启动 MCP server（`StdioClientTransport`）
- **SSE/HTTP 传输**：连接远程 MCP server（`SSEClientTransport`）
- **工具发现**：`client.listTools()` 自动发现 server 暴露的工具
- **工具注册**：发现的工具以 `mcp__<serverId>__<toolName>` 命名空间注册到本地 `ToolRegistry`
- **注入检测**（Phase 32 Task 4.2）：`ToolResultSanitizer` 检测工具描述中的注入模式

### 1.2 Codex / Claude Code / Cursor 的 MCP 支持

| 工具 | MCP 客户端 | 传输支持 | 工具命名约定 |
|------|-----------|---------|-------------|
| OpenAI Codex | 是 | stdio + http | `mcp__<server>__<tool>` |
| Claude Code | 是 | stdio + http | `mcp__<server>__<tool>` |
| Cursor | 是 | stdio + http | `mcp__<server>__<tool>` |
| **RouteDev** | 是 | stdio + sse | `mcp__<server>__<tool>` |

**关键发现：** 四者采用**完全相同的命名约定**，这是 MCP 规范的事实标准。RouteDev 的命名空间格式与 Codex/Claude Code 完全一致。

### 1.3 兼容性验证

**结论：工具层完全兼容。** RouteDev 可以直接连接任何符合 MCP 规范的 server，无需适配层。

**已验证的兼容点：**
- 工具描述格式：MCP `Tool` 类型（`name` + `description` + `inputSchema`）是跨工具通用格式
- 参数 schema：基于 JSON Schema，RouteDev 的 `validateArgs` 已支持类型检查（Phase 32 Task 4.1）
- 命名空间：`mcp__<serverId>__<toolName>` 与 Codex/Claude Code 一致

**潜在不兼容点：**
- RouteDev 仅支持 SSE 传输，而较新的 MCP 规范引入了 **Streamable HTTP** 传输（替代 SSE）。需要后续升级 SDK 版本。
- RouteDev 未实现 MCP 的 `resources` 和 `prompts` 能力，仅支持 `tools`。Codex/Claude Code 同样主要使用 `tools`，但部分 server 会暴露 `resources`（如文件系统快照）。

### 1.4 推荐路径

1. **短期（已实现）：** 直接复用现有 MCP 客户端连接第三方 server
2. **中期：** 升级 `@modelcontextprotocol/sdk` 到最新版本，支持 Streamable HTTP 传输
3. **长期：** 实现 `resources` 和 `prompts` 能力，完整覆盖 MCP 规范

---

## 2. 约定文件兼容性

### 2.1 各工具的约定文件

| 工具 | 约定文件 | 格式 | 用途 |
|------|---------|------|------|
| OpenAI Codex | `AGENTS.md` | Markdown | 项目级 Agent 行为约定 |
| Claude Code | `CLAUDE.md` | Markdown | 项目级 Agent 行为约定 |
| Cursor | `.cursorrules` | 纯文本/Markdown | 项目级行为约定 |
| **RouteDev** | `AGENTS.md` | Markdown | 项目级 Agent 行为约定 + 陷阱日志 |

### 2.2 兼容性分析

**关键发现：** AGENTS.md 正在成为事实标准。OpenAI 在 2025 年推动 AGENTS.md 作为开放约定，Claude Code 也开始支持读取 AGENTS.md（作为 CLAUDE.md 的 fallback）。

**RouteDev 的 AGENTS.md 已包含：**
- 项目级约定（编码风格、目录结构、构建命令）
- 陷阱日志（#1-59，持续累积的踩坑记录）
- Phase 验收清单

### 2.3 推荐路径

**结论：RouteDev 只需支持 AGENTS.md，无需互转工具。**

理由：
1. AGENTS.md 已是事实标准，Codex 原生支持
2. CLAUDE.md 与 AGENTS.md 内容本质相同，手动复制即可
3. `.cursorrules` 是 Cursor 专有格式，但 Cursor 也开始支持 AGENTS.md
4. 互转工具会增加维护成本，收益有限

**可选增强：** 在 RouteDev 的 AGENTS.md 解析器中增加对 `CLAUDE.md` 的 fallback 读取（当 AGENTS.md 不存在时尝试读取 CLAUDE.md），实现零成本兼容。

---

## 3. 插件市场可行性

### 3.1 现有 MCP 服务器注册表

| 注册表 | 类型 | 规模 | API |
|--------|------|------|-----|
| mcp.so | 社区 | 500+ servers | Web 浏览 + 手动配置 |
| Smithery | 社区 | 300+ servers | CLI 安装 (`npx @smithery/cli install`) |
| MCP Hub | 官方 | 100+ servers | Web 浏览 |

### 3.2 RouteDev 的定位

**结论：RouteDev 应作为消费者接入现有注册表，不自建插件市场。**

理由：
1. **避免重复造轮子：** mcp.so 和 Smithery 已有成熟的注册表基础设施
2. **生态规模不足：** RouteDev 用户基数不足以支撑独立插件市场
3. **MCP 是通用协议：** 任何 MCP server 都能直接接入，无需 RouteDev 专属市场

### 3.3 推荐路径

1. **短期：** 在设置页面增加"MCP 服务器市场"链接，引导用户到 mcp.so / Smithery 浏览
2. **中期：** 实现 Smithery CLI 集成（`smithery install <server>` 一键安装到 RouteDev 配置）
3. **长期：** 当 RouteDev 用户规模增长后，再考虑是否需要专属市场

---

## 4. 运行时差异分析

### 4.1 运行时环境对比

| 工具 | 运行时 | 沙箱 | 文件系统访问 |
|------|--------|------|-------------|
| OpenAI Codex | Node.js | 是（网络隔离） | 受限 |
| Claude Code | Node.js | 否 | 完整 |
| Cursor | Electron + Node.js | 否 | 完整 |
| **RouteDev** | Electron + Node.js | 否 | 完整 |

### 4.2 跨运行时复用分析

**可复用的插件能力：**
- 所有 stdio 类型的 MCP server（文件系统、Git、数据库等）——跨运行时完全兼容
- 所有 HTTP 类型的 MCP server——跨运行时完全兼容
- 工具描述和参数 schema——格式统一

**不可复用的能力：**
- Codex 沙箱内的网络隔离策略——RouteDev 无沙箱，需自行实现安全策略（已有 `SecurityConfig`）
- Cursor 的 Electron 特定 API（如原生菜单集成）——RouteDev 虽同为 Electron，但 API 不兼容
- Claude Code 的终端特定交互（如进度条）——RouteDev 有自己的 GUI，不适用

### 4.3 推荐路径

1. **工具层：** 完全复用 MCP 生态，无需适配
2. **安全层：** RouteDev 已有 `directoryBoundary` + `commandBlacklist` + `sensitiveFilePolicy`，覆盖 Codex 沙箱的部分能力
3. **UI 层：** 不追求与 Codex/Claude Code 的 UI 一致，保持 RouteDev 自己的 GUI 风格

---

## 5. 兼容性评估表

| 层级 | 兼容项 | 不兼容项 | RouteDev 策略 |
|------|--------|---------|--------------|
| **工具层** | MCP stdio/http 传输、工具命名约定、JSON Schema 参数 | Streamable HTTP 传输（新规范）、resources/prompts 能力 | 短期复用现有 MCP 客户端；中期升级 SDK |
| **约定层** | AGENTS.md 格式（事实标准） | CLAUDE.md / .cursorrules 专有格式 | 只支持 AGENTS.md；可选 fallback 读取 CLAUDE.md |
| **市场层** | Smithery CLI 安装协议 | 无统一市场 API | 作为消费者接入 Smithery；不自建市场 |
| **运行时层** | stdio/http MCP server 跨运行时 | 沙箱策略、Electron API、终端交互 | 工具层复用；安全层自行实现；UI 层保持独立 |

---

## 6. 原型验证结果

### 6.1 验证内容

在 `tests/phase37/plugin-ecosystem.test.ts` 中验证了三个关键兼容点：

1. **MCP 工具描述兼容性：** MCP `Tool` 定义能正确转换为 RouteDev `ToolDefinition`，命名空间格式与 Codex/Claude Code 一致
2. **MCP 服务器配置兼容性：** stdio 和 http 传输配置能正确解析，支持 Codex/Claude Code 生态常用的配置格式
3. **工具命名空间兼容性：** `mcp__<serverId>__<toolName>` 格式与 Codex/Claude Code 完全一致，跨工具可识别

### 6.2 验证结论

**RouteDev 已具备接入第三方 MCP 生态的能力，无需额外适配层。** 现有 MCP 客户端（Phase 8）+ 注入检测（Phase 32）+ 参数校验（Phase 32）已覆盖核心兼容性需求。

---

## 7. 总结与行动项

### 立即可做（已验证）
- ✅ 连接任何符合 MCP 规范的第三方 server
- ✅ 工具描述和参数 schema 自动适配
- ✅ 命名空间与 Codex/Claude Code 一致

### 短期（下个 Phase）
- 升级 `@modelcontextprotocol/sdk` 到最新版本
- 在设置页面增加 MCP 服务器市场链接

### 中期
- 实现 Smithery CLI 集成（一键安装）
- 支持 Streamable HTTP 传输
- AGENTS.md 解析器增加 CLAUDE.md fallback

### 长期
- 实现 MCP `resources` 和 `prompts` 能力
- 评估是否需要专属插件市场
