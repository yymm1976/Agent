// desktop/main/bridges/index.ts
// bridges 模块 barrel 导出：集中暴露所有 delegate bridge 类与共享上下文
// engine-bridge.ts 与外部消费方统一从此处引入，避免散落的相对路径引用。

export { EngineContext, type EngineBridges } from './engine-context.js';
export type {
  EngineBridgeOptions,
  SkillInfo,
  SkillPreview,
  MCPToolInfo,
  GoalRunner,
  PendingConfirmEntry,
} from './engine-context.js';

export { ChatBridge } from './chat-bridge.js';
export { ConfigBridge } from './config-bridge.js';
export { MCPBridge } from './mcp-bridge.js';
export { SkillBridge } from './skill-bridge.js';
export { ExperimentBridge } from './experiment-bridge.js';
export { GoalBridge } from './goal-bridge.js';
