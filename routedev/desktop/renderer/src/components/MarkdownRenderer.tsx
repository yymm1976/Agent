// desktop/renderer/src/components/MarkdownRenderer.tsx
// Markdown 渲染组件：支持 GFM、代码高亮、复制按钮

import { useState, useCallback, isValidElement, type ReactNode, type ComponentProps } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check } from 'lucide-react';

// 从 React 节点中递归提取纯文本
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

// 代码块组件：语法高亮 + 复制按钮
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="group my-3 overflow-hidden rounded-lg border border-rd-border">
      {/* 语言标签 + 复制按钮 */}
      <div className="flex items-center justify-between border-b border-rd-border bg-rd-bg/60 px-3 py-1.5">
        <span className="font-mono text-xs text-rd-textMuted">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-rd-textMuted transition hover:text-rd-primary"
          title="复制代码"
        >
          {copied ? <Check size={14} className="text-rd-success" /> : <Copy size={14} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          background: 'transparent',
          fontSize: '13px',
          padding: '12px',
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed text-rd-text">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 代码块：通过 pre 提取代码内容和语言，渲染为 CodeBlock
          pre({ children }: ComponentProps<'pre'>) {
            const child = Array.isArray(children) ? children[0] : children;
            if (isValidElement(child)) {
              const props = child.props as { className?: string; children?: ReactNode };
              const className = props.className || '';
              const match = /language-(\w+)/.exec(className);
              const language = match ? match[1] : 'text';
              const code = extractText(props.children).replace(/\n$/, '');
              return <CodeBlock language={language} code={code} />;
            }
            return <pre>{children}</pre>;
          },
          // 行内代码
          code({ children }: ComponentProps<'code'>) {
            return (
              <code className="rounded bg-rd-bg px-1.5 py-0.5 font-mono text-[13px] text-rd-primary">
                {children}
              </code>
            );
          },
          // 表格
          table({ children }: ComponentProps<'table'>) {
            return (
              <div className="my-3 overflow-x-auto rounded-lg border border-rd-border">
                <table className="w-full border-collapse text-sm">{children}</table>
              </div>
            );
          },
          thead({ children }: ComponentProps<'thead'>) {
            return <thead className="bg-rd-bg/60">{children}</thead>;
          },
          th({ children }: ComponentProps<'th'>) {
            return (
              <th className="border-b border-rd-border px-3 py-2 text-left font-medium text-rd-text">
                {children}
              </th>
            );
          },
          td({ children }: ComponentProps<'td'>) {
            return (
              <td className="border-b border-rd-border px-3 py-2 text-rd-textMuted">{children}</td>
            );
          },
          // 引用块
          blockquote({ children }: ComponentProps<'blockquote'>) {
            return (
              <blockquote className="my-3 border-l-4 border-rd-primary/40 bg-rd-bg/40 py-2 pl-4 text-rd-textMuted">
                {children}
              </blockquote>
            );
          },
          // 列表
          ul({ children }: ComponentProps<'ul'>) {
            return <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>;
          },
          ol({ children }: ComponentProps<'ol'>) {
            return <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>;
          },
          // 链接
          a({ href, children }: ComponentProps<'a'>) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-rd-primary underline hover:text-rd-primaryHover"
              >
                {children}
              </a>
            );
          },
          // 段落
          p({ children }: ComponentProps<'p'>) {
            return <p className="my-2 first:mt-0 last:mb-0">{children}</p>;
          },
          // 标题
          h1({ children }: ComponentProps<'h1'>) {
            return <h1 className="mb-3 mt-4 text-xl font-bold text-rd-text">{children}</h1>;
          },
          h2({ children }: ComponentProps<'h2'>) {
            return <h2 className="mb-2 mt-3 text-lg font-bold text-rd-text">{children}</h2>;
          },
          h3({ children }: ComponentProps<'h3'>) {
            return <h3 className="mb-2 mt-3 text-base font-semibold text-rd-text">{children}</h3>;
          },
          h4({ children }: ComponentProps<'h4'>) {
            return <h4 className="mb-1 mt-2 text-sm font-semibold text-rd-text">{children}</h4>;
          },
          // 水平线
          hr() {
            return <hr className="my-4 border-rd-border" />;
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
