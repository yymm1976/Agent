import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import type { AppConfig } from '../../src/config/schema.js';
import { loadConfig } from '../../src/config/loader.js';
import { getGlobalConfigPath } from '../../src/utils/paths.js';

const SECRET_PREFIX = '${ROUTEDEV_SECRET_';
const SECRET_SUFFIX = '}';
const SECRET_KEYS = new Set(['apiKey', 'registryToken', 'clientSecret', 'password', 'secret']);

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

function isEnvReference(value: string): boolean {
  return /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value);
}

function isSecretReference(value: string): boolean {
  return value.startsWith(SECRET_PREFIX) && value.endsWith(SECRET_SUFFIX);
}

function secretId(pathParts: string[]): string {
  return pathParts.join('_').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
}

export class SecretStore {
  private cache: Record<string, string> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly storage: SafeStorageLike = safeStorage,
  ) {}

  isAvailable(): boolean {
    try { return this.storage.isEncryptionAvailable(); } catch { return false; }
  }

  get(key: string): string | undefined {
    const encrypted = this.read()[key];
    if (!encrypted || !this.isAvailable()) return undefined;
    try {
      return this.storage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return undefined;
    }
  }

  set(key: string, value: string): void {
    if (!this.isAvailable()) {
      throw new Error('Electron safeStorage 不可用，拒绝将密钥写入明文配置');
    }
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const next = this.read();
    next[key] = this.storage.encryptString(value).toString('base64');
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows ACLs are managed by Electron */ }
    this.cache = next;
  }

  private read(): Record<string, string> {
    if (this.cache) return { ...this.cache };
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.cache = parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
    } catch {
      this.cache = {};
    }
    return { ...this.cache };
  }
}

function transformSecrets(value: unknown, pathParts: string[], store: SecretStore, persist: boolean): unknown {
  if (Array.isArray(value)) return value.map((item, index) => transformSecrets(item, [...pathParts, String(index)], store, persist));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    if (
      SECRET_KEYS.has(key)
      && typeof child === 'string'
      && child.length > 0
      // Secret references also match the generic ${ENV_VAR} shape, but must
      // still be resolved from SecretStore rather than preserved as env refs.
      && (!isEnvReference(child) || isSecretReference(child))
    ) {
      const id = secretId(childPath);
      if (persist && !isSecretReference(child)) {
        store.set(id, child);
        result[key] = `${SECRET_PREFIX}${id}${SECRET_SUFFIX}`;
      } else if (!persist && isSecretReference(child)) {
        result[key] = store.get(id) ?? child;
      } else {
        result[key] = child;
      }
    } else {
      result[key] = transformSecrets(child, childPath, store, persist);
    }
  }
  return result;
}

function secretPath(configPath: string): string {
  return `${configPath}.secrets`;
}

export function persistConfigSecrets(
  config: AppConfig,
  configPath: string,
  store = new SecretStore(secretPath(configPath)),
): AppConfig {
  return transformSecrets(config, [], store, true) as AppConfig;
}

export function restoreConfigSecrets(
  config: AppConfig,
  configPath: string,
  store = new SecretStore(secretPath(configPath)),
): AppConfig {
  return transformSecrets(config, [], store, false) as AppConfig;
}

export function loadConfigWithSecrets(options?: { globalConfigPath?: string; projectPath?: string }): AppConfig {
  const configPath = options?.globalConfigPath ?? process.env.ROUTEDEV_CONFIG_PATH ?? getGlobalConfigPath();
  return restoreConfigSecrets(loadConfig({ ...options, globalConfigPath: configPath }), configPath);
}
