// tests/skills/governance.test.ts
// B-17：扩展治理——能力版本 / 最小宿主版本 / 权限清单 / 故障隔离
//
// 契约：
// 1. semver 解析与比较（parseVersion/isVersionAtLeast）
// 2. capabilityVersion 不受支持 → 拒绝
// 3. minRouteDevVersion 高于宿主 → 拒绝；低于/等于 → 通过
// 4. 宿主版本未知时不因 minRouteDevVersion 拒绝（fail-open）
// 5. 权限清单摘要（缺省 = 无网络/无环境变量）
// 6. loader 集成：不兼容 skill 在 load() 被过滤且记入 errors

import { describe, it, expect } from 'vitest';
import {
  parseVersion,
  isVersionAtLeast,
  checkSkillCompatibility,
  describeSkillPermissions,
  SUPPORTED_CAPABILITY_VERSION,
} from '../../src/skills/governance.js';
import type { SkillMetadata } from '../../src/skills/skill-md-parser.js';

function meta(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return { name: 's', description: '', version: '1.0.0', author: 'a', tags: [], ...overrides };
}

describe('B-17 governance: semver', () => {
  it('parseVersion 解析 major/minor/patch，非法返回 null', () => {
    expect(parseVersion('4.9.0')).toEqual({ major: 4, minor: 9, patch: 0 });
    expect(parseVersion('4.9.0-beta.1')).toEqual({ major: 4, minor: 9, patch: 0 });
    expect(parseVersion('v4.9.0')).toBeNull();
    expect(parseVersion('abc')).toBeNull();
  });

  it('isVersionAtLeast 比较', () => {
    expect(isVersionAtLeast('4.9.0', '4.8.0')).toBe(true);
    expect(isVersionAtLeast('4.9.0', '4.9.0')).toBe(true);
    expect(isVersionAtLeast('4.9.0', '4.9.1')).toBe(false);
    expect(isVersionAtLeast('5.0.0', '4.9.0')).toBe(true);
    expect(isVersionAtLeast('4.9.0', 'abc')).toBe(false);
  });
});

describe('B-17 governance: checkSkillCompatibility', () => {
  it('缺省字段（存量 skill）兼容', () => {
    expect(checkSkillCompatibility(meta(), '4.9.0')).toEqual({ ok: true });
  });

  it('capabilityVersion 与支持版本一致时通过', () => {
    expect(checkSkillCompatibility(meta({ capabilityVersion: SUPPORTED_CAPABILITY_VERSION }), '4.9.0')).toEqual({ ok: true });
  });

  it('capabilityVersion 不受支持时拒绝并给出原因', () => {
    const r = checkSkillCompatibility(meta({ capabilityVersion: '2' }), '4.9.0');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('能力格式版本 2');
  });

  it('minRouteDevVersion 高于宿主时拒绝', () => {
    const r = checkSkillCompatibility(meta({ minRouteDevVersion: '5.0.0' }), '4.9.0');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('RouteDev >= 5.0.0');
  });

  it('minRouteDevVersion 不高于宿主时通过', () => {
    expect(checkSkillCompatibility(meta({ minRouteDevVersion: '4.8.0' }), '4.9.0')).toEqual({ ok: true });
  });

  it('宿主版本未知时 minRouteDevVersion 不拒绝（fail-open）', () => {
    expect(checkSkillCompatibility(meta({ minRouteDevVersion: '99.0.0' }), undefined)).toEqual({ ok: true });
  });
});

describe('B-17 governance: 权限清单', () => {
  it('缺省 = 无网络/无环境变量/文件仅工作区', () => {
    const p = describeSkillPermissions(meta());
    expect(p.network).toBe(false);
    expect(p.env).toEqual([]);
    expect(p.files).toEqual([]);
  });

  it('显式声明完整汇总', () => {
    const p = describeSkillPermissions(meta({
      permissions: { files: ['src/**'], network: true, env: ['HOME', 'API_KEY'] },
    }));
    expect(p.network).toBe(true);
    expect(p.env).toEqual(['HOME', 'API_KEY']);
    expect(p.files).toEqual(['src/**']);
  });
});
