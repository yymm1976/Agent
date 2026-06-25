// src/cli/components/Spinner.tsx
// Phase 34 Task 3：极简 Spinner + 计时器
// 只在工具执行等需要“后台任务进行中”信号的场景使用，LLM 推理阶段不需要

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';

/** Spinner 帧序列（5fps，每 200ms 切换） */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 200;

interface SpinnerProps {
  /** 开始时间戳（用于计算已运行秒数） */
  startTime?: number;
  /** 是否显示计时器 */
  showTimer?: boolean;
  /** 计时器阈值：运行超过多少秒才显示（默认 30s） */
  timerThresholdSeconds?: number;
}

/**
 * Spinner 组件
 * 低帧率设计（5fps），传递“后台任务，无需盯着看”的信号
 */
export function Spinner({ startTime, showTimer = true, timerThresholdSeconds = 30 }: SpinnerProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = startTime ?? Date.now();
    setElapsed(Math.floor((Date.now() - start) / 1000));

    const frameTimer = setInterval(() => {
      setFrameIndex(prev => (prev + 1) % SPINNER_FRAMES.length);
    }, FRAME_INTERVAL_MS);

    const secondTimer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);

    return () => {
      clearInterval(frameTimer);
      clearInterval(secondTimer);
    };
  }, [startTime]);

  const showElapsed = showTimer && elapsed >= timerThresholdSeconds;

  return (
    <Text>
      <Text color="yellow">{SPINNER_FRAMES[frameIndex]}</Text>
      {showElapsed && (
        <Text color="gray" dimColor> 已运行 {elapsed}s</Text>
      )}
    </Text>
  );
}

/**
 * 格式化已运行时间（短文本，用于非 Spinner 场景）
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m${secs.toString().padStart(2, '0')}s`;
}
