// src/cli/components/InputBox.tsx
// 输入框组件：支持文本输入和 Enter 发送，/ 开头的输入作为命令处理
// Phase 17c：集成 Tab 补全（命令名 + 子命令）

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { createCompleter, type CompletionItem } from '../completion.js';

interface InputBoxProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  /** 补全候选项（默认使用内置命令补全） */
  completions?: CompletionItem[];
}

export function InputBox({ onSubmit, disabled = false, completions }: InputBoxProps) {
  const [value, setValue] = useState('');
  // 补全器（memoized，避免每次渲染重建）
  const completer = useMemo(
    () => createCompleter(completions),
    [completions],
  );

  useInput((char, key) => {
    if (disabled) return;

    // Tab 键触发补全
    if (key.tab) {
      const [matches] = completer(value);
      if (matches.length > 0) {
        // 取第一个匹配项填充
        setValue(matches[0]);
      }
      return;
    }

    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
        setValue('');
      }
      return;
    }

    if (key.backspace || key.delete) {
      setValue(prev => prev.slice(0, -1));
      return;
    }

    if (key.ctrl && char === 'c') {
      // Ctrl+C 退出
      process.exit(0);
    }

    // 普通字符输入
    if (char && !key.ctrl && !key.meta) {
      setValue(prev => prev + char);
    }
  });

  const isCommand = value.startsWith('/');

  return (
    <Box>
      <Text color={isCommand ? 'cyan' : 'green'} bold>{disabled ? '⏳ ' : '❯ '}</Text>
      <Text>{value}</Text>
      {!disabled && <Text color="gray">▌</Text>}
    </Box>
  );
}
