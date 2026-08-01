// desktop/renderer/src/components/chat/InputArea.tsx
// 输入区：文本输入 + 命令补全 + 自主度切换 + Skill/MCP 状态栏 + 高度调整
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致

import { useRef, useState, useEffect, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Send, Square, Zap, BookOpen, Plug, X, ChevronDown, History,
} from 'lucide-react';
import type { AutonomyMode } from '../../../../shared/config-types.js';
import type { SkillInfo, MCPToolInfo } from '../../../../shared/ipc-types.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Textarea } from '../ui/textarea.js';
import type { ComposerSuggestion } from '../../hooks/useComposerReference.js';
import { useComposerReference } from '../../hooks/useComposerReference.js';

// Phase 97 Part G：命令补全与引用提示合并菜单的条目类型
type MenuItem =
  | { type: 'command'; label: string; hint?: string }
  | { type: 'reference'; ref: ComposerSuggestion };

// 支持的命令列表（Phase 37：扩展为动态获取 + 静态兜底）
// Phase 54：补全 /goal 命令
// Phase 77：补全 /replay /scorecard 命令
// Grok F-016：补全 /doctor 命令（手动触发环境健康检查）
const STATIC_COMMANDS = ['/clear', '/status', '/mcp', '/compact', '/compress', '/help', '/skill', '/skills', '/goal', '/replay', '/scorecard', '/doctor'];
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  '/clear': '清空对话',
  '/status': '查看状态',
  '/mcp': 'MCP 状态',
  '/compact': '压缩上下文',
  '/compress': '压缩上下文（同 /compact）',
  '/help': '帮助',
  '/skill': 'Skill 管理',
  '/skills': 'Skill 列表',
  '/goal': '目标分解与执行（多 Agent 协作）',
  '/replay': '运行回放（面板）',
  '/scorecard': '评分卡（面板）',
  '/doctor': '环境健康检查（探测本地工具 / Provider / MCP / 目录权限）',
};

// 自主度模式标签
const AUTONOMY_LABELS: Record<AutonomyMode, string> = {
  auto: '全自动',
  semi: '半自动',
  manual: '手动确认',
};

export function InputArea({
  isProcessing,
  autonomyMode,
  onAutonomyChange,
  onSubmit,
  onFollowUp,
  onStop,
  focusKey,
}: {
  isProcessing: boolean;
  autonomyMode?: AutonomyMode;
  onAutonomyChange: (mode: AutonomyMode) => Promise<void>;
  /** 提交文本——ChatPage 决定进入队列还是直接发送 */
  onSubmit: (text: string) => void;
  /** 加入 follow-up 队列——ChatPage 处理 IPC 调用 + 队列展开 */
  onFollowUp: (text: string) => void;
  onStop: () => void;
  /** 切换对话时自动聚焦输入框 + 重置本地状态（currentConversationId） */
  focusKey?: string | null;
}) {
  const [input, setInput] = useState('');
  // Phase 97 Part G：光标位置（用于定位当前引用 token）
  const [cursor, setCursor] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuVisible, setCommandMenuVisible] = useState(false);
  // Phase 54 修复：命令菜单位置状态（用 Portal 渲染到 body，避免被祖先 overflow-hidden 裁剪）
  const [commandMenuPos, setCommandMenuPos] = useState<{ top: number; left: number } | null>(null);
  // Phase 54 修复：IME 组合状态——组合期间不触发命令菜单，避免中文输入法干扰
  const [isComposing, setIsComposing] = useState(false);
  // 自主度下拉菜单
  const [autonomyMenuOpen, setAutonomyMenuOpen] = useState(false);
  // 输入区高度（可拖动上边框调整）
  // v3 使用参考界面的紧凑默认高度，避免继承旧版过高输入区。
  // 最小值保护：防止 localStorage 中存储了 0 或负数导致输入区不可见
  const [inputHeight, setInputHeight] = useState<number>(() => {
    const saved = localStorage.getItem('routedev-input-height-v3');
    if (saved) {
      const n = Number(saved);
      if (!isNaN(n) && n >= 116) return Math.min(n, 420);
    }
    // 清除旧版本 key
    localStorage.removeItem('routedev-input-height-v2');
    return 148;
  });
  const [isResizing, setIsResizing] = useState(false);
  // Phase 37：已启用的 Skill 列表和 MCP 工具列表（用于输入框上方 Badge 显示）
  const [enabledSkills, setEnabledSkills] = useState<SkillInfo[]>([]);
  const [mcpTools, setMcpTools] = useState<MCPToolInfo[]>([]);
  const [showSkillBar, setShowSkillBar] = useState(true);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // G-F025: resize 监听器的 AbortController 引用，组件卸载时自动清理
  const resizeAbortRef = useRef<AbortController | null>(null);

  // 切换对话时自动聚焦输入框，避免焦点丢失导致无法点击输入框
  // 无论 isProcessing 状态如何都聚焦：排队队列模式允许用户在引擎工作时输入下一条消息
  // 延迟一帧执行，确保 DOM 已完成渲染
  // 修复顽固 bug：删除对话后所有输入框失焦（持续 50+ Phase）
  // 根因：原生 confirm() 在 frame:false 窗口上破坏 webContents 焦点
  // 兜底：先通过 IPC 显式恢复 webContents 焦点，再聚焦 textarea
  useEffect(() => {
    const timer = setTimeout(async () => {
      await window.routedev.window.restoreFocus();
      textareaRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [focusKey]);

  // G-F025: 组件卸载时清理残留的 resize 监听器，防止内存泄漏
  useEffect(() => {
    return () => {
      resizeAbortRef.current?.abort();
    };
  }, []);

  // 切换对话时重置可能残留的 local state，避免旧对话的状态泄漏到新对话
  useEffect(() => {
    setCommandMenuVisible(false);
    setAutonomyMenuOpen(false);
  }, [focusKey]);

  // Phase 37：加载已启用的 Skill 列表和 MCP 工具列表
  useEffect(() => {
    const loadSkillsAndMcp = async () => {
      try {
        const [skills, mcpResult] = await Promise.all([
          window.routedev.skill.list(),
          window.routedev.mcp.tools(),
        ]);
        setEnabledSkills(skills.filter((s) => s.enabled));
        setMcpTools(mcpResult.tools);
      } catch (err) {
        // eslint-disable-next-line no-console -- 渲染层日志，logger 为 Node-only 模块无法在浏览器导入
        console.error('加载 Skill/MCP 状态失败:', err);
      }
    };
    loadSkillsAndMcp();
    // 每 30 秒刷新一次（MCP 连接状态可能变化）
    const timer = setInterval(loadSkillsAndMcp, 30000);
    return () => clearInterval(timer);
  }, []);

  // 输入变化时重置命令选择索引
  useEffect(() => {
    setCommandIndex(0);
  }, [input]);

  // 命令补全：过滤匹配的命令
  const filteredCommands = useMemo(
    () => STATIC_COMMANDS.filter((cmd) => cmd.startsWith(input)),
    [input],
  );
  const showCommands =
    commandMenuVisible &&
    !isComposing &&
    input.startsWith('/') &&
    !input.includes(' ') &&
    filteredCommands.length > 0;
  const visibleSkills = enabledSkills.slice(0, 3);
  const visibleMcpTools = mcpTools.slice(0, 3);
  // Phase 97 Part G：Composer 引用提示（/ @ & ~ 前缀）——仅输入辅助，不改变发送逻辑
  const { trigger, suggestions, applySuggestion, insertDroppedFile } = useComposerReference(input, cursor);
  // 命令补全与引用提示合并为一个菜单：命令组（仅行首 / 时）+ 引用组
  const commandItems = showCommands ? filteredCommands : [];
  const refItems = trigger.active && suggestions.length > 0 ? suggestions : [];
  const menuItems: MenuItem[] = [
    ...commandItems.map((cmd) => ({ type: 'command' as const, label: cmd, hint: COMMAND_DESCRIPTIONS[cmd] })),
    ...refItems.map((ref) => ({ type: 'reference' as const, ref })),
  ];
  const menuVisible = commandMenuVisible && !isComposing && menuItems.length > 0;
  // Phase 54 修复：菜单显示时计算 textarea 位置，用 Portal 渲染菜单到 body
  useLayoutEffect(() => {
    if (menuVisible && textareaRef.current) {
      const rect = textareaRef.current.getBoundingClientRect();
      setCommandMenuPos({ top: rect.top, left: rect.left });
    } else {
      setCommandMenuPos(null);
    }
  }, [menuVisible]);
  const activeCommandIndex = Math.min(
    commandIndex,
    Math.max(0, menuItems.length - 1),
  );

  // 提交消息：引擎工作时进入队列，否则直接发送
  const handleSubmit = () => {
    if (!input.trim()) return;
    onSubmit(input);
    setInput('');
  };

  // 自主度切换
  const handleAutonomyChange = async (mode: AutonomyMode) => {
    setAutonomyMenuOpen(false);
    if (autonomyMode === mode) return;
    await onAutonomyChange(mode);
  };

  // 拖动调整输入区高度（G-F025: 使用 AbortController 管理监听器生命周期）
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startY = e.clientY;
    const startHeight = inputHeight;
    let nextHeight = startHeight;
    // 中止上一次未完成的拖拽（防御性）
    resizeAbortRef.current?.abort();
    const controller = new AbortController();
    resizeAbortRef.current = controller;
    const onMove = (moveE: MouseEvent) => {
      const delta = startY - moveE.clientY;
      nextHeight = Math.max(116, Math.min(420, startHeight + delta));
      setInputHeight(nextHeight);
    };
    const onUp = () => {
      setIsResizing(false);
      localStorage.setItem('routedev-input-height-v3', String(nextHeight));
      controller.abort();
      resizeAbortRef.current = null;
    };
    document.addEventListener('mousemove', onMove, { signal: controller.signal });
    document.addEventListener('mouseup', onUp, { signal: controller.signal });
  };

  const selectCommand = (cmd: string) => {
    setInput(cmd + ' ');
    setCommandMenuVisible(false);
    textareaRef.current?.focus();
  };

  // Phase 97 Part G：选中引用候选——替换当前 token 并聚焦回输入框
  const selectReference = (ref: ComposerSuggestion) => {
    const next = applySuggestion(ref);
    setInput(next);
    setCommandMenuVisible(false);
    // 计算插入后光标位置：token 起始 + 前缀(1) + id + 末尾空格
    const before = input.slice(0, cursor);
    const m = /(?:^|\s)([/&~@])([^\s@]*)$/.exec(before);
    const tokenStart = m ? m.index + m[1].length : input.length;
    const newCursor = tokenStart + 1 + ref.id.length + 1;
    setCursor(newCursor);
    textareaRef.current?.focus();
  };

  // Phase 97 Part G：统一选中当前菜单项（命令或引用）
  const selectActive = () => {
    const item = menuItems[activeCommandIndex];
    if (!item) return;
    if (item.type === 'command') selectCommand(item.label);
    else selectReference(item.ref);
  };

  // Phase 97 Part G：拖拽文件到输入框 → 把文件路径解析为 @ 引用标记插入文本
  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    // 仅对文件拖拽阻止默认（防止浏览器打开文件），文本拖拽保持默认
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    // Electron 中 File 对象带非标准 path 属性（绝对路径）
    const filePath = (file as File & { path?: string }).path;
    if (!filePath) return;
    const next = insertDroppedFile(filePath);
    setInput(next);
    setCursor(next.length);
    setCommandMenuVisible(false);
    textareaRef.current?.focus();
  };

  // 关闭自主度菜单（点击外部）
  useEffect(() => {
    if (!autonomyMenuOpen) return;
    const close = () => setAutonomyMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [autonomyMenuOpen]);

  return (
    <div className="bg-rd-surface px-3 pb-3" style={{ height: inputHeight }}>
      <div
        onMouseDown={handleResizeStart}
        className={[
          'flex h-1 cursor-row-resize items-center justify-center transition',
          isResizing ? 'bg-rd-primary/20' : 'bg-transparent hover:bg-rd-surfaceHover',
        ].join(' ')}
        title="拖动调整输入区高度"
      >
        <div className="h-px w-10 rounded-full bg-transparent" />
      </div>
      <div className="flex h-[calc(100%-4px)]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-rd-background/30 shadow-rd transition"
        >
          {/* Phase 37：Skill/MCP 状态栏——显示已启用的 Skill 和已连接的 MCP 工具 */}
          {showSkillBar && (enabledSkills.length > 0 || mcpTools.length > 0) && (
            <div className="flex shrink-0 items-center gap-1.5 overflow-hidden px-4 py-2">
              {enabledSkills.length > 0 && (
                <>
                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-rd-textSubtle">
                    <BookOpen size={12} /> Skill:
                  </span>
                  {visibleSkills.map((s) => (
                    <span
                      key={s.name}
                      className="max-w-32 shrink-0 truncate rounded-md bg-rd-primary/10 px-2 py-0.5 text-xs text-rd-primary"
                      title={s.description}
                    >
                      {s.name}
                    </span>
                  ))}
                  {enabledSkills.length > visibleSkills.length && (
                    <span className="shrink-0 text-xs text-rd-textSubtle">+{enabledSkills.length - visibleSkills.length}</span>
                  )}
                </>
              )}
              {mcpTools.length > 0 && (
                <>
                  <span className="ml-2 flex shrink-0 items-center gap-1 text-xs font-medium text-rd-textSubtle">
                    <Plug size={12} /> MCP:
                  </span>
                  {visibleMcpTools.map((t) => (
                    <span
                      key={t.name}
                      className="max-w-32 shrink-0 truncate rounded-md bg-rd-surfaceHover px-2 py-0.5 text-xs text-rd-textSubtle"
                      title={t.description}
                    >
                      {t.name.replace('mcp__', '').replace('__', '.')}
                    </span>
                  ))}
                  {mcpTools.length > visibleMcpTools.length && (
                    <span className="shrink-0 text-xs text-rd-textSubtle">+{mcpTools.length - visibleMcpTools.length}</span>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => setShowSkillBar(false)}
                className="ml-auto text-rd-textSubtle hover:text-rd-text"
                title="隐藏状态栏"
              >
                <X size={12} />
              </button>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
          {menuVisible && commandMenuPos && createPortal(
            <Card
              className="fixed z-[9999] mb-2 w-96 overflow-hidden border-rd-border/80 bg-rd-background p-1 shadow-rdLg"
              style={{ top: commandMenuPos.top - 8, left: commandMenuPos.left, transform: 'translateY(-100%)' }}
            >
              {commandItems.length > 0 && (
                <>
                  {refItems.length > 0 && (
                    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-rd-textSubtle">命令</div>
                  )}
                  {commandItems.map((cmd, idx) => (
                    <Button
                      key={cmd}
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => selectCommand(cmd)}
                      className={[
                        'flex w-full items-center justify-start gap-2 px-3 py-2 text-left text-sm',
                        idx === activeCommandIndex
                          ? 'bg-rd-primary/10 text-rd-primary'
                          : 'text-rd-text',
                      ].join(' ')}
                    >
                      <span className="font-mono">{cmd}</span>
                      <span className="ml-auto text-xs text-rd-textMuted">
                        {COMMAND_DESCRIPTIONS[cmd]}
                      </span>
                    </Button>
                  ))}
                </>
              )}
              {refItems.length > 0 && (
                <>
                  {commandItems.length > 0 && (
                    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-rd-textSubtle">引用</div>
                  )}
                  {refItems.map((ref, idx) => {
                    const active = commandItems.length + idx === activeCommandIndex;
                    return (
                      <Button
                        key={`${ref.kind}:${ref.id}`}
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => selectReference(ref)}
                        className={[
                          'flex w-full items-center justify-start gap-2 px-3 py-2 text-left text-sm',
                          active ? 'bg-rd-primary/10 text-rd-primary' : 'text-rd-text',
                        ].join(' ')}
                      >
                        <span
                          className={[
                            'w-4 shrink-0 text-center font-mono text-xs font-bold',
                            active ? 'text-rd-primary' : 'text-rd-textMuted',
                          ].join(' ')}
                        >
                          {ref.prefix}
                        </span>
                        <span className="truncate font-mono text-[13px]">{ref.label}</span>
                        <span className="ml-auto min-w-0 shrink-0 truncate pl-2 text-xs text-rd-textMuted">
                          {ref.hint}
                        </span>
                      </Button>
                    );
                  })}
                </>
              )}
            </Card>,
            document.body,
          )}
          <Textarea
            ref={textareaRef}
            data-chat-input
            value={input}
            // 防御性点击处理：确保点击输入框时立即聚焦，避免焦点被其他元素劫持
            // 这是"新建对话后输入框不可点击"顽固 Bug 的防御性修复
            onMouseDown={(e) => {
              // 允许默认聚焦行为，但确保 textarea 获得焦点
              if (document.activeElement !== e.currentTarget) {
                e.currentTarget.focus();
              }
            }}
            onChange={(e) => {
              setInput(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
              setCommandMenuVisible(true);
            }}
            onSelect={(e) => {
              // 光标移动（方向键 / 点击）时同步，确保引用 token 定位准确
              setCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            }}
            onCompositionStart={() => {
              setIsComposing(true);
            }}
            onCompositionEnd={(e) => {
              setIsComposing(false);
              // compositionEnd 后手动同步输入框当前值（IME 最终输出）
              const v = (e.target as HTMLTextAreaElement).value;
              setInput(v);
              setCursor((e.target as HTMLTextAreaElement).selectionStart ?? v.length);
              setCommandMenuVisible(true);
            }}
            onKeyDown={(e) => {
              if (menuVisible) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCommandIndex((prev) => (prev + 1) % menuItems.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCommandIndex(
                    (prev) => (prev - 1 + menuItems.length) % menuItems.length,
                  );
                  return;
                }
                // Enter / Tab 选中当前项（引用候选支持 Tab 快速选择）
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  selectActive();
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setCommandMenuVisible(false);
                  return;
                }
              } else {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }
            }}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            placeholder={isProcessing ? '输入下一条消息（Enter 加入排队队列）... Shift+Enter 换行' : '输入问题开始... Shift+Enter 换行，输入 / 查看命令'}
            rows={4}
            className="h-full min-h-0 resize-none border-0 bg-transparent px-4 py-3 text-sm leading-6 shadow-none focus-visible:ring-0"
          />
          </div>
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {autonomyMode && (
                <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setAutonomyMenuOpen(!autonomyMenuOpen)}
                    title={`自主度: ${AUTONOMY_LABELS[autonomyMode]}`}
                  >
                    <Zap size={14} />
                    <span>{AUTONOMY_LABELS[autonomyMode]}</span>
                    <ChevronDown size={14} />
                  </Button>
                  {autonomyMenuOpen && (
                    <div className="absolute bottom-full left-0 z-50 mb-2 w-44 overflow-hidden rounded-xl border border-rd-border bg-rd-background p-1 shadow-rdLg">
                      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-rd-textSubtle">自主度</div>
                      {(Object.keys(AUTONOMY_LABELS) as AutonomyMode[]).map((mode) => (
                        <button
                          type="button"
                          key={mode}
                          onClick={() => handleAutonomyChange(mode)}
                          className={[
                            'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition',
                            autonomyMode === mode ? 'bg-rd-primary/10 font-semibold text-rd-primary' : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
                          ].join(' ')}
                        >
                          <span>{AUTONOMY_LABELS[mode]}</span>
                          {autonomyMode === mode && <span>✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <span className="hidden truncate text-xs text-rd-textSubtle 2xl:block">Enter 发送 · Shift+Enter 换行</span>
            </div>
            {isProcessing ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (!input.trim() || !isProcessing) return;
                    onFollowUp(input.trim());
                    setInput('');
                  }}
                  disabled={!input.trim()}
                  title="把当前输入作为后续任务排队（Agent 完成当前工作后自动接续）"
                  className="h-9 gap-2 rounded-lg px-3"
                >
                  <History size={16} />
                  加入后续
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={onStop}
                  title="停止生成"
                  className="h-9 gap-2 rounded-lg px-3"
                >
                  <Square size={16} fill="currentColor" />
                  停止
                </Button>
              </div>
            ) : (
              <Button
                type="submit"
                disabled={!input.trim()}
                title="发送"
                aria-label="发送"
                className="!h-9 !w-9 !rounded-full !px-0 !py-0 disabled:!bg-rd-surfaceHover disabled:!text-rd-textMuted disabled:!opacity-100"
              >
                <Send size={15} strokeWidth={2.3} className="shrink-0" />
                <span className="sr-only">发送</span>
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
