# Phase 82 — 外置包机制落地

> **Phase 类型：** 架构外置（Capability Packs）  
> **前置依赖：** Phase-81（模块已退默认装配）  
> **目标版本：** v4.7.x  
> **核心目标：** 建立 Pi Extensions 风格的 Pack API，区分 Extended Pack 与 Standard Pack，支持用户自建 Pack  
> **策略：冷处理不删除** —— 保留所有接口，通过 Pack 机制按需启用  
> **蓝图参考：** [BLUEPRINT-CORE-CAPABILITY-PACK-v3.md](./BLUEPRINT-CORE-CAPABILITY-PACK-v3.md) §4 Pack 扩展能力升级

---

## 可验证目标

| # | 目标 | 验证方式 |
|---|------|----------|
| 1 | `CapabilityPack` + `PackContext` 接口可用（含 tools/commands/events） | `tests/plugins/capability-pack.test.ts` 全绿 |
| 2 | ≥3 Extended Pack 完成迁移 | goal-advanced / multi-agent / adversarial-review 可开关 |
| 3 | ≥3 Standard Pack 完成迁移 | browser-web / code-map / harness 可开关 |
| 4 | 默认启动不加载任何 Pack 工具定义 | 启动后 ToolRegistry 不含 Pack 工具 |
| 5 | Pack 启用后功能完整 | 各 Pack 启用后集成测试通过 |
| 6 | Pack 加载失败不影响 Core | fail-open 测试 |
| 7 | 用户可在 `~/.routedev/packs/` 放置自建 Pack | 自建 Pack 示例可加载并注册工具 |

---

## 设计

> 参考 [BLUEPRINT-CORE-CAPABILITY-PACK-v3.md](./BLUEPRINT-CORE-CAPABILITY-PACK-v3.md) §4

### Pack 接口（Pi Extensions 风格）

```ts
export type PackLayer = 'extended' | 'standard';

export interface CapabilityPack {
  id: string;           // 'pack.multi-agent'
  layer: PackLayer;     // extended | standard
  description: string;  // 用户可见描述
  costHint: string;     // 启用后的 token/性能成本提示
  defaultEnabled: false;
  register(ctx: PackContext): Promise<void> | void;
  unregister?(ctx: PackContext): Promise<void> | void;
}
```

### PackContext API（Pi Extensions 风格升级）

```ts
interface PackContext {
  // 工具注册（Pi 式新增：可注册自定义工具或替换内置工具）
  tools: ToolRegistry;
  // 命令注册（Pi 式新增：可注册 slash 命令）
  commands: CommandRegistry;
  // 事件钩子（Pi 式新增：tool_call / message / turn_start 等）
  events: PackEventBus;
  // 配置（已有）
  config: AppConfig;
  // 日志（已有）
  logger: Logger;
  // 使用计数（已有）
  usage: UsageCounter;
}
```

### 用户自建 Pack 支持

用户可在以下路径放置自定义 Pack（与官方 Pack 使用相同 API）：

```text
~/.routedev/packs/my-pack/index.ts + pack.json    // 全局
.routedev/packs/project-pack/index.ts + pack.json  // 项目级
```

Pack 发现顺序：项目级 → 全局 → 内置。后者不覆盖前者同名 Pack。

### Extended vs Standard Pack 差异

| | Extended Pack | Standard Pack |
|---|---------------|---------------|
| 维护优先级 | 中等偏下 | 冷处理（仅崩溃修复） |
| 启用成本提示 | 有（说明 token 影响） | 有 |
| 接口完整性要求 | 高（修 bug、保类型契约） | 中（允许内部简化） |
| 设置页位置 | "高级" 区 | "扩展" 区 |
| 测试要求 | 启用后集成测试 | 启用后冒烟测试 |

### 加载策略

1. 读 config `packs.<id>.enabled`
2. 仅 enabled 时 `register()`
3. 热重载时可 unregister + register（能做则做，不能则提示重启）
4. register 抛错 → fail-open + log + usage-counter 记录

---

## Task 1：Pack 运行时

**文件：**
- 创建：`src/plugins/capability-pack.ts`
- 创建：`src/plugins/capability-pack-registry.ts`
- 修改：`src/runtime/app-init.ts` / `app-init-tools.ts`
- 修改：`src/config/schema.ts` / `defaults.ts`
- 测试：`tests/plugins/capability-pack.test.ts`

- [ ] **Step 1: 实现接口与注册表**

- [ ] **Step 2: app-init 改为"Core 装配 + Pack 装配"两阶段**

- [ ] **Step 3: 配置 schema**

```yaml
packs:
  # Extended Pack（中等偏下）
  goal-advanced: { enabled: false }
  multi-agent: { enabled: false }
  adversarial-review: { enabled: false }
  # Standard Pack（冷处理）
  browser-web: { enabled: false }
  code-map: { enabled: false }
  harness: { enabled: false }
  compose: { enabled: false }
  import-ecosystem: { enabled: false }
```

- [ ] **Step 4: 测试**

1. 默认不 register 任何 Pack 工具
2. enable 后可调用
3. 重复 enable 幂等
4. register 抛错不阻断 Core
5. usage-counter 记录 pack load/skip

- [ ] **Step 5: 提交**

```powershell
git commit -m "feat(phase-82): CapabilityPack 运行时与配置门控"
```

---

## Task 2：迁移 Extended Pack（≥3 个）

| Pack | 包含模块 | 启用后验收 |
|------|----------|------------|
| `pack.goal-advanced` | goal-runner 高级编排（Phase-79 拆分后的 scheduler 部分） | `/goal` 可用；sequential 闭环 |
| `pack.multi-agent` | multi/orchestrator + blackboard + worker + spawn_agent | spawn_agent 可达 |
| `pack.adversarial-review` | cross-model-reviewer + adversarial 逻辑 | /review 命令可用 |

- [ ] **Step 1–3: 逐 Pack 迁移**

每包验收：
- 默认 off
- on 后入口可达
- off 后入口不可达
- `CAPABILITY_LAYERS.md` 更新

- [ ] **Step 4: 提交**

```powershell
git commit -m "refactor(phase-82): Extended Pack 迁移（goal/multi-agent/adversarial）"
```

---

## Task 3：迁移 Standard Pack（≥3 个）

| Pack | 包含模块 | 冷处理验收 |
|------|----------|------------|
| `pack.browser-web` | browser / web_search / web_fetch | 默认 off；on 后可用 |
| `pack.code-map` | code-map / code_graph_query | 默认 off；on 后可索引 |
| `pack.harness` | trace-replayer / scorecard | 默认 off；命令触发 |

- [ ] **Step 1–3: 逐 Pack 迁移**
- [ ] **Step 4: 提交**

```powershell
git commit -m "refactor(phase-82): Standard Pack 冷处理迁移（browser/code-map/harness）"
```

---

## Task 4：用户自建 Pack 支持

**文件：**
- 创建：`src/plugins/pack-discovery.ts`
- 修改：`src/runtime/app-init.ts`
- 测试：`tests/plugins/pack-discovery.test.ts`
- 文档：`docs/packs/user-built.md`

- [ ] **Step 1: 实现 Pack 发现器**

扫描路径（优先级从高到低）：
1. 项目级 `.routedev/packs/`
2. 全局 `~/.routedev/packs/`
3. 内置 Pack

每个目录包含 `pack.json`（元数据）+ `index.ts`（入口）。

- [ ] **Step 2: Pack 加载与错误隔离**

- 自建 Pack register 抛错 → fail-open + log + 不阻断 Core
- 自建 Pack 注册的工具受 PermissionEngine 管控

- [ ] **Step 3: 提供示例 Pack**

`docs/packs/example-pack/` 包含：
- 一个注册自定义工具的示例
- 一个注册自定义命令的示例
- 一个监听事件钩子的示例

- [ ] **Step 4: 测试**

1. 全局 Pack 可发现并加载
2. 项目级 Pack 优先于全局
3. 同名 Pack 项目级覆盖全局
4. 加载失败不影响 Core

- [ ] **Step 5: 提交**

```powershell
git commit -m "feat(phase-82): 用户自建 Pack 发现与加载"
```

---

## Task 5：设置页与文档

**文件：**
- 修改：Settings 新增"能力包"分组（高级 / 扩展两区）
- 修改：`docs/CONFIGURATION.md`
- 修改：`docs/CAPABILITY_LAYERS.md`
- 修改：`CHANGELOG.md`

- [ ] **Step 1: UI 开关绑定 packs.* **

每个 Pack 开关附带：
- 描述
- 成本提示（预估 token 影响）
- Extended Pack 标"高级"，Standard Pack 标"扩展"

- [ ] **Step 2: 文档写清"默认 Core + 按需 Pack"**

- [ ] **Step 3: 提交**

```powershell
git commit -m "docs(phase-82): 能力包设置与配置文档"
```

---

## 验收

- [ ] Pack 接口统一可用
- [ ] ≥3 Extended Pack + ≥3 Standard Pack 迁移完成
- [ ] 默认启动工具定义显著减少
- [ ] Core 场景不受 Pack 失败影响
- [ ] 审查提示词将 Pack 默认关视为设计
- [ ] 设置页分层展示

---

## 风险

- 热重载不完整：允许"改 Pack 需重启"
- 循环依赖：Pack 不得反向依赖 UI 具体组件
- 过度抽象：只做最小接口
