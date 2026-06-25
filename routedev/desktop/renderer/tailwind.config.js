/** @type {import('tailwindcss').Config} */
// RouteDev 设计系统 v3
// 颜色全部引用 CSS 变量，由 index.css 按 data-theme 属性切换主题（white/black/gray/blue）
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  content: [
    path.resolve(__dirname, 'index.html'),
    path.resolve(__dirname, 'src/**/*.{js,ts,jsx,tsx}'),
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        rd: {
          // 背景层级：全部引用 CSS 变量，由 [data-theme] 切换
          background: 'var(--rd-background)',
          bg: 'var(--rd-background)', // 兼容旧代码别名
          surface: 'var(--rd-surface)',
          surfaceHover: 'var(--rd-surface-hover)',
          surfaceHighlight: 'var(--rd-surface-highlight)',
          border: 'var(--rd-border)',
          borderHover: 'var(--rd-border-hover)',
          treeLine: 'var(--rd-tree-line)',
          input: 'var(--rd-border)',

          // 主色
          primary: 'var(--rd-primary)',
          primaryHover: 'var(--rd-primary-hover)',
          primaryForeground: 'var(--rd-primary-foreground)',

          // 文字层级
          text: 'var(--rd-text)',
          textMuted: 'var(--rd-text-muted)',
          textSubtle: 'var(--rd-text-subtle)',

          // 语义色
          danger: 'var(--rd-danger)',
          dangerHover: 'var(--rd-danger-hover)',
          dangerForeground: 'var(--rd-danger-foreground)',
          warning: 'var(--rd-warning)',
          success: 'var(--rd-success)',
          successForeground: 'var(--rd-success-foreground)',

          // 次要色
          secondary: 'var(--rd-surface)',
          secondaryHover: 'var(--rd-surface-hover)',
          secondaryForeground: 'var(--rd-text)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      borderRadius: {
        rd: '0.75rem',      // 12px
        rdSm: '0.5rem',     // 8px
        rdLg: '1rem',       // 16px
        rdXl: '1.25rem',    // 20px
      },
      boxShadow: {
        rd: '0 1px 3px 0 rgb(0 0 0 / 0.05)',
        rdSm: '0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05)',
        rdMd: '0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.05)',
        rdLg: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.05)',
        rdXl: '0 25px 50px -12px rgb(0 0 0 / 0.15)',
        rdGlow: '0 0 0 1px rgb(79 70 229 / 0.2), 0 4px 20px rgb(79 70 229 / 0.15)',
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out',
        'slide-up': 'slide-up 0.4s ease-out',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
