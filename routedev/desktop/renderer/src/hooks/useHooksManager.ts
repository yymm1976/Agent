// desktop/renderer/src/hooks/useHooksManager.ts
// Phase 74-G：SettingsPage 的 Hook 管理 hook
// 从 SettingsPage.tsx 迁移，保留所有原逻辑与函数签名

import { useState, useEffect } from 'react';
import type { HookInfo } from '../../../shared/ipc-types.js';
import type { ConfirmDialogState } from './useSkillsManager.js';

interface UseHooksManagerOptions {
  /** 当前激活的 Tab id（用于触发 Hooks Tab 懒加载） */
  activeTab: string;
  /** 替代原生 alert 的消息 setter */
  setAlertMsg: (msg: string | null) => void;
  /** 确认对话框 setter */
  setConfirmDialog: (dialog: ConfirmDialogState | null) => void;
}

/**
 * Hooks 管理 hook
 * 包含：3 个 state + 4 个 handler + 进入 Hooks Tab 加载 useEffect
 */
export function useHooksManager({ activeTab, setAlertMsg, setConfirmDialog }: UseHooksManagerOptions) {
  const [hooks, setHooks] = useState<HookInfo[]>([]);
  const [hookLoading, setHookLoading] = useState(false);
  const [hookCreateForm, setHookCreateForm] = useState<{ description: string; generating: boolean; generated: { name: string; event: string; content: string } | null } | null>(null);

  // Phase 39：进入 Hooks Tab 时加载 Hook 列表
  useEffect(() => {
    if (activeTab !== 'hooks') return;
    refreshHooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  /** 刷新 Hook 列表 */
  const refreshHooks = async () => {
    setHookLoading(true);
    try {
      const list = await window.routedev.hook.list();
      setHooks(list);
    } catch (err) {
      // eslint-disable-next-line no-console -- 渲染层日志，logger 为 Node-only 模块无法在浏览器导入
      console.error('加载 Hook 列表失败:', err);
    } finally {
      setHookLoading(false);
    }
  };

  /** 切换 Hook 启用/禁用 */
  const handleHookToggle = async (hookId: string, enabled: boolean) => {
    const result = await window.routedev.hook.toggle(hookId, enabled);
    if (result.success) {
      setHooks((prev) => prev.map((h) => h.id === hookId ? { ...h, enabled } : h));
    } else {
      setAlertMsg(`切换失败: ${result.error}`);
    }
  };

  /** 删除自定义 Hook */
  const handleHookDelete = async (hookId: string) => {
    setConfirmDialog({
      message: `确定删除 Hook "${hookId}" 吗？此操作不可恢复。`,
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        const result = await window.routedev.hook.delete(hookId);
        if (result.success) {
          await refreshHooks();
        } else {
          setAlertMsg(`删除失败: ${result.error}`);
        }
      },
    });
  };

  /** 创建 Hook（自定义模式：把描述作为 shell 命令直接保存）
   *  注：原 HookGenerator（LLM 生成）已移除，UI 改为模板选择 + 自定义命令两种模式
   *  当前 UI 仍保留描述输入框，但将其作为自定义 shell 命令保存（用户自担风险）
   */
  const handleHookAiGenerate = async () => {
    if (!hookCreateForm || !hookCreateForm.description.trim()) return;
    setHookCreateForm({ ...hookCreateForm, generating: true });
    try {
      const desc = hookCreateForm.description.trim();
      // 把描述前 30 字符作为 name，整个描述作为 code（shell 命令）
      // 注：自然语言描述作为 shell 命令通常会失败，建议用户在描述中直接输入 shell 命令
      const result = await window.routedev.hook.create({
        name: desc.slice(0, 30),
        event: 'post-tool-call',
        code: desc,
        description: desc,
      });
      if (result.success && result.hookId) {
        setHookCreateForm(null);
        await refreshHooks();
      } else {
        setAlertMsg(`创建失败: ${result.error}`);
      }
    } catch (err) {
      setAlertMsg(`创建失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (hookCreateForm) {
        setHookCreateForm({ ...hookCreateForm, generating: false });
      }
    }
  };

  return {
    hooks, setHooks,
    hookLoading,
    hookCreateForm, setHookCreateForm,
    refreshHooks,
    handleHookToggle,
    handleHookDelete,
    handleHookAiGenerate,
  };
}
