# Design: AgentProfile Version Management

## Goal
为 RouteDev Sub-Agent 的 AgentProfile 增加版本管理：自动留档、字段级 diff、回滚、保留策略。

## Storage
- 路径：`${rootDir}/.routedev/skills/agents/<profileId>/versions/<versionId>.json`
- versionId：`${Date.now()}-${random6}`（避免同毫秒冲突）
- 每个 profile 最多保留 20 个版本；超出删除最旧
- 不覆盖旧版本

## Version Record Schema
```ts
type VersionSource = 'user_edit' | 'programmatic_write' | 'rollback';

interface FieldChange {
  field: string;
  oldValue?: unknown;
  newValue?: unknown;
  changeType: 'modified' | 'added' | 'removed';
}

interface VersionMeta {
  versionId: string;
  profileId: string;
  timestamp: number;
  source: VersionSource;
  changeSummary: string;   // 人类可读摘要，如 "修改 name; 修改 maxSteps"
  fieldChanges: FieldChange[];
}

interface VersionRecord {
  meta: VersionMeta;
  snapshot: Record<string, unknown>; // AgentProfile 全量快照
}

interface FieldDiff {
  field: string;
  baseVersion: string;
  targetVersion: string;
  baseValue: unknown;
  targetValue: unknown;
  changeType: 'modified' | 'added' | 'removed';
}
```

## Core Classes（已实现，勿重写）

### VersionManager (`src/agents/profiles/version-manager.ts`)
- `saveVersion(profile, source, previousSnapshot?)` → versionId
- `listVersions(profileId)` → VersionMeta[]（时间倒序）
- `loadVersion(profileId, versionId)` → VersionRecord（不存在抛错）
- `diffVersions(profileId, fromId, toId)` → FieldDiff[]
- `diffCurrentWith(profileId, currentProfile, targetVersionId)` → FieldDiff[]
- `rollbackTo(profileId, targetVersionId)` → AgentProfile（仅返回快照，不写盘）
- `enforceRetention(profileId)` — 保留最近 20
- `deleteAllVersions(profileId)`

Diff 规则：JSON 深度比较；忽略 `updatedAt`。

### AgentProfileManager (`src/agents/profiles/manager.ts`) 集成（已实现）
- 构造时创建 `VersionManager`
- `getVersionManager()`
- `saveProfile(profile, source = 'programmatic_write')`：写 SKILL.md 后 `saveVersion`
- `rollback(profileId, targetVersionId)`：`rollbackTo` + `saveProfile(..., 'rollback')`
- `deleteProfile`：删除整个 profile 目录（含 versions/）

## 本次需补齐：IPC / Bridge / Preload

### 原则
- diff / 回滚 **走渲染层 IPC**，主进程 **不** 弹窗（无 `dialog.showMessageBox`）
- fail-open / 返回 `{ success, error }`，与现有 ProfileBridge 风格一致
- UI 保存 profile 时 source 用 `'user_edit'`

### A. `desktop/shared/ipc-types.ts`
新增/导出：
- re-export 或镜像：`VersionMeta`, `FieldDiff`, `VersionSource`
- Profile API 增加：
  - `listVersions(profileId: string): Promise<VersionMeta[]>`
  - `diffVersions(profileId, fromVersionId, toVersionId): Promise<FieldDiff[]>`
  - `diffCurrentWith(profileId, targetVersionId): Promise<FieldDiff[]>`
  - `rollbackProfile(profileId, targetVersionId): Promise<ProfileOpResult>`

### B. `desktop/main/bridges/profile-bridge.ts`
新增：
```ts
async listVersions(profileId: string): Promise<VersionMeta[]>
async diffVersions(profileId, fromVersionId, toVersionId): Promise<FieldDiff[]>
async diffCurrentWith(profileId, targetVersionId): Promise<FieldDiff[]>
// 实现：getProfile 取当前 → versionManager.diffCurrentWith
async rollbackProfile(profileId, targetVersionId): Promise<ProfileOpResult>
// 实现：manager.rollback
```
`saveProfile`（来自 UI）：调用 `manager.saveProfile(profile, 'user_edit')`。

### C. Engine 委托
`desktop/main/engine-bridge.ts`：转发 4 个方法到 ProfileBridge（与现有 listProfiles 等同模式）。

### D. IPC handlers (`desktop/main/index.ts`)
注册：
- `profile:listVersions`
- `profile:diffVersions`
- `profile:diffCurrentWith`
- `profile:rollback`

与现有 `profile:*` handler 风格一致；无确认对话框。

### E. Preload (`desktop/preload/index.ts`)
在 profile API 对象上暴露上述 4 个方法。

## 测试 (`tests/agents/profiles-version.test.ts`)
必须覆盖：
1. **保存**：VersionManager.saveVersion + manager.saveProfile 自动留档
2. **diff**：diffVersions 和/或 diffCurrentWith 字段级差异
3. **回滚**：rollbackTo + manager.rollback
4. **清理**：超过 20 个版本 enforceRetention 删除最旧

修复点：
- `source` 只能用 `'user_edit' | 'programmatic_write' | 'rollback'`
- 注释/断言 max=20 不是 30

## 非目标（本次不做）
- 前端版本历史 UI 组件
- 改写 VersionManager / manager 核心逻辑（除非明显 bug）
- 改存储路径或保留数

## Acceptance
1. `npx vitest run tests/agents/profiles-version.test.ts` 通过
2. IPC 四路径可从 renderer 调用
3. UI save 记为 user_edit；rollback 再保存记为 rollback
