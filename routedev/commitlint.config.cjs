// Phase 75-A6：commitlint 配置（.cjs 后缀，因 package.json "type": "module" 强制 ESM）
// 接受两种格式：[scope] description（tau 风格）或 type(scope): description（Conventional Commits）
// 技术债 commit 必须含 [TECH-DEBT] tag（在 CONTRIBUTING.md 第 3 节定义）
// 注意：[scope] description 格式 commitlint 默认不识别，需通过 parser-plugins 扩展；
//       当前先用 Conventional Commits 严格模式，[scope] 格式作为补充规范在 CONTRIBUTING.md 中约束（人工 review 兜底）。
//       后续 Phase 视需要再引入自定义 parser 自动校验 [scope] 格式。
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // type 白名单（与 CONTRIBUTING.md 第 3 节一致）
    'type-enum': [2, 'always', [
      'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci'
    ]],
    // scope 必须在白名单内（与 CONTRIBUTING.md 第 2 节一致）
    'scope-enum': [2, 'always', [
      'router', 'agent', 'skill', 'ui', 'setting', 'infra', 'docs',
      'tools', 'config', 'desktop', 'runtime', 'harness', 'memory',
      'prompts', 'security', 'plugins', 'macros', 'code-map', 'hooks',
      'agents', 'mcp', 'tests'
    ]],
    'scope-case': [2, 'always', 'lower-case'],
  },
};
