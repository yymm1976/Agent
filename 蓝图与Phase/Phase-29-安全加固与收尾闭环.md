# Phase 29 — 安全加固与收尾闭环

> **Phase 类型：** 安全加固 + 收尾（Security Hardening + Final Wrap-up）
> **前置依赖：** Phase 28 完成（v2.0.0，1242 测试 / 107 文件）
> **目标版本：** v2.1.0
> **核心目标：** 回应代码审查报告发现的安全缺口，修复 Phase 26/27/28 遗漏的问题，将安全性从 5/10 提升到 7/10，正式关闭项目

---

## 背景：三份报告的交叉审视

本 Phase 的诞生源于三份报告之间的矛盾。

**报告一：代码审查报告**（审查视角：金融/医疗/航天级零容忍标准，审查范围：src/ 全部 80+ 源文件）

这份报告给出了 19/30 的总分（可读性 7、可维护性 7、安全性 5），发现了 8 个架构问题、12 个安全漏洞、15 个边界缺陷、8 个性能问题。安全性 5/10 是拉低总分的主因。

**报告二：Phase 26 执行报告**（技术债务清零，v1.3.0）

Phase 26 修复了 7 个审查问题（路径遍历 S4、凭据脱敏 S7、ServiceContext as any A8、/permissions 运行时修复、同步 I/O 异步化 ×3、提示词迁移 A7）。但审查报告中 59 个问题只覆盖了 11 个——不到 20%。

**报告三：Phase 28 执行报告**（质量验收与发布准备，v2.0.0）

Phase 28 宣称"安全审计 9/9 PASS、蓝图合规率 100%"。但代码审查报告中 12 个安全漏洞的绝大多数（S1/S2/S3/S5/S6/S8/S9/S10/S11/S12）从未出现在 Phase 26/27/28 的修复范围内。

**矛盾所在：** Phase 28 的安全审计是自己审计自己——审查的是 Phase 26 修复后的状态，而非用外部零容忍标准审视。代码审查报告发现的高危漏洞（命令解析绕过 S1/S2/S3、签名验证降级 S5/S6、PKCS#7 padding oracle S8）在 Phase 28 的安全审计中被标记为 PASS，因为审计清单的粒度不够细（例如"路径遍历"PASS 了，但"命令注入绕过"不在清单中）。

**本 Phase 的定位：** 这是项目的收尾 Phase——不引入新功能，只把审查报告发现的安全缺口和关键缺陷补上，让 v2.1.0 在外部零容忍标准下达到可交付水平。

---

## 审查报告纠错（架构师裁定）

在逐项核对审查报告与实际代码后，发现报告中 2 处描述与实际代码不符，特此纠正：

| # | 审查报告描述 | 实际代码 | 裁定 |
|---|-------------|---------|------|
| B8/P7 | Slack DEDUP 使用 `Array.shift()`，O(n) 性能问题 | 实际使用 `Set<string>` + `.clear()`（`slack.ts:197-207`），不存在 `Array.shift()` | **审查错误**——此问题不存在，Set.clear() 是 O(1) |
| B13 | orchestrator 检测到环时"抛错" | 实际行为是**静默追加**未访问节点到排序末尾（`orchestrator.ts:365-370`），无错误、无警告 | **审查错误**——但实际问题更严重：静默降级比抛错更危险，因为调用方完全不知道依赖图有环 |

---

## 接口对齐观察表

以下签名已通过代码级验证（v2.0.0 实际代码）：

| 接口 / 类 | 当前签名 | 文件位置 | 本 Phase 修复方式 |
|---|---|---|---|
| `PermissionEngine` deny 规则 | `/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/(\s\|$)/.test(String(a.command ?? ''))` | `permission-engine.ts:165` | Task 3 改为 tokenize 解析 |
| `SecurityChecker.checkCommand()` | `checkCommand(command, _context): SecurityCheckResult`，内部用 `normalized.includes(allowed)` / `normalized.includes(black)` | `security.ts:78-105` | Task 3 改为首 token 解析 |
| `ChannelAdapter.verifySignature()` | `verifySignature(body, signature, timestamp): boolean`——wechat-work 在 `token` 缺失时返回 `true`（line 84），slack 在 `signingSecret` 缺失时返回 `true`（line 147） | `wechat-work.ts:79` / `slack.ts:142` | Task 1 生产模式拒绝降级 |
| `ChannelManager.createAdapter()` | `switch (entry.type)` 仅含 `wechat-work` 和 `telegram`，缺少 `slack` | `channels/manager.ts:49-68` | Task 2 补充 slack 分支 |
| `config/loader.ts` `replaceEnvVars()` | 环境变量未设置时返回原始 `${VAR}` 占位符（line 23） | `config/loader.ts:16-27` | Task 1 启动时 fail-fast |
| `shell-exec.ts` spawn | `spawn('cmd.exe', ['/c', command])`，`env: { ...process.env, ...context.environment }` | `shell-exec.ts:101-107` | Task 3 环境白名单 |
| `ModelRouter.isModelAvailable()` | `private isModelAvailable(model): boolean`，恒返回 `true` | `router.ts:351-355` | Task 4 实现真实检查 |
| `ReActAgentLoop` isError 判断 | `toolResult.includes('不可用') \|\| toolResult.includes('不存在') \|\| toolResult.includes('错误')` | `loop.ts:265` | Task 5 改结构化判断 |
| `TaskClassifier` 默认值 | LLM 失败时返回 `{ tier: 'simple', confidence: 0.5 }` | `classifier.ts:88-93` | Task 4 改为 `complex`（保守策略） |
| `CheckpointManager.rollback()` | `await this.git.reset(['--hard', checkpoint.gitCommitHash])`，无工作区检查 | `harness/checkpoint-manager.ts:189-224` | Task 4 添加前置检查 |
| `VisionAssistant.loadImage()` | `normalizedPath.startsWith(normalizedRoot + path.sep)` | `vision.ts:110-121` | Task 5 改用 `path.relative` |
| `OpenAIClient` / `AnthropicClient` | `config.apiKey \|\| 'placeholder'` | `openai.ts:43-48` / `anthropic.ts:44-49` | Task 1 构造时 fail-fast |
| `PermissionEngine.getRules()` | `getRules(): PermissionRule[]`——审查报告引用的 `listRules()` 实际不存在 | `permission-engine.ts:66` | 审查报告名称有误，Phase 24 Task 4 的 `listRules()` 应为 `getRules()` |
| `Orchestrator.topologicalSort()` | 检测到环时静默追加剩余节点，无错误无警告 | `multi/orchestrator.ts:336-373` | Task 4 添加日志警告 |

---

## Task 1：渠道适配器安全加固

**目标**：修复渠道适配器中 4 个安全漏洞——签名验证降级、环境变量占位符、API Key 占位符、PKCS#7 padding。

### 比喻

想象一栋大楼的门卫系统：正常情况下门卫会检查你的门禁卡（签名验证），但如果大楼忘了给门卫配门禁读卡器（token 未配置），现在的做法是"没读卡器就放所有人进去"——这显然不对。正确做法是：没有读卡器，大楼就不应该开门迎客。

### 1.1 签名验证生产模式拒绝降级（S5 + S6）

**当前行为：** `wechat-work.ts:84` 和 `slack.ts:147` 在 token/signingSecret 未配置时返回 `true`，签名验证静默跳过。

**修复：**

```typescript
// wechat-work.ts verifySignature() 和 slack.ts verifySignature() 统一改造
verifySignature(body: string, signature: string, timestamp: string): boolean {
  const secret = this.config.options.token; // 或 signingSecret
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('签名密钥未配置，生产模式拒绝处理请求');
      return false;  // 生产环境：拒绝
    }
    logger.warn('签名密钥未配置，开发模式放行（不安全）');
    return true;  // 开发环境：降级放行（保留开发便利）
  }
  // ... 正常验证逻辑
}
```

### 1.2 环境变量占位符 fail-fast（S9）

**当前行为：** `config/loader.ts:23` 在环境变量未设置时保留 `${VAR}` 占位符。Zod schema 验证通过（非空字符串），运行时 LLM 客户端用字面量 `${OPENAI_API_KEY}` 调用 API，返回 401。

**修复：**

```typescript
function replaceEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new ConfigValidationError(
        varName,
        `环境变量 ${varName} 未设置。请在 .env 文件或系统环境变量中配置。`
      );
    }
    return envValue;
  });
}
```

使用 Phase 26 Task 7 创建的 `ConfigValidationError` 类。`console.warn` 也一并替换为 `logger.warn`（审查报告指出 line 20 的 `[RISK]` 注释）。

### 1.3 API Key 占位符 fail-fast（S11）

**当前行为：** `openai.ts:43-48` 和 `anthropic.ts:44-49` 在 `apiKey` 为空时使用 `'placeholder'`，延迟到 API 调用时才 401。

**修复：**

```typescript
// openai.ts 和 anthropic.ts 统一改造
if (!config.apiKey) {
  this.client = null;  // 标记为不可用
  this._isReady = false;
  logger.warn(`${providerId} API Key 未配置，客户端不可用`);
} else {
  this.client = new OpenAI({ apiKey: config.apiKey, ... });
  this._isReady = true;
}
```

`isReady()` 方法已存在（返回 `_isReady`），调用方在调用前检查 `isReady()` 即可。不再构造带 `'placeholder'` 的假客户端。

### 1.4 PKCS#7 padding 严格验证（S8）

**当前行为：** `wechat-work.ts:114-117` 的 PKCS#7 验证仅检查 `padLen >= 1 && padLen <= 32`，未验证最后 `padLen` 个字节是否都等于 `padLen`。且上界 32 对 AES 不正确（AES 块大小为 16 字节，padding 上界应为 16）。

**修复：**

```typescript
const padLen = decrypted.charCodeAt(decrypted.length - 1);
if (padLen < 1 || padLen > 16) {
  throw new Error('Invalid PKCS#7 padding: out of range');
}
// 严格验证：最后 padLen 个字节必须全部等于 padLen
for (let i = 0; i < padLen; i++) {
  if (decrypted.charCodeAt(decrypted.length - 1 - i) !== padLen) {
    throw new Error('Invalid PKCS#7 padding: inconsistent bytes');
  }
}
decrypted = decrypted.slice(0, decrypted.length - padLen);
```

### 1.5 wechat-work parseInt NaN 防护

**当前行为：** `wechat-work.ts:139` 和 `wechat-work.ts:227` 的 `parseInt` 未检查 NaN。

**修复：**

```typescript
// line 139
const rawCreateTime = parseInt(extract('CreateTime'), 10);
const createTime = isNaN(rawCreateTime) ? Math.floor(Date.now() / 1000) : rawCreateTime;

// line 227
const rawAgentId = parseInt(agentId, 10);
const agentIdNum = isNaN(rawAgentId) ? 0 : rawAgentId;
```

### 验收

- 生产模式下 token 未配置的 webhook 请求被拒绝（返回 false）
- 环境变量未设置时启动失败并给出明确错误
- API Key 为空时 `isReady()` 返回 false，不构造假客户端
- PKCS#7 padding oracle 攻击被阻止
- parseInt 返回 NaN 时使用安全默认值
- 新增 ≥ 6 个测试

---

## Task 2：渠道管理器架构修复

**目标**：修复 ChannelManager 的两个架构问题——Slack 适配器未注册（A1）和末尾 import（A2）。

### 2.1 Slack 适配器注册（A1）

**当前行为：** `channels/manager.ts:49-68` 的 `createAdapter` switch 仅处理 `wechat-work` 和 `telegram`。`SlackAdapter` 已完整实现（385 行），但配置中启用 `type: 'slack'` 会抛出 `Unsupported channel type: slack`。

**修复：**

```typescript
import { SlackAdapter } from './adapters/slack.js';
import type { SlackConfig } from './adapters/slack.js';

private createAdapter(entry: ChannelEntryConfig, router: MessageRouter): ChannelAdapter {
  switch (entry.type) {
    case 'wechat-work':
      return new WeChatWorkAdapter({ ... });
    case 'telegram':
      return new TelegramAdapter({ ... });
    case 'slack':  // 新增
      return new SlackAdapter({
        id: entry.id,
        type: 'slack',
        enabled: entry.enabled,
        options: entry.options as SlackConfig['options'],
      });
    default:
      throw new Error(`Unsupported channel type: ${entry.type}`);
  }
}
```

### 2.2 末尾 import 移至顶部（A2）

**当前行为：** `channels/manager.ts:130` 有一行 `import type { WeChatWorkConfig }` 放在类定义之后。

**修复：** 将此 import 移至文件顶部，与其他 import 合并。

### 验收

- 配置 `type: 'slack'` 的渠道可以正常启动
- 文件所有 import 在顶部
- 新增 ≥ 2 个测试（slack 适配器创建、unknown type 报错）

---

## Task 3：命令解析统一与加固（核心安全任务）

**目标**：将命令安全检查从"正则/子串匹配"升级为"tokenize 解析"，一次性修复 S1、S2、S3、shell-exec env 注入四个关联漏洞。

### 比喻

现在的命令检查像是"看照片认人"——拿到一张命令的照片（字符串），看看里面有没有"坏人的特征"（正则匹配 `rm -rf /`、子串匹配 `includes('rm')`）。问题在于：戴个帽子（引号包裹）、换个角度（大写、变量替换），就认不出来了。

改造后的命令检查像是"安检门"——先把你身上的东西一件件拆出来（tokenize：把 `rm -rf /` 拆成 `["rm", "-rf", "/"]`），然后逐一检查：命令名是不是黑名单？参数有没有危险路径？这样不管你怎么伪装，拆出来的零件都是一样的。

### 3.1 引入命令 tokenize 工具

新建 `src/tools/command-parser.ts`：

```typescript
interface ParsedCommand {
  /** 命令名（首 token），如 "rm"、"git"、"python" */
  command: string;
  /** 参数列表（不含命令名） */
  args: string[];
  /** 是否包含管道 (|) */
  hasPipe: boolean;
  /** 是否包含命令替换 ($() 或 ``) */
  hasSubstitution: boolean;
  /** 是否包含重定向 (>, >>, <) */
  hasRedirect: boolean;
  /** 原始命令字符串 */
  raw: string;
}

/**
 * 将 shell 命令字符串解析为结构化表示。
 * 注意：这不是一个完整的 shell parser，而是提取安全决策所需的关键信息。
 */
function parseCommand(command: string): ParsedCommand;
```

解析策略：
1. 用 `command.trim()` 去除首尾空格
2. 按空白字符拆分得到 tokens（`command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)`）
3. 首 token 去除引号后作为 `command`，其余作为 `args`
4. 检测特殊字符：`|`（管道）、`$()`/`` ` ``（命令替换）、`>`/`>>`/`<`（重定向）

### 3.2 SecurityChecker.checkCommand() 改造（S2）

**当前行为：** `security.ts:82-102` 用 `normalized.includes(allowed)` / `normalized.includes(black)` 做子串匹配。

**修复：**

```typescript
checkCommand(command: string, _context: ToolExecutionContext): SecurityCheckResult {
  const parsed = parseCommand(command);

  // 白名单检查：匹配命令名（首 token），不再子串匹配
  if (this.commandWhitelist.length > 0) {
    const allowed = this.commandWhitelist.some(wl => parsed.command === wl);
    if (!allowed) {
      return { allowed: false, reason: `命令 "${parsed.command}" 不在白名单中`, requiresConfirmation: false };
    }
  }

  // 黑名单检查：匹配命令名（首 token），不再子串匹配
  const blocked = this.commandBlacklist.some(bl => parsed.command === bl);
  if (blocked) {
    return { allowed: false, reason: `命令 "${parsed.command}" 在黑名单中`, requiresConfirmation: false };
  }

  // 危险模式标记（不阻断，但标记为需确认）
  if (parsed.hasSubstitution || parsed.hasPipe) {
    return { allowed: true, requiresConfirmation: true, reason: '命令含管道或命令替换，需确认' };
  }

  return { allowed: true, requiresConfirmation: false };
}
```

### 3.3 PermissionEngine deny 规则改造（S1）

**当前行为：** `permission-engine.ts:165` 用正则 `/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/(\s|$)/` 匹配 `rm -rf /`。

**修复：** 将 deny 规则的 `argsPredicate` 改为基于 tokenize 结果：

```typescript
// deny-rm-rf-root 规则改造
{
  id: 'deny-rm-rf-root',
  layer: 'deny',
  toolPattern: 'shell-exec',
  argsPredicate: (args) => {
    const command = String(args.command ?? '');
    const parsed = parseCommand(command);
    // 命令名是 rm（不区分大小写），参数含 -f 类标志，且目标是根目录
    if (parsed.command.toLowerCase() !== 'rm') return false;
    const hasForceFlag = parsed.args.some(a => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
    const targetsRoot = parsed.args.some(a => a === '/' || a === '"/"' || a === "'/'");
    return hasForceFlag && targetsRoot;
  },
  description: '阻止 rm -rf / 及其变体',
}
```

同时新增 deny 规则覆盖审查报告列出的绕过场景：

```typescript
// 新增：阻止 find -delete
{
  id: 'deny-find-delete',
  layer: 'deny',
  toolPattern: 'shell-exec',
  argsPredicate: (args) => {
    const parsed = parseCommand(String(args.command ?? ''));
    return parsed.command === 'find' && parsed.args.includes('-delete');
  },
  description: '阻止 find ... -delete',
}

// 新增：阻止 dd 写入设备
{
  id: 'deny-dd-device',
  layer: 'deny',
  toolPattern: 'shell-exec',
  argsPredicate: (args) => {
    const parsed = parseCommand(String(args.command ?? ''));
    return parsed.command === 'dd' && parsed.args.some(a => /^of=\/dev\//.test(a));
  },
  description: '阻止 dd of=/dev/...',
}
```

### 3.4 shell-exec 环境变量白名单（env 注入）

**当前行为：** `shell-exec.ts:107` 的 `env: { ...process.env, ...context.environment }` 允许覆盖任意环境变量。

**修复：**

```typescript
// shell-exec.ts — 在 spawn 前过滤
const ALLOWED_ENV_KEYS = new Set([
  'NODE_ENV', 'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL',
  'TERM', 'SHELL', 'EDITOR', 'PAGER',
  // 工具链常见变量
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]);

const filteredEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(context.environment ?? {})) {
  if (ALLOWED_ENV_KEYS.has(key)) {
    filteredEnv[key] = String(value);
  } else {
    logger.warn(`环境变量 ${key} 不在白名单中，已忽略`);
  }
}

const child = spawn(shell, shellArgs, {
  cwd,
  env: { ...process.env, ...filteredEnv },
  // ...
});
```

### Executor 注意事项

1. `parseCommand()` 不需要是完美的 shell parser——只需提取命令名和参数，识别危险模式
2. `SecurityChecker.checkCommand()` 的调用方不变（仍由 `ToolExecutor` 和中间件调用）
3. `PermissionEngine` 的 deny 规则从正则改为 `argsPredicate` 函数——需确认 `argsPredicate` 已在 `PermissionRule` 接口中（`permission-engine.ts:21-32` 已有此字段）
4. 环境变量白名单 `ALLOWED_ENV_KEYS` 可通过配置扩展（不硬编码）
5. 新增的 deny 规则（find-delete、dd-device）注册到 `DEFAULT_DENY_RULES`

### 验收

- `rm -rf /` 被阻止（原有）
- `rm -rf "/"` 被阻止（引号绕过修复）
- `RM -rf /` 被阻止（大小写绕过修复）
- `find / -delete` 被阻止（新增规则）
- `dd of=/dev/sda` 被阻止（新增规则）
- `python program.py` 不被误拦（子串匹配修复）
- `ls; rm -rf /` 不被白名单放行（子串匹配修复）
- 环境变量覆盖被白名单限制
- 新增 ≥ 8 个测试

---

## Task 4：运行时健壮性修复

**目标**：修复 4 个影响运行时行为的 bug——模型可用性检查、分类器回退策略、检查点回滚安全、编排器环检测。

### 4.1 isModelAvailable 实现真实检查（B3）

**当前行为：** `router.ts:351-355` 恒返回 `true`。

**修复：**

```typescript
private isModelAvailable(model: ModelDefinition): boolean {
  // 检查 1：对应的 LLMClient 是否存在且 ready
  const client = this.clientManager.getClient(model.providerId);
  if (!client || !client.isReady()) return false;

  // 检查 2：最近 5 分钟内该模型的调用失败率是否 > 80%
  const recentStats = this.failureTracker.getRecent(model.id, 5 * 60 * 1000);
  if (recentStats.total > 3 && recentStats.failures / recentStats.total > 0.8) {
    logger.warn(`模型 ${model.id} 近期失败率过高 (${recentStats.failures}/${recentStats.total})，标记为不可用`);
    return false;
  }

  return true;
}
```

`failureTracker` 是一个轻量级内存计数器（新建），在每次 LLM 调用成功/失败时更新。无需持久化——重启后重新统计。

如果 `failureTracker` 的实现成本过高（毕竟这是收尾阶段），可以用更简单的版本：只检查 `client.isReady()`，不做失败率统计。

### 4.2 分类器回退改为 complex（B4）

**当前行为：** `classifier.ts:88-93` LLM 分类失败时返回 `tier: 'simple', confidence: 0.5`。

**修复：** 将回退策略改为 `complex`（保守策略）：

```typescript
// 默认返回 complex（保守策略：不确定时用强模型兜底）
return {
  tier: 'complex',
  confidence: 0.3,  // 低置信度标记，让路由日志可追溯
  reasoning: 'Fallback tier (LLM classifier unavailable, conservative strategy)',
  source: 'rule',
};
```

比喻：分类器的工作是"判断这个任务有多难"。如果分类器自己出了问题（LLM 挂了），我们宁可高估任务难度（用强模型），也不低估（用弱模型导致输出质量差）。就像考试时如果看不清题目，宁可多写一点也不要少写。

### 4.3 CheckpointManager rollback 前置检查（B10）

**当前行为：** `checkpoint-manager.ts:189-224` 直接执行 `git reset --hard`，不检查工作区是否干净。

**修复：** 在 `rollback()` 开头添加工作区检查：

```typescript
async rollback(checkpointId: string): Promise<boolean> {
  if (!this.isRepo) return false;

  // 前置检查：工作区是否干净
  const status = await this.git.status();
  const hasUncommitted = status.modified.length > 0
    || status.not_added.length > 0
    || status.deleted.length > 0;

  if (hasUncommitted) {
    logger.error('回滚中止：工作区有未提交的更改。请先 stash 或 commit 后再回滚。');
    return false;  // 不执行，让调用方通知用户
  }

  // ... 原有的 rollback 逻辑
}
```

### 4.4 Orchestrator 环检测添加警告（B13 纠正 + 修复）

**当前行为：** `orchestrator.ts:365-370` 检测到环时静默追加剩余节点，无错误无警告。审查报告称"抛错"是不准确的——实际行为更危险，因为调用方完全不知道依赖图有环。

**修复：**

```typescript
// 处理循环依赖
if (order.length < dependencies.length) {
  const cycleSteps = dependencies
    .filter(dep => !order.includes(dep.stepId))
    .map(dep => dep.stepId);

  logger.warn(`依赖图存在循环，以下步骤的执行顺序可能不正确: [${cycleSteps.join(', ')}]`);

  // 仍然追加（保持现有行为，不阻断执行），但标记为"顺序不确定"
  for (const dep of dependencies) {
    if (!order.includes(dep.stepId)) {
      order.push(dep.stepId);
    }
  }
}
```

### 验收

- 模型 API Key 未配置时 `isModelAvailable()` 返回 false
- LLM 分类失败时路由到 complex 而非 simple
- 工作区有未提交更改时 rollback 返回 false
- 依赖图有环时日志输出警告信息
- 新增 ≥ 5 个测试

---

## Task 5：边界案例修复

**目标**：修复 3 个边界案例——isError 结构化（B1）、vision 路径检查加固（S12）、搜索工具代码去重（A4）。

### 5.1 isError 结构化判断（B1）

**当前行为：** `loop.ts:265` 用 `toolResult.includes('错误')` 判断是否为错误。正常输出含"错误"二字（如"修复了3个错误"）会被误判。

**修复：** 工具执行器的返回值应包含结构化错误信息。改造 `ToolExecutor.execute()` 的返回：

```typescript
// 如果工具返回了结构化的错误字段，优先使用
// 否则 fallback 到字符串匹配（但增加更精确的模式）
const isError = typeof toolResultObj === 'object' && toolResultObj !== null
  ? Boolean(toolResultObj.isError || toolResultObj.error)
  : /\[错误\]|\[error\]|Error:|failed to|无法|失败/.test(String(toolResult));
```

改造要点：
1. 工具返回对象（`ToolResult`）已有 `isError` 可选字段——优先读取
2. fallback 的正则从"包含关键词"改为"以错误标记开头"的模式，降低误判率
3. 不改变 `ToolResult` 接口（`isError` 字段已存在），只是让 loop 优先读取

### 5.2 vision.ts 路径检查加固（S12）

**当前行为：** `vision.ts:118` 使用 `normalizedPath.startsWith(normalizedRoot + path.sep)`。如果 `allowedRoot` 是 `/project`，则 `/project-secret/file` 也会通过（前缀匹配但非子目录）。

**修复：** 使用 `path.relative()` 替代 `startsWith`：

```typescript
const relativePath = path.relative(normalizedRoot, normalizedPath);
if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
  logger.warn(`Path traversal blocked: ${filePath} resolves outside project root`);
  return null;
}
```

这个修复同时适用于 `security.ts:40-42` 的 `checkFilePath()` 方法（也用 `startsWith`）。在 `checkFilePath()` 中同步改造：

```typescript
checkFilePath(filePath: string, _context: ToolExecutionContext): SecurityCheckResult {
  const resolved = path.resolve(filePath);
  const inAllowedDir = this.allowedDirs.some(dir => {
    const rel = path.relative(dir, resolved);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });

  if (!inAllowedDir) {
    return { allowed: false, reason: `路径 ${filePath} 不在允许的目录中`, requiresConfirmation: false };
  }
  return { allowed: true, requiresConfirmation: false };
}
```

### 5.3 搜索工具代码去重（A4）

**当前行为：** `code-search.ts` 和 `file-search.ts` 中 `walkDir`（~30 行）、`isIgnoredPath`（~5 行）、`matchGlob`（~5 行）三个方法逐字符相同。

**修复：** 提取到 `src/tools/builtin/search-utils.ts`：

```typescript
// src/tools/builtin/search-utils.ts — 新建

/** 递归遍历目录，返回所有文件路径 */
export async function walkDir(dir: string, maxFiles: number): Promise<string[]>;

/** 判断路径是否在忽略列表中 */
export function isIgnoredPath(relativePath: string): boolean;

/** 简单的 glob 模式匹配 */
export function matchGlob(pattern: string, filePath: string): boolean;
```

`code-search.ts` 和 `file-search.ts` 改为从 `search-utils.ts` 导入，删除各自的私有实现。

### 验收

- "修复了3个错误"不再被误判为 isError
- `/project-secret/file` 在 `allowedRoot=/project` 时被阻止
- `code-search.ts` 和 `file-search.ts` 无重复的 walkDir/isIgnoredPath/matchGlob
- 新增 ≥ 5 个测试

---

## Task 6：测试覆盖与文档同步

**目标**：确保 Phase 29 所有修复有充分测试，文档与代码同步。

### 6.1 测试补充

| 模块 | 测试文件 | 测试数 |
|------|---------|-------|
| `command-parser.ts` | `tests/tools/command-parser.test.ts` | ≥ 4（tokenize 正常、引号、管道、命令替换） |
| `security.ts` 改造后 | `tests/tools/security-command.test.ts` | ≥ 3（白名单首 token、黑名单首 token、危险模式标记） |
| `permission-engine.ts` 新规则 | `tests/tools/permission-engine-deny.test.ts` | ≥ 3（rm -rf 变体、find -delete、dd of=/dev/） |
| `channels/manager.ts` slack | `tests/channels/manager-slack.test.ts` | ≥ 2（slack 创建、unknown type） |
| `wechat-work.ts` 安全 | `tests/channels/wechat-work-security.test.ts` | ≥ 3（生产模式拒绝、padding 严格、parseInt NaN） |
| `slack.ts` 安全 | `tests/channels/slack-security.test.ts` | ≥ 2（生产模式拒绝、signingSecret 缺失） |
| `config/loader.ts` fail-fast | `tests/config/loader-env.test.ts` | ≥ 2（未设置抛错、已设置替换） |
| `loop.ts` isError | `tests/agent/loop-iserror.test.ts` | ≥ 2（结构化判断、误判修复） |
| `classifier.ts` fallback | `tests/router/classifier-fallback.test.ts` | ≥ 1（LLM 失败返回 complex） |
| `checkpoint-manager.ts` rollback | `tests/harness/checkpoint-rollback.test.ts` | ≥ 1（未提交阻止回滚） |
| `orchestrator.ts` cycle | `tests/agent/multi/orchestrator-cycle.test.ts` | ≥ 1（环检测日志） |
| `search-utils.ts` | `tests/tools/builtin/search-utils.test.ts` | ≥ 3（walkDir、isIgnoredPath、matchGlob） |

### 6.2 文档同步

1. **AGENTS.md**：更新陷阱警告——命令解析改 tokenize、签名验证生产模式行为、环境变量 fail-fast、rollback 前置检查
2. **CODEMAP.md**：新增 `src/tools/command-parser.ts` 和 `src/tools/builtin/search-utils.ts` 条目
3. **README.md**：更新版本号到 v2.1.0
4. **CHANGELOG.md**：添加 v2.1.0 变更记录
5. **EXECUTION_STATUS.md**：添加 Phase 29 条目

### 验收

- 新增测试 ≥ 25 个
- 全量测试通过
- 构建通过
- 文档与代码一致

---

## 执行顺序

```
Task 1 (渠道安全加固) ───────┐
Task 2 (渠道管理器修复) ─────┤── 独立模块，可并行，快速修复
  ↓
Task 3 (命令解析统一) ─────── 核心安全任务，最大改动
  ↓
Task 4 (运行时健壮性) ─────── 独立 bug 修复，可并行
Task 5 (边界案例) ─────────── 独立修复，可并行
  ↓
Task 6 (测试 + 文档) ──────── 最后做，反映所有改动
```

Task 1/2 可并行（都是渠道相关但互不依赖）。Task 3 是核心安全改造，建议单独执行确保质量。Task 4/5 可并行。Task 6 在全部完成后执行。

---

## 验收标准

| # | 验收标准 | 验证方式 |
|---|---------|---------|
| 1 | 签名验证生产模式拒绝降级 | NODE_ENV=production 下 token 缺失返回 false |
| 2 | 环境变量未设置时启动失败 | 删除 .env 中某个变量，启动验证报错信息 |
| 3 | API Key 为空时 isReady() 返回 false | 构造空 key 客户端，验证不发送假请求 |
| 4 | PKCS#7 padding 严格验证 | 构造畸形 padding 密文，验证被拒绝 |
| 5 | Slack 渠道配置可正常启动 | 配置 type: 'slack'，验证不抛错 |
| 6 | 命令解析绕过全部修复 | rm -rf "/"、find / -delete、dd of=/dev/sda 均被阻止 |
| 7 | 子串匹配误拦修复 | python program.py 不被黑名单拦截 |
| 8 | 环境变量覆盖被白名单限制 | 尝试覆盖 PATH 以外的变量，验证被忽略 |
| 9 | 分类器失败回退到 complex | 模拟 LLM 分类失败，验证路由到强模型 |
| 10 | rollback 检查工作区 | 有未提交更改时 rollback 返回 false |
| 11 | vision 路径检查加固 | /project-secret/file 被阻止 |
| 12 | 搜索工具代码无重复 | code-search.ts 和 file-search.ts 无 walkDir 方法 |
| 13 | 全量测试通过 | `pnpm vitest run` |
| 14 | 构建通过 | `pnpm build && pnpm typecheck` |
| 15 | 新增测试 ≥ 25 个 | 测试计数 |
| 16 | 文档与代码一致 | 人工审查 |

---

## 对审查报告的逐项回应矩阵

| 审查编号 | 问题 | 严重程度 | Phase 29 覆盖 | 处理方式 |
|---|---|---|---|---|
| S1 | permission-engine 正则绕过 | 高 | Task 3 | tokenize + argsPredicate |
| S2 | security.ts includes 子串匹配 | 高 | Task 3 | 首 token 匹配 |
| S3 | shell-exec 命令注入 | 高 | Task 3 | tokenize + 危险模式标记 |
| S5 | wechat-work 签名验证降级 | 中 | Task 1 | 生产模式拒绝 |
| S6 | slack 签名验证降级 | 中 | Task 1 | 生产模式拒绝 |
| S8 | PKCS#7 padding oracle | 中 | Task 1 | 严格验证 |
| S9 | 环境变量占位符保留 | 中 | Task 1 | 启动 fail-fast |
| S10 | Telegram botToken URL 暴露 | 低 | — | 接受为技术债务（v2.x） |
| S11 | API Key 'placeholder' | 低 | Task 1 | 构造时 fail-fast |
| S12 | vision startsWith 路径遍历 | 低 | Task 5 | path.relative 改造 |
| — | shell-exec env 注入 | 中 | Task 3 | 环境变量白名单 |
| A1 | Slack switch 缺失 | 功能 | Task 2 | 添加 case 分支 |
| A2 | manager.ts 末尾 import | 规范 | Task 2 | 移至顶部 |
| A3 | 权限/安全双引擎不统一 | 架构 | — | 接受为技术债务（v2.x） |
| A4 | 搜索工具代码重复 | 维护 | Task 5 | 提取 search-utils |
| B1 | isError 字符串匹配 | 逻辑 | Task 5 | 结构化判断 |
| B2 | resumeFrom 只执行单步 | 功能 | — | 接受为技术债务（v2.x） |
| B3 | isModelAvailable 恒 true | 功能 | Task 4 | 实现真实检查 |
| B4 | 分类器回退 simple | 逻辑 | Task 4 | 改为 complex |
| B5 | 图片 token 固定 1000 | 精度 | — | 接受为技术债务（v2.x） |
| B6 | wechat parseInt NaN | 边界 | Task 1 | isNaN 防护 |
| B7 | telegram pollIntervalMs string | 边界 | — | 接受为技术债务（v2.x） |
| B8 | ~~Slack Array.shift~~ | ~~性能~~ | — | **审查错误**：实际用 Set |
| B9 | audit-logger sync | 性能 | P26 Task 5 | 已修复 |
| B10 | rollback git reset --hard | 安全 | Task 4 | 前置工作区检查 |
| B11 | plugin validateArgs 默认 valid | 边界 | — | 接受为技术债务（v2.x） |
| B12 | L5 摘要失败无 fallback | 边界 | — | 接受为技术债务（v2.x） |
| B13 | ~~orchestrator 环检测抛错~~ | 边界 | Task 4 | **审查纠正**：静默追加→添加警告 |
| B14 | web-search HTML 解析脆弱 | 边界 | — | 接受为技术债务（v2.x） |
| B15 | fork 后索引错位 | 边界 | — | 接受为技术债务（v2.x） |
| P4 | trace-collector 无背压 | 性能 | — | 接受为技术债务（v2.x） |
| P5 | walkDir 同步递归 | 性能 | — | 接受为技术债务（v2.x） |
| P6 | message-router Map 无限制 | 性能 | — | 接受为技术债务（v2.x） |
| P7 | ~~Slack Array.shift~~ | ~~性能~~ | — | **审查错误**：同 B8 |
| P8 | 压缩全量扫描 | 性能 | — | 接受为技术债务（v2.x） |

**统计：**
- 审查报告共 59 项发现（8 架构 + 12 安全 + 15 边界 + 8 性能 + 16 逐行细项）
- Phase 26/27/28 已覆盖：11 项
- Phase 29 新增覆盖：19 项（含 2 项审查错误纠正）
- 接受为技术债务（v2.x）：15 项
- 审查报告描述错误：2 项（B8/P7 Slack Array.shift、B13 orchestrator 抛错）
- 总计已处理：47/59 项（含审查错误），剩余 12 项为 v2.x 技术债务

---

## 项目收尾声明

Phase 29 是 RouteDev 项目的最后一个开发 Phase。完成后项目进入维护模式：

**已完成（Phase 1-29）：**
- 29 个 Phase 的设计与执行
- 核心链路：路由→Agent Loop→工具执行→响应
- 基础设施：插件系统、记忆系统、Guardrails、工作模式、Compose 管线
- 安全：7 层防护（权限→目录→命令→文件→网络→进程→审计）+ tokenize 命令解析
- 质量：~1270+ 测试（预估）、~110 源文件、零 Critical/High 缺陷
- 文档：README、CODEMAP、AGENTS、CHANGELOG、ARCHITECTURE、PLUGIN_GUIDE、SECURITY_AUDIT

**v2.x 技术债务清单（12 项，非紧急）：**
1. Telegram botToken URL 暴露（S10）
2. 权限/安全双引擎不统一（A3）
3. DurableExecutor resumeFrom 只执行单步（B2）
4. 图片 token 估算固定 1000（B5）
5. Telegram pollIntervalMs 类型转换（B7）
6. Plugin validateArgs 默认 valid（B11）
7. Context compaction L5 无 fallback（B12）
8. Web search HTML 解析脆弱（B14）
9. Branch fork 后索引错位（B15）
10. Trace collector 无背压（P4）
11. Message router Map 无上限（P6）
12. Context compaction 全量扫描（P8）

这些项目不影响安全和核心功能，在 v2.x 的常规维护中逐步处理。
