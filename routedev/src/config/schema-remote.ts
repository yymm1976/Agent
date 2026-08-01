import { z } from 'zod';

const emptyOrUrl = z.string().refine(
  (value) => value === '' || (() => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  })(),
  '必须为空或有效的 HTTP(S) 地址',
);

const emptyOrHttpsUrl = z.string().refine(
  (value) => value === '' || (() => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  })(),
  '必须为空或有效的 HTTPS 地址',
);

export const RemoteTransportSchema = z.enum(['lan', 'tailscale']);
export type RemoteTransport = z.infer<typeof RemoteTransportSchema>;

const RemoteConfigObjectSchema = z.object({
  enabled: z.boolean().default(false),
  transport: RemoteTransportSchema.default('lan'),
  host: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  port: z.number().int().min(1024).max(65535).default(43117),
  pairingTtlMs: z.number().int().min(60_000).max(30 * 60_000).default(5 * 60_000),
  allowRemoteApprovals: z.boolean().default(false),
  allowAutonomyChange: z.boolean().default(false),
  deviceStorePath: z.string().min(1).default('.routedev/remote/devices.json'),
  lanBaseUrl: emptyOrUrl.default(''),
  tailscaleBaseUrl: emptyOrHttpsUrl.default(''),
}).strict();

/**
 * Desktop remote gateway configuration.
 *
 * LAN mode is explicit and intended for a trusted private network. Tailscale
 * remains available for cross-network HTTPS access.
 */
export const RemoteConfigSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  // Preserve the old behavior for existing configurations that already have
  // a Tailscale URL; fresh configurations default to LAN mode.
  if (record.transport === undefined) {
    record.transport = typeof record.tailscaleBaseUrl === 'string' && record.tailscaleBaseUrl
      ? 'tailscale'
      : 'lan';
  }
  return record;
}, RemoteConfigObjectSchema);

export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;
