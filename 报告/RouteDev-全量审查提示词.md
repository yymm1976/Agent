# RouteDev 全量审查提示词

> **使用方法**：将本提示词完整粘贴给目标模型（Claude / GPT / Gemini / Qwen / 豆包等），模型需具备代码库读取能力（如 Cursor / Trae / Claude Code 等 IDE Agent）。审查者应按章节顺序执行，每章输出独立报告，最后汇总。
>
> **项目路径**：`c:\Users\杨铭\Desktop\Agent\routedev`
>
> **项目背景**：RouteDev 是一个 Electron 34 + React 19 + TypeScript 的 AI 编程助手，按任务复杂度自动路由模型。项目已历经 75 个 Phase 的迭代，代码库较成熟，本次为全量综合审查（非单一维度的死代码审查）。
>
> **审查原则**：
> - **证据优先**：每条 finding 必须附文件路径 + 行号 + 代码片段，严禁推测
> - **分级准确**：Critical（阻塞合并）/ Important（应修复）/ Minor（建议优化）/ Info（仅记录）
> - **避免误报**：理解项目设计模式再判断，不把"可选功能 / 动态 import / fail-open 降级"判为问题
> - **可执行**：每条 finding 给出具体修复建议（代码片段或 PR 描述级别），不止说"建议优化"

---

## 一、角色与任务

你是 RouteDev 项目的全量审查专家。请对项目代码库进行**多维度综合审查**，覆盖以下 10 个维度：

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

每个维度独立成章，按 Critical / Important / Minor / Info 四级分类 findings，最后汇总成统一报告。

**严禁行为**：
- 严禁在不读取实际代码的情况下推测问题
- 严禁仅凭 `detect-dead-code.ts` 脚本输出判定死代码（该脚本有已知缺陷）
- 严禁把"默认关闭的可选功能"判为死代码或问题
- 严禁把"通过动态 import 接入的模块"判为死代码
- 严禁把 TypeScript 类型导出（interface / type）列为死代码
- 严禁把"fail-open 降级路径"判为"未处理错误"
- 严禁给出"建议优化"而无具体方案的 finding

---

## 二、项目架构与关键设计模式（审查前必读）

### 2.1 技术栈
- TypeScript 6.x + Electron 34 + React 19（strict 模式，ESM，`"type": "module"`）
- 构建工具：electron-vite + tsc
- 测试：vitest
- 桌面应用，无 CLI 入口（CLI 已在 Phase 72 退役）

### 2.2 生产入口链路（唯一入口）

```
desktop/main/index.ts          ← Electron 主进程入口
  └─ desktop/main/engine-bridge.ts   ← 核心桥接层，this.deps.<field> 访问所有依赖
       └─ src/runtime/app-init.ts    ← 核心装配工厂，createAppDependencies()
            ├─ 静态 import：核心模块
            ├─ 动态 import()：可选模块（变量路径 + fail-open）
            └─ 实例化后返回 AppDependencies 对象
                 ├─ src/agent/loop.ts          ← 聊天循环
                 ├─ src/runtime/goal-runner.ts ← /goal 命令执行
                 └─ src/tools/builtin/*        ← 工具注册
```

**渲染进程入口**：`desktop/renderer/src/main.tsx → App.tsx`

### 2.3 关键设计模式（必须理解，否则会大量误报）

1. **AppDependencies 装配模式**：`src/runtime/app-init.ts` 的 `createAppDependencies()` 是核心装配工厂，静态 import 核心模块，动态 import 可选模块（fail-open 降级）。**fail-open 不是"未处理错误"，是设计**。
2. **engine-bridge 桥接层**：`desktop/main/engine-bridge.ts` 通过 `this.deps.<field>` 访问所有依赖，不直接 import src/ 模块。
3. **工具注册机制**：`src/tools/builtin/*` 通过统一注册表接入，工具之间独立。
4. **prompt 模板三级优先级**：`src/prompts/manager.ts` 三级：项目覆盖 `{project}/.routedev/prompts/{id}.md` → 用户 `{AppData}/prompts/{id}.md` → 内置 `BUILTIN_TEMPLATES`（代码内）。
5. **Skill 系统**：`.routedev/skills/<name>/SKILL.md` 由 `src/plugins/filesystem-discovery.ts` 自动扫描加载。
6. **AgentRole 类型碎片化警告**：`AgentRole` 在 `src/agents/profiles/types.ts`（主定义）、`src/agent/context-packer.ts`、`src/agent/delegation-gate.ts`、`desktop/shared/ipc-types.ts` 有 4 处定义，**这是已知技术债**，不要重复报告。
7. **预存在的 engine-bridge.ts 类型错误**：`desktop/main/engine-bridge.ts(1471)` 和 `(1478)` 有 2 个 `AgentRole`/`AgentOutputFormat` 与 `AgentProfileRole`/`AgentProfileOutputFormat` 不兼容的 TS 错误，**这是已知问题**（Phase 75-A4 CONCERN-1 记录），不要重复报告。
8. **预存在的 SettingsPage.tsx 类型错误**：`desktop/renderer/src/pages/SettingsPage.tsx(429)` 和 `(463)` 有 2 个 `AppConfig` 类型双重定义的 TS 错误（Two different types with this name exist），**这是已知问题**，不要重复报告。
9. **调度器为预留功能**：`SettingsCommandsTab.tsx` 中的调度器 Card 已标注为"预留功能，当前不生效"并禁用控件，这是设计意图（调度器引擎未接入运行时），不要报告为"功能缺失"或"僵尸配置"。

### 2.4 审查范围

**包含**：
- `src/` — 主源码（agent / agents / prompts / router / runtime / tools / skills / config / plugins / observability 等）
- `desktop/main/` — Electron 主进程
- `desktop/renderer/src/` — React 渲染进程
- `desktop/shared/` — 主/渲染共享类型
- `desktop/preload/` — preload 脚本
- `scripts/` — 构建/校验脚本
- `tools/` — config-gen 等工具
- `tests/` + `test/` — 测试
- 配置文件（package.json / tsconfig.json / electron-builder.yml 等）

**排除**：
- `node_modules/` / `out/` / `build/` / `release/` / `coverage/`
- `.routedev/`（运行时数据，已被 gitignore）
- `design-demos/`（原型 HTML，非生产代码）

---

## 三、审查维度详解

### 维度 1：架构与耦合

**审查重点**：
- 模块边界是否清晰（高内聚低耦合）
- 是否存在循环依赖
- 是否有跨层直接访问（如渲染进程直接 import 主进程模块）
- AppDependencies 装配是否合理，是否有绕过装配工厂的直接 import
- AgentRole 类型碎片化（4 处定义）是否引入了实际 bug（而非只是风格问题）
- prompt 模板三级优先级是否有短路或覆盖异常
- Skill 系统加载机制是否有竞态条件
- SubAgent 调度 API（spawn-agent.ts）的 model 字段透传链路是否完整

**输出要求**：
- 依赖图关键路径（文字描述，不需要画图）
- 耦合热点 top 5（被 import 次数最多的模块 + 是否合理）
- 循环依赖检测结果（如有）

### 维度 2：类型安全

**审查重点**：
- `any` 类型使用（`as any` / `: any` / `@ts-ignore` / `@ts-expect-error`）
- 类型断言是否安全（`as` 断言是否有运行时校验）
- 联合类型是否被窄化前使用
- 可空字段是否被访问前判空
- Record<K, V> 的 K 是否覆盖所有实际 key（如 `Record<AgentRole, ...>` 是否覆盖所有 AgentRole 值）
- 函数返回类型是否显式标注（依赖类型推断的公共 API）
- Zod schema 与 TypeScript 类型是否同步（result-schemas.ts 是重点）

**输出要求**：
- `any` 使用统计 + top 10 位置（文件:行号 + 上下文）
- `@ts-ignore` / `@ts-expect-error` 全部位置 + 是否有注释说明原因
- 类型断言热点（`as` 断言密集区）

### 维度 3：错误处理与韧性

**审查重点**：
- try/catch 是否吞错（catch 后既不 throw 也不 log）
- Promise 是否有 .catch 或 await + try/catch
- fail-open 降级路径是否记录了降级原因（log warn/error）
- 外部调用（fs / network / child_process）是否有超时和重试
- 用户输入校验是否在边界层（而非深处）
- 错误信息是否含定位线索（文件名 / 函数名 / 上下文）
- 是否有"错误恢复后继续运行但状态不一致"的路径

**输出要求**：
- 吞错位置清单（catch 后无处理的）
- 未捕获 Promise rejection 风险点
- fail-open 降级路径清单（确认是否记录了降级 log）

### 维度 4：性能

**审查重点**：
- 渲染进程重渲染热点（React 组件缺少 memo / useMemo / useCallback）
- 主进程同步阻塞操作（fs.readFileSync / execSync 在热路径）
- 大对象深拷贝（structuredClone / JSON.parse(JSON.stringify) 在循环中）
- 未释放的资源（事件监听器 / 定时器 / 文件句柄 / 数据库连接）
- 内存泄漏风险（闭包捕获 / 全局 Map/Set 只增不减）
- 渲染进程 bundle 体积（大依赖是否懒加载）
- IPC 通信频率（是否有高频 IPC 调用可批量化）

**输出要求**：
- React 重渲染热点 top 5
- 同步阻塞操作清单
- 内存泄漏风险点
- bundle 体积分析（如能获取）

### 维度 5：安全

**审查重点**：
- Electron 安全：`contextIsolation` / `nodeIntegration` / `sandbox` 配置
- preload 脚本是否暴露了过宽的 API（`contextBridge.exposeInMainWorld` 的暴露面）
- IPC 消息校验（ipcMain.handle 是否校验参数）
- 用户输入到 shell 的注入风险（child_process.exec 的参数是否转义）
- 文件路径遍历风险（用户输入的路径是否 resolve + startsWith 校验）
- 敏感信息泄露（API key / token 是否打到 log / 错误信息）
- CSP（Content Security Policy）配置
- 是否有 `eval` / `new Function` 的动态代码执行

**输出要求**：
- 安全配置审计（Electron BrowserWindow webPreferences）
- 注入风险点清单
- 敏感信息泄露风险点
- 暴露面审计（preload API 清单）

### 维度 6：可维护性与代码质量

**审查重点**：
- 函数长度（>100 行的函数清单）
- 文件长度（>500 行的文件清单 + 是否应拆分）
- 圈复杂度（嵌套 >4 层的代码块）
- 重复代码（copy-paste 的代码块）
- 命名一致性（同一概念是否有多个名称）
- 魔法数字 / 魔法字符串（未提取为常量）
- 注释覆盖率（公共 API 是否有 JSDoc）
- TODO / FIXME / XXX 注释清单
- 技术债标注（`[TECH-DEBT]` tag 是否规范，Phase 75-A5 引入）

**输出要求**：
- 长 함수 top 10（>100 行）
- 长文件 top 10（>500 行）
- 重复代码块清单
- TODO / FIXME 清单（含文件:行号 + 内容）
- 魔法数字 / 字符串热点

### 维度 7：测试覆盖

**审查重点**：
- 测试文件与源码文件的比例
- 关键模块是否有测试（agent loop / router / spawn-agent / app-init / progress-ledger / handoff-contract）
- 测试是否覆盖错误路径（不只测 happy path）
- 测试是否隔离（不依赖外部资源 / 不互相依赖）
- 测试命名是否清晰（describe / it 描述是否表意）
- 是否有跳过的测试（`.skip` / `xit` / `xdescribe`）
- e2e 测试现状（CONTRIBUTING.md 要求 e2e 串行，是否有 e2e 测试）

**输出要求**：
- 测试覆盖率估算（关键模块覆盖情况）
- 关键模块测试缺口清单
- 跳过的测试清单
- 测试质量评估（是否测了错误路径）

### 维度 8：文档与注释

**审查重点**：
- README.md / AGENTS.md / CONTRIBUTING.md / CHANGELOG.md 完整性
- 代码注释覆盖率（公共 API 的 JSDoc 比例）
- 注释与代码是否一致（注释描述的行为是否与代码实际行为一致）
- 是否有过时注释（注释引用的 Phase 已被后续 Phase 替代）
- docs/ 目录文档与代码是否同步
- 是否有"孤儿文档"（文档描述的功能已被移除）

**输出要求**：
- 文档完整性审计（4 个根文档 + docs/ 目录）
- 注解覆盖率（公共 API JSDoc 比例）
- 过时注释清单
- 孤儿文档清单

### 维度 9：依赖管理

**审查重点**：
- 依赖版本是否过旧（major 版本落后）
- 是否有未使用的依赖（package.json 声明但代码未 import）
- 是否有重复依赖（功能重叠的多个包）
- 依赖安全性（是否有已知漏洞的版本，跑 `npm audit` 如能）
- 依赖许可证兼容性（GPL 与 AGPL-3.0 项目兼容性）
- devDependencies 与 dependencies 是否分清
- Phase 75-A6 引入的 husky / lint-staged / commitlint 是否正确配置

**输出要求**：
- 过旧依赖清单（major 落后）
- 未使用依赖清单
- 重复依赖清单
- 安全漏洞（如能跑 npm audit）

### 维度 10：死代码与冗余

**审查重点**：
- 未被生产路径调用的函数 / 模块
- 未被任何测试引用的测试辅助函数
- 已废弃的 Phase 代码（如 Phase 72 退役的 CLI 相关残余）
- 重复的类型定义（AgentRole 4 处定义是已知债，其他类型是否有类似情况）
- 未使用的 export（导出但无任何 import）
- 注释掉的代码块
- 空 try/catch 或空 if 分支

**输出要求**：
- 死代码清单（文件:行号 + 证据：为何判定为死代码）
- 重复类型定义清单
- 注释代码块清单
- **严禁**仅凭 detect-dead-code.ts 输出判定（该脚本有已知缺陷）

---

## 四、审查流程（建议执行顺序）

### 阶段 1：理解项目（必做，不可跳过）
1. Read `package.json` / `tsconfig.json` / `electron-builder.yml`
2. Read `AGENTS.md` / `CONTRIBUTING.md` / `CODEMAP.md`
3. Read `src/runtime/app-init.ts`（核心装配）
4. Read `desktop/main/index.ts` + `desktop/main/engine-bridge.ts`（入口链路）
5. Glob `src/**/*` + `desktop/**/*` 了解目录结构

### 阶段 2：分维度审查
按上述 10 个维度依次审查，每个维度：
1. 用 Grep / Glob 定位候选问题
2. Read 实际代码确认（不可跳过）
3. 记录 finding（文件:行号 + 代码片段 + 分级 + 修复建议）

### 阶段 3：交叉验证
1. 跨维度关联（如维度 2 的 `any` 与维度 3 的吞错是否同源）
2. 误报过滤（对照 2.3 关键设计模式，排除设计意图行为）
3. 优先级排序（Critical → Important → Minor → Info）

### 阶段 4：汇总报告
输出统一报告，含：
- 执行摘要（总 findings 数 + 各级别数量 + 整体评价）
- 10 个维度分章报告
- 优先修复清单（按 Critical → Important 排序，top 20）
- 附录：审查覆盖范围（哪些文件被读取 / 哪些被跳过）

---

## 五、输出格式要求

### 5.1 Finding 格式

每条 finding 必须含以下字段：

```markdown
### [F-001] 简短标题
- **级别**：Critical / Important / Minor / Info
- **维度**：维度 N - 维度名
- **位置**：`src/xxx/yyy.ts:123-145`
- **代码**：
  ```typescript
  // 实际代码片段
  ```
- **问题**：具体描述问题是什么，为什么是问题
- **修复建议**：具体方案（代码片段或 PR 描述级别）
- **证据**：为何确认这是问题（如"全仓库 grep 无其他调用点"）
```

### 5.2 分章报告格式

```markdown
## 维度 N：维度名

### 概述
本维度审查了 XX 个文件，发现 N 个 findings（Critical: X / Important: Y / Minor: Z / Info: W）。

### Findings
[F-001] ...
[F-002] ...
```

### 5.3 汇总报告格式

```markdown
# RouteDev 全量审查报告

## 执行摘要
- 审查日期：YYYY-MM-DD
- 审查范围：XX 文件
- 总 findings：N（Critical: X / Important: Y / Minor: Z / Info: W）
- 整体评价：[一段话总体评价]

## 优先修复清单（Top 20）
1. [F-001] ...
2. [F-002] ...
...

## 维度 1：架构与耦合
...

## 维度 2：类型安全
...

（依次到维度 10）

## 附录：审查覆盖范围
- 已读取文件清单：...
- 跳过文件清单：...（含原因）
```

---

## 六、审查者签名块

审查完成后，审查者需填写以下签名块：

```markdown
## 审查者签名
- 审查者模型：[模型名 + 版本]
- 审查工具：[IDE / CLI]
- 审查日期：YYYY-MM-DD
- 审查耗时：[小时数]
- 总 findings 数：N
- Critical 数量：X
- 建议处理方式：[立即修复 / 排期修复 / 评估后决定]
- 备注：[其他需要说明的事项]
```

---

## 七、特殊说明

### 7.1 已知技术债（不要重复报告）

1. **AgentRole 类型碎片化**：4 处定义（profiles/types.ts / context-packer.ts / delegation-gate.ts / ipc-types.ts），Phase 75-A4 CONCERN-1 已记录
2. **engine-bridge.ts 类型错误**：2 个 pre-existing TS 错误（AgentRole/AgentOutputFormat 与 AgentProfileRole/AgentProfileOutputFormat 不兼容，L1471/L1478），Phase 75-A4 已确认
3. **SettingsPage.tsx 类型错误**：2 个 pre-existing TS 错误（AppConfig 类型双重定义，L429/L463），已知问题
4. **`.routedev/skills/writing-plans/SKILL.md` 不入库**：`.routedev/` 被 gitignore，Phase 75-B6 CONCERN 已记录，建议迁移到 `src/skills/builtin/`
5. **commitlint.config.cjs**：Phase 75-A6 引入，因 `"type": "module"` 用 .cjs 后缀，待 npm install 后实测
6. **调度器预留功能**：`SettingsCommandsTab.tsx` 调度器 Card 已禁用并标注"预留功能，当前不生效"，调度器引擎未接入运行时
7. **classifier deterministic 类型断言**：`src/router/classifier.ts` L92 使用 `as unknown as ClassificationResult` 注入 `tier='deterministic'`（不在 ScenarioTier 枚举中），这是已知技术债（F-2.02 排期修复），正确修复需统一下游 10+ 处类型收窄，不要重复报告断言本身

### 7.2 审查边界

- 审查者**不应**修改任何代码，只输出报告
- 审查者**不应**运行 `npm install` 或 `npm run build`（避免副作用）
- 审查者**可以**运行只读命令（`npx tsc --noEmit` / `git log` / `git status`）
- 审查者**应**优先使用 Grep / Glob / Read 工具，避免 `cat` / `find` / `grep` shell 命令

### 7.3 误报预防

以下行为是**设计意图**，不应报告为问题：

1. **fail-open 降级**：`app-init.ts` 的动态 import 失败时降级是设计，不是"未处理错误"
2. **动态 import**：可选模块用 `await import()` 加载是设计，不是"未被静态引用的死代码"
3. **三级 prompt 优先级**：项目覆盖 > 用户 > 内置，是设计
4. **Skill 自动扫描**：`filesystem-discovery.ts` 扫描 `.routedev/skills/`，是设计
5. **SubAgent model 字段可选**：Phase 75-A3 过渡期，JSDoc 已标注"第二阶段计划强制必填"
6. **reviewer verdict 三态**：Phase 75-B3 引入的 `clean / issues-found / cannot-verify` 是设计
7. **progress-ledger append-only**：Phase 75-B2 的 JSONL append-only 是设计，不是"缺少 update/delete"
8. **调度器预留功能**：`SettingsCommandsTab.tsx` 调度器 Card 已禁用并标注，是设计意图，不是"功能缺失"
9. **Phase 77 新增能力**：trace 回放（`trace-replayer.ts`）、评分卡（`scorecard.ts`）、冷启动恢复（`goal-recovery.ts`）、会话状态卡（`session-status-aggregator.ts`）为 Phase 77 新增，通过 `/replay`、`/scorecard` 命令触发，是活代码
10. **StepRow memo 包装**：`GoalExecutionCard.tsx` 中 `StepRow` 用 `memo()` 包装是性能优化设计，不是"不必要的包装"

---

## 八、审查质量自检（审查者完成后自检）

审查者在提交报告前，必须自检以下项：

- [ ] 是否读取了 `app-init.ts` 理解装配模式？
- [ ] 是否读取了 `engine-bridge.ts` 理解桥接层？
- [ ] 是否理解了 fail-open 是设计而非缺陷？
- [ ] 是否理解了动态 import 不是死代码？
- [ ] 每个 finding 是否附了文件:行号 + 代码片段？
- [ ] 每个 finding 是否给了具体修复建议？
- [ ] 是否交叉验证了误报（对照 7.3 误报预防清单）？
- [ ] 是否避免了重复报告已知技术债（对照 7.1）？
- [ ] Critical findings 是否真的是 Critical（阻塞合并级别）？
- [ ] 报告是否结构化（按维度分章 + 汇总）？

如任一项未达标，审查者应补充工作后再提交报告。

---

**审查者**：请开始审查。先执行阶段 1（理解项目），再分维度审查，最后汇总。
