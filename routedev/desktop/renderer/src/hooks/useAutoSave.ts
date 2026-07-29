// desktop/renderer/src/hooks/useAutoSave.ts
// Phase 74-G：SettingsPage 的自动保存 + 实时预览 + 卸载恢复 + 保存提示
// 从 SettingsPage.tsx 迁移，保留所有原逻辑与函数签名

import { useState, useEffect, type RefObject, type Dispatch, type SetStateAction } from 'react';
import type { AppConfig } from '../../../shared/config-types.js';
import type { ConfigSaveResult } from '../../../shared/ipc-types.js';
import { cleanDraftForSave } from '../pages/settings-helpers.js';

/** 保存提示类型 */
export type SaveResult = { success: boolean; message: string } | null;

interface UseAutoSaveOptions {
  /** 当前 draft（来自 useSettingsDraft） */
  draft: AppConfig | null;
  /** draft setter（来自 useSettingsDraft，用于保存后回写） */
  setDraft: Dispatch<SetStateAction<AppConfig | null>>;
  /** 脏标记 ref（来自 useSettingsDraft，标识是否有未保存改动） */
  dirtyRef: RefObject<boolean>;
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
  draft, setDraft, dirtyRef,
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
    // store.saveConfig 内部已调用 config:reload 并更新 store.config，
    // 此处无需再调用 reloadConfig，避免双重 reload 导致 config 引用二次变化
    const result = await saveConfig(cleanedDraft);
    setSaving(false);
    if (!silent || !result.success) {
      setSaveResult({
        success: result.success,
        message: result.success ? '配置已自动保存并热重载' : `保存失败: ${result.error ?? '未知错误'}`,
      });
    }
    if (result.success) {
      // 保存成功：重置 dirtyRef，让 config→draft 同步 effect 能正常工作
      // store.saveConfig 内部已 reload，config 变化会触发 useSettingsDraft 同步 draft
      // useSettingsDraft 的 dirtyRef 守卫会保护用户在同步窗口内的编辑
      dirtyRef.current = false;
    } else {
      // Bug 修复：保存失败时保留 dirtyRef=true，确保用户后续编辑或手动保存能再次触发
      // 之前重置 dirtyRef=false 会导致用户不修改字段就无法再次自动保存
      // 保存失败的原因可能是临时性的（如 URL 输入到一半 schema 校验失败），
      // 保留 dirtyRef 让用户继续编辑后能自动重试保存
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

  // 主题、字体大小和主题色实时预览：draft 变化时立即应用到 <html>，无需先保存
  useEffect(() => {
    if (!draft) return;
    const root = document.documentElement;
    root.setAttribute('data-theme', draft.general.appearanceTheme);
    root.style.setProperty('--rd-font-size', `${draft.general.fontSize}px`);
    // 同步主题色到 CSS 变量，留空则清除自定义值回退到预设
    root.style.setProperty('--rd-primary', draft.general.accentColor || '');
  }, [draft?.general.appearanceTheme, draft?.general.fontSize, draft?.general.accentColor]);

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
