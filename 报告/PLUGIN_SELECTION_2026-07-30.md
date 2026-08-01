# RouteDev 插件选择与配置建议

日期：2026-07-30

## 结论

结合 RouteDev 的 Electron + React + Tailwind 技术栈、当前以主对话工作台为核心的开发方式，以及 `openai/plugins` 官方仓库，推荐顺序如下：

1. **build-web-apps**：优先安装。用于 React 页面实现、布局收敛、前端验证和浏览器侧调试，对当前项目的日常效率提升最大。
2. **Figma**：优先连接。用于把满意的参考图、组件规范、间距与字体规则沉淀为可复用设计系统，对审美一致性帮助最大。
3. **GitHub**：建议连接。用于 Issue、PR、审查与变更追踪，适合 RouteDev 大量阶段性修复和回归工作。
4. **Codex Security**：后续按需启用。适合安全审计，但不是当前主页面视觉与 Harness 性能优化的首要瓶颈。

不建议当前安装 Expo、iOS、macOS、文档/表格类插件：它们与现有 Windows Electron 主工程的高频工作流不匹配，会增加选择噪声。

## 建议配置

### build-web-apps

- 作用域：仅 RouteDev 前端与 Electron 渲染层。
- 默认验证：类型检查、相关组件测试、生产构建。
- 设计约束：单一滚动容器、减少嵌套卡片与标签页、统一正文与辅助文字字号。

### Figma

- 初始权限：只读。
- 只读取用户明确提供的设计文件或节点。
- RouteDev 设计基线：参考 Codex 紧凑工作台；优先保证信息层级、时间顺序与空间利用率，不追求装饰性卡片。

### GitHub

- 初始权限：读操作自动允许，写操作前确认。
- 默认用于查看 Issue/PR/检查结果；不自动创建 PR、推送或修改远端状态。

## 当前安装状态

本机 Codex CLI 位于 WindowsApps 受保护目录，执行 `codex plugin list --available --json` 时被系统拒绝访问；当前会话暴露的插件管理接口也只支持权限查询与卸载，不提供安装入口。因此本轮没有伪造“已安装”状态。

可用的官方安装入口是 Codex 桌面端 `/plugins` 页面。安装后需要新建任务，使插件与其技能/MCP 工具进入新会话上下文。

## 参考

- OpenAI 官方插件仓库：https://github.com/openai/plugins
- OpenAI 插件 UI 规范：https://developers.openai.com/plugins/concepts/ui-guidelines.md
- Codex 插件说明：https://learn.chatgpt.com/docs/plugins
