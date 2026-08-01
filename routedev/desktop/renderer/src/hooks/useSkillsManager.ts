// desktop/renderer/src/hooks/useSkillsManager.ts
// Phase 74-G：SettingsPage 的 Skill 管理 hook
// 从 SettingsPage.tsx 迁移，保留所有原逻辑与函数签名

import { useState, useEffect } from 'react';
import type { SkillInfo, SkillPreview } from '../../../shared/ipc-types.js';

/** 确认对话框状态（主组件管理，本 hook 仅引用 setConfirmDialog） */
export interface ConfirmDialogState {
  message: string;
  variant?: 'default' | 'danger';
  onConfirm: () => void;
}

interface UseSkillsManagerOptions {
  /** 当前激活的 Tab id（用于触发 Skills Tab 懒加载） */
  activeTab: string;
  /** 替代原生 alert 的消息 setter */
  setAlertMsg: (msg: string | null) => void;
  /** 确认对话框 setter */
  setConfirmDialog: (dialog: ConfirmDialogState | null) => void;
}

/**
 * Skills 管理 hook
 * 包含：6 个 state + 8 个 handler + 进入 Skills Tab 加载 useEffect
 */
export function useSkillsManager({ activeTab, setAlertMsg, setConfirmDialog }: UseSkillsManagerOptions) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillPreview, setSkillPreview] = useState<SkillPreview | null>(null);
  const [skillForm, setSkillForm] = useState<{ name: string; description: string; keywords: string; content: string } | null>(null);
  const [skillRouteTest, setSkillRouteTest] = useState<{ query: string; results: SkillInfo[] } | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  // Phase 39：Skill AI 自动生成对话框（描述 → 生成 → 确认）
  const [skillAiForm, setSkillAiForm] = useState<{ description: string; generating: boolean; generated: { name: string; description: string; keywords: string; content: string } | null } | null>(null);

  // Phase 37：进入 Skills Tab 时加载 Skill 列表
  useEffect(() => {
    if (activeTab !== 'skills') return;
    refreshSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  /** 刷新 Skill 列表 */
  const refreshSkills = async () => {
    setSkillLoading(true);
    try {
      const list = await window.routedev.skill.list();
      setSkills(list);
    } catch (err) {
      // eslint-disable-next-line no-console -- 渲染层日志，logger 为 Node-only 模块无法在浏览器导入
      console.error('加载 Skill 列表失败:', err);
    } finally {
      setSkillLoading(false);
    }
  };

  /** 切换 Skill 启用/禁用 */
  const handleSkillToggle = async (name: string, enabled: boolean) => {
    const ok = await window.routedev.skill.toggle(name, enabled);
    if (ok) {
      setSkills((prev) => prev.map((s) => s.name === name ? { ...s, enabled } : s));
    }
  };

  /** 预览 Skill */
  const handleSkillPreview = async (name: string) => {
    const preview = await window.routedev.skill.preview(name);
    setSkillPreview(preview);
  };

  /** 创建 Skill */
  const handleSkillCreate = async () => {
    if (!skillForm) return;
    const keywords = skillForm.keywords.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
    const result = await window.routedev.skill.create({
      name: skillForm.name,
      description: skillForm.description,
      keywords,
      content: skillForm.content,
    });
    if (result.success) {
      setSkillForm(null);
      await refreshSkills();
    } else {
      setAlertMsg(`创建失败: ${result.error}`);
    }
  };

  /** 删除 Skill */
  const handleSkillDelete = async (name: string) => {
    setConfirmDialog({
      message: `确定删除 Skill "${name}" 吗？此操作不可恢复。`,
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        const result = await window.routedev.skill.delete(name);
        if (result.success) {
          await refreshSkills();
        } else {
          setAlertMsg(`删除失败: ${result.error}`);
        }
      },
    });
  };

  /** 测试 Skill 路由匹配 */
  const handleSkillRouteTest = async () => {
    if (!skillRouteTest || !skillRouteTest.query.trim()) return;
    const result = await window.routedev.skill.route(skillRouteTest.query);
    setSkillRouteTest({ ...skillRouteTest, results: result.skills });
  };

  /** 重新发现 Skill */
  const handleSkillReload = async () => {
    await window.routedev.skill.reload();
    await refreshSkills();
  };

  /** Skill AI 自动生成（通过自然语言描述） */
  const handleSkillAiGenerate = async () => {
    if (!skillAiForm || !skillAiForm.description.trim()) return;
    setSkillAiForm({ ...skillAiForm, generating: true });
    try {
      // 调用 skill.create，将描述作为内容，自动生成名称和关键词
      const desc = skillAiForm.description.trim();
      const autoName = `ai-${Date.now().toString(36).slice(-6)}`;
      const result = await window.routedev.skill.create({
        name: autoName,
        description: desc,
        keywords: desc.split(/\s+/).filter((w) => w.length > 1).slice(0, 5),
        content: `# ${desc}\n\n本 Skill 由 AI 自动生成，请根据实际需求编辑内容。`,
      });
      if (result.success) {
        setSkillAiForm(null);
        await refreshSkills();
      } else {
        setAlertMsg(`生成失败: ${result.error}`);
      }
    } catch (err) {
      setAlertMsg(`生成失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (skillAiForm) {
        setSkillAiForm({ ...skillAiForm, generating: false });
      }
    }
  };

  return {
    skills, setSkills,
    skillPreview, setSkillPreview,
    skillForm, setSkillForm,
    skillRouteTest, setSkillRouteTest,
    skillLoading,
    skillAiForm, setSkillAiForm,
    refreshSkills,
    handleSkillToggle,
    handleSkillPreview,
    handleSkillCreate,
    handleSkillDelete,
    handleSkillRouteTest,
    handleSkillReload,
    handleSkillAiGenerate,
  };
}
