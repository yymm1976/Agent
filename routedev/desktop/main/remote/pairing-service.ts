import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteDeviceScope,
  type RemotePairRequest,
  type RemotePairResponse,
} from '../../shared/remote-protocol.js';
import { RemoteServiceError } from './remote-types.js';
import type { RemoteDeviceStore } from './device-store.js';

interface PendingPairing {
  secretHash: Buffer;
  expiresAt: number;
  used: boolean;
  baseUrl: string;
  desktopName: string;
}

export interface RemotePairingOffer {
  pairingId: string;
  secret: string;
  expiresAt: string;
  baseUrl: string;
  desktopName: string;
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  transport: 'lan' | 'https';
  qrPayload: string;
}

export type PairingApproval = (
  request: Omit<RemotePairRequest, 'secret'>,
  proposedScopes: RemoteDeviceScope[],
) => Promise<RemoteDeviceScope[] | false>;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class RemotePairingService {
  private readonly pending = new Map<string, PendingPairing>();

  constructor(
    private readonly devices: RemoteDeviceStore,
    private readonly approve: PairingApproval,
  ) {}

  createOffer(
    baseUrl: string,
    desktopName: string,
    ttlMs = 5 * 60_000,
    transport: 'lan' | 'https' = 'https',
  ): RemotePairingOffer {
    const pairingId = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    const expiresAtMs = Date.now() + Math.max(1_000, ttlMs);
    this.pending.set(pairingId, {
      secretHash: digest(secret),
      expiresAt: expiresAtMs,
      used: false,
      baseUrl,
      desktopName,
    });
    this.removeExpired();
    const payload = {
      baseUrl,
      pairingId,
      secret,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      desktopName,
      transport,
    };
    return {
      ...payload,
      expiresAt: new Date(expiresAtMs).toISOString(),
      qrPayload: JSON.stringify(payload),
    };
  }

  async pair(request: RemotePairRequest): Promise<RemotePairResponse> {
    const pairing = this.pending.get(request.pairingId);
    if (!pairing) {
      throw new RemoteServiceError('PAIRING_INVALID', '配对信息无效', 401);
    }
    if (pairing.used) {
      throw new RemoteServiceError('PAIRING_INVALID', '配对码已使用', 401);
    }
    if (pairing.expiresAt <= Date.now()) {
      this.pending.delete(request.pairingId);
      throw new RemoteServiceError('PAIRING_EXPIRED', '配对码已过期', 401);
    }
    const receivedHash = digest(request.secret);
    if (
      receivedHash.length !== pairing.secretHash.length
      || !timingSafeEqual(receivedHash, pairing.secretHash)
    ) {
      throw new RemoteServiceError('PAIRING_INVALID', '配对信息无效', 401);
    }

    // Consume before awaiting UI approval so concurrent replays cannot create
    // two tokens from a single secret.
    pairing.used = true;
    const requested = [...new Set(request.requestedScopes)];
    const proposed = requested;
    const { secret: _secret, ...safeRequest } = request;
    const approvedScopes = await this.approve(safeRequest, proposed);
    if (approvedScopes === false) {
      throw new RemoteServiceError('PAIRING_INVALID', '桌面端未批准该设备', 403);
    }
    const grantedScopes = [...new Set(approvedScopes)]
      .filter((scope) => requested.includes(scope));
    const deviceToken = randomBytes(32).toString('base64url');
    await this.devices.add(
      request.deviceId,
      request.deviceName,
      grantedScopes,
      deviceToken,
    );
    this.pending.delete(request.pairingId);
    return {
      deviceId: request.deviceId,
      deviceToken,
      grantedScopes,
      desktopName: pairing.desktopName,
      baseUrl: pairing.baseUrl,
    };
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [pairingId, pairing] of this.pending) {
      if (pairing.expiresAt <= now || pairing.used) {
        this.pending.delete(pairingId);
      }
    }
  }
}
