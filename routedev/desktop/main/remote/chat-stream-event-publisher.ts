import { randomUUID } from 'node:crypto';
import type { ChatStreamPayload } from '../../shared/ipc-types.js';
import type { RemoteError } from '../../shared/remote-protocol.js';
import type {
  RemoteAutonomyMode,
  RemoteImageInput,
} from '../../shared/remote-protocol.js';
import type { EngineEventHub } from './engine-event-hub.js';

export interface RemoteTurnContext {
  sessionId: string;
  turnId: string;
  clientMessageId: string;
}

export interface RemoteTurnContextInput extends Partial<RemoteTurnContext> {
  skillIds?: string[];
  mcpServerIds?: string[];
  allowedToolNames?: string[];
  autonomyMode?: RemoteAutonomyMode;
  images?: RemoteImageInput[];
  /** Phase 97 Part A Task A4：触发来源透传（automation 调度 / remote 远程 / user 本地） */
  triggerSource?: import('../../../src/agent/execution-context.js').TriggerSource;
}

export function createRemoteTurnContext(
  input: RemoteTurnContextInput = {},
): RemoteTurnContext {
  return {
    sessionId: input.sessionId ?? 'desktop-local',
    turnId: input.turnId ?? randomUUID(),
    clientMessageId: input.clientMessageId ?? randomUUID(),
  };
}

function summarize(value: unknown, maxLength = 1_000): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function engineError(message: string, retryable = false): RemoteError {
  return {
    code: 'ENGINE_UNAVAILABLE',
    message,
    retryable,
  };
}

/**
 * Adapts the existing renderer stream to the ordered remote event contract.
 * The event hub commits first; the renderer callback runs second.
 */
export class ChatStreamEventPublisher {
  private failed = false;
  private terminal = false;

  constructor(
    private readonly hub: EngineEventHub,
    readonly context: RemoteTurnContext,
    private readonly rendererSink: (payload: ChatStreamPayload) => void,
  ) {}

  start(userText: string): void {
    this.hub.publish(
      this.context.sessionId,
      this.context.turnId,
      'turn.started',
      { clientMessageId: this.context.clientMessageId, userText },
    );
  }

  emit(payload: ChatStreamPayload): void {
    const { sessionId, turnId } = this.context;
    switch (payload.type) {
      case 'text_delta':
        this.hub.publish(sessionId, turnId, 'assistant.text.delta', {
          text: payload.chunk,
        });
        break;
      case 'reasoning_delta':
        this.hub.publish(sessionId, turnId, 'assistant.reasoning.delta', {
          text: payload.reasoning,
          visibility: 'provider_returned',
        });
        break;
      case 'progress':
        this.hub.publish(sessionId, turnId, 'assistant.progress', {
          text: payload.progress.label,
          source: 'engine',
        });
        break;
      case 'tool_start':
        this.hub.publish(sessionId, turnId, 'tool.started', {
          toolCallId: payload.toolCallId ?? `${turnId}:${payload.toolName}`,
          toolName: payload.toolName,
          argsSummary: summarize(payload.toolArgs),
        });
        break;
      case 'tool_call_delta':
        this.hub.publish(sessionId, turnId, 'tool.output.delta', {
          toolCallId: payload.toolCallId,
          delta: payload.chunk,
        });
        break;
      case 'tool_done': {
        const toolCallId = payload.toolCallId ?? `${turnId}:${payload.toolName}`;
        if (payload.isError) {
          this.hub.publish(sessionId, turnId, 'tool.failed', {
            toolCallId,
            error: engineError(summarize(payload.toolResult) ?? `${payload.toolName} failed`),
          });
        } else {
          this.hub.publish(sessionId, turnId, 'tool.completed', {
            toolCallId,
            outputSummary: summarize(payload.toolResult),
          });
        }
        break;
      }
      case 'error':
        if (!this.terminal) {
          this.failed = true;
          this.terminal = true;
          this.hub.publish(sessionId, turnId, 'turn.failed', {
            error: engineError(payload.error),
          });
        }
        break;
      case 'done':
        if (!this.terminal) {
          this.terminal = true;
          this.hub.publish(sessionId, turnId, 'turn.completed', {
            finishReason: 'stop',
            completionStatus: payload.completionStatus ?? null,
          });
        }
        break;
      case 'thinking':
      case 'micro_summary':
      case 'escalation':
        // thinking is a synthetic UI state, not model output. The remaining
        // renderer-only payloads have no Remote v1 timeline equivalent.
        break;
    }
    this.rendererSink(payload);
  }

  publishTodoResult(
    action: unknown,
    result: unknown,
    isError: boolean | undefined,
  ): void {
    if (isError || !result || typeof result !== 'object') return;
    const metadata = (result as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object') return;

    if (action === 'replace') {
      const items = (metadata as { items?: unknown }).items;
      if (Array.isArray(items)) {
        this.hub.publish(
          this.context.sessionId,
          this.context.turnId,
          'todo.replaced',
          { items: items as never },
        );
      }
      return;
    }

    const item = (metadata as { item?: unknown }).item;
    if (item && typeof item === 'object') {
      this.hub.publish(
        this.context.sessionId,
        this.context.turnId,
        'todo.updated',
        { item: item as never },
      );
    }
  }

  publishApprovalRequired(
    approvalId: string,
    toolName: string,
    args: Record<string, unknown>,
    expiresAt: string,
  ): void {
    this.hub.publish(
      this.context.sessionId,
      this.context.turnId,
      'approval.required',
      {
        approval: {
          approvalId,
          toolName,
          summary: summarize(args) ?? toolName,
          expiresAt,
          canResolveRemotely: true,
        },
      },
    );
  }

  publishApprovalResolved(
    approvalId: string,
    approved: boolean,
    resolvedBy: 'desktop' | 'android',
  ): void {
    this.hub.publish(
      this.context.sessionId,
      this.context.turnId,
      'approval.resolved',
      { approvalId, approved, resolvedBy },
    );
  }

  get didFail(): boolean {
    return this.failed;
  }
}
