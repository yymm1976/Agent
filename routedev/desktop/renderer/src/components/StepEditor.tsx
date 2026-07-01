// desktop/renderer/src/components/StepEditor.tsx
// Phase 54：计划编辑器——semi/manual 模式下用户审查/修改 /goal 计划步骤
// 触发：goal-runner.requestPlanEdit → IPC plan:edit-request → store.pendingPlanEdit
// 确认/取消 → store.confirmPlanEdit / cancelPlanEdit → IPC plan:edit-response
//
// 设计原则：
//   - 独立 modal（覆盖在 ChatPage 上），符合用户偏好"独立 modal 设置页"
//   - 圆角、紫色主题、lucide-react 线性图标
//   - 大按钮 + 文字标签（不用纯图标按钮）
//   - 步骤描述用 textarea 可直接编辑；acceptanceCriteria 折叠展示
//   - 顶部显示目标描述 + 验证条件，提供上下文
// Phase 54 阶段三：每步支持手动指定子 Agent 角色（researcher/executor/reviewer）

import { useState, useEffect } from 'react';
import {
  Target, Check, X, ChevronDown, ChevronRight,
  ListChecks, ShieldCheck, GripVertical,
  Search, Code2, Eye,
} from 'lucide-react';
import { Button } from './ui/button.js';
import { useRouteDevStore } from '../store/useRouteDevStore.js';

/** Phase 54 阶段三：子 Agent 角色定义 */
type SuggestedRole = 'researcher' | 'executor' | 'reviewer';

const ROLE_OPTIONS: { value: SuggestedRole; label: string; icon: typeof Search }[] = [
  { value: 'researcher', label: '调研', icon: Search },
  { value: 'executor', label: '执行', icon: Code2 },
  { value: 'reviewer', label: '审查', icon: Eye },
];

/** Phase 54 阶段三：紧凑的角色选择 pill 按钮组 */
function RoleSelector({
  value,
  onChange,
}: {
  value: SuggestedRole;
  onChange: (role: SuggestedRole) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-rdSm bg-rd-surfaceHover/40 p-0.5">
      {ROLE_OPTIONS.map(opt => {
        const active = value === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={[
              'flex items-center gap-1 rounded-rdSm px-2 py-1 text-xs font-medium transition',
              active
                ? 'bg-rd-primary/15 text-rd-primary shadow-sm'
                : 'text-rd-textSubtle hover:text-rd-text hover:bg-rd-surfaceHover',
            ].join(' ')}
            aria-pressed={active}
            title={`${opt.label}角色`}
          >
            <Icon size={11} strokeWidth={1.75} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** 单个步骤的编辑行 */
function EditableStepRow({
  step,
  index,
  onChange,
}: {
  step: { id: number; description: string; acceptanceCriteria?: string; dependencies: number[]; suggestedRole?: SuggestedRole };
  index: number;
  onChange: (updated: { description: string; acceptanceCriteria?: string; dependencies: number[]; suggestedRole?: SuggestedRole }) => void;
}) {
  const [showCriteria, setShowCriteria] = useState(false);
  const hasCriteria = !!step.acceptanceCriteria && step.acceptanceCriteria.trim().length > 0;
  // Phase 54 阶段三：角色默认 executor（LLM 未输出 suggestedRole 时）
  const currentRole: SuggestedRole = step.suggestedRole ?? 'executor';

  return (
    <div className="rounded-rdMd border border-rd-border/60 bg-rd-card/40 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <GripVertical size={14} strokeWidth={1.5} className="shrink-0 mt-1 text-rd-textSubtle" />
        <span className="shrink-0 mt-1 w-6 h-6 rounded-full bg-rd-primary/10 text-rd-primary text-xs font-semibold flex items-center justify-center">
          {index + 1}
        </span>
        <textarea
          value={step.description}
          onChange={(e) => onChange({
            description: e.target.value,
            acceptanceCriteria: step.acceptanceCriteria,
            dependencies: step.dependencies,
            suggestedRole: currentRole,
          })}
          rows={2}
          className="flex-1 resize-y rounded-rdSm bg-rd-surfaceHover/50 px-2.5 py-1.5 text-sm text-rd-text outline-none focus:bg-rd-surfaceHover focus:ring-1 focus:ring-rd-primary/40 transition"
          placeholder="步骤描述"
          aria-label={`步骤 ${index + 1} 描述`}
        />
      </div>
      {/* Phase 54 阶段三：角色选择 + 依赖关系 */}
      <div className="mt-1.5 ml-12 flex items-center gap-3 flex-wrap">
        <RoleSelector
          value={currentRole}
          onChange={(role) => onChange({
            description: step.description,
            acceptanceCriteria: step.acceptanceCriteria,
            dependencies: step.dependencies,
            suggestedRole: role,
          })}
        />
        {step.dependencies.length > 0 && (
          <span className="text-xs text-rd-textSubtle">
            依赖: {step.dependencies.map(d => `#${d}`).join(' → ')}
          </span>
        )}
      </div>
      {/* 验收标准：可折叠展示（只读，由 GoalParser 生成，用户一般不修改） */}
      {hasCriteria && (
        <div className="mt-1.5 ml-12">
          <button
            type="button"
            onClick={() => setShowCriteria(v => !v)}
            className="flex items-center gap-1 text-xs text-rd-textSubtle hover:text-rd-text transition"
          >
            {showCriteria ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
            <ShieldCheck size={12} strokeWidth={1.5} />
            验收标准
          </button>
          {showCriteria && (
            <div className="mt-1 ml-4 text-xs text-rd-textMuted break-all bg-rd-surfaceHover/30 rounded-rdSm px-2 py-1">
              {step.acceptanceCriteria}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Phase 54：计划编辑器 Modal */
export function StepEditor() {
  const pendingPlanEdit = useRouteDevStore(s => s.pendingPlanEdit);
  const confirmPlanEdit = useRouteDevStore(s => s.confirmPlanEdit);
  const cancelPlanEdit = useRouteDevStore(s => s.cancelPlanEdit);

  // 本地编辑态（深拷贝 steps，避免直接修改 store）
  const [editedSteps, setEditedSteps] = useState<
    { id: number; description: string; acceptanceCriteria?: string; dependencies: number[]; suggestedRole?: SuggestedRole }[]
  >([]);

  // pendingPlanEdit 变化时同步到本地编辑态
  useEffect(() => {
    if (pendingPlanEdit) {
      setEditedSteps(pendingPlanEdit.plan.steps.map(s => ({ ...s })));
    }
  }, [pendingPlanEdit]);

  // Esc 键取消（所有 Hooks 必须在条件返回之前调用，遵守 Rules of Hooks）
  useEffect(() => {
    if (!pendingPlanEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelPlanEdit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingPlanEdit, cancelPlanEdit]);

  // 无待编辑计划时不渲染
  if (!pendingPlanEdit) return null;

  const { plan } = pendingPlanEdit;

  const handleStepChange = (index: number, updated: { description: string; acceptanceCriteria?: string; dependencies: number[]; suggestedRole?: SuggestedRole }) => {
    setEditedSteps(prev => prev.map((s, i) => i === index ? { ...s, ...updated } : s));
  };

  const handleConfirm = () => {
    // 过滤掉空描述的步骤（防御性），保留 id/dependencies
    const validSteps = editedSteps.filter(s => s.description.trim().length > 0);
    confirmPlanEdit(validSteps);
  };

  const handleCancel = () => {
    cancelPlanEdit();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleCancel}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-rdLg bg-rd-card shadow-rdLg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-rd-border/60">
          <Target size={18} strokeWidth={1.5} className="shrink-0 text-rd-primary" />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-rd-text truncate">审查与编辑计划</h2>
            <p className="text-xs text-rd-textSubtle truncate mt-0.5">{plan.description}</p>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="shrink-0 text-rd-textSubtle hover:text-rd-text transition"
            aria-label="关闭"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        {/* 验证条件（如有） */}
        {plan.verificationCriteria && (
          <div className="px-5 py-2.5 border-b border-rd-border/40 bg-rd-surfaceHover/20">
            <div className="flex items-start gap-2">
              <ShieldCheck size={14} strokeWidth={1.5} className="shrink-0 mt-0.5 text-rd-success" />
              <div className="min-w-0">
                <div className="text-xs font-medium text-rd-text">验证条件</div>
                <div className="text-xs text-rd-textMuted break-all mt-0.5">{plan.verificationCriteria}</div>
              </div>
            </div>
          </div>
        )}

        {/* 步骤列表（可滚动） */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-rd-textSubtle">
            <ListChecks size={13} strokeWidth={1.5} />
            <span>共 {editedSteps.length} 个步骤 · 可编辑描述与角色</span>
          </div>
          <div className="space-y-2">
            {editedSteps.map((step, i) => (
              <EditableStepRow
                key={step.id}
                step={step}
                index={i}
                onChange={(updated) => handleStepChange(i, updated)}
              />
            ))}
          </div>
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-rd-border/60">
          <span className="text-xs text-rd-textSubtle">Esc 取消 · 确认后将开始执行</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleCancel}>
              <X size={14} strokeWidth={1.5} />
              取消
            </Button>
            <Button variant="default" size="sm" onClick={handleConfirm}>
              <Check size={14} strokeWidth={1.5} />
              确认执行
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
