// src/hooks/built-in.ts
// Phase 35 Task 2：内置生命周期钩子注册
//
// 设计目标：
//   1. Post-File-Change Validation（post-tool-call）
//      - 触发条件：toolName 为 file_write / file_edit
//      - 行为：对修改的文件做轻量验证（可读性 + 大小合理性 + JSON 语法检查）
//      - 失败时返回 continue + 警告消息（不中止任务，仅提醒 Agent 下一次推理时注意）
//   2. Session Lifecycle Logger（on-session-start / on-session-end）
//      - on-session-start：写入 AuditLogger（action: session_start），含 sessionId/cwd/modelId
//      - on-session-end：写入 AuditLogger（action: session_end），含 durationMs
//
// 注意：
//   - 内置钩子优先级设为 50（低于默认 100），让用户插件钩子可以排在后面执行
//   - 钩子内部异常被 HookRunner 隔离，不会影响主流程
//   - 文件验证用方案 C（fs.access + 大小检查）+ JSON 文件的 JSON.parse 检查，
//     不做 tsc 单文件类型检查（启动慢 1-2 秒，性价比低）

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { HookDefinition, HookContext, HookResult } from '../agent/hooks.js';
import type { AuditLogger } from '../harness/audit-logger.js';
import { logger } from '../utils/logger.js';

/** 内置钩子优先级：低于默认 100，让用户插件钩子排在后面 */
const BUILTIN_HOOK_PRIORITY = 50;

/** 文件大小合理范围：1 字节 ~ 10MB */
const MIN_FILE_SIZE = 1;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * 钩子 1：Post-File-Change Validation
 *
 * 触发条件：toolName 为 file_write 或 file_edit
 * 验证内容：
 *   - 文件可读（fs.access）
 *   - 文件大小在合理范围内（1B ~ 10MB）
 *   - JSON 文件额外做 JSON.parse 验证
 *
 * 失败处理：返回 continue + 警告消息（不 abort，文件语法错误不严重到要中止任务）
 */
function createPostFileChangeHook(): HookDefinition {
  return {
    event: 'post-tool-call',
    name: 'builtin:post-file-change-validate',
    priority: BUILTIN_HOOK_PRIORITY,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      const toolName = ctx.toolName;
      // 只处理文件写入/编辑工具
      if (toolName !== 'file_write' && toolName !== 'file_edit') {
        return { action: 'continue' };
      }

      // 从工具参数中提取文件路径
      const filePath = ctx.toolArgs?.path as string | undefined;
      if (!filePath) {
        return { action: 'continue' };
      }

      // 解析为绝对路径（projectPath 作为基准）
      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(ctx.projectPath, filePath);

      try {
        // 检查文件可读
        await fs.access(absPath, fsSync.constants.R_OK);

        // 检查文件大小
        const stats = await fs.stat(absPath);
        if (stats.size < MIN_FILE_SIZE) {
          return {
            action: 'continue',
            message: `⚠️ 文件验证警告: ${filePath} 大小为 ${stats.size} 字节，可能为空文件`,
          };
        }
        if (stats.size > MAX_FILE_SIZE) {
          return {
            action: 'continue',
            message: `⚠️ 文件验证警告: ${filePath} 大小 ${stats.size} 字节超过 10MB，请确认是否预期`,
          };
        }

        // JSON 文件额外做语法检查
        if (filePath.endsWith('.json')) {
          try {
            const content = await fs.readFile(absPath, 'utf-8');
            JSON.parse(content);
          } catch (parseErr) {
            return {
              action: 'continue',
              message: `⚠️ 文件验证警告: ${filePath} JSON 语法错误: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            };
          }
        }

        // 验证通过，不附加消息
        return { action: 'continue' };
      } catch (err) {
        // 文件不可读或不存在
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn('Post-file-change hook: validation failed', {
          filePath,
          error: errMsg,
        });
        return {
          action: 'continue',
          message: `⚠️ 文件验证警告: ${filePath} 不可读 - ${errMsg}`,
        };
      }
    },
  };
}

/**
 * 钩子 2：Session Lifecycle Logger
 *
 * - on-session-start：写入 AuditLogger（action: session_start），含 sessionId/cwd/modelId
 * - on-session-end：写入 AuditLogger（action: session_end），含 durationMs
 *
 * 这是最轻量的钩子，目的是让审计日志有会话级生命周期事件
 */
function createSessionStartHook(audit: AuditLogger, cwd: string, modelId: string): HookDefinition {
  return {
    event: 'on-session-start',
    name: 'builtin:session-start-logger',
    priority: BUILTIN_HOOK_PRIORITY,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      audit.log(
        'session_start',
        ctx.stepId || 'session',
        {
          sessionId: ctx.agentId,
          cwd,
          modelId,
          startTime: new Date().toISOString(),
        },
        'success',
        'system',
      );
      return { action: 'continue' };
    },
  };
}

function createSessionEndHook(audit: AuditLogger): HookDefinition {
  return {
    event: 'on-session-end',
    name: 'builtin:session-end-logger',
    priority: BUILTIN_HOOK_PRIORITY,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      audit.log(
        'session_end',
        ctx.stepId || 'session',
        {
          endTime: new Date().toISOString(),
          stepResult: ctx.stepResult,
        },
        'success',
        'system',
      );
      return { action: 'continue' };
    },
  };
}

/**
 * 注册全部内置钩子到 HookRunner
 *
 * @param hookRunner HookRunner 实例
 * @param audit AuditLogger 实例（用于 session 生命周期钩子）
 * @param cwd 工作目录（写入 session_start 审计记录）
 * @param modelId 当前模型 ID（写入 session_start 审计记录）
 */
export function registerBuiltinHooks(
  hookRunner: { register: (hook: HookDefinition) => void },
  audit: AuditLogger,
  cwd: string,
  modelId: string,
): void {
  // 钩子 1：文件变更后轻量验证
  hookRunner.register(createPostFileChangeHook());

  // 钩子 2：会话生命周期日志
  hookRunner.register(createSessionStartHook(audit, cwd, modelId));
  hookRunner.register(createSessionEndHook(audit));

  logger.info('Built-in hooks registered', {
    count: 3,
    hooks: [
      'builtin:post-file-change-validate',
      'builtin:session-start-logger',
      'builtin:session-end-logger',
    ],
  });
}
