import { logger } from '../../utils/logger.js';

interface SimpleMessage {
  role: string;
  content: string | unknown[];
}

export interface MessageGroup<T extends SimpleMessage = SimpleMessage> {
  messages: T[];
  startIndex: number;
  endIndex: number;
  isCompleteRound: boolean;
}

export interface MessageGrouperConfig {
  cleanBeforeRounds: number;
  keepRecentRounds: number;
}

export class MessageGrouper {
  private readonly config: MessageGrouperConfig;

  constructor(config?: Partial<MessageGrouperConfig>) {
    this.config = {
      cleanBeforeRounds: config?.cleanBeforeRounds ?? 5,
      keepRecentRounds: config?.keepRecentRounds ?? 3,
    };
  }

  getCleanBeforeRounds(): number {
    return this.config.cleanBeforeRounds;
  }

  getKeepRecentRounds(): number {
    return this.config.keepRecentRounds;
  }

  groupByRounds<T extends SimpleMessage>(messages: T[]): MessageGroup<T>[] {
    const groups: MessageGroup<T>[] = [];
    let currentStart = 0;

    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        groups.push({
          messages: messages.slice(currentStart, i),
          startIndex: currentStart,
          endIndex: i,
          isCompleteRound: this.isCompleteRound(messages.slice(currentStart, i)),
        });
        currentStart = i;
      }
    }

    if (currentStart < messages.length) {
      groups.push({
        messages: messages.slice(currentStart),
        startIndex: currentStart,
        endIndex: messages.length,
        isCompleteRound: this.isCompleteRound(messages.slice(currentStart)),
      });
    }

    return groups;
  }

  markCompressible(groups: MessageGroup[], keepRecentRounds: number): boolean[] {
    return groups.map((_, i) => i < groups.length - keepRecentRounds);
  }

  private isCompleteRound(messages: SimpleMessage[]): boolean {
    const hasUser = messages.some((m) => m.role === 'user');
    const hasAssistant = messages.some((m) => m.role === 'assistant');
    return hasUser && hasAssistant;
  }
}
