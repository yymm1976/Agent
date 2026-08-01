import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_PROTOCOL_VERSION,
  type RemotePairRequest,
} from '../../desktop/shared/remote-protocol.js';
import {
  RemoteDeviceStore,
  RemotePairingService,
} from '../../desktop/main/remote/index.js';

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{ store: RemoteDeviceStore; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'routedev-remote-test-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'devices.json');
  const store = new RemoteDeviceStore(filePath);
  await store.initialize();
  return { store, filePath };
}

function requestFrom(
  offer: ReturnType<RemotePairingService['createOffer']>,
  overrides: Partial<RemotePairRequest> = {},
): RemotePairRequest {
  return {
    pairingId: offer.pairingId,
    secret: offer.secret,
    deviceId: 'android-device-1',
    deviceName: 'Pixel',
    requestedScopes: ['sessions:read', 'messages:send', 'approvals:resolve'],
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    ...overrides,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe('Remote pairing and device storage', () => {
  it('marks LAN offers explicitly so clients can apply the local-network URL policy', async () => {
    const { store } = await createStore();
    const service = new RemotePairingService(store, async (_request, proposed) => proposed);
    const offer = service.createOffer('http://192.168.1.20:43117', 'Desktop', 300_000, 'lan');

    expect(offer.transport).toBe('lan');
    expect(JSON.parse(offer.qrPayload)).toMatchObject({
      baseUrl: 'http://192.168.1.20:43117',
      transport: 'lan',
    });
  });

  it('stores only a token hash and revocation invalidates authentication', async () => {
    const { store, filePath } = await createStore();
    const service = new RemotePairingService(store, async (_request, proposed) => proposed);
    const offer = service.createOffer('https://desktop.tailnet.ts.net', 'Desktop');
    const paired = await service.pair(requestFrom(offer));

    const file = await readFile(filePath, 'utf8');
    expect(file).not.toContain(paired.deviceToken);
    expect(file).not.toContain(offer.secret);
    expect((await store.authenticate(paired.deviceToken))?.device.deviceId)
      .toBe('android-device-1');

    await store.revoke('android-device-1');
    expect(await store.authenticate(paired.deviceToken)).toBeNull();
  });

  it('rejects wrong, expired and replayed one-time secrets', async () => {
    const { store } = await createStore();
    const service = new RemotePairingService(store, async (_request, proposed) => proposed);
    const wrongOffer = service.createOffer('https://desktop.tailnet.ts.net', 'Desktop');
    await expect(service.pair(requestFrom(wrongOffer, { secret: 'x'.repeat(32) })))
      .rejects.toMatchObject({ code: 'PAIRING_INVALID' });

    const replayOffer = service.createOffer('https://desktop.tailnet.ts.net', 'Desktop');
    await service.pair(requestFrom(replayOffer));
    await expect(service.pair(requestFrom(replayOffer, { deviceId: 'another-device' })))
      .rejects.toMatchObject({ code: 'PAIRING_INVALID' });

    vi.useFakeTimers();
    const expiredOffer = service.createOffer(
      'https://desktop.tailnet.ts.net',
      'Desktop',
      1_000,
    );
    vi.advanceTimersByTime(1_001);
    await expect(service.pair(requestFrom(expiredOffer, { deviceId: 'expired-device' })))
      .rejects.toMatchObject({ code: 'PAIRING_EXPIRED' });
  });

  it('cannot grant scopes that the device did not request', async () => {
    const { store } = await createStore();
    const service = new RemotePairingService(
      store,
      async () => ['sessions:read', 'approvals:resolve', 'autonomy:change'],
    );
    const offer = service.createOffer('https://desktop.tailnet.ts.net', 'Desktop');
    const paired = await service.pair(requestFrom(offer, {
      requestedScopes: ['sessions:read'],
    }));

    expect(paired.grantedScopes).toEqual(['sessions:read']);
  });

  it('consumes a secret before asynchronous desktop approval completes', async () => {
    const { store } = await createStore();
    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const service = new RemotePairingService(store, async (_request, proposed) => {
      await approval;
      return proposed;
    });
    const offer = service.createOffer('https://desktop.tailnet.ts.net', 'Desktop');
    const first = service.pair(requestFrom(offer));
    await expect(service.pair(requestFrom(offer, { deviceId: 'racer' })))
      .rejects.toMatchObject({ code: 'PAIRING_INVALID' });
    releaseApproval();
    await expect(first).resolves.toMatchObject({ deviceId: 'android-device-1' });
  });
});
