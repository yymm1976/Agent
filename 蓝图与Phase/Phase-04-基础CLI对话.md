# Phase 4：基础 CLI 对话（Ink + 流式输出 + 状态栏）

**回应**：Phase 3 无 CONCERN（等待执行人报告）

**目标**：用 Ink（React for CLI）实现基础对话界面——流式输出 LLM 回复、状态栏显示当前模型/token/路由等级、输入框支持发送消息和基础 / 命令。这是用户第一次能"用"RouteDev 的 Phase。

**蓝图参考**：第五节决策 6（CLI 先行）、第四节（文件结构 cli/）、design-routedev-spec2.md §3（UI 层组件接口）

**前置依赖**：Phase 2（LLM 客户端）+ Phase 3（Router 层）全部完成

---

## 具体任务

### Task 1：安装 Ink 依赖 + 配置 JSX

- [ ] **Step 1：安装 Ink 和 React**

```powershell
pnpm add ink react
pnpm add -D @types/react
```

依赖说明：
- `ink`：React for CLI，组件化终端 UI
- `react`：Ink 的底层依赖
- `@types/react`：TypeScript 类型

- [ ] **Step 2：更新 tsconfig.json 支持 JSX**

在 `compilerOptions` 中添加：

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```

注意：保留所有已有配置不变，只新增这两行。

- [ ] **Step 3：更新 tsup.config.ts 支持 TSX**

```typescript
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  // 支持 JSX/TSX
  jsx: 'automatic',
  external: ['react', 'ink'],
});
```

- [ ] **Step 4：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL

- [ ] **Step 5：提交**

```powershell
git add package.json pnpm-lock.yaml tsconfig.json tsup.config.ts
git commit -m "chore: add ink/react and configure JSX support"
```

---

### Task 2：状态栏组件

**文件：** 创建 `src/cli/StatusBar.tsx`

状态栏显示在 CLI 底部，实时显示当前模型、场景等级、token 消耗、降级状态。

```tsx
// src/cli/StatusBar.tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { RouterStatus, ScenarioTier } from '../router/types.js';
import { formatTokenCount } from '../utils/token-counter.js';

interface StatusBarProps {
  routerStatus: RouterStatus;
  autonomyMode: string;
  workMode: string;
}

/** 场景等级的颜色 */
function tierColor(tier: ScenarioTier): string {
  switch (tier) {
    case 'simple': return 'green';
    case 'medium': return 'yellow';
    case 'complex': return 'magenta';
    case 'reasoning': return 'cyan';
    default: return 'white';
  }
}

/** 场景等级的标签 */
function tierLabel(tier: ScenarioTier): string {
  switch (tier) {
    case 'simple': return '简单';
    case 'medium': return '中等';
    case 'complex': return '复杂';
    case 'reasoning': return '推理';
    default: return tier;
  }
}

export function StatusBar({ routerStatus, autonomyMode, workMode }: StatusBarProps) {
  const { currentModel, currentTier, isDegraded, todayTokensUsed } = routerStatus;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text color="gray">模型: </Text>
        <Text bold>{currentModel}</Text>
        <Text color="gray"> │ </Text>
        <Text color={tierColor(currentTier)} bold>[{tierLabel(currentTier)}]</Text>
        {isDegraded && <Text color="red"> ⚠ 已降级</Text>}
        <Text color="gray"> │ </Text>
        <Text color="gray">Token: </Text>
        <Text>{formatTokenCount(todayTokensUsed)}</Text>
        <Text color="gray"> │ </Text>
        <Text color="gray">自主: </Text>
        <Text>{autonomyMode}</Text>
        <Text color="gray"> │ </Text>
        <Text color="gray">模式: </Text>
        <Text>{workMode}</Text>
      </Box>
    </Box>
  );
}
```

构建验证 → 提交。

---

### Task 3：输入框组件

**文件：** 创建 `src/cli/InputBox.tsx`

输入框支持文本输入和 Enter 发送。/ 开头的输入作为命令处理。

```tsx
// src/cli/InputBox.tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface InputBoxProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

export function InputBox({ onSubmit, disabled = false }: InputBoxProps) {
  const [value, setValue] = useState('');

  useInput((char, key) => {
    if (disabled) return;

    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
        setValue('');
      }
      return;
    }

    if (key.backspace || key.delete) {
      setValue(prev => prev.slice(0, -1));
      return;
    }

    if (key.ctrl && char === 'c') {
      // Ctrl+C 退出
      process.exit(0);
    }

    // 普通字符输入
    if (char && !key.ctrl && !key.meta) {
      setValue(prev => prev + char);
    }
  });

  const isCommand = value.startsWith('/');

  return (
    <Box>
      <Text color={isCommand ? 'cyan' : 'green'} bold>{disabled ? '⏳ ' : '❯ '}</Text>
      <Text>{value}</Text>
      {!disabled && <Text color="gray">▌</Text>}
    </Box>
  );
}
```

构建验证 → 提交。

---

### Task 4：对话视图组件

**文件：** 创建 `src/cli/ChatView.tsx`

对话视图显示消息列表，支持流式输出。

```tsx
// src/cli/ChatView.tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { ScenarioTier } from '../router/types.js';

/** 对话消息 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tier?: ScenarioTier;
  modelId?: string;
  isStreaming?: boolean;
}

interface ChatViewProps {
  messages: ChatMessage[];
}

/** 消息角色颜色 */
function roleColor(role: string): string {
  switch (role) {
    case 'user': return 'green';
    case 'assistant': return 'white';
    case 'system': return 'gray';
    default: return 'white';
  }
}

/** 消息角色标签 */
function roleLabel(role: string): string {
  switch (role) {
    case 'user': return '你';
    case 'assistant': return 'AI';
    case 'system': return '系统';
    default: return role;
  }
}

export function ChatView({ messages }: ChatViewProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={roleColor(msg.role)} bold>{roleLabel(msg.role)}: </Text>
            {msg.tier && (
              <Text color="gray" dimColor>[{msg.tier}] </Text>
            )}
            {msg.modelId && (
              <Text color="gray" dimColor>({msg.modelId}) </Text>
            )}
          </Box>
          <Box paddingLeft={2}>
            <Text wrap="wrap">
              {msg.content}
              {msg.isStreaming && <Text color="gray"> ▌</Text>}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
```

构建验证 → 提交。

---

### Task 5：主应用组件

**文件：** 创建 `src/cli/App.tsx`

App 组件是 Ink 应用的根组件，整合 ChatView + StatusBar + InputBox，管理消息状态和 LLM 交互。

```tsx
// src/cli/App.tsx
import React, { useState, useCallback, useRef } from 'react';
import { Box } from 'ink';
import { ChatView, type ChatMessage } from './ChatView.js';
import { StatusBar } from './StatusBar.js';
import { InputBox } from './InputBox.js';
import type { RouterStatus, ScenarioTier, LLMClient, LLMMessage } from '../router/types.js';
import { ScenarioClassifier } from '../router/classifier.js';
import { ModelRouter } from '../router/router.js';
import { TokenTracker } from '../router/tracker.js';
import { LLMClientManager } from '../router/llm/index.js';
import type { AppConfig } from '../config/schema.js';

interface AppProps {
  config: AppConfig;
  clientManager: LLMClientManager;
  classifier: ScenarioClassifier;
  modelRouter: ModelRouter;
  tracker: TokenTracker;
}

let messageIdCounter = 0;
function nextId(): string {
  return `msg-${++messageIdCounter}`;
}

export function App({ config, clientManager, classifier, modelRouter, tracker }: AppProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: nextId(),
      role: 'system',
      content: 'RouteDev 已就绪。输入消息开始对话，输入 /help 查看命令列表。',
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [autonomyMode] = useState(config.autonomy.defaultMode);
  const [workMode] = useState('build');
  const [routerStatus, setRouterStatus] = useState<RouterStatus>(modelRouter.getStatus());

  const conversationRef = useRef<LLMMessage[]>([]);
  // 流式输出节流：用 ref 累积文本，定时刷新到 state（避免每个 delta 都触发 React 重渲染）
  const streamBufferRef = useRef<string>('');
  const streamMsgIdRef = useRef<string | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flushStreamBuffer = useCallback(() => {
    const msgId = streamMsgIdRef.current;
    const content = streamBufferRef.current;
    if (msgId && content) {
      setMessages(prev =>
        prev.map(m => m.id === msgId ? { ...m, content } : m),
      );
    }
  }, []);

  const startFlushTimer = useCallback(() => {
    if (!flushTimerRef.current) {
      flushTimerRef.current = setInterval(flushStreamBuffer, 80); // 每 80ms 刷新一次
    }
  }, [flushStreamBuffer]);

  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    // 最终刷新一次确保完整
    flushStreamBuffer();
  }, [flushStreamBuffer]);

  const handleSubmit = useCallback(async (text: string) => {
    // 添加用户消息
    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: text,
    };
    setMessages(prev => [...prev, userMsg]);

    // 处理命令
    if (text.startsWith('/')) {
      handleCommand(text);
      return;
    }

    setIsProcessing(true);

    try {
      // 1. 场景分类
      const classifyResult = await classifier.classify({
        userMessage: text,
        conversationContext: conversationRef.current.slice(-5).map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content.slice(0, 200),
        })),
      });

      // 2. 路由决策
      const routeDecision = modelRouter.selectModel(classifyResult.tier);
      setRouterStatus(modelRouter.getStatus());

      // 3. 获取 LLM 客户端
      const client = clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        const errMsg: ChatMessage = {
          id: nextId(),
          role: 'system',
          content: `错误: 提供商 ${routeDecision.providerId} 不可用。请检查 API Key 配置。`,
        };
        setMessages(prev => [...prev, errMsg]);
        setIsProcessing(false);
        return;
      }

      // 4. 构建消息列表
      conversationRef.current.push({ role: 'user', content: text });
      const llmMessages: LLMMessage[] = [
        { role: 'system', content: '你是 RouteDev，一个智能开发助手。用中文回答。' },
        ...conversationRef.current,
      ];

      // 5. 流式调用 LLM
      const assistantId = nextId();
      let assistantContent = '';

      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        tier: classifyResult.tier,
        modelId: routeDecision.modelId,
        isStreaming: true,
      };
      setMessages(prev => [...prev, assistantMsg]);

      try {
        const stream = client.chatStream({
          model: routeDecision.modelId,
          messages: llmMessages,
          stream: true,
          timeout: 60000,
        });

        // 初始化节流缓冲
        streamBufferRef.current = '';
        streamMsgIdRef.current = assistantId;
        startFlushTimer();

        for await (const event of stream) {
          if (event.type === 'text_delta') {
            // 累积到 buffer（不直接触发 setState），由定时器批量刷新
            streamBufferRef.current += event.data;
            assistantContent = streamBufferRef.current;
          } else if (event.type === 'usage' && event.usage) {
            tracker.record(event.usage, {
              modelId: routeDecision.modelId,
              agentId: 'default',
              stepId: 'chat',
            });
          }
        }

        // 停止节流定时器，刷新最终内容
        stopFlushTimer();

        // 流结束
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantId ? { ...m, isStreaming: false } : m
          )
        );

        conversationRef.current.push({ role: 'assistant', content: assistantContent });
        setRouterStatus(modelRouter.getStatus());
      } catch (streamError) {
        // 清理节流定时器
        stopFlushTimer();

        // 流式失败，尝试非流式
        const response = await client.chat({
          model: routeDecision.modelId,
          messages: llmMessages,
          timeout: 60000,
        });

        assistantContent = response.content;
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantId
              ? { ...m, content: response.content, isStreaming: false }
              : m
          )
        );

        if (response.usage) {
          tracker.record(response.usage, {
            modelId: routeDecision.modelId,
            agentId: 'default',
            stepId: 'chat',
          });
        }

        conversationRef.current.push({ role: 'assistant', content: assistantContent });
        setRouterStatus(modelRouter.getStatus());
      }
    } catch (error) {
      const errMsg: ChatMessage = {
        id: nextId(),
        role: 'system',
        content: `错误: ${error instanceof Error ? error.message : String(error)}`,
      };
      setMessages(prev => [...prev, errMsg]);
    } finally {
      setIsProcessing(false);
    }
  }, [classifier, modelRouter, clientManager, tracker, startFlushTimer, stopFlushTimer]);

  const handleCommand = useCallback((text: string) => {
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/help':
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: [
            '可用命令：',
            '  /help     - 显示帮助',
            '  /status   - 查看当前状态',
            '  /model <name> - 手动切换模型',
            '  /clear    - 清空对话',
            '  /quit     - 退出',
          ].join('\n'),
        }]);
        break;

      case '/status':
        const stats = tracker.getStats();
        const status = modelRouter.getStatus();
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: [
            `当前模型: ${status.currentModel}`,
            `场景等级: ${status.currentTier}`,
            `已降级: ${status.isDegraded ? '是' : '否'}`,
            `今日 Token: ${stats.today.total}`,
            `会话 Token: ${stats.currentSession.total}`,
          ].join('\n'),
        }]);
        break;

      case '/model': {
        const modelName = parts.slice(1).join(' ');
        if (!modelName) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: '用法: /model <模型名称>。当前模型: ' + modelRouter.getStatus().currentModel,
          }]);
          break;
        }
        try {
          const decision = modelRouter.override(modelName);
          setRouterStatus(modelRouter.getStatus());
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `已切换到模型: ${decision.modelId}${decision.isDegraded ? ' (降级)' : ''}`,
          }]);
        } catch (e) {
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system',
            content: `模型切换失败: ${e instanceof Error ? e.message : String(e)}`,
          }]);
        }
        break;
      }

      case '/clear':
        setMessages([{
          id: nextId(),
          role: 'system',
          content: '对话已清空。',
        }]);
        conversationRef.current = [];
        break;

      case '/quit':
      case '/exit':
        console.log('\n再见！');
        process.exit(0);
        break;

      default:
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system',
          content: `未知命令: ${cmd}。输入 /help 查看可用命令。`,
        }]);
    }

    setIsProcessing(false);
  }, [modelRouter, tracker]);

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ChatView messages={messages} />
      </Box>
      <Box paddingX={1}>
        <StatusBar
          routerStatus={routerStatus}
          autonomyMode={autonomyMode}
          workMode={workMode}
        />
      </Box>
      <Box paddingX={1}>
        <InputBox onSubmit={handleSubmit} disabled={isProcessing} />
      </Box>
    </Box>
  );
}
```

构建验证 → 提交。

---

### Task 6：更新 CLI 入口启动 Ink

**文件：** 重写 `src/index.ts`

将入口改为启动 Ink 应用。非交互模式（如 pipe）时回退到纯文本。

```typescript
// src/index.ts
#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { LLMClientManager } from './router/llm/index.js';
import { TokenTracker } from './router/tracker.js';
import { ScenarioClassifier } from './router/classifier.js';
import { ModelRouter } from './router/router.js';
import { extractRouterConfig } from './router/config.js';
import { App } from './cli/App.js';

const VERSION = '0.4.0';

async function main(): Promise<void> {
  // 加载配置
  const config = loadConfig();

  // 初始化 LLM 客户端
  const clientManager = new LLMClientManager();
  clientManager.initializeFromConfig(
    config.providers.map(p => ({
      id: p.id,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
    })),
  );

  // 提取 Router 配置
  const routerConfig = extractRouterConfig(config);

  // 初始化 Router 层
  const tracker = new TokenTracker(routerConfig.budget);
  const classifierClient = clientManager.listAll().values().next().value;
  const classifier = new ScenarioClassifier({
    llmFallbackThreshold: 0.6,
    llmClient: classifierClient,
    llmModelId: routerConfig.classifierModelId,
    userPreference: routerConfig.userPreference,
  });
  const modelRouter = new ModelRouter(
    { rules: routerConfig.rules, budget: routerConfig.budget, models: routerConfig.models },
    tracker,
  );

  // 启动 Ink 应用
  render(
    React.createElement(App, {
      config,
      clientManager,
      classifier,
      modelRouter,
      tracker,
    }),
    {
      exitOnCtrlC: true,
    },
  );

  logger.info('RouteDev CLI started', { version: VERSION });
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
```

- [ ] **Step 1：构建验证**

```powershell
pnpm build
pnpm typecheck
```

- [ ] **Step 2：运行测试**

```powershell
pnpm test
```

- [ ] **Step 3：提交**

```powershell
git add src/index.ts src/cli/
git commit -m "feat(cli): implement Ink-based interactive CLI with streaming, status bar, and commands"
```

---

### Task 7：更新 package.json 入口

确保 `pnpm start` 和 `pnpm dev` 能正确启动 Ink 应用。

- [ ] **Step 1：确认 package.json scripts**

```json
{
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2：最终构建验证**

```powershell
pnpm build
pnpm typecheck
pnpm test
```

预期：全部通过

- [ ] **Step 3：提交**

```powershell
git add package.json
git commit -m "chore: finalize package.json scripts for Phase 4"
```

---

## 完成标准

1. `pnpm build` 成功（包含 TSX 编译）
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 30 个用例）
4. `pnpm start` 启动交互式 CLI，显示欢迎消息
5. 输入文本后能流式显示 LLM 回复
6. 状态栏正确显示当前模型、场景等级、token 消耗
7. `/help`、`/status`、`/clear`、`/quit` 命令正常工作
8. Ctrl+C 正常退出
9. 所有代码无 `any`

## 注意事项

- **中文输入法兼容**：Ink 的 `useInput` hook 在 Windows Terminal 下与中文 IME 存在已知兼容性问题——输入法候选过程中的字符可能被丢失或错位。这是 Ink 框架层面的限制，Phase 4 先记录此问题。缓解方案（后续 Phase 评估）：(1) 检测 IME 活跃状态时暂停 useInput 处理；(2) 改用 `process.stdin` raw mode 手动处理；(3) 提供 Web UI 替代方案
- **流式渲染节流**：App.tsx 的流式输出使用 80ms 间隔的定时器批量刷新（ref 缓冲 + setInterval），避免每个 text_delta 都触发 React 重渲染。如果发现终端闪烁严重，可调大间隔（如 120ms）
- **Ink 版本**：使用 ink@5.x（最新版），API 可能有变化。如果 `useInput` 的行为与预期不符，用 CONCERN 上报
- **React JSX**：tsconfig 的 `jsx: "react-jsx"` + `jsxImportSource: "react"` 是 React 17+ 的新 JSX 转换，不需要在每个文件顶部 `import React`，但 Ink 组件仍需显式 import
- **tsup JSX**：`jsx: 'automatic'` 配合 tsconfig 的 `jsxImportSource`
- **流式降级**：如果流式调用失败，自动回退到非流式模式。这是防御性设计
- **Ink 组件拆分**：从 Phase 4 开始就做好组件拆分（ChatView / StatusBar / InputBox / App），避免 Claude Code 的 875KB 单组件反面教材
- **stdin/stdout**：Ink 需要 TTY 终端。如果通过 pipe 运行（如 `echo "hello" | pnpm start`），Ink 可能无法正常工作。这是已知限制，后续 Phase 可加非交互模式
- **Phase 1-3 踩坑清单**：pnpm 11 allowBuilds、TS 6 ignoreDeprecations、Zod 4 preprocess 模式、types: ["node"]

---

*Phase 4 | 蓝图 V1.0 | 预估新增文件：~4 个（App.tsx, ChatView.tsx, StatusBar.tsx, InputBox.tsx） | 预估修改文件：~3 个（index.ts, tsconfig.json, tsup.config.ts）*
