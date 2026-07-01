# Phase 57 — 花架子去除工程（二）：C 档收窄

> **版本目标：** v4.5.1
> **前置依赖：** Phase 56 已完成
> **后继依赖：** Phase 58（路由合并）依赖本 Phase 完成
> **核心约束：** 不删除功能代码，只做"降级 + 改名 + 默认关闭 + 入口收窄"；保留的能力必须仍有命令或设置页入口；用户旧配置通过 Zod safe-parse 兼容（旧字段不报错但忽略）

---

## 目标与判定标准

**目标：** 把四个"名字花、场景边缘、默认不该占主线"的模块收窄到可选能力，不再以核心功能自居。

**判定标准：**
1. `pnpm typecheck` + `pnpm test` 通过
2. 默认配置下，voice/vision/persona 三个模块不进入主流程装配
3. `/dream` 命令改名为 `/consolidate-memory`，帮助文案去掉"梦境"措辞
4. persona-engine 简化为 output-style 扩展，删 persona-templates.ts

---

## 收窄清单与处理方式

| # | 模块 | 行数 | 处理方式 | 理由 |
|---|------|------|----------|------|
| 1 | `voice-manager.ts` | 516 | 保留代码，默认 off 不变，移到 `src/optional/voice/`，设置页加"实验能力"分组 | 编程 CLI 非核心，但桌面应用未来可能用 |
| 2 | `vision.ts` | 171 | 保留代码与 chat-runner 依赖，但加 `vision.enabled` 配置开关，默认 `false`，启用时才装配 | 截图报错有价值，但默认不该占用所有会话 |
| 3 | `memory/dream-to-graph.ts` | 236 | 改名为 `memory/consolidation.ts`，`/dream` 命令改为 `/consolidate-memory`，文案去拟人化 | 功能有用（整理项目记忆到图谱），名字是花架子 |
| 4 | `persona-engine.ts` + `persona-templates.ts` | 412 | 简化 persona-engine 为 output-style 扩展（动态生成片段逻辑保留），删 persona-templates.ts（硬编码人格改为读 config.persona.systemPromptAppend） | "人格引擎"过度包装，实际就是动态 system prompt 片段 |

---

## 源码接线点速查

| 接线点 | 文件 | 关键位置 | 动作 |
|--------|------|----------|------|
| voice-manager 装配 | `src/cli/app-init.ts:1664` | 动态 import 块 | 改路径到 `../optional/voice/voice-manager.js`，保持 fail-open |
| vision 装配 | `src/cli/app-init.ts:52` | 静态 import | 加 `if (config.vision?.enabled)` 守卫，默认不装配 |
| vision 在 chat-runner | `src/cli/chat-runner.ts:13` | 静态 import | 改为可选注入，`visionAssistant` 可为 undefined，chat-runner 内加 null 守卫 |
| dream-to-graph 命令 | `src/cli/commands/dream.ts` | 整个文件 | 改名为 `consolidate-memory.ts`，命令名改 `/consolidate-memory` |
| dream-to-graph 模块 | `src/agent/memory/dream-to-graph.ts` | 整个文件 | 改名为 `consolidation.ts`，类名/函数名去 dream 措辞 |
| persona-engine 装配 | `src/cli/app-init.ts:1592` | 动态 import | 保留装配逻辑，但 import 路径不变，简化后的 engine 仍兼容 |
| persona-templates 引用 | `src/agent/persona-engine.ts:21` | import | 删除 import，改读 `config.persona.systemPromptAppend` |
| 配置 schema | `src/config/schema.ts` | vision/persona 段 | vision 加 enabled 字段；persona 加 systemPromptAppend 字段 |
| 配置默认值 | `src/config/defaults.ts:399-411` | persona/voice 段 | vision.enabled=false；persona.systemPromptAppend='' |

---

## Task 1：voice-manager 移到 optional 目录

**文件：**
- 移动：`src/agent/voice-manager.ts` → `src/optional/voice/voice-manager.ts`
- 修改：`src/cli/app-init.ts:1664` import 路径
- 修改：`src/config/defaults.ts` voice 段注释

- [ ] **Step 1: 创建 optional 目录并移动文件**

```powershell
mkdir src/optional/voice
Move-Item src/agent/voice-manager.ts src/optional/voice/voice-manager.ts
```

- [ ] **Step 2: 更新 app-init.ts 的 import 路径**

打开 `src/cli/app-init.ts`，定位 `:1664` 的动态 import，将 `'../agent/voice-manager.js'` 改为 `'../optional/voice/voice-manager.js'`。

- [ ] **Step 3: 在 defaults.ts 的 voice 段加注释**

打开 `src/config/defaults.ts`，定位 voice 段（`:399` 附近），加注释：
```ts
voice: {
  // Phase 57：移到 optional/，编程 CLI 非核心能力，默认 off
  // 桌面应用未来若启用语音，需在设置页显式开启
  inputProvider: 'off',
  outputProvider: 'off',
  language: 'zh-CN',
  autoPlay: false,
},
```

- [ ] **Step 4: 类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "refactor(phase-57): voice-manager 移到 optional/voice/

依据：编程 CLI 非核心能力，默认 off。保留代码供桌面应用未来启用。
改动：移动文件 + 更新 import 路径 + 加注释"
```

---

## Task 2：vision 加 enabled 开关，默认关闭

**文件：**
- 修改：`src/config/schema.ts` vision 段
- 修改：`src/config/defaults.ts` vision 段（新增）
- 修改：`src/cli/app-init.ts:52` 装配守卫
- 修改：`src/cli/chat-runner.ts:13` 可选注入
- 修改：`src/cli/service-context.ts` visionAssistant 改为 optional

- [ ] **Step 1: schema.ts 加 vision 配置**

打开 `src/config/schema.ts`，搜索 vision 相关 schema（若无则新增）。在 AppConfigSchema 中加：
```ts
vision: z.object({
  enabled: z.boolean().default(false),
}).optional(),
```

- [ ] **Step 2: defaults.ts 加 vision 默认值**

打开 `src/config/defaults.ts`，在合适位置加：
```ts
// Phase 57：vision 默认关闭，启用时才装配 VisionAssistant
vision: {
  enabled: false,
},
```

- [ ] **Step 3: app-init.ts 加装配守卫**

打开 `src/cli/app-init.ts`，定位 `:52` 的 VisionAssistant import 与装配。把装配逻辑包在 `if (config.vision?.enabled)` 内，不启用时不 new VisionAssistant。

- [ ] **Step 4: chat-runner.ts 改为可选注入**

打开 `src/cli/chat-runner.ts`，定位 `:13` 的 import。`visionAssistant` 参数类型改为 `VisionAssistant | undefined`。在所有使用 `visionAssistant` 的地方加 `?.` 可选链或 `if (visionAssistant)` 守卫。

- [ ] **Step 5: service-context.ts 字段改 optional**

打开 `src/cli/service-context.ts`，把 `visionAssistant` 字段类型改为 `VisionAssistant | undefined`，并加 `?` optional 标记。

- [ ] **Step 6: 类型检查**

运行：`pnpm typecheck`
预期：通过。若有报错，根据报错补 null 守卫。

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "refactor(phase-57): vision 加 enabled 开关默认关闭

依据：截图报错有价值但非核心，默认不该占用所有会话。
改动：schema/defaults 新增 vision.enabled=false；app-init 加守卫；chat-runner/service-context 改可选注入"
```

---

## Task 3：dream-to-graph 改名为 consolidation

**文件：**
- 改名：`src/agent/memory/dream-to-graph.ts` → `src/agent/memory/consolidation.ts`
- 改名：`src/cli/commands/dream.ts` → `src/cli/commands/consolidate-memory.ts`
- 修改：`src/cli/commands/index.ts` 命令注册
- 修改：模块内类名/函数名/注释去 dream 措辞

- [ ] **Step 1: 移动文件**

```powershell
Move-Item src/agent/memory/dream-to-graph.ts src/agent/memory/consolidation.ts
Move-Item src/cli/commands/dream.ts src/cli/commands/consolidate-memory.ts
```

- [ ] **Step 2: 更新 consolidation.ts 内部命名**

打开 `src/agent/memory/consolidation.ts`，把 `DreamResult` 改为 `ConsolidationResult`，`ingestToGraph` 改为 `consolidateToGraph`，函数签名不变，所有注释去掉"梦境/dream"措辞，改为"记忆整理/consolidation"。

- [ ] **Step 3: 更新 consolidate-memory.ts 命令**

打开 `src/cli/commands/consolidate-memory.ts`，命令名从 `dream` 改为 `consolidate-memory`，帮助文案改为"整理项目记忆到知识图谱"，去掉拟人化措辞。import 路径改为 `'../../agent/memory/consolidation.js'`。

- [ ] **Step 4: 更新 commands/index.ts 注册**

打开 `src/cli/commands/index.ts`，搜索 `dream`，把 import 路径和命令注册改为 `consolidate-memory`。

- [ ] **Step 4.5: 注册 dream 作为 deprecated alias**

在 consolidate-memory.ts 的命令定义中，额外注册 `dream` 作为 deprecated alias：
```ts
// 保留 dream 作为 deprecated alias，Phase 60 删除
export const dreamAlias = {
  name: 'dream',
  description: '[已废弃] 请使用 /consolidate-memory',
  handler: async (args, ctx) => {
    ctx.logger?.warn('[Deprecated] /dream 已改名，请使用 /consolidate-memory');
    return consolidateMemoryCommand.handler(args, ctx);
  },
};
```
在 index.ts 同时注册 dreamAlias，确保用户旧习惯不会报错。

- [ ] **Step 5: 全局扫描残留 dream 引用**

```powershell
rg "dream-to-graph|commands/dream" src/
```
预期：无匹配。若有匹配，更新 import 路径。

- [ ] **Step 6: 类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "refactor(phase-57): dream-to-graph 改名 consolidation

依据：功能有用（整理项目记忆到图谱），但'梦境'拟人化命名是花架子。
改动：文件改名 + 类名/函数名/命令名/注释去 dream 措辞；/dream 改为 /consolidate-memory"
```

---

## Task 4：persona-engine 简化，删 persona-templates.ts

**文件：**
- 修改：`src/agent/persona-engine.ts`
- 删除：`src/agent/persona-templates.ts`
- 修改：`src/config/schema.ts` persona 段
- 修改：`src/config/defaults.ts` persona 段

- [ ] **Step 1: schema.ts 加 persona.systemPromptAppend 字段**

打开 `src/config/schema.ts`，搜索 persona schema，加：
```ts
systemPromptAppend: z.string().default(''),
```

- [ ] **Step 2: defaults.ts 加默认值**

打开 `src/config/defaults.ts`，定位 persona 段（`:395` 附近），加：
```ts
persona: {
  enabled: true,
  intensity: 'medium',
  currentId: 'collaborator',
  // Phase 57：替代硬编码 persona-templates，用户可自定义 system prompt 片段
  systemPromptAppend: '',
},
```

- [ ] **Step 3: 简化 persona-engine.ts**

先扫描所有硬编码引用点：
运行：`rg "COLLABORATOR_PERSONA|persona-templates" src/agent/persona-engine.ts -n`
列出所有匹配行号。

然后：
1. 删除 `:21` 的 `import { COLLABORATOR_PERSONA } from './persona-templates.js'`
2. 所有使用 `COLLABORATOR_PERSONA` 的地方改为读 `config.persona.systemPromptAppend`
3. 保留动态片段生成逻辑（根据用户信号调整 prompt 的函数，如 detectUserSignal / buildDynamicFragment 等，具体函数名以扫描结果为准）
4. 删除其他 persona-templates 中的硬编码常量引用（如其他 PERSONA 变量）

替换示例：
```ts
// 旧：const personaPrompt = COLLABORATOR_PERSONA.systemPrompt;
// 新：
const personaPrompt = config.persona.systemPromptAppend || '';
```

- [ ] **Step 4: 删除 persona-templates.ts**

```powershell
Remove-Item src/agent/persona-templates.ts
```

- [ ] **Step 4.5: 全局残留扫描**

运行：`rg "persona-templates|COLLABORATOR_PERSONA" src/`
预期：无匹配。若有匹配，定位并清理。

- [ ] **Step 5: 类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "refactor(phase-57): persona-engine 简化，删 persona-templates

依据：'人格引擎'过度包装，实际是动态 system prompt 片段。硬编码模板改为 config 驱动。
改动：删 persona-templates.ts（97 行）；persona-engine 改读 config.persona.systemPromptAppend；schema/defaults 加字段"
```

---

## Task 5：全量验证与残留扫描

- [ ] **Step 1: 残留扫描**

```powershell
rg "persona-templates|dream-to-graph|commands/dream" src/
```
预期：无匹配。

- [ ] **Step 2: 全量类型检查**

运行：`pnpm typecheck`
预期：通过。

- [ ] **Step 3: 全量测试**

运行：`pnpm test`
预期：全绿。若有测试因改名失败，更新测试 import 路径。

- [ ] **Step 4: 推送**

```powershell
git push origin main
```

---

## 边界条件

**vision 默认关闭的向后兼容：** 用户旧 config 无 vision 字段，Zod safe-parse 会填默认 `false`，不会报错。但若有用户依赖默认启用的 vision，需在 CHANGELOG 标注"vision 改为默认关闭，需显式 `vision.enabled: true` 启用"。

**dream 命令改名：** 用户若用 `/dream` 习惯，改名后会报"未知命令"。在 `consolidate-memory.ts` 中加 alias：命令注册时同时注册 `dream` 作为 deprecated alias，输出警告"已改名，请使用 /consolidate-memory"，Phase 60 删除 alias。

**persona-engine 简化风险：** 若 `COLLABORATOR_PERSONA` 包含关键 prompt 逻辑（不只是几句话），简化后可能导致 AI 回答风格变化。Step 3 需仔细检查硬编码模板内容，若有非文本逻辑（如条件分支），保留逻辑只改数据源。

---

## 验收清单

- [ ] `pnpm typecheck` + `pnpm test` 通过
- [ ] voice-manager 在 `src/optional/voice/` 下
- [ ] vision 默认关闭，需显式启用
- [ ] `/dream` 改名为 `/consolidate-memory`（保留 dream 作 deprecated alias）
- [ ] persona-templates.ts 已删除
- [ ] 残留扫描无匹配
- [ ] 已推送到 origin/main
- [ ] CHANGELOG.md 标注 vision 默认关闭与命令改名
