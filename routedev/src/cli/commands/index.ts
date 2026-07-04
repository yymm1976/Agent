// src/cli/commands/index.ts
// 命令导出（按字母顺序）

// Phase 74：/ask 只问答不修改文件（对齐 Aider /ask）
export * from './ask.js';
export * from './autonomy.js';
// Phase 74：/architect 切换到 architect 模式（强模型规划，弱模型执行）
export * from './architect.js';
export * from './branch.js';
export * from './btw.js';
export * from './channels.js';
export * from './checkpoint.js';
export * from './clarify.js';
export * from './clear.js';
// Phase 74：/code 切换到 code 模式（默认模式，直接编码）
export * from './code.js';
// Phase 74：CliContextManager 单例（/include 文件上下文管理）
export * from './context-manager.js';
export * from './config.js';
// Phase 57：/consolidate-memory（原 /dream 改名，去拟人化）；Phase 60：dream alias 已删除
export * from './consolidate-memory.js';
export * from './cost.js';
// Phase 72：/deep-review 并行多 reviewer 对抗性审查
export * from './deep-review.js';
export * from './diff.js';
export * from './doctor.js';
// Phase 49 Task 5.4：/eval 内置评估用例集（smoke 10 / regression 30 / all / list）
export * from './eval.js';
export * from './experiment.js';
export * from './goal.js';
export * from './help.js';
export * from './history.js';
export * from './init.js';
// Phase 74：/include 将文件加入上下文（对齐 Aider /add，支持 glob）
export * from './include.js';
export * from './memory.js';
// Phase 74：ModeManager 单例（architect / code / ask 模式管理）
export * from './mode-manager.js';
export * from './output-style.js';
export * from './pause.js';
// Phase 71：/plan diff <goalId> + /plan omissions <goalId>
export * from './plan-diff.js';
export * from './permissions.js';
export * from './plugin.js';
// SDK 插件管理命令（/plugins，动态加载/卸载 RouteDevPlugin）
export * from './plugins.js';
export * from './prompt.js';
export * from './quality.js';
export * from './quit.js';
export * from './resume.js';
export * from './review.js';
export * from './rollback.js';
export * from './schedule.js';
export * from './security.js';
export * from './status.js';
export * from './swarm.js';
export * from './tech-debt.js';
export * from './token.js';
export * from './trace.js';
// Phase 73：/undo 撤销最近一次文件编辑（Aider 风格，单次编辑级别）
export * from './undo.js';
export * from './trust.js';
export * from './work-modes.js';
