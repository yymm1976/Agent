// desktop/renderer/src/components/settings/SettingsSkillsTab.tsx
// Phase 74-G：Skill 技能管理 Tab（列表 + 路由测试 + 创建/AI 生成 + 预览模态）
// 从 SettingsPage.tsx 迁移

import type { Dispatch, SetStateAction } from 'react';
import { BookOpen, RefreshCw, Sparkles, Plus, Wand2, Code, Eye, Trash2, X } from 'lucide-react';
import type { SkillInfo, SkillPreview } from '../../../../shared/ipc-types.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Badge } from '../ui/badge.js';
import { Switch } from '../ui/switch.js';

/** Skill 创建表单状态 */
interface SkillFormState {
  name: string;
  description: string;
  keywords: string;
  content: string;
}

/** Skill AI 生成表单状态 */
interface SkillAiFormState {
  description: string;
  generating: boolean;
  generated: { name: string; description: string; keywords: string; content: string } | null;
}

/** Skill 路由测试状态 */
interface SkillRouteTestState {
  query: string;
  results: SkillInfo[];
}

interface SettingsSkillsTabProps {
  /** Skill 列表 */
  skills: SkillInfo[];
  /** Skill 加载中 */
  skillLoading: boolean;
  /** Skill 预览模态状态 */
  skillPreview: SkillPreview | null;
  /** 设置 Skill 预览模态状态 */
  setSkillPreview: Dispatch<SetStateAction<SkillPreview | null>>;
  /** Skill 创建表单状态 */
  skillForm: SkillFormState | null;
  /** 设置 Skill 创建表单状态 */
  setSkillForm: Dispatch<SetStateAction<SkillFormState | null>>;
  /** Skill 路由测试状态 */
  skillRouteTest: SkillRouteTestState | null;
  /** 设置 Skill 路由测试状态 */
  setSkillRouteTest: Dispatch<SetStateAction<SkillRouteTestState | null>>;
  /** Skill AI 生成表单状态 */
  skillAiForm: SkillAiFormState | null;
  /** 设置 Skill AI 生成表单状态 */
  setSkillAiForm: Dispatch<SetStateAction<SkillAiFormState | null>>;
  /** 重新发现 Skill */
  handleSkillReload: () => void;
  /** 切换 Skill 启用/禁用 */
  handleSkillToggle: (name: string, enabled: boolean) => void;
  /** 预览 Skill */
  handleSkillPreview: (name: string) => void;
  /** 删除 Skill */
  handleSkillDelete: (name: string) => void;
  /** 测试 Skill 路由匹配 */
  handleSkillRouteTest: () => void;
  /** 创建 Skill */
  handleSkillCreate: () => void;
  /** Skill AI 自动生成 */
  handleSkillAiGenerate: () => void;
  /** 替代原生 alert 的消息 setter（用于"从代码学习"按钮提示） */
  setAlertMsg: (msg: string | null) => void;
}

/**
 * Skill 技能管理 Tab
 * 包含：说明卡片、Skill 列表、路由测试、创建表单、AI 生成表单、预览模态
 */
export function SettingsSkillsTab({
  skills,
  skillLoading,
  skillPreview,
  setSkillPreview,
  skillForm,
  setSkillForm,
  skillRouteTest,
  setSkillRouteTest,
  skillAiForm,
  setSkillAiForm,
  handleSkillReload,
  handleSkillToggle,
  handleSkillPreview,
  handleSkillDelete,
  handleSkillRouteTest,
  handleSkillCreate,
  handleSkillAiGenerate,
  setAlertMsg,
}: SettingsSkillsTabProps) {
  return (
    <>
      <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
        {/* 说明卡片 */}
        <Card>
          <CardContent className="flex items-start justify-between gap-4 py-6">
            <div className="flex items-start gap-3">
              <BookOpen size={20} className="mt-0.5 shrink-0 text-rd-primary" />
              <div>
                <Label>Skill 技能系统</Label>
                <p className="text-xs text-rd-textMuted mt-1">
                  Skill 是按需加载的 Markdown 程序，框架根据任务描述自动匹配并注入相关 Skill 内容到上下文。
                  只有匹配的 Skill 才会消耗 token，未匹配的不会影响上下文预算。
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleSkillReload} disabled={skillLoading}>
              <RefreshCw size={14} className={skillLoading ? 'animate-spin' : ''} />
              重新发现
            </Button>
          </CardContent>
        </Card>

        {/* Skill 列表 */}
        {skills.length === 0 && !skillLoading && (
          <Card>
            <CardContent className="py-12 text-center">
              <BookOpen size={32} className="mx-auto mb-3 text-rd-textSubtle" />
              <p className="text-sm text-rd-textMuted">
                未发现任何 Skill。Skill 文件约定放在 <code className="rounded bg-rd-surfaceHover px-1.5 py-0.5 text-xs">.routedev/skills/&lt;name&gt;/SKILL.md</code>
              </p>
            </CardContent>
          </Card>
        )}

        {skills.map((skill) => (
          <Card key={skill.name}>
            <CardContent className="py-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-semibold text-rd-text">{skill.name}</span>
                    <Badge variant={skill.enabled ? 'primary' : 'outline'}>
                      {skill.enabled ? '已启用' : '已禁用'}
                    </Badge>
                  </div>
                  <p className="text-sm text-rd-textMuted line-clamp-2">{skill.description}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {skill.routingKeywords.slice(0, 8).map((kw) => (
                      <span key={kw} className="rounded-md bg-rd-surfaceHover px-2 py-0.5 text-xs text-rd-textSubtle">
                        {kw}
                      </span>
                    ))}
                    {skill.routingKeywords.length > 8 && (
                      <span className="text-xs text-rd-textSubtle">+{skill.routingKeywords.length - 8}</span>
                    )}
                  </div>
                  <p className="text-xs text-rd-textSubtle font-mono truncate">{skill.sourcePath}</p>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <Switch
                    checked={skill.enabled}
                    onCheckedChange={(checked) => handleSkillToggle(skill.name, checked)}
                  />
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleSkillPreview(skill.name)}>
                      <Eye size={14} /> 预览
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                      onClick={() => handleSkillDelete(skill.name)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {/* 路由测试 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles size={16} className="text-rd-primary" />
              Skill 路由测试
            </CardTitle>
            <CardDescription>输入任务描述，查看哪些 Skill 会被自动匹配</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder="例如：实现一个新的用户认证功能"
                value={skillRouteTest?.query ?? ''}
                onChange={(e) => setSkillRouteTest({ query: e.target.value, results: skillRouteTest?.results ?? [] })}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSkillRouteTest(); }}
              />
              <Button onClick={handleSkillRouteTest} disabled={!skillRouteTest?.query.trim()}>
                测试
              </Button>
            </div>
            {skillRouteTest?.results && skillRouteTest.results.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-rd-textMuted">匹配到 {skillRouteTest.results.length} 个 Skill：</p>
                {skillRouteTest.results.map((s) => (
                  <div key={s.name} className="flex items-center gap-2 rounded-lg bg-rd-surfaceHover px-3 py-2">
                    <Badge variant="primary">{s.name}</Badge>
                    <span className="text-xs text-rd-textMuted truncate">{s.description}</span>
                  </div>
                ))}
              </div>
            )}
            {skillRouteTest?.results && skillRouteTest.results.length === 0 && (
              <p className="text-xs text-rd-textMuted">无匹配的 Skill</p>
            )}
          </CardContent>
        </Card>

        {/* 创建 Skill 表单 */}
        {skillForm === null && skillAiForm === null ? (
          <div className="flex gap-2">
            <Button
              onClick={() => setSkillForm({ name: '', description: '', keywords: '', content: '' })}
              className="flex-1"
            >
              <Plus size={16} /> 创建新 Skill
            </Button>
            <Button
              variant="outline"
              onClick={() => setSkillAiForm({ description: '', generating: false, generated: null })}
              className="flex-1"
            >
              <Wand2 size={16} /> AI 生成 Skill
            </Button>
            <Button
              variant="outline"
              onClick={() => setAlertMsg('从代码学习功能由其他子代理负责实现，敬请期待')}
              className="flex-1"
            >
              <Code size={16} /> 从代码学习
            </Button>
          </div>
        ) : null}

        {/* Phase 39：Skill AI 自动生成对话框 */}
        {skillAiForm !== null && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wand2 size={16} className="text-rd-primary" />
                AI 自动生成 Skill
              </CardTitle>
              <CardDescription>
                输入自然语言描述，AI 将自动生成 Skill 内容
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="skill-ai-desc">描述你想要的 Skill</Label>
                <textarea
                  id="skill-ai-desc"
                  className="w-full rounded-md border border-rd-border bg-rd-background px-3 py-2 text-sm text-rd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40 focus-visible:border-rd-primary/70"
                  rows={4}
                  value={skillAiForm.description}
                  onChange={(e) => setSkillAiForm({ ...skillAiForm, description: e.target.value })}
                  placeholder="例如：当用户要求实现 REST API 时，自动遵循项目的控制器-服务-仓库分层模式"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={handleSkillAiGenerate}
                  disabled={!skillAiForm.description.trim() || skillAiForm.generating}
                >
                  {skillAiForm.generating ? <RefreshCw size={16} className="animate-spin" /> : <Wand2 size={16} />}
                  生成 Skill
                </Button>
                <Button variant="ghost" onClick={() => setSkillAiForm(null)}>
                  <X size={16} /> 取消
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {skillForm !== null && (
          <Card>
            <CardHeader>
              <CardTitle>创建新 Skill</CardTitle>
              <CardDescription>
                Skill 文件将创建在 <code className="text-xs">.routedev/skills/&lt;name&gt;/SKILL.md</code>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="skill-form-name">名称（仅字母、数字、连字符）</Label>
                  <Input
                    id="skill-form-name"
                    value={skillForm.name}
                    onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })}
                    placeholder="例如 my-skill"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="skill-form-desc">描述（作为路由提示）</Label>
                  <Input
                    id="skill-form-desc"
                    value={skillForm.description}
                    onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })}
                    placeholder="当用户...时使用此 Skill"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="skill-form-keywords">路由关键词（逗号分隔）</Label>
                <Input
                  id="skill-form-keywords"
                  value={skillForm.keywords}
                  onChange={(e) => setSkillForm({ ...skillForm, keywords: e.target.value })}
                  placeholder="关键词1, 关键词2, keyword3"
                />
                <p className="text-xs text-rd-textMuted">任务描述包含这些关键词时触发匹配，每个关键词 +10 分</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="skill-form-content">Skill 内容（Markdown）</Label>
                <textarea
                  id="skill-form-content"
                  className="w-full rounded-md border border-rd-border bg-rd-background px-3 py-2 text-sm text-rd-text font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40 focus-visible:border-rd-primary/70"
                  rows={10}
                  value={skillForm.content}
                  onChange={(e) => setSkillForm({ ...skillForm, content: e.target.value })}
                  placeholder="# Skill 标题&#10;&#10;Skill 的具体指令内容..."
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={handleSkillCreate}
                  disabled={!skillForm.name || !skillForm.description}
                >
                  <Plus size={16} /> 创建
                </Button>
                <Button variant="ghost" onClick={() => setSkillForm(null)}>
                  <X size={16} /> 取消
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Skill 预览模态 */}
      {skillPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setSkillPreview(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-rd-background shadow-rdLg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-rd-border px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold text-rd-text">{skillPreview.name}</h2>
                <p className="text-xs text-rd-textMuted">{skillPreview.sourcePath}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSkillPreview(null)}>
                <X size={18} />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="mb-4 space-y-2">
                <div>
                  <span className="text-xs font-semibold text-rd-textSubtle">描述</span>
                  <p className="text-sm text-rd-text mt-0.5">{skillPreview.description}</p>
                </div>
                <div>
                  <span className="text-xs font-semibold text-rd-textSubtle">关键词</span>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {skillPreview.routingKeywords.map((kw) => (
                      <span key={kw} className="rounded-md bg-rd-surfaceHover px-2 py-0.5 text-xs text-rd-textSubtle">
                        {kw}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <span className="text-xs font-semibold text-rd-textSubtle">内容</span>
                <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-rd-surfaceHover p-4 text-sm text-rd-text font-mono">
                  {skillPreview.content}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
