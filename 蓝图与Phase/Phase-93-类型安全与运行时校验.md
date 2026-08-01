# Phase 93：类型安全与运行时校验

**目标：** 为安全敏感路径添加 Zod schema 运行时校验，并建立 schema migration 机制，防止反序列化数据被篡改或版本迁移后格式不兼容导致数据丢失。

**架构：** 不新建校验框架。复用现有 Zod schema 体系（AppConfigSchema 等），为安全敏感路径创建独立 schema 文件。migration 机制通过 `__schemaVersion` 字段 + `migrate()` 工具函数实现，与 Zod schema 协同。

**Token 原则：** 不全量替换所有 `as` 断言（136 处），仅覆盖安全敏感路径（磁盘 / LLM 输出 / 网络 / localStorage）；不引入运行时校验库（用 Zod）；不为每个类型新建 schema（按风险优先级）。

**涉及文件：**
- 新建：`routedev/src/config/schemas/integrity-manifest.ts`
- 新建：`routedev/src/config/schemas/goal-persistence.ts`
- 新建：`routedev/src/config/schemas/checkpoint.ts`
- 新建：`routedev/src/config/schemas/ipc-payload.ts`
- 新建：`routedev/src/utils/migration.ts`
- 修改：`routedev/src/runtime/app-init.ts`
- 修改：`routedev/desktop/renderer/src/store/useRouteDevStore.ts`
- 修改：`routedev/src/code-map/database.ts`
- 修改：28+ JSON 持久化文件（添加 `__schemaVersion`）

**关联技术债：** TD-15（High）/ TD-14（High）

---

## 明确不做

- 不全量替换 136 处 `as` 断言（仅覆盖安全敏感路径）
- 不引入 io-ts / runtypes 等替代库（用 Zod）
- 不为每个 TypeScript 类型新建 Zod schema
- 不改变现有持久化文件格式（仅添加 `__schemaVersion` 字段）
- 不新建 migration 配置文件或迁移脚本目录

---

### Task 1：安全敏感路径清单与 schema 优先级

**文件：**
- 新建：`routedev/src/config/schemas/index.ts`（聚合导出）

- [ ] **Step 1：梳理安全敏感路径清单**

按风险排序：
1. integrity-manifest（完整性校验，被篡改导致安全绕过）
2. goal-persistence（Goal 状态，损坏导致执行异常）
3. checkpoint（上下文快照，损坏导致恢复失败）
4. AppDependencies 合并点（配置加载，被篡改导致权限提升）
5. IPC payload（跨进程通信，被篡改导致权限绕过）
6. useRouteDevStore 回调（渲染层状态，被篡改导致 UI 异常）
7. database.ts JSON.parse（代码地图，被篡改导致索引污染）

- [ ] **Step 2：定义 schema 文件结构**

每个 schema 文件包含：
- `XxxSchema`（Zod schema 定义）
- `Xxx` 类型导出（`z.infer<typeof XxxSchema>`）
- `parseXxx(raw): Xxx` 函数（封装 Zod parse + 错误日志）

---

### Task 2：integrity-manifest Zod 校验

**文件：**
- 新建：`routedev/src/config/schemas/integrity-manifest.ts`
- 修改：`routedev/src/security/integrity-manifest.ts`（替换 `as` 断言）

- [ ] **Step 1：定义 IntegrityManifestSchema**

覆盖 manifest 结构：version / files / hashes / timestamp。

- [ ] **Step 2：替换 as 断言**

integrity-manifest.ts 中 `JSON.parse(raw) as IntegrityManifest` 改为 `parseIntegrityManifest(raw)`。

- [ ] **Step 3：运行测试**

```powershell
rtk err pnpm test -- tests/security/ --run
```

---

### Task 3：goal-persistence + checkpoint Zod 校验

**文件：**
- 新建：`routedev/src/config/schemas/goal-persistence.ts`
- 新建：`routedev/src/config/schemas/checkpoint.ts`
- 修改：`routedev/src/runtime/goal-runner-persist.ts`（Phase-92 拆分后）
- 修改：`routedev/src/runtime/checkpoint-manager.ts`

- [ ] **Step 1：定义 GoalPersistenceSchema**

覆盖 Goal / GoalStep / GoalState 结构。

- [ ] **Step 2：定义 CheckpointSchema**

覆盖 Checkpoint / ContextSnapshot 结构。

- [ ] **Step 3：替换 as 断言**

goal-runner-persist.ts 和 checkpoint-manager.ts 中的 `JSON.parse(raw) as Xxx` 改为 `parseXxx(raw)`。

- [ ] **Step 4：运行测试**

```powershell
rtk err pnpm test -- tests/runtime/ --run
```

---

### Task 4：AppDependencies 合并点 Zod 校验

**文件：**
- 修改：`routedev/src/runtime/app-init.ts:399`

- [ ] **Step 1：定义 AppDependenciesMergeSchema**

覆盖 app-init.ts 中合并配置后的 AppDependencies 结构（仅校验关键字段：security / autonomy / router / providers）。

- [ ] **Step 2：替换 as 断言**

`as AppDependencies` 改为 `parseAppDependenciesMerge(merged)`。

- [ ] **Step 3：运行测试**

```powershell
rtk err pnpm test -- tests/runtime/app-init --run
```

---

### Task 5：useRouteDevStore IPC 回调 Zod 校验

**文件：**
- 修改：`routedev/desktop/renderer/src/store/useRouteDevStore.ts`

- [ ] **Step 1：定义 IPC 回调 payload schema**

为 10 处 IPC 事件回调定义 payload schema（chat:message / tool:call / agent:state 等）。

- [ ] **Step 2：替换 as 断言**

10 处 `as Xxx` 改为 `parseXxx(payload)`。

- [ ] **Step 3：运行测试**

```powershell
rtk err pnpm test -- desktop/renderer/src/store/ --run
```

---

### Task 6：database.ts JSON.parse Zod 校验

**文件：**
- 修改：`routedev/src/code-map/database.ts`

- [ ] **Step 1：定义 CodeMapDatabaseSchema**

覆盖 NodeRecord / EdgeRecord / Metadata 结构。

- [ ] **Step 2：替换 as 断言**

系统性 `as Record<string, unknown>` + 逐字段断言改为 `parseCodeMapRecord(raw)`。

- [ ] **Step 3：运行测试**

```powershell
rtk err pnpm test -- tests/code-map/ --run
```

---

### Task 7：schema migration 工具函数

**文件：**
- 新建：`routedev/src/utils/migration.ts`

- [ ] **Step 1：实现 migrate() 工具函数**

```typescript
export function migrate<T>(
  raw: unknown,
  migrations: Array<(data: unknown) => unknown>,
  currentVersion: number,
): T {
  const version = (raw as { __schemaVersion?: number })?.__schemaVersion ?? 0;
  let data = raw;
  for (let v = version; v < currentVersion; v++) {
    data = migrations[v](data);
  }
  return data as T;
}
```

- [ ] **Step 2：单元测试**

```powershell
rtk err pnpm test -- tests/utils/migration.test.ts --run
```

---

### Task 8：28+ JSON 文件接入 migration

**文件：**
- 修改：`routedev/src/memory/memory-store.ts`
- 修改：`routedev/src/agent/memory/session-memory-store.ts`
- 修改：`routedev/src/runtime/goal-runner-persist.ts`
- 修改：`routedev/src/runtime/checkpoint-manager.ts`
- 其余 24 个 JSON 持久化文件

- [ ] **Step 1：添加 __schemaVersion 字段**

每个 JSON 文件顶层添加 `__schemaVersion: 1`（当前版本）。

- [ ] **Step 2：load 时调用 migrate**

每个 load 函数改为：
```typescript
const raw = JSON.parse(content);
const migrated = migrate(raw, migrations, CURRENT_VERSION);
const parsed = parseXxx(migrated);
```

- [ ] **Step 3：save 时写入 __schemaVersion**

每个 save 函数确保写入当前版本号。

- [ ] **Step 4：运行测试**

```powershell
rtk err pnpm test
```

---

### Task 9：验收

- [ ] **Step 1：全量测试基线**

```powershell
rtk err pnpm test
```

- [ ] **Step 2：typecheck**

```powershell
rtk err pnpm typecheck
```

- [ ] **Step 3：更新技术债跟踪表**

将 TD-14 和 TD-15 移至 §3 历史区。

---

## 依赖关系

- Task 7（migration 工具）应在 Task 8 之前完成
- Task 2-6 可并行
- Phase-92 Task 1（goal-runner 拆分）应在 Task 3 之前完成

## 验收标准

- 7 个安全敏感路径均有 Zod schema 校验
- 28+ JSON 文件均有 `__schemaVersion` 字段
- migrate() 工具函数有单元测试
- 全量测试零新增失败
- typecheck 通过
