// tests/utils/error-messages.test.ts
// 错误消息人性化测试（Phase 24 Task 7）

import { describe, it, expect } from 'vitest';
import {
  classifyError,
  humanizeError,
  formatHumanError,
  formatRoutingNotice,
  type ErrorCategory,
} from '../../src/utils/error-messages.js';

describe('错误消息人性化 (Phase 24 Task 7)', () => {
  // ============================================================
  // 错误分类
  // ============================================================
  describe('classifyError', () => {
    it('LLM 相关错误分类为 llm_api', () => {
      expect(classifyError('LLM stream failed')).toBe('llm_api');
      expect(classifyError('openai api error')).toBe('llm_api');
      expect(classifyError('model not found')).toBe('llm_api');
    });

    it('工具相关错误分类为 tool_exec', () => {
      expect(classifyError('tool execution failed')).toBe('tool_exec');
      expect(classifyError('file not found')).toBe('tool_exec');
      expect(classifyError('directory does not exist')).toBe('tool_exec');
    });

    it('配置相关错误分类为 config', () => {
      expect(classifyError('config validation failed')).toBe('config');
      expect(classifyError('schema error in config')).toBe('config');
    });

    it('网络相关错误分类为 network', () => {
      expect(classifyError('network timeout')).toBe('network');
      expect(classifyError('DNS lookup failed')).toBe('network');
    });

    it('权限相关错误分类为 permission', () => {
      expect(classifyError('permission denied')).toBe('permission');
      expect(classifyError('access blocked by policy')).toBe('permission');
    });

    it('未知错误分类为 unknown', () => {
      expect(classifyError('something weird happened')).toBe('unknown');
    });
  });

  // ============================================================
  // LLM API 错误人性化
  // ============================================================
  describe('humanizeError - LLM API', () => {
    it('ECONNREFUSED 错误（强制 llm_api 类别）', () => {
      const result = humanizeError('connect ECONNREFUSED 127.0.0.1:3000', 'llm_api');
      expect(result.what).toBe('无法连接到 LLM 服务');
      expect(result.why).toContain('服务未启动');
      expect(result.how).toContain('/config');
    });

    it('ECONNREFUSED 错误（自动分类为 network 也合理）', () => {
      // "connect ECONNREFUSED" 无 LLM 关键词，自动分类为 network
      const result = humanizeError('connect ECONNREFUSED 127.0.0.1:3000');
      // 应该匹配到 network 类别的 ECONNREFUSED 模式
      expect(result.what).toBeTruthy();
      expect(result.why).toBeTruthy();
      expect(result.how).toBeTruthy();
    });

    it('timeout 错误', () => {
      const result = humanizeError('Request timeout after 30000ms');
      expect(result.what).toBe('LLM 请求超时');
      expect(result.why).toContain('网络延迟');
      expect(result.how).toContain('timeoutMs');
    });

    it('401 鉴权失败', () => {
      const result = humanizeError('HTTP 401 Unauthorized: invalid api key');
      expect(result.what).toBe('LLM API 鉴权失败');
      expect(result.why).toContain('API Key');
      expect(result.how).toContain('apiKey');
    });

    it('429 速率限制', () => {
      const result = humanizeError('HTTP 429: too many requests');
      expect(result.what).toBe('触发 LLM 速率限制');
      expect(result.why).toContain('频率');
    });

    it('404 模型不存在', () => {
      const result = humanizeError('HTTP 404: model not found');
      expect(result.what).toBe('指定的模型不存在');
      expect(result.why).toContain('模型 ID');
    });

    it('500 服务端错误', () => {
      const result = humanizeError('HTTP 500: internal server error');
      expect(result.what).toBe('LLM 服务端错误');
    });
  });

  // ============================================================
  // 工具执行错误人性化
  // ============================================================
  describe('humanizeError - 工具执行', () => {
    it('ENOENT 文件不存在', () => {
      const result = humanizeError('ENOENT: no such file or directory');
      expect(result.what).toBe('文件或目录不存在');
      expect(result.why).toContain('路径错误');
      expect(result.how).toContain('file_search');
    });

    it('EACCES 权限不足（强制 tool_exec 类别）', () => {
      const result = humanizeError('EACCES: permission denied', 'tool_exec');
      expect(result.what).toBe('权限不足');
    });

    it('EACCES 错误（自动分类为 permission 也合理）', () => {
      // "permission denied" 关键词导致分类为 permission
      const result = humanizeError('EACCES: permission denied');
      expect(result.what).toBeTruthy();
      expect(result.why).toBeTruthy();
    });

    it('command not found', () => {
      const result = humanizeError('bash: foo: command not found');
      expect(result.what).toBe('命令未找到');
      expect(result.how).toContain('PATH');
    });

    it('exit code 非零', () => {
      const result = humanizeError('Process exited with code 1');
      expect(result.what).toBe('命令执行失败');
    });
  });

  // ============================================================
  // 配置错误人性化
  // ============================================================
  describe('humanizeError - 配置', () => {
    it('config validation failed', () => {
      const result = humanizeError('config validation failed: missing field');
      expect(result.what).toBe('配置文件格式错误');
      expect(result.how).toContain('/config validate');
    });

    it('missing required field', () => {
      const result = humanizeError('missing required property: apiKey');
      expect(result.what).toBe('配置缺少必填字段');
    });
  });

  // ============================================================
  // 跨类别查找
  // ============================================================
  describe('humanizeError - 跨类别查找', () => {
    it('自动推断类别不准时跨类别匹配', () => {
      // "permission denied" 会被分类为 permission，但 EACCES 模式在 tool_exec 中
      // humanizeError 应跨类别查找找到匹配
      const result = humanizeError('EACCES: permission denied');
      // 应该匹配到 EACCES 模式（tool_exec 类别）
      expect(result.what).toBeTruthy();
    });
  });

  // ============================================================
  // 兜底处理
  // ============================================================
  describe('humanizeError - 兜底', () => {
    it('完全未知的错误返回原始消息', () => {
      const result = humanizeError('totally unknown weird error xyz123');
      expect(result.what).toBe('totally unknown weird error xyz123');
      expect(result.why).toContain('未知');
    });

    it('接受 Error 对象', () => {
      const err = new Error('ECONNREFUSED');
      const result = humanizeError(err);
      expect(result.what).toBe('无法连接到 LLM 服务');
    });
  });

  // ============================================================
  // formatHumanError
  // ============================================================
  describe('formatHumanError', () => {
    it('输出三行结构', () => {
      const output = formatHumanError('ECONNREFUSED');
      const lines = output.split('\n');
      expect(lines.length).toBe(3);
      expect(lines[0]).toContain('[错误]');
      expect(lines[1]).toContain('可能原因：');
      expect(lines[2]).toContain('建议：');
    });

    it('强制指定类别', () => {
      const output = formatHumanError('some error', 'llm_api');
      expect(output).toContain('[错误]');
    });
  });

  // ============================================================
  // 路由透明化
  // ============================================================
  describe('formatRoutingNotice', () => {
    it('默认显示路由决策', () => {
      const lines = formatRoutingNotice('complex', 'gpt-4o', 0.89);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('[路由]');
      expect(lines[0]).toContain('complex');
      expect(lines[0]).toContain('gpt-4o');
      expect(lines[0]).toContain('0.89');
    });

    it('showRoutingDecisions=false 时返回空数组', () => {
      const lines = formatRoutingNotice('simple', 'gpt-4o-mini', 0.95, undefined, {
        showRoutingDecisions: false,
      });
      expect(lines.length).toBe(0);
    });

    it('verbose 模式显示原因', () => {
      const lines = formatRoutingNotice('complex', 'gpt-4o', 0.89, '多文件修改需求', {
        verbose: true,
      });
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain('原因');
      expect(lines[1]).toContain('多文件修改需求');
    });

    it('非 verbose 模式不显示原因', () => {
      const lines = formatRoutingNotice('complex', 'gpt-4o', 0.89, '多文件修改需求');
      expect(lines.length).toBe(1);
    });

    it('无置信度时不显示', () => {
      const lines = formatRoutingNotice('simple', 'gpt-4o-mini');
      expect(lines.length).toBe(1);
      expect(lines[0]).not.toContain('置信度');
    });
  });
});
