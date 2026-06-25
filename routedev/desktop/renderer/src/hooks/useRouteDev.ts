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
 */
export function useRouteDev() {
  return useRouteDevStore();
}
