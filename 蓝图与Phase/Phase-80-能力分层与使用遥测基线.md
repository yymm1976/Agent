# Phase 80 — 能力分层与使用遥测基线

> **Phase 类型：** 产品分层基建（Foundation）  
> **前置依赖：** Phase-79 + [BLUEPRINT-CORE-CAPABILITY-PACK-v3.md](./BLUEPRINT-CORE-CAPABILITY-PACK-v3.md)  
> **目标版本：** v4.6.x  
> **核心目标：** 为每个生产模块明确四层归属（Core / Extended Pack / Standard Pack / Freeze），建立本地调用遥测，为后续冷处理提供数据证据  
> **明确不做：** 不删除模块、不改默认工具集、不引入新功能

---

## 背景

Phase-78 给了社区方向，Phase-79 收尾技术债。但缺 RouteDev 自身使用数据就无法安全执行冷处理。本 Phase 做两件事：**定层**（每模块归属）+ **量尺**（调用计数）。

---

## 可验证目标

| # | 目标 | 验证方式 |
|---|------|----------|
| 1 | `CAPABILITY_LAYERS.md` 覆盖 ≥80% 生产模块 | 文件存在 + 行数 ≥ 模块总数 × 0.8 |
| 2 | 本地 usage 计数器上线且不影响主路径 | `pnpm test -- tests/observability/usage-counter.test.ts` 全绿 |
| 3 | 每个模块有且仅有一个四层标签 | 清单无 `unknown` 标签 |
| 4 | `/usage` 命令可导出 7 天摘要 | 手动运行验证 |

---

## Task 1：四层能力分层清单

**文件：**
- 创建：`routedev/docs/CAPABILITY_LAYERS.md`
- 修改：`routedev/CODEMAP.md`（增加分层索引段）

- [ ] **Step 1: 从生产入口枚举**

读取并枚举：
- `src/runtime/app-init*.ts` 装配项
- `src/tools/builtin/*` 工具注册
- `desktop/preload/index.ts` IPC
- `desktop/main/engine-bridge.ts` slash 命令
- `src/config/schema.ts` + `defaults.ts` 开关

- [ ] **Step 2: 写入四层分层表**

`CAPABILITY_LAYERS.md` 列定义：

| ID | 名称 | 层 | 默认 | 入口 | 源码 | 依赖 | 冷处理策略 |
|----|------|----|------|------|------|------|------------|

层枚举（四层）：
- `core` — 默认开，必须强化
- `extended-pack` — 默认关，中等偏下维护，修 bug 不扩功能
- `standard-pack` — 默认关，冷处理，仅修崩溃
- `freeze` — 停止接线，不承诺

冷处理策略列填写：保留接口方式 / 是否保留配置开关 / 预计迁移到的 Pack 名。

- [ ] **Step 3: 与蓝图 §2 逐条对齐**

对照 `BLUEPRINT-CORE-CAPABILITY-PACK-v2.md` §2.1–2.4，修正冲突项并记录理由。

重点确认：
- Multi-Agent → `extended-pack`（`pack.multi-agent`）
- Goal 高级编排 → `extended-pack`（`pack.goal-advanced`）
- 对抗审查 → `extended-pack`（`pack.adversarial-review`）
- 浏览器/Web → `standard-pack`（`pack.browser-web`）
- 代码地图 → `standard-pack`（`pack.code-map`）
- Progressive Trust → `freeze`
- KG 高级算法 → `freeze`

- [ ] **Step 4: 提交**

```powershell
git add routedev/docs/CAPABILITY_LAYERS.md routedev/CODEMAP.md
git commit -m "docs(phase-80): 建立四层能力分层清单"
```

---

## Task 2：使用遥测（本地计数）

**文件：**
- 创建：`src/observability/usage-counter.ts`
- 修改：`src/tools/executor.ts`、`desktop/main/engine-bridge.ts`、`src/runtime/app-init-observability.ts`
- 测试：`tests/observability/usage-counter.test.ts`

- [ ] **Step 1: 实现 UsageCounter**

```ts
export type UsageEvent =
  | { kind: 'tool'; name: string }
  | { kind: 'command'; name: string }
  | { kind: 'pack'; name: string; action: 'load' | 'skip' }
  | { kind: 'config_gate'; name: string; enabled: boolean };

export class UsageCounter {
  increment(event: UsageEvent): void {}
  snapshot(): Record<string, number> {}
  flushToFile(path: string): Promise<void> {}
}
```

约束：仅计数 key；写到 `.routedev/usage/`；fail-open。

- [ ] **Step 2: 接入工具、命令、Pack 加载点**

- [ ] **Step 3: `/usage` 导出命令**

- [ ] **Step 4: 测试（≥3 用例）**

1. 同名工具多次调用累加
2. flush 后文件可解析
3. 计数异常不抛到调用方

- [ ] **Step 5: 提交**

```powershell
git commit -m "feat(phase-80): 本地使用计数遥测基线"
```

---

## Task 3：去留看板

**文件：**
- 创建：`routedev/docs/SLIMDOWN_BOARD.md`

- [ ] **Step 1: 按层分区**

看板分四区：
- **Core 膨胀点**：默认装配模块中成本/复杂度异常项
- **Extended Pack 候选**：中等偏下，等待 Pack 机制落地
- **Standard Pack 冷处理队列**：已决定外置，等 Phase-82 迁移
- **Freeze 清单**：停止接线项

- [ ] **Step 2: 审查提示词挂钩**

更新 `报告/RouteDev-功能完整度审查提示词.md` 和 `报告/RouteDev-死代码审查提示词.md`，引用四层清单。

- [ ] **Step 3: 提交**

```powershell
git commit -m "docs(phase-80): 去留看板并挂钩审查提示词"
```

---

## 验收

- [ ] `CAPABILITY_LAYERS.md` 覆盖 ≥80% 生产模块且无 `unknown`
- [ ] usage-counter 测试全绿
- [ ] `/usage` 命令可导出
- [ ] 无默认行为破坏
- [ ] `SLIMDOWN_BOARD.md` 四区各有内容
- [ ] Phase-81 可直接依据清单开工

---

## 风险

- 遥测被误做成云上报：**禁止**，仅本地
- 清单与代码漂移：CODEMAP 同步更新
- 过早删除：本 Phase **明确禁止物理删除**
