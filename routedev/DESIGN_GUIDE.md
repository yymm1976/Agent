# RouteDev UI 设计规范

> 基于 shadcn/ui + Tailwind CSS 的桌面应用设计系统。
> 目标：信息层级清晰、组件风格统一、避免"彩虹色页面"。

## 1. 颜色系统

### 主色板
| Token | 值 | 用途 |
|-------|-----|------|
| `--primary` | `#4f46e5` | 主按钮、链接、激活状态、进度条 |
| `--primary-hover` | `#4338ca` | 主按钮悬停 |
| `--primary-foreground` | `#ffffff` | 主色上的文字 |

### 背景层级
| Token | 值 | 用途 |
|-------|-----|------|
| `--background` | `#ffffff` | 应用主背景 |
| `--surface` | `#f8fafc` | 卡片、面板背景 |
| `--surface-hover` | `#f1f5f9` | 卡片悬停、列表项悬停 |
| `--surface-highlight` | `#e2e8f0` | 选中、高亮背景 |
| `--border` | `#e2e8f0` | 边框、分隔线 |
| `--border-hover` | `#cbd5e1` | 边框悬停 |
| `--input` | `#e2e8f0` | 输入框边框 |

### 文字层级
| Token | 值 | 用途 |
|-------|-----|------|
| `--text` | `#0f172a` | 标题、主要文字 |
| `--text-muted` | `#475569` | 次要文字、描述 |
| `--text-subtle` | `#94a3b8` | 占位符、禁用、提示 |

### 语义色
| Token | 值 | 用途 |
|-------|-----|------|
| `--danger` | `#dc2626` | 错误、删除 |
| `--warning` | `#f59e0b` | 警告 |
| `--success` | `#16a34a` | 成功、在线 |

## 2. 字体

- **字体族**：`Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif`
- **标题**：`font-semibold`
  - 页面标题：`text-2xl` (24px)
  - 卡片标题：`text-lg` (18px)
  - 小标题：`text-base` (16px)
- **正文**：`text-sm` (14px)，`font-normal`
- **辅助/占位符**：`text-xs` (12px)，`text-muted`
- **代码/ID**：`font-mono` (`JetBrains Mono, Consolas, monospace`)

## 3. 间距

基础单位 4px：
- `space-1` = 4px
- `space-2` = 8px
- `space-3` = 12px
- `space-4` = 16px
- `space-6` = 24px
- `space-8` = 32px

常用约定：
- 卡片内边距：`p-5` (20px) 或 `p-6` (24px)
- 表单字段间距：`space-y-4` (16px)
- 区块间距：`space-y-6` (24px)
- 页面外边距：`p-6` (24px) 或 `p-8` (32px)

## 4. 圆角

| 组件 | 圆角 |
|------|------|
| 按钮 | `rounded-md` (6px) |
| 输入框 | `rounded-md` (6px) |
| 卡片 | `rounded-xl` (12px) |
| 对话框 | `rounded-xl` (12px) |
| 小标签 | `rounded-full` |

## 5. 阴影

- `shadow-sm`：按钮、输入框
- `shadow-md`：卡片悬停、下拉菜单
- `shadow-lg`：对话框、浮层
- 禁用 `shadow-xl` 及更大的阴影，避免过度设计。

## 6. 组件规范

### Button
```
高度: 40px (py-2.5)
内边距: px-4 (默认), px-5 (主要)
圆角: rounded-md
字体: text-sm font-semibold

变体:
- primary: bg-primary text-white hover:bg-primary-hover
- secondary: bg-white border border-border text-text hover:bg-surface-hover
- ghost: bg-transparent text-text-muted hover:bg-surface hover:text-text
- danger: bg-danger text-white hover:bg-danger-hover
```

### Input
```
高度: 40px (py-2.5 px-3)
边框: border border-input
背景: bg-white
圆角: rounded-md
占位符: text-text-subtle
聚焦: border-primary ring-4 ring-primary/10
```

### Card
```
背景: bg-white
边框: border border-border
圆角: rounded-xl
内边距: p-5 或 p-6
阴影: shadow-sm
悬停: shadow-md + -translate-y-0.5 (可选)
```

### Badge
```
圆角: rounded-full
内边距: px-2.5 py-0.5
字体: text-xs font-semibold

变体:
- default: bg-surface border border-border text-text-muted
- primary: bg-primary/10 text-primary border-primary/20
- success: bg-success/10 text-success border-success/20
- danger: bg-danger/10 text-danger border-danger/20
```

### Switch
```
使用标准 Toggle 样式:
- 轨道: h-5 w-9 rounded-full
- 开启: bg-primary
- 关闭: bg-input
- 滑块: bg-white shadow-sm
```

## 7. 布局原则

- 页面最大宽度：无限制，主要内容区自适应
- 表单最大宽度：`max-w-2xl` (672px)
- 卡片网格：响应式 `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
- 侧边栏宽度：`w-64` (256px)

## 8. 图标

- 统一使用 `lucide-react`
- 按钮内图标大小：`16px`
- 空状态/标题图标：`24px` 或 `32px`
- 状态小图标：`12px`

## 9. 禁用项

- 禁止直接使用任意值如 `bg-[#xxx]`
- 禁止彩虹色背景卡片
- 禁止阴影过重
- 禁止字号小于 12px
- 禁止无边框的输入框
