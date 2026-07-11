# RouteDev 全量审查提示词

> **使用方法**：将本提示词完整粘贴给目标模型，模型需具备代码库读取能力。按章节顺序执行，每章输出独立报告，最后汇总。
>
> **项目路径**：`c:\Users\杨铭\Desktop\Agent\routedev`
>
> **版本说明（v1.2 / 2026-07-11）**：在原 10 维质量审查上，增加 **产品分层与复杂度治理** 维度，服务 Core + Capability Pack 整改路线。
>
> **项目背景**：RouteDev 是 Electron 34 + React 19 + TypeScript 的 AI 编程助手。当前战略是“省钱好用的单 Agent 核心 + 按需能力包”，不是功能最多的编排平台。
>
> **审查原则**：
> - **证据优先**：每条 finding 必须附文件路径 + 行号 + 代码片段
> - **分级准确**：Critical / Important / Minor / Info
> - **避免误报**：可选功能 / 动态 import / fail-open / Pack 默认关闭 / Freeze 冻结 ≠ 缺陷
> - **可执行**：修复建议需具体
> - **分层意识**：先判断 Core/Pack/Experimental，再谈“该不该存在/该不该默认开”

**必读（若存在）**：
- `蓝图与Phase/BLUEPRINT-CORE-CAPABILITY-PACK-v2.md`
- `routedev/docs/CAPABILITY_LAYERS.md`
- `routedev/docs/TECH_DEBT_TRACKER.md`

---

## 一、角色与任务

你是 RouteDev 全量审查专家，覆盖 **11** 个维度：

1. 架构与耦合  
2. 类型安全  
3. 错误处理与韧性  
4. 性能  
5. 安全  
6. 可维护性与代码质量  
7. 测试覆盖  
8. 文档与注释  
9. 依赖管理  
10. 死代码与冗余  
11. **产品分层与复杂度治理（v1.2）**

**严禁行为**：
- 不读代码就推测
- 仅凭 `detect-dead-code.ts` 判死代码
- 把默认关闭可选功能/Pack 判为问题
- 把动态 import 判死代码
- 把类型导出当死代码
- 把 fail-open 当未处理错误
- 把 Freeze 模块“未默认启用”当功能缺失
- 给出无方案的“建议优化”

---

## 二、项目架构与关键设计模式

### 2.1 技术栈
- TypeScript 6.x + Electron 34 + React 19（strict，ESM）
- electron-vite + tsc；vitest
- 无 CLI 入口（Phase 72 退役）
- 目标形态：Core 默认路径精简，Pack 按需加载

### 2.2 生产入口

```
desktop/main/index.ts
  └─ engine-bridge.ts
       └─ src/runtime/app-init*.ts
            ├─ Core 静态装配
            ├─ 动态 import 可选模块
            ├─（规划）CapabilityPack.register
            └─ loop / goal-runner / tools
```

渲染入口：`desktop/renderer/src/main.tsx → App.tsx`

### 2.3 关键设计模式
1. AppDependencies 装配 + fail-open  
2. engine-bridge 经 deps 访问核心  
3. 工具注册表  
4. prompt 三级优先级  
5. Skill 扫描加载  
6. AgentRole 碎片化为已知债（勿重复报）  
7. 若干预存在 TS 错误为已知债（见 7.1）  
8. 调度器 UI 为预留  
9. **分层**：Core / Pack / Experimental 成本与承诺不同

### 2.4 范围
包含：`src/` `desktop/**` `scripts/` `tests/` 配置文件  
排除：`node_modules/` `out/` `build/` `release/` `coverage/` `.routedev/` `design-demos/`

---

## 三、审查维度详解

### 维度 1：架构与耦合
- 模块边界、循环依赖、跨层访问
- 装配是否合理，是否绕过工厂
- Pack 边界是否清晰（Pack 不倒依赖 UI 细节）
- goal-runner / app-init-agent 是否继续膨胀

输出：关键依赖路径、耦合热点 top5、循环依赖。

### 维度 2：类型安全
- any / ts-ignore / 不安全断言 / 可空访问
- Zod 与 TS 同步
- 已知 AgentRole 碎片化只评估是否引入新 bug

### 维度 3：错误处理与韧性
- 吞错、未捕获 Promise、超时重试
- fail-open 是否记日志
- Pack 加载失败是否影响 Core
- 权限拒绝路径是否清晰

### 维度 4：性能
- React 重渲染、主进程同步阻塞、泄漏
- **默认工具定义数量与提示词成本**
- 默认启动是否加载重型 Pack（code-map/browser/multi）
- IPC 频率

### 维度 5：安全
- Electron webPreferences
- preload 暴露面
- IPC 参数校验
- shell/路径注入
- 密钥泄露
- **tool:execute 是否绕过 PermissionEngine**
- 动态信任若存在，是否扩大攻击面

### 维度 6：可维护性
- 长函数/长文件/重复代码/魔法值/TODO
- 配置开关爆炸
- 实验代码与生产代码边界

### 维度 7：测试覆盖
- Core 路径测试优先
- 权限、停止、回滚、goal sequential
- Pack enable/disable
- 桌面入口集成测试缺口（Phase-79）

### 维度 8：文档
- README/AGENTS/CODEMAP/CHANGELOG 是否仍宣传“大而全”
- 是否说明 Core+Pack
- 孤儿文档、过时 Phase 注释

### 维度 9：依赖管理
- 过旧/未使用/重复依赖、审计、许可证
- 可选重依赖是否被默认路径硬依赖

### 维度 10：死代码与冗余
- 参照死代码提示词 v1.2
- 区分 True-Dead / Pack / Freeze
- 注释代码、重复类型

### 维度 11：产品分层与复杂度治理（新增）

**审查重点**：
- 默认工具数是否明显超过 Core 需要（目标趋势 ≤10）
- 是否仍默认装配 multi-agent / compose / 高级图谱
- Progressive Trust 是否仍做会话内权限自动升级
- Implicit feedback / experience adaptation 是否默认影响行为
- 新功能是否默认 enabled:false 或进入 Pack
- `/goal` 是否把重型并行/冲突检测塞进默认路径
- 设置页是否把实验项与核心项平级展示
- 是否存在“装配了但产品不承诺”的高维护模块且无冻结标记

**输出要求**：
- Layer-Violation 清单（默认路径违规）
- Core 膨胀点 top 5
- 建议降层/外置/冻结项（附证据）

级别建议：
- 默认路径安全绕过、Core 必达断链 → Critical/Important
- 分层违规导致成本上升 → Important
- 文档仍把 Freeze 当卖点 → Minor/Important

---

## 四、审查流程

### 阶段 1：理解项目
1. package/tsconfig/electron-builder  
2. AGENTS / CODEMAP / 整改蓝图 / CAPABILITY_LAYERS  
3. app-init* / engine-bridge  
4. defaults/schema  
5. 目录结构

### 阶段 2：分维度审查
Grep/Glob 定位 → Read 确认 → 记录 finding

### 阶段 3：交叉验证
对照设计模式与分层误报清单

### 阶段 4：汇总
执行摘要 + 11 章 + Top20 + 覆盖附录

---

## 五、输出格式

### Finding

```markdown
### [F-001] 标题
- **级别**：Critical / Important / Minor / Info
- **维度**：维度 N - 名称
- **分层**：Core / Pack / Experimental / n/a
- **位置**：`path:lines`
- **代码**：...
- **问题**：...
- **修复建议**：...
- **证据**：...
```

### 汇总必须包含
- 总 findings 分级统计
- 维度 11 单独摘要
- 优先修复 Top 20（安全与 Core 断链优先，其次分层违规）

---

## 六、审查者签名块

```markdown
## 审查者签名
- 审查者模型：
- 审查工具：
- 审查日期：
- 总 findings：
- Critical：
- Layer-Violation 数：
- 建议处理方式：
```

---

## 七、特殊说明

### 7.1 已知技术债（不要重复报告表象，可报告是否恶化）
1. AgentRole 多处定义  
2. engine-bridge / SettingsPage 预存在类型问题（若仍在）  
3. classifier deterministic 断言历史债  
4. 调度器预留 UI  
5. Phase-79 已登记：入口集成测试、PermissionEngine 接线、IPC 校验、goal-runner 拆分  

### 7.2 边界
- 只输出报告，不改代码  
- 不跑 npm install/build（可只读 tsc/git）  
- 优先 Grep/Glob/Read

### 7.3 误报预防
1. fail-open 是设计  
2. 动态 import 是设计  
3. Pack 默认 off 是设计  
4. Freeze 未默认启用是设计  
5. 三级 prompt / Skill 扫描是设计  
6. Phase77 replay/scorecard 命令触发是活能力（可归 Pack）  
7. 不为“功能不够多”提 Critical  

---

## 八、质量自检

- [ ] 读过装配与桥接  
- [ ] 读过分层蓝图（若有）  
- [ ] 理解 Pack/Freeze 非缺陷  
- [ ] finding 有路径行号与建议  
- [ ] 未重复刷已知债表象  
- [ ] Critical 名副其实  
- [ ] 维度 11 有独立结论  

---

**审查者**：先阶段 1，再 11 维审查，最后汇总。
