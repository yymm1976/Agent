import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  RemoteDevice,
  RemoteDeviceScope,
} from '../../shared/remote-protocol.js';

interface StoredRemoteDevice extends RemoteDevice {
  tokenHash: string;
}

interface StoredDeviceDocument {
  version: 1;
  devices: StoredRemoteDevice[];
}

export interface DeviceAuthentication {
  device: RemoteDevice;
  scopes: ReadonlySet<RemoteDeviceScope>;
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function publicDevice(device: StoredRemoteDevice): RemoteDevice {
  const { tokenHash: _tokenHash, ...safe } = device;
  return { ...safe, scopes: [...safe.scopes] };
}

/**
 * Persistent device registry. Only SHA-256 hashes of 256-bit random tokens are
 * stored; the raw token exists only in the pairing response.
 */
export class RemoteDeviceStore {
  private readonly devices = new Map<string, StoredRemoteDevice>();
  private readonly revokedListeners = new Set<(deviceId: string) => void>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredDeviceDocument;
      if (parsed.version !== 1 || !Array.isArray(parsed.devices)) return;
      this.devices.clear();
      for (const device of parsed.devices) {
        if (device?.deviceId && device?.tokenHash) {
          this.devices.set(device.deviceId, device);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }

  list(): RemoteDevice[] {
    return [...this.devices.values()]
      .map(publicDevice)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(deviceId: string): RemoteDevice | null {
    const device = this.devices.get(deviceId);
    return device ? publicDevice(device) : null;
  }

  async add(
    deviceId: string,
    deviceName: string,
    scopes: RemoteDeviceScope[],
    rawToken: string,
  ): Promise<RemoteDevice> {
    if (this.devices.has(deviceId)) {
      throw new Error('DEVICE_ALREADY_EXISTS');
    }
    const device: StoredRemoteDevice = {
      deviceId,
      deviceName,
      scopes: [...new Set(scopes)],
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
      tokenHash: hashSecret(rawToken),
    };
    this.devices.set(deviceId, device);
    await this.persist();
    return publicDevice(device);
  }

  async authenticate(rawToken: string): Promise<DeviceAuthentication | null> {
    const candidateHash = hashSecret(rawToken);
    for (const device of this.devices.values()) {
      if (device.revokedAt || !equalHash(candidateHash, device.tokenHash)) continue;
      device.lastSeenAt = new Date().toISOString();
      await this.persist();
      return {
        device: publicDevice(device),
        scopes: new Set(device.scopes),
      };
    }
    return null;
  }

  async revoke(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt) return false;
    device.revokedAt = new Date().toISOString();
    await this.persist();
    for (const listener of this.revokedListeners) {
      try {
        listener(deviceId);
      } catch {
        // Revocation persistence is authoritative; listeners are best effort.
      }
    }
    return true;
  }

  async updateScopes(
    deviceId: string,
    scopes: RemoteDeviceScope[],
  ): Promise<RemoteDevice | null> {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt) return null;
    device.scopes = [...new Set(scopes)];
    await this.persist();
    return publicDevice(device);
  }

  onRevoked(listener: (deviceId: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  private persist(): Promise<void> {
    const document: StoredDeviceDocument = {
      version: 1,
      devices: [...this.devices.values()],
    };
    const serialized = JSON.stringify(document, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const directory = path.dirname(this.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      try {
        await chmod(this.filePath, 0o600);
      } catch {
        // Windows ACLs do not implement POSIX chmod consistently.
      }
    });
    return this.writeQueue;
  }
}
