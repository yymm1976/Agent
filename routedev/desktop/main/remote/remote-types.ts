import type { AppConfig } from '../../shared/config-types.js';
import type {
  RemoteDeviceScope,
  RemoteErrorCode,
  RemoteSessionDetail,
  RemoteSessionAclEntry,
  RemoteTool,
} from '../../shared/remote-protocol.js';
import type {
  MCPStatus,
} from '../../shared/ipc-types.js';
import type {
  EngineEventHub,
} from './engine-event-hub.js';
import type { RemoteTurnContextInput } from './chat-stream-event-publisher.js';

export interface RemotePrincipal {
  deviceId: string;
  scopes: ReadonlySet<RemoteDeviceScope>;
}

export interface RemoteEngine {
  isReady(): boolean;
  getProjectInfo(): { id: string; name: string; cwd: string };
  getConfig(): AppConfig;
  getEventHub(): EngineEventHub;
  auditRemoteAction?(
    action: string,
    details: Record<string, unknown>,
    result?: 'success' | 'failure' | 'denied',
  ): void;
  sendChat(text: string, context?: RemoteTurnContextInput): Promise<void>;
  stopGeneration(requestId?: string): void;
  resolveToolConfirm(
    requestId: string,
    approved: boolean,
    payload?: unknown,
    resolvedBy?: 'desktop' | 'android',
  ): void;
  listSkills(): Array<{
    name: string;
    description: string;
    enabled: boolean;
    sourcePath: string;
  }>;
  getMCPStatus(): MCPStatus;
  listRemoteTools(): RemoteTool[];
}

export interface RemoteSessionRecord extends RemoteSessionDetail {
  clientSessionId: string;
  ownerDeviceId: string;
  acl: RemoteSessionAclEntry[];
}

export class RemoteServiceError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RemoteServiceError';
  }
}
