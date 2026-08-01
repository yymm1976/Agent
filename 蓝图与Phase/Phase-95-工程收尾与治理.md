# Phase 95：工程收尾与治理

**目标：** 完成 IPC handler 统一校验中间件迁移剩余 85 个 handler，统一全库 console 为结构化 logger，建立 eslint 规则防止回退。

**架构：** 不新建治理平台。IPC handler 按优先级分批迁移到 createValidatedHandler；console 替换按文件分批进行；eslint 规则作为最终门禁。

**Token 原则：** 不重写 handler 逻辑（仅包装校验层）；不引入新日志库（用现有 logger）；不一次性替换所有 console（分批进行）。

**涉及文件：**
- 修改：`routedev/desktop/main/index.ts`（85 个 handler + 23 处 console）
- 修改：`routedev/src/` 29 文件（61 处 console）
- 修改：`routedev/desktop/` 20 文件（75 处 console）
- 修改：`routedev/.eslintrc.cjs`（新增 no-console 规则）

**关联技术债：** TD-07（剩余 85 handler）/ TD-20（剩余 23+61 处 console）

---

## 明确不做

- 不重写 handler 业务逻辑（仅包装校验层）
- 不引入 winston / pino 等新日志库
- 不删除启动日志（logger 未初始化时合理保留 console）
- 不删除渲染层日志转发（必须用 console 转发到主进程）
- 不追求 0 console（白名单允许必要场景）

---

### Task 1：IPC handler 优先级清单

**文件：**
- 修改：`routedev/docs/IPC_HANDLER_INVENTORY.md`（新建清单文档）

- [ ] **Step 1：梳理 85 个未包装 handler**

按风险分 3 级：
- 高风险（外部输入）：mcp:install / mcp:uninstall / store:set / store:delete / fs:read / fs:write / fs:mkdir / fs:delete / experiment:adopt / experiment:rollback
- 中风险（参数校验）：checkpoint:rollback / checkpoint:restore / trace:replay / plan:check-omissions / agent:spawn / agent:terminate
- 低风险（无参数或内部调用）：chat:generate-title / agent:state / config:get / config:set 等

- [ ] **Step 2：输出清单文档**

记录每个 handler 的：channel / 参数 schema / 校验规则 / 优先级 / 迁移状态。

---

### Task 2：高风险 handler 批量迁移

**文件：**
- 修改：`routedev/desktop/main/index.ts`

- [ ] **Step 1：迁移 mcp:* handler**

mcp:install / mcp:uninstall 包装 createValidatedHandler：
- 校验 serverName 非空字符串
- 校验 source URL 格式（npm/本地路径）
- 校验长度上限

- [ ] **Step 2：迁移 store:* handler**

store:set / store:delete 包装：
- 校验 key 格式（白名单）
- 校验 value JSON 序列化
- 校验 value 长度上限

- [ ] **Step 3：迁移 fs:* handler**

fs:read / fs:write / fs:mkdir / fs:delete 包装：
- 校验 path 在工作区范围内（防路径穿越）
- 校验 content 长度上限
- 校验 operation 合法性

- [ ] **Step 4：迁移 experiment:* handler**

experiment:adopt / experiment:rollback 包装：
- 校验 experimentId 格式
- 校验 rollback target version

- [ ] **Step 5：运行测试**

```powershell
rtk err pnpm test -- desktop/main/__tests__/ --run
```

---

### Task 3：中低风险 handler 迁移

**文件：**
- 修改：`routedev/desktop/main/index.ts`

- [ ] **Step 1：迁移中风险 handler**

checkpoint:rollback / checkpoint:restore / trace:replay / plan:check-omissions / agent:spawn / agent:terminate 按参数 schema 包装。

- [ ] **Step 2：迁移低风险 handler**

无参数 handler（agent:state / agent:clearAllQueues）仅包装引擎初始化检查。
有参数 handler（chat:generate-title / config:get / config:set）按参数类型包装。

- [ ] **Step 3：验证全覆盖**

```powershell
# 统计未包装 handler 数量，预期为 0
rtk grep "ipcMain.handle\(" routedev/desktop/main/index.ts | Measure-Object | Select-Object Count
rtk grep "createValidatedHandler\(" routedev/desktop/main/index.ts | Measure-Object | Select-Object Count
```

预期：两者数量接近（ipcMain.handle 仅剩 createValidatedHandler 内部调用）。

- [ ] **Step 4：运行测试**

```powershell
rtk err pnpm test
```

---

### Task 4：desktop/main/index.ts 剩余 console 替换

**文件：**
- 修改：`routedev/desktop/main/index.ts`

- [ ] **Step 1：替换 IPC handler 错误 console（16 处）**

16 处 `console.error/warn` 在 IPC handler 内 → `logger.error/warn`，带结构化字段（channel / args / error）。

- [ ] **Step 2：保留启动日志（4 处）**

启动阶段（logger 未初始化）的 4 处 console.log 保留，添加 `// eslint-disable-next-line no-console` 注释。

- [ ] **Step 3：保留渲染层转发（3 处）**

3 处渲染层日志转发必须用 console（转发到主进程），添加 eslint-disable 注释。

- [ ] **Step 4：运行测试**

```powershell
rtk err pnpm typecheck
```

---

### Task 5：src/ console 替换（61 处 / 29 文件）

**文件：**
- 修改：`routedev/src/` 下 29 个文件

- [ ] **Step 1：按模块分批替换**

按模块分批：
- src/runtime/（15 处）
- src/agent/（12 处）
- src/tools/（10 处）
- src/router/（8 处）
- src/code-map/（6 处）
- src/config/ / src/security/ / src/utils/（10 处）

每批替换后跑该模块测试。

- [ ] **Step 2：保留必要 console**

仅在以下场景保留 console：
- logger 模块本身（src/utils/logger.ts）
- 进程启动前（无 logger 实例）
- 测试辅助代码

- [ ] **Step 3：运行测试**

```powershell
rtk err pnpm test
```

---

### Task 6：desktop/ console 替换（75 处 / 20 文件）

**文件：**
- 修改：`routedev/desktop/` 下 20 个文件

- [ ] **Step 1：替换 desktop/main/ 剩余文件（不含 index.ts）**

- [ ] **Step 2：替换 desktop/renderer/ 文件**

渲染层使用 `console.log` 转发到主进程的场景保留并标注。

- [ ] **Step 3：替换 desktop/preload/ 文件**

- [ ] **Step 4：运行测试**

```powershell
rtk err pnpm test
```

---

### Task 7：eslint no-console 规则

**文件：**
- 修改：`routedev/.eslintrc.cjs`

- [ ] **Step 1：添加 no-console 规则**

```json
{
  "rules": {
    "no-console": ["error", { "allow": ["warn", "error"] }]
  }
}
```

允许 warn/error（开发期临时调试），禁止 log/info/debug。

- [ ] **Step 2：添加白名单文件**

在 eslint 配置的 overrides 中为以下文件添加白名单：
- src/utils/logger.ts
- desktop/main/index.ts（启动日志部分，用 eslint-disable-next-line）
- tests/（测试代码允许 console）

- [ ] **Step 3：运行 eslint 验证**

```powershell
rtk err pnpm lint
```

预期：零 error（白名单文件除外）。

---

### Task 8：验收

- [ ] **Step 1：全量测试基线**

```powershell
rtk err pnpm test
```

- [ ] **Step 2：typecheck**

```powershell
rtk err pnpm typecheck
```

- [ ] **Step 3：eslint 检查**

```powershell
rtk err pnpm lint
```

- [ ] **Step 4：统计 console 残留**

```powershell
rtk grep "console\.\(log\|info\|debug\)" routedev/src/ routedev/desktop/ | Measure-Object | Select-Object Count
```

预期：仅白名单文件命中。

- [ ] **Step 5：统计未包装 IPC handler**

```powershell
# 预期：所有 ipcMain.handle 均使用 createValidatedHandler 包装
```

- [ ] **Step 6：更新技术债跟踪表**

将 TD-07 和 TD-20 移至 §3 历史区，技术债清单清空或仅剩新增项。

---

## 依赖关系

- 无前置依赖，可与 Phase-91/92/93/94 并行
- Task 1（handler 清单）应在 Task 2/3 之前完成
- Task 7（eslint 规则）应在 Task 4/5/6 之后完成（先替换再加门禁）

## 验收标准

- 92 个 IPC handler 全部用 createValidatedHandler 包装（或标注无校验需求）
- console.log/info/debug 残留仅限白名单文件
- eslint no-console 规则启用，零 error
- 全量测试零新增失败
- typecheck 通过
- 技术债跟踪表 §1 活跃清单清空或仅剩新增项
