// desktop/renderer/src/components/chat/ToolConfirmDialog.tsx
// 工具确认弹窗：工具调用需要确认时弹出，支持 ask_user 问答模式
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致

import { useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import type { PendingConfirm } from '../../store/useRouteDevStore.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from '../ui/card.js';
import { Textarea } from '../ui/textarea.js';

export function ToolConfirmDialog({
  pending,
  onConfirm,
}: {
  pending: PendingConfirm;
  onConfirm: (approved: boolean, payload?: unknown) => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [collapsed, setCollapsed] = useState(false);
  const rawQuestions = Array.isArray(pending.params.questions)
    ? pending.params.questions
    : pending.params.question
      ? [pending.params.question]
      : [];
  const questions = rawQuestions
    .map((item) => typeof item === 'string' ? item : String((item as Record<string, unknown>)?.question ?? (item as Record<string, unknown>)?.content ?? ''))
    .filter(Boolean);
  const isQuestionMode = pending.toolName === 'ask_user' || pending.toolName === 'ask_question' || questions.length > 0;

  if (isQuestionMode) {
    const currentQuestion = questions[questionIndex] ?? '请回答问题';
    return (
      <div className="absolute inset-x-0 bottom-24 z-20 mx-auto w-full max-w-2xl px-4">
        <div className="rounded-2xl border border-rd-primary/30 bg-rd-surface shadow-rdLg">
          <div className="flex items-center justify-between gap-2 border-b border-rd-border/50 px-4 py-3">
            <div className="flex items-center gap-2 text-rd-primary">
              <AlertCircle size={16} />
              <span className="text-sm font-semibold">需要你回答</span>
              {questions.length > 1 && (
                <span className="text-xs text-rd-textSubtle">
                  第 {questionIndex + 1} / {questions.length} 个
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setCollapsed((current) => !current)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
              title={collapsed ? '展开' : '折叠'}
            >
              {collapsed ? <ChevronDown size={14} /> : <ChevronRight size={14} className="-rotate-90" />}
            </button>
          </div>
          {!collapsed && (
            <>
              <div className="space-y-3 px-4 py-3">
                <div className="text-sm leading-relaxed text-rd-text">
                  {currentQuestion}
                </div>
                <Textarea
                  value={answers[questionIndex] ?? ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [questionIndex]: e.target.value }))}
                  placeholder="在这里输入你的回答..."
                  className="min-h-28"
                />
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-rd-border/50 px-4 py-3">
                {questions.length > 1 ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={questionIndex === 0}
                      onClick={() => setQuestionIndex((idx) => Math.max(0, idx - 1))}
                    >
                      上一个
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={questionIndex >= questions.length - 1}
                      onClick={() => setQuestionIndex((idx) => Math.min(questions.length - 1, idx + 1))}
                    >
                      下一个
                    </Button>
                  </div>
                ) : (
                  <div />
                )}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => onConfirm(false)}>取消</Button>
                  <Button size="sm" onClick={() => onConfirm(true, { answers, questions })}>提交</Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-x-0 bottom-24 z-10 mx-auto w-full max-w-2xl px-4">
      <Card className="border-rd-warning/30 shadow-lg">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 text-rd-warning">
            <AlertCircle size={18} />
            <CardTitle className="text-base">工具调用需要确认</CardTitle>
          </div>
          <CardDescription>
            工具名：
            <code className="ml-1 rounded bg-rd-surface px-1 py-0.5 font-mono text-rd-primary">
              {pending.toolName}
            </code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-40 overflow-auto rounded-lg bg-rd-surface p-3 text-xs text-rd-textMuted">
            {JSON.stringify(pending.params, null, 2)}
          </pre>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" onClick={() => onConfirm(false)}>
            拒绝
          </Button>
          <Button onClick={() => onConfirm(true)}>批准</Button>
        </CardFooter>
      </Card>
    </div>
  );
}
