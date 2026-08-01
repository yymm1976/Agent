// src/config/schemas/index.ts
// Phase 93 Task 6：持久化 / 装配 / 数据库行校验 schema 聚合导出
//
// 本目录聚焦"安全敏感路径的运行时校验"——仅覆盖持久化文件读取、关键装配点、数据库行解析。
// 全量配置 schema 仍在 src/config/schema.ts（及其 5 个 schema-*.ts 子文件），不在本目录重复。

export * from './integrity-manifest.js';
export * from './goal-persistence.js';
export * from './checkpoint.js';
export * from './app-dependencies.js';
export * from './database.js';
