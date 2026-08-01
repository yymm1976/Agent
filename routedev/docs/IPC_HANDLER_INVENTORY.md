# IPC Handler 清单（Phase 95 Task 1）

> **用途：** 记录 `desktop/main/index.ts` 全部 92 个 IPC handler 的 channel / 参数 schema / 校验规则 / 优先级 / 迁移状态，便于审查与回归追踪。
> **维护规则：** 新增 handler 时同步追加到此表；handler 迁移到 createValidatedHandler 后更新"迁移状态"列。
> **最后更新：** 2026-07-29（Phase-95 Task 1-3 完成，92/92 handler 全部包装）

---

## 概览

- **总数：** 92 个 ipcMain.handle
- **包装状态：** 92/100% 已用 `createValidatedHandler` / `createValidatedHandlerMulti` 包装
- **校验工具：**
  - `ipcValidate.{none, string, optionalString, number, optionalNumber, object, optionalObject, boolean}` 通用校验器工厂
  - 内联自定义校验函数（用于带业务规则的校验，如 shell:open-external 的协议白名单）
- **风险分级：**
  - 高风险（外部输入 / 破坏性操作）：18 个
  - 中风险（参数校验缺失会引发逻辑错误）：43 个
  - 低风险（无参数或仅内部调用）：31 个

---

## 高风险 handler（18 个）

带外部输入或破坏性操作，校验失败可能导致路径穿越 / 数据丢失 / 任意代码执行。

| # | channel | 参数 schema | 校验规则 | 迁移状态 |
|---|---------|------------|---------|---------|
| 1 | `mcp:install` | MCPInstallPayload | ipcValidate.object() + 内部字段校验 | 已包装 |
| 2 | `mcp:connect` | string（serverName） | ipcValidate.string(256) | 已包装 |
| 3 | `mcp:disconnect` | string（serverName） | ipcValidate.string(256) | 已包装 |
| 4 | `store:set` | string key + unknown value | createValidatedHandlerMulti [ipcValidate.string(256), () => null] | 已包装 |
| 5 | `store:delete` | string（key） | ipcValidate.string(256) | 已包装 |
| 6 | `fs:read` | string（绝对路径） | ipcValidate.string(4096) + 内部 engine.handleFsRead 路径校验 | 已包装 |
| 7 | `fs:open-folder` | string（路径） | ipcValidate.string(4096) + 内部 shell.openPath | 已包装 |
| 8 | `shell:open-external` | string（URL） | 自定义校验：URL 必须 http/https/mailto 协议 | 已包装 |
| 9 | `shell:open-path` | string（路径） | 自定义校验：长度上限 4096 | 已包装 |
| 10 | `shell:show-item-in-folder` | string（路径） | 自定义校验：长度上限 4096 | 已包装 |
| 11 | `clipboard:write-text` | string（文本） | 自定义校验：长度上限 1MB（防 OOM） | 已包装 |
| 12 | `experiment:adopt` | { experimentId, confirmationToken? } \| string | 自定义校验：string 或 object | 已包装 |
| 13 | `experiment:discard` | { experimentId, confirmationToken? } \| string | 自定义校验：string 或 object | 已包装 |
| 14 | `checkpoint:rollback` | { checkpointId, confirmationToken? } \| string | 自定义校验：string 或 object + 一次性确认令牌消费 | 已包装 |
| 15 | `command:execute` | CommandExecutePayload | 自定义校验：text 长度 + slash 命令白名单 ALLOWED_SHELL_COMMANDS | 已包装 |
| 16 | `tool:execute` | ToolExecutePayload | 自定义校验：toolName 必须在 IPC_TOOL_WHITELIST（test_connection/list_directory/file_read） | 已包装 |
| 17 | `hook:create` | unknown（hook 配置对象） | ipcValidate.object() + 内部 Zod schema 校验 | 已包装 |
| 18 | `confirmation:create` | string operation + string targetId | createValidatedHandlerMulti [ipcValidate.string(64), ipcValidate.string(256)] | 已包装 |

---

## 中风险 handler（43 个）

参数缺失或类型错误会引发逻辑错误或异常，但不直接导致安全风险。

| # | channel | 参数 schema | 校验规则 | 迁移状态 |
|---|---------|------------|---------|---------|
| 1 | `plan:get-revisions` | string（goalId） | ipcValidate.string(256) | 已包装 |
| 2 | `plan:check-omissions` | string（planText） | ipcValidate.string(256) | 已包装 |
| 3 | `goal:resume` | string（goalId） | ipcValidate.string(256) | 已包装 |
| 4 | `goal:discard` | string（goalId） | ipcValidate.string(256) | 已包装 |
| 5 | `mcp:catalog:list` | string?（filter） | ipcValidate.optionalString(256) | 已包装 |
| 6 | `mcp:catalog:search` | string（query） | ipcValidate.string(1000) | 已包装 |
| 7 | `skill:preview` | string（skillName） | ipcValidate.string(256) | 已包装 |
| 8 | `skill:toggle` | { name, enabled } | ipcValidate.object() | 已包装 |
| 9 | `skill:create` | unknown（skill 配置） | ipcValidate.object() | 已包装 |
| 10 | `skill:delete` | string（skillName） | ipcValidate.string(256) | 已包装 |
| 11 | `skill:route` | string（taskText） | ipcValidate.string(10000) | 已包装 |
| 12 | `fs:select-folder` | string?（defaultPath） | ipcValidate.optionalString(4096) | 已包装 |
| 13 | `chat:generate-title` | string + string? | createValidatedHandlerMulti [ipcValidate.string(100000), ipcValidate.optionalString(100000)] | 已包装 |
| 14 | `app:get-path` | string（pathName） | ipcValidate.string(256) | 已包装 |
| 15 | `window:action` | string（action） | ipcValidate.string(256) | 已包装 |
| 16 | `terminal:create` | { cwd?, cols?, rows? }? | ipcValidate.optionalObject() | 已包装 |
| 17 | `terminal:destroy` | string（sessionId） | ipcValidate.string(256) | 已包装 |
| 18 | `terminal:write` | string id + string data | createValidatedHandlerMulti [ipcValidate.string(256), ipcValidate.string(1000000)] | 已包装 |
| 19 | `terminal:resize` | string id + number cols + number rows | createValidatedHandlerMulti [ipcValidate.string(256), ipcValidate.number(0,10000), ipcValidate.number(0,10000)] | 已包装 |
| 20 | `dialog:open` | Electron.OpenDialogOptions? | ipcValidate.optionalObject() | 已包装 |
| 21 | `dialog:save` | Electron.SaveDialogOptions? | ipcValidate.optionalObject() | 已包装 |
| 22 | `dialog:message` | Electron.MessageBoxOptions | ipcValidate.object() | 已包装 |
| 23 | `notification:show` | Electron.NotificationConstructorOptions | ipcValidate.object() | 已包装 |
| 24 | `project:add-recent` | string（projectPath） | ipcValidate.string(4096) | 已包装 |
| 25 | `store:get` | string（key） | ipcValidate.string(256) | 已包装 |
| 26 | `experiment:get-diff` | string（experimentId） | ipcValidate.string(256) | 已包装 |
| 27 | `hook:toggle` | { hookId, enabled } | ipcValidate.object() | 已包装 |
| 28 | `hook:delete` | string（hookId） | ipcValidate.string(256) | 已包装 |
| 29 | `checkpoint:list` | string?（filter） | ipcValidate.optionalString(256) | 已包装 |
| 30 | `agent:removeFollowUp` | number（index） | ipcValidate.number(0, 1000000) | 已包装 |
| 31 | `trace:list-sessions` | number?（limit） | ipcValidate.optionalNumber(1, 1000) | 已包装 |
| 32 | `trace:replay` | string sessionId + number? speed | createValidatedHandlerMulti [ipcValidate.string(128), ipcValidate.optionalNumber(0,100000)] | 已包装 |
| 33 | `trace:scorecard` | string（sessionId） | ipcValidate.string(128) | 已包装 |
| 34 | `profile:get` | string（profileId） | ipcValidate.string(256) | 已包装 |
| 35 | `profile:save` | unknown（profile 配置） | ipcValidate.object() + 内部 Zod schema 校验 | 已包装 |
| 36 | `profile:delete` | string（profileId） | ipcValidate.string(256) | 已包装 |
| 37 | `profile:duplicate` | string srcId + string newName | createValidatedHandlerMulti [ipcValidate.string(256), ipcValidate.string(256)] | 已包装 |
| 38 | `profile:list-versions` | string（profileId） | ipcValidate.string(256) | 已包装 |
| 39 | `profile:get-version` | string profileId + string versionId | createValidatedHandlerMulti [ipcValidate.string(256), ipcValidate.string(128)] | 已包装 |
| 40 | `profile:rollback` | string profileId + string versionId | createValidatedHandlerMulti [ipcValidate.string(256), ipcValidate.string(128)] | 已包装 |
| 41 | `profile:diff-versions` | string profileId + string fromId + string toId | createValidatedHandlerMulti [ipcValidate.string(256), ipcValidate.string(128), ipcValidate.string(128)] | 已包装 |
| 42 | `profile:diff-current-with` | string profileId + string targetId | createValidatedHandlerMulti [ipcValidate.string(256), ipcValidate.string(128)] | 已包装 |
| 43 | `config:save` | unknown（AppConfig） | ipcValidate.object() + 内部 AppConfigSchema Zod parse | 已包装 |

---

## 低风险 handler（31 个）

无参数或仅内部调用，校验主要保证 engine 已初始化。

| # | channel | 参数 schema | 校验规则 | 迁移状态 |
|---|---------|------------|---------|---------|
| 1 | `goal:list-resumable` | undefined | ipcValidate.none | 已包装 |
| 2 | `config:get` | undefined | ipcValidate.none | 已包装 |
| 3 | `config:reload` | undefined | () => null（无参数校验） | 已包装 |
| 4 | `mcp:status` | undefined | ipcValidate.none | 已包装 |
| 5 | `mcp:tools` | undefined | ipcValidate.none | 已包装 |
| 6 | `skill:list` | undefined | ipcValidate.none | 已包装 |
| 7 | `skill:reload` | undefined | ipcValidate.none | 已包装 |
| 8 | `window:restore-focus` | undefined | ipcValidate.none | 已包装 |
| 9 | `app:get-info` | undefined | ipcValidate.none | 已包装 |
| 10 | `app:quit` | undefined | ipcValidate.none | 已包装 |
| 11 | `app:relaunch` | undefined | ipcValidate.none | 已包装 |
| 12 | `window:get-state` | undefined | ipcValidate.none | 已包装 |
| 13 | `engine:get-state` | undefined | ipcValidate.none | 已包装 |
| 14 | `engine:start` | undefined | ipcValidate.none | 已包装 |
| 15 | `engine:stop` | undefined | ipcValidate.none | 已包装 |
| 16 | `engine:restart` | undefined | ipcValidate.none | 已包装 |
| 17 | `terminal:list` | undefined | ipcValidate.none | 已包装 |
| 18 | `clipboard:read-text` | undefined | ipcValidate.none | 已包装 |
| 19 | `project:open` | undefined | ipcValidate.none | 已包装 |
| 20 | `project:get-recent` | undefined | ipcValidate.none | 已包装 |
| 21 | `update:check` | undefined | ipcValidate.none | 已包装 |
| 22 | `update:download` | undefined | ipcValidate.none | 已包装 |
| 23 | `update:install` | undefined | ipcValidate.none | 已包装 |
| 24 | `experiment:list` | undefined | ipcValidate.none | 已包装 |
| 25 | `hook:list` | undefined | ipcValidate.none | 已包装 |
| 26 | `agent:queueStatus` | undefined | ipcValidate.none | 已包装 |
| 27 | `agent:getFollowUpQueue` | undefined | ipcValidate.none | 已包装 |
| 28 | `profile:list` | undefined | ipcValidate.none | 已包装 |
| 29 | `profile:import` | undefined | ipcValidate.none | 已包装 |
| 30 | `session:get-status` | undefined | ipcValidate.none | 已包装 |
| 31 | `stats:get-snapshot` | undefined | ipcValidate.none | 已包装 |

---

## 校验工具说明

### `createValidatedHandler<TArgs, TResult>(channel, validator, handler)`

单参数 handler 包装器（Phase 79 Task 7）。validator 返回 null 表示通过，返回字符串表示错误消息。

### `createValidatedHandlerMulti<TResult>(channel, validators, handler)`

多参数 handler 包装器（Phase 95）。validators 是校验器数组，对应每个 positional 参数。

### `ipcValidate.*` 通用校验器工厂

| 工厂 | 用途 | 失败消息 |
|------|------|---------|
| `none` | 无参数 handler | 永远通过 |
| `string(maxLen)` | 非空字符串 + 长度上限 | "参数必须是字符串" / "参数不能为空" / "字符串长度不能超过 N" |
| `optionalString(maxLen)` | undefined/null 或 string | 同上 |
| `number(min, max)` | 数字范围 | "参数必须是数字" / "数字不能小于/大于 N" |
| `optionalNumber(min, max)` | undefined/null 或 number | 同上 |
| `object()` | 非 null 对象 | "参数必须是对象" |
| `optionalObject()` | undefined/null 或 object | 同上 |
| `boolean()` | 布尔值 | "参数必须是布尔值" |

### 内联自定义校验函数

部分 handler 的校验规则包含业务逻辑（如协议白名单 / 命令白名单 / 工具白名单），使用内联函数实现：

- `shell:open-external`：URL 必须 http/https/mailto 协议
- `shell:open-path` / `shell:show-item-in-folder`：长度上限 4096
- `clipboard:write-text`：长度上限 1MB（防 OOM）
- `command:execute`：slash 命令白名单 ALLOWED_SHELL_COMMANDS
- `tool:execute`：工具白名单 IPC_TOOL_WHITELIST
- `experiment:adopt` / `experiment:discard` / `checkpoint:rollback`：string 或 object 类型校验

---

## 迁移历史

- **2026-07-11**：F-N026 短期修复，10+ handler 补薄弱校验
- **2026-07-29 Phase 79 Task 7**：新建 `ipc-guard.ts` 实现 `createValidatedHandler`，包装 7 个高风险 handler（config:reload / command:execute / tool:execute / shell:open-external / shell:open-path / shell:show-item-in-folder / clipboard:write-text）
- **2026-07-29 Phase 95 Task 2-3**：完成剩余 85 个 handler 迁移，新建 `createValidatedHandlerMulti`（多参数）和 `ipcValidate.*`（通用校验器工厂），92/92 全部包装

---

## 相关文档

- [TECH_DEBT_TRACKER.md](./TECH_DEBT_TRACKER.md) §3 TD-07 修复历史
- [Phase-95-工程收尾与治理.md](../蓝图与Phase/Phase-95-工程收尾与治理.md) 完整规划
- [ipc-guard.ts](../desktop/main/ipc-guard.ts) 校验工具实现
