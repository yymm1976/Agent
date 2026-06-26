# Codex 项目指令

## 编码规范

- 使用 TypeScript ESM，所有 import 路径必须带 .js 后缀
- 类型导入使用 `import type` 语法
- 优先使用 const，避免 var
- 函数复杂度不超过 15

## 测试规范

- 每个公开函数至少 3 个测试用例
- 测试文件放在 tests/ 镜像目录
- 使用 vitest，禁止使用 jest
- 覆盖率目标 80%
