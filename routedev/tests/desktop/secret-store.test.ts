import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../../src/config/schema.js';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from('unavailable'),
    decryptString: () => 'unavailable',
  },
}));

import {
  SecretStore,
  persistConfigSecrets,
  restoreConfigSecrets,
} from '../../desktop/main/secret-store.js';

const tempDirs: string[] = [];

function createTempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-secrets-'));
  tempDirs.push(dir);
  return path.join(dir, 'config.yaml');
}

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('SecretStore', () => {
  it('stores secrets outside YAML and restores them through references', () => {
    const configPath = createTempPath();
    const store = new SecretStore(`${configPath}.secrets`, storage);
    const config = {
      providers: { openai: { apiKey: 'sk-test-value' } },
      registryToken: '${REGISTRY_TOKEN}',
      nested: { password: 'local-password' },
    } as unknown as AppConfig;

    const persisted = persistConfigSecrets(config, configPath, store) as unknown as Record<string, any>;
    expect(persisted.providers.openai.apiKey).toBe('${ROUTEDEV_SECRET_PROVIDERS_OPENAI_APIKEY}');
    expect(persisted.registryToken).toBe('${REGISTRY_TOKEN}');
    expect(persisted.nested.password).toBe('${ROUTEDEV_SECRET_NESTED_PASSWORD}');

    const onDisk = fs.readFileSync(`${configPath}.secrets`, 'utf8');
    expect(onDisk).not.toContain('sk-test-value');
    expect(onDisk).not.toContain('local-password');

    const restored = restoreConfigSecrets(persisted as unknown as AppConfig, configPath, store) as unknown as Record<string, any>;
    expect(restored.providers.openai.apiKey).toBe('sk-test-value');
    expect(restored.registryToken).toBe('${REGISTRY_TOKEN}');
    expect(restored.nested.password).toBe('local-password');
  });

  it('rejects plaintext writes when Electron encryption is unavailable', () => {
    const store = new SecretStore(createTempPath() + '.secrets');
    expect(() => store.set('API_KEY', 'secret')).toThrow('拒绝将密钥写入明文配置');
  });
});
