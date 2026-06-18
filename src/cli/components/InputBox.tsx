// src/cli/components/InputBox.tsx
// 输入框组件：支持文本输入和 Enter 发送，/ 开头的输入作为命令处理

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface InputBoxProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

export function InputBox({ onSubmit, disabled = false }: InputBoxProps) {
  const [value, setValue] = useState('');

  useInput((char, key) => {
    if (disabled) return;

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
