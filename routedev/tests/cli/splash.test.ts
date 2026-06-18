// tests/cli/splash.test.ts

import { describe, it, expect } from 'vitest';
import { renderSplash } from '../../src/cli/splash.js';

describe('renderSplash', () => {
  const baseInfo = {
    version: '0.4.0',
    modelCount: 5,
    readyModels: 3,
    channelsEnabled: ['telegram'],
    projectPath: '/home/user/project',
  };

  it('输出包含版本号', () => {
    const output = renderSplash(baseInfo);
    expect(output).toContain('v0.4.0');
  });

  it('输出包含 RouteDev CLI 标题', () => {
    const output = renderSplash(baseInfo);
    expect(output).toContain('RouteDev CLI');
  });

  it('channelsEnabled 为空时输出 "渠道: 无"', () => {
    const output = renderSplash({ ...baseInfo, channelsEnabled: [] });
    expect(output).toContain('渠道: 无');
  });

  it('channelsEnabled 非空时列出渠道', () => {
    const output = renderSplash({ ...baseInfo, channelsEnabled: ['telegram', 'wechat-work'] });
    expect(output).toContain('渠道: telegram, wechat-work');
  });

  it('输出包含模型就绪信息', () => {
    const output = renderSplash(baseInfo);
    expect(output).toContain('模型: 3/5 就绪');
  });
});
