// desktop/renderer/src/hooks/useRouteDev.ts
// 薄封装：从 Zustand store 获取状态和操作，保持组件接口不变
// 类型定义从 store 重导出，确保现有 import 路径兼容

import { useRouteDevStore } from '../store/useRouteDevStore.js';

// 重导出类型定义，保持组件 import 路径不变
export type {
  MessageRole,
  ToolCallStatus,
  ChatMessage,
  PendingConfirm,
} from '../store/useRouteDevStore.js';

/**
 * 薄封装 hook：直接返回 Zustand store 的状态和操作。
 * IPC 事件订阅和初始配置加载由 App.tsx 调用 initIPCListeners / loadInitialConfig 完成。
 *
 * F-001 注意（重要性能建议）：
 *   本 hook 内部调用 `useRouteDevStore()` 不带 selector，会订阅整个 store，
 *   导致任何 store 字段变化（如流式 messages 增量、isProcessing 切换）都触发重渲染。
 *   新代码请优先使用 selector 模式直接订阅所需字段：
 *     const messages = useRouteDevStore(s => s.messages);
 *     const sendMessage = useRouteDevStore(s => s.sendMessage);
 *   多字段订阅可配合 `useShallow`（zustand/react/shallow）避免引用变化误触发。
 *   App.tsx（F-047）已按此模式重构，不再调用本 hook。
 */
export function useRouteDev() {
  return useRouteDevStore();
}
