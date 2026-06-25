// desktop/renderer/src/components/ErrorBoundary.tsx
// 全局错误边界：捕获子组件渲染异常，避免整棵组件树卸载导致白屏
// 用途：当 SettingsPage 等页面因数据异常抛错时，显示友好错误提示并提供"重置"按钮，而非整页白屏

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { Button } from './ui/button.js';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义错误回退渲染（可选）。未提供则使用默认 UI */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 仅打印到控制台便于调试，不向上抛
    console.error('[ErrorBoundary] 捕获渲染异常:', error, info);
  }

  /** 重置错误状态，触发子树重新渲染 */
  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      // 默认错误 UI：居中提示 + 错误信息 + 重试按钮
      return (
        <div className="flex h-full flex-col items-center justify-center bg-rd-background p-8 text-center">
          <AlertCircle size={48} className="mb-4 text-rd-danger" />
          <h2 className="mb-2 text-xl font-semibold text-rd-text">页面渲染出错</h2>
          <p className="mb-2 max-w-md text-sm text-rd-textMuted">
            页面遇到异常无法继续渲染。可以尝试重试，或返回上一页。
          </p>
          <p className="mb-6 max-w-lg rounded-lg bg-rd-surfaceHover p-3 text-left text-xs text-rd-textMuted">
            {this.state.error.message}
          </p>
          <div className="flex gap-2">
            <Button onClick={this.reset}>
              <RotateCcw size={16} /> 重试
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
