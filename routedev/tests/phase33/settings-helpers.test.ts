// tests/phase33/settings-helpers.test.ts
// Phase 33 Task 5：SettingsPage 纯函数辅助模块测试
// 覆盖 settings-helpers.ts 中所有导出函数
// 测试策略：项目 vitest 配置为 environment: 'node'，无 React 渲染依赖
//           settings-helpers.ts 已将可测试逻辑提取为纯函数，可直接单测

import { describe, it, expect } from 'vitest';
import {
  parseStringList,
  parseKeyValuePairs,
  keyValueToText,
  constructMcpServer,
  mcpServerToForm,
  EMPTY_MCP_FORM,
  getChannelOptionFields,
  isChannelTypeSupported,
  constructChannelOptions,
  constructChannelEntry,
  getAppVersion,
  type McpFormState,
} from '../../desktop/renderer/src/pages/settings-helpers.js';

// ============================================================
// 通用解析函数
// ============================================================

describe('Phase 33 Task 5: parseStringList', () => {
  it('正常逗号分隔字符串转数组', () => {
    expect(parseStringList('a, b, c')).toEqual(['a', 'b', 'c']);
  });

  it('过滤空值和空白项', () => {
    expect(parseStringList('a, , b, ,')).toEqual(['a', 'b']);
    expect(parseStringList('')).toEqual([]);
    expect(parseStringList('   ')).toEqual([]);
  });
});

describe('Phase 33 Task 5: parseKeyValuePairs', () => {
  it('正常 key=value 文本转对象（每行一个键值对）', () => {
    const text = 'API_KEY=sk-123\nNODE_ENV=production';
    expect(parseKeyValuePairs(text)).toEqual({
      API_KEY: 'sk-123',
      NODE_ENV: 'production',
    });
  });

  it('过滤空行和没有 = 的行', () => {
    const text = '\nAPI_KEY=sk-123\n\nINVALID_LINE\n=missing_key\n';
    expect(parseKeyValuePairs(text)).toEqual({ API_KEY: 'sk-123' });
  });
});

describe('Phase 33 Task 5: keyValueToText', () => {
  it('对象转 key=value 文本（每行一个）', () => {
    expect(keyValueToText({ a: '1', b: '2' })).toBe('a=1\nb=2');
    expect(keyValueToText(undefined)).toBe('');
    expect(keyValueToText({})).toBe('');
  });
});

// ============================================================
// MCP 服务器配置构造
// ============================================================

describe('Phase 33 Task 5: constructMcpServer', () => {
  it('stdio 类型：正确构造带 args 和 env 的配置', () => {
    const form: McpFormState = {
      ...EMPTY_MCP_FORM,
      id: 'fs-server',
      name: '文件系统 MCP',
      transport: 'stdio',
      command: 'npx',
      args: '@mcp/server-fs, /home/user/project',
      env: 'API_KEY=sk-123\nNODE_ENV=production',
      cwd: '/tmp',
    };
    const entry = constructMcpServer(form);
    expect(entry.id).toBe('fs-server');
    expect(entry.name).toBe('文件系统 MCP');
    expect(entry.enabled).toBe(true);
    expect(entry.config.transport).toBe('stdio');
    if (entry.config.transport === 'stdio') {
      expect(entry.config.command).toBe('npx');
      expect(entry.config.args).toEqual(['@mcp/server-fs', '/home/user/project']);
      expect(entry.config.env).toEqual({ API_KEY: 'sk-123', NODE_ENV: 'production' });
      expect(entry.config.cwd).toBe('/tmp');
    }
  });

  it('http 类型：正确构造带 headers 的配置', () => {
    const form: McpFormState = {
      ...EMPTY_MCP_FORM,
      id: 'remote-mcp',
      name: '远程 MCP',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: 'Authorization=Bearer xxx',
    };
    const entry = constructMcpServer(form);
    expect(entry.config.transport).toBe('http');
    if (entry.config.transport === 'http') {
      expect(entry.config.url).toBe('https://example.com/mcp');
      expect(entry.config.headers).toEqual({ Authorization: 'Bearer xxx' });
    }
  });

  it('connectTimeout：合法数字被保留，空值或非法值被忽略', () => {
    // 合法数字
    const validForm: McpFormState = {
      ...EMPTY_MCP_FORM,
      id: 't1',
      name: 'T1',
      transport: 'stdio',
      command: 'cmd',
      connectTimeout: '5000',
    };
    expect(constructMcpServer(validForm).connectTimeout).toBe(5000);

    // 空值
    const emptyForm: McpFormState = {
      ...EMPTY_MCP_FORM,
      id: 't2',
      name: 'T2',
      transport: 'stdio',
      command: 'cmd',
      connectTimeout: '',
    };
    expect(constructMcpServer(emptyForm).connectTimeout).toBeUndefined();

    // 非法值（负数）
    const negForm: McpFormState = {
      ...EMPTY_MCP_FORM,
      id: 't3',
      name: 'T3',
      transport: 'stdio',
      command: 'cmd',
      connectTimeout: '-100',
    };
    expect(constructMcpServer(negForm).connectTimeout).toBeUndefined();
  });
});

describe('Phase 33 Task 5: mcpServerToForm', () => {
  it('stdio 配置回填表单', () => {
    const server = {
      id: 'fs',
      name: 'FS',
      enabled: true,
      config: {
        transport: 'stdio' as const,
        command: 'npx',
        args: ['@mcp/server-fs', '/path'],
        env: { KEY: 'val' },
        cwd: '/tmp',
      },
      connectTimeout: 3000,
    };
    const form = mcpServerToForm(server);
    expect(form.id).toBe('fs');
    expect(form.transport).toBe('stdio');
    expect(form.command).toBe('npx');
    expect(form.args).toBe('@mcp/server-fs, /path');
    expect(form.env).toBe('KEY=val');
    expect(form.cwd).toBe('/tmp');
    expect(form.connectTimeout).toBe('3000');
  });

  it('http 配置回填表单', () => {
    const server = {
      id: 'remote',
      name: 'Remote',
      enabled: false,
      config: {
        transport: 'http' as const,
        url: 'https://example.com',
        headers: { Authorization: 'Bearer xxx' },
      },
    };
    const form = mcpServerToForm(server);
    expect(form.transport).toBe('http');
    expect(form.url).toBe('https://example.com');
    expect(form.headers).toBe('Authorization=Bearer xxx');
    expect(form.command).toBe(''); // stdio 字段应为空
    expect(form.connectTimeout).toBe(''); // 未设置
  });
});

// ============================================================
// 渠道 options 配置
// ============================================================

describe('Phase 33 Task 5: getChannelOptionFields', () => {
  it('telegram 返回 3 个字段（botToken/allowedUserIds/pollIntervalMs）', () => {
    const fields = getChannelOptionFields('telegram');
    expect(fields).toHaveLength(3);
    expect(fields.map((f) => f.key)).toEqual(['botToken', 'allowedUserIds', 'pollIntervalMs']);
  });

  it('wechat-work 返回 5 个字段，其中 3 个必填（corpId/corpSecret/token）', () => {
    const fields = getChannelOptionFields('wechat-work');
    expect(fields).toHaveLength(5);
    const required = fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(['corpId', 'corpSecret', 'token']);
  });
});

describe('Phase 33 Task 5: isChannelTypeSupported', () => {
  it('所有合法渠道类型均返回 true', () => {
    expect(isChannelTypeSupported('telegram')).toBe(true);
    expect(isChannelTypeSupported('wechat-work')).toBe(true);
    expect(isChannelTypeSupported('slack')).toBe(true);
  });
});

describe('Phase 33 Task 5: constructChannelOptions', () => {
  it('过滤空值，只保留非空字段', () => {
    const formValues = {
      botToken: '123:ABC',
      allowedUserIds: '',  // 空值应被过滤
      pollIntervalMs: '2000',
    };
    const options = constructChannelOptions('telegram', formValues);
    expect(options).toEqual({
      botToken: '123:ABC',
      pollIntervalMs: '2000',
    });
    expect(options).not.toHaveProperty('allowedUserIds');
  });
});

describe('Phase 33 Task 5: constructChannelEntry', () => {
  it('构造完整的 ChannelEntryConfig', () => {
    const formValues = {
      corpId: 'my-corp',
      corpSecret: 'secret',
      token: 'verify-token',
    };
    const entry = constructChannelEntry('my-channel', 'wechat-work', formValues);
    expect(entry.id).toBe('my-channel');
    expect(entry.type).toBe('wechat-work');
    expect(entry.enabled).toBe(true);
    expect(entry.options).toEqual({
      corpId: 'my-corp',
      corpSecret: 'secret',
      token: 'verify-token',
    });
  });
});

// ============================================================
// 版本号
// ============================================================

describe('Phase 33 Task 5: getAppVersion', () => {
  it('从 package.json 读取版本号（非空字符串）', () => {
    const version = getAppVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
    // 测试环境能读到 package.json，版本号应匹配语义化版本格式
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
