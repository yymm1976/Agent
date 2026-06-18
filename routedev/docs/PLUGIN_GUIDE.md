# RouteDev 插件开发指南

> 本文档介绍如何为 RouteDev 开发自定义插件。

## 1. 插件类型

RouteDev 支持四类插件：

| 类型 | 接口 | 用途 |
|------|------|------|
| ThemePlugin | `ThemePlugin` | 自定义颜色主题 |
| ToolPlugin | `ToolPlugin` | 注册自定义工具 |
| HookPlugin | `HookPlugin` | 生命周期钩子 |
| RouterPlugin | `RouterPlugin` | 自定义路由决策 |

## 2. 插件清单

每个插件需要一个 `routedev-plugin.json` 清单文件：

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "type": "tool",
  "entry": "./index.js",
  "description": "我的自定义工具插件"
}
```

- `name`：插件唯一标识
- `version`：语义化版本
- `type`：插件类型（theme / tool / hook / router）
- `entry`：入口文件（相对路径）
- `description`：插件描述

## 3. 开发 ToolPlugin

```typescript
import type { ToolPlugin, ITool, ToolDefinition, ToolResult } from 'routedev';

class MyTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'my_tool',
    description: '我的自定义工具',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '输入文本' },
      },
      required: ['input'],
    },
    requiresApproval: false,
    category: 'custom',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.input || typeof args.input !== 'string') {
      errors.push('缺少必需参数: input');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const input = args.input as string;
    return {
      success: true,
      output: `处理结果: ${input}`,
      durationMs: 0,
    };
  }
}

export default class MyToolPlugin implements ToolPlugin {
  readonly type = 'tool' as const;

  getTools(): ITool[] {
    return [new MyTool()];
  }
}
```

## 4. 开发 HookPlugin

```typescript
import type { HookPlugin, HookContext, StepResult } from 'routedev';

export default class MyHookPlugin implements HookPlugin {
  readonly type = 'hook' as const;

  async preStep(context: HookContext): Promise<boolean> {
    console.log(`步骤 ${context.stepId} 即将执行`);
    return true; // true = 继续，false = 中止
  }

  async postStep(context: HookContext, result: StepResult): Promise<void> {
    console.log(`步骤 ${context.stepId} 完成，成功: ${result.success}`);
  }

  async onError(context: HookContext, error: Error): Promise<void> {
    console.error(`步骤 ${context.stepId} 失败: ${error.message}`);
  }
}
```

## 5. 开发 ThemePlugin

```typescript
import type { ThemePlugin, ThemeColors } from 'routedev';

export default class MyThemePlugin implements ThemePlugin {
  readonly type = 'theme' as const;

  getColors(): ThemeColors {
    return {
      primary: '#ff6600',
      secondary: '#0066ff',
      success: '#00cc00',
      error: '#cc0000',
      warning: '#cccc00',
      info: '#00cccc',
      text: '#ffffff',
      muted: '#888888',
    };
  }
}
```

## 6. 开发 RouterPlugin

```typescript
import type { RouterPlugin, RouteDecision, ClassificationResult } from 'routedev';

export default class MyRouterPlugin implements RouterPlugin {
  readonly type = 'router' as const;

  route(classification: ClassificationResult): RouteDecision | null {
    // 自定义路由逻辑
    if (classification.tier === 'simple' && classification.confidence > 0.9) {
      return {
        modelId: 'my-fast-model',
        providerId: 'my-provider',
        reason: '高置信度简单任务使用快速模型',
      };
    }
    return null; // 返回 null 交还默认路由
  }
}
```

## 7. 插件安装

将插件目录放入 `~/.routedev/plugins/` 或项目根目录的 `.routedev/plugins/`：

```
~/.routedev/plugins/
  my-plugin/
    routedev-plugin.json
    index.js
```

使用 `/plugin` 命令管理插件：
- `/plugin list` — 列出已安装插件
- `/plugin enable <name>` — 启用插件
- `/plugin disable <name>` — 禁用插件
- `/plugin reload` — 重新加载插件

## 8. 插件生命周期

```
discover → load → init → bridge → enable/disable → destroy
```

- **discover**：扫描插件目录，读取清单
- **load**：加载入口文件
- **init**：调用插件的 init() 方法（如有）
- **bridge**：将插件功能桥接到核心系统
- **enable/disable**：运行时启用/禁用（状态持久化）
- **destroy**：清理资源
