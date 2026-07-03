import { logger } from '../../utils/logger.js';

export interface ActionChain {
  startIndex: number;
  endIndex: number;
  chainType: 'debug-loop' | 'repeated-tool' | 'exploration';
  summary: string;
  messageCount: number;
}

interface SimpleMessage {
  role: string;
  content: string | Array<{ type: string; name?: string }>;
}

export class ActionChainDetector {
  private readonly minToolCalls: number;

  constructor(minToolCallsForChain = 3) {
    this.minToolCalls = minToolCallsForChain;
  }

  detect(messages: SimpleMessage[]): ActionChain[] {
    const chains: ActionChain[] = [];
    let chainStart = -1;
    let toolCallCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const isTool = this.isToolMessage(messages[i]);
      if (isTool) {
        if (chainStart === -1) chainStart = i;
        toolCallCount++;
      } else {
        if (chainStart !== -1 && toolCallCount >= this.minToolCalls) {
          const slice = messages.slice(chainStart, i);
          chains.push({
            startIndex: chainStart,
            endIndex: i,
            chainType: 'repeated-tool',
            summary: this.buildSummary(slice),
            messageCount: i - chainStart,
          });
        }
        chainStart = -1;
        toolCallCount = 0;
      }
    }

    if (chainStart !== -1 && toolCallCount >= this.minToolCalls) {
      const slice = messages.slice(chainStart);
      chains.push({
        startIndex: chainStart,
        endIndex: messages.length,
        chainType: 'repeated-tool',
        summary: this.buildSummary(slice),
        messageCount: messages.length - chainStart,
      });
    }

    return chains;
  }

  collapseChain(chain: ActionChain): SimpleMessage {
    return {
      role: 'system',
      content: `[Collapsed] ${chain.summary} (${chain.messageCount} messages, type: ${chain.chainType})`,
    };
  }

  private isToolMessage(msg: SimpleMessage): boolean {
    if (typeof msg.content === 'string') return false;
    if (Array.isArray(msg.content)) {
      return msg.content.some((p) => p.type === 'tool_use' || p.type === 'tool_result');
    }
    return false;
  }

  private buildSummary(messages: SimpleMessage[]): string {
    const toolNames = new Set<string>();
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_use' && part.name) toolNames.add(part.name);
        }
      }
    }
    const names = [...toolNames].join(', ') || 'unknown tools';
    return `Used [${names}] for ${messages.length} steps`;
  }
}
