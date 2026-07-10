// desktop/renderer/src/hooks/useAutoSave.ts
// Phase 74-G：SettingsPage 的自动保存 + 实时预览 + 卸载恢复 + 保存提示
// 从 SettingsPage.tsx 迁移，保留所有原逻辑与函数签名

import { useState, useEffect, type RefObject, type Dispatch, type SetStateAction } from 'react';
import type { AppConfig } from '../../../shared/config-types.js';
import type { ConfigSaveResult } from '../../../shared/ipc-types.js';
import { cleanDraftForSave, deepClone } from '../pages/settings-helpers.js';

/** 保存提示类型 */
export type SaveResult = { success: boolean; message: string } | null;

interface UseAutoSaveOptions {
  /** 当前 draft（来自 useSettingsDraft） */
  draft: AppConfig | null;
  /** draft setter（来自 useSettingsDraft，用于保存后回写） */
  setDraft: Dispatch<SetStateAction<AppConfig | null>>;
  /** 脏标记 ref（来自 useSettingsDraft，标识是否有未保存改动） */
  dirtyRef: RefObject<boolean>;
  /** 跳过同步标记 ref（来自 useSettingsDraft，保存成功后跳过一次 config→draft 同步） */
  skipSyncRef: RefObject<boolean>;
  /** 已保存的 config（用于卸载时恢复预览主题） */
  config: AppConfig | null;
  /** 保存配置的 IPC 调用 */
  saveConfig: (cfg: AppConfig) => Promise<ConfigSaveResult>;
  /** 热重载配置（可选，saveConfig 内部已自动 reload） */
  reloadConfig?: () => Promise<void>;
  /** 保存提示状态（由主组件管理，因 useSettingsDraft 的 onClearSaveResult 需引用） */
  saveResult: SaveResult;
  /** 保存提示 setter（同上，由主组件管理） */
  setSaveResult: (result: SaveResult) => void;
}

/**
 * SettingsPage 自动保存 hook
 * 包含：handleSave + 4 个 useEffect
 *  - 700ms 防抖自动保存
 *  - 主题/字体实时预览
 *  - 卸载时恢复到 config 的主题
 *  - 保存提示 3 秒后自动消失
 * 注：saveResult/saveResult 由主组件管理，本 hook 仅消费并触发其变化
 */
export function useAutoSave({
  draft, setDraft, dirtyRef, skipSyncRef,
  config, saveConfig, reloadConfig, saveResult, setSaveResult,
}: UseAutoSaveOptions) {
  const [saving, setSaving] = useState(false);

  // 保存提示 3 秒后自动消失（必须放在 early return 之前，否则 hooks 数量不一致会触发 React #310）
  useEffect(() => {
    if (!saveResult) return;
    const timer = setTimeout(() => setSaveResult(null), 3000);
    return () => clearTimeout(timer);
  }, [saveResult, setSaveResult]);

  // --- 保存配置 ---
  const handleSave = async (silent = false) => {
    if (!draft) return;
    // Phase 74-G：保存前清理逻辑已抽离到 settings-helpers.ts 的 cleanDraftForSave
    const cleanedDraft = cleanDraftForSave(draft);
    setSaving(true);
    const result = await saveConfig(cleanedDraft);
    // G-016：saveConfig 仅更新内存，需显式调用 reloadConfig 才能重建 deps
    // 仅当主进程标记 needsReload 时才调用，避免无谓的重载
    if (result.success && result.needsReload && reloadConfig) {
      try {
        await reloadConfig();
      } catch (err) {
        console.error('[SettingsPage] reloadConfig 失败:', err);
        setSaving(false);
        setSaveResult({
          success: true,
          message: `配置已保存，但热重载失败: ${err instanceof Error ? err.message : String(err)}。重启应用后生效。`,
        });
        return;
      }
    }
    setSaving(false);
    if (!silent || !result.success) {
      setSaveResult({
        success: result.success,
        message: result.success ? '配置已自动保存并热重载' : `保存失败: ${result.error ?? '未知错误'}`,
      });
    }
    // 保存成功后跳过 config→draft 同步，保留用户正在编辑的 draft
    // draft 保留原始内容（包括未通过校验的 Provider），避免用户看到表单清空
    if (result.success) {
      skipSyncRef.current = true;
      dirtyRef.current = false;
      // 用 cleanedDraft 更新 draft（已保存的有效 Provider 用清理后的版本）
      // 但保留未通过校验的 Provider，让用户继续编辑
      const failedProviders = draft.providers.filter((p) => !p.apiKey.trim());
      setDraft(deepClone({ ...cleanedDraft, providers: [...cleanedDraft.providers, ...failedProviders], router: { ...cleanedDraft.router, fallbackChain: draft.router.fallbackChain ?? [] } }));
    }
  };

  // 700ms 防抖自动保存：draft 变化且 dirtyRef 为 true 时触发
  useEffect(() => {
    if (!draft || !dirtyRef.current) return;
    const timer = setTimeout(() => {
      void handleSave(true);
    }, 700);
    return () => clearTimeout(timer);
    // 注：handleSave 是闭包内函数，不放入依赖数组以避免每次渲染都重新计时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // 主题和字体大小实时预览：draft 变化时立即应用到 <html>，无需先保存
  useEffect(() => {
    if (!draft) return;
    const root = document.documentElement;
    root.setAttribute('data-theme', draft.general.appearanceTheme);
    root.style.setProperty('--rd-font-size', `${draft.general.fontSize}px`);
  }, [draft?.general.appearanceTheme, draft?.general.fontSize]);

  // 组件卸载时恢复到已保存的 config 值（若用户未保存则回退预览）
  useEffect(() => {
    return () => {
      if (config) {
        const root = document.documentElement;
        root.setAttribute('data-theme', config.general.appearanceTheme);
        root.style.setProperty('--rd-font-size', `${config.general.fontSize}px`);
      }
    };
  }, [config]);

  return {
    saving,
    handleSave,
  };
}
