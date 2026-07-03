import { describe, it, expect, beforeEach } from 'vitest';
import {
  SessionMemoryStore,
  type SessionMemory,
} from '../../../src/agent/memory/session-memory-store.js';

function makeMemory(overrides: Partial<SessionMemory> = {}): SessionMemory {
  return {
    sessionId: 'session-1',
    summary: 'Implemented authentication module',
    keyDecisions: ['Use JWT for tokens'],
    involvedFiles: ['src/auth.ts'],
    errorsAndFixes: [{ error: 'TypeError', fix: 'Added null check' }],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('SessionMemoryStore', () => {
  let store: SessionMemoryStore;

  beforeEach(() => {
    store = new SessionMemoryStore();
  });

  describe('save + get', () => {
    it('saves and retrieves a memory by sessionId', () => {
      const mem = makeMemory();
      store.save(mem);
      expect(store.get('session-1')).toEqual(mem);
    });

    it('returns undefined for unknown sessionId', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('overwrites existing memory with same sessionId', () => {
      store.save(makeMemory({ summary: 'first' }));
      store.save(makeMemory({ summary: 'second' }));
      expect(store.get('session-1')!.summary).toBe('second');
    });
  });

  describe('query', () => {
    it('returns matching memories by keyword in summary', () => {
      store.save(makeMemory({ sessionId: 's1', summary: 'Build authentication system' }));
      store.save(makeMemory({ sessionId: 's2', summary: 'Implement caching layer' }));
      const results = store.query('authentication');
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('s1');
    });

    it('returns matching memories by keyword in keyDecisions', () => {
      store.save(makeMemory({ sessionId: 's1', keyDecisions: ['Use Redis for caching'] }));
      const results = store.query('redis');
      expect(results).toHaveLength(1);
    });

    it('returns empty array when no match', () => {
      store.save(makeMemory({ summary: 'Build UI components' }));
      const results = store.query('blockchain');
      expect(results).toHaveLength(0);
    });

    it('respects limit parameter', () => {
      store.save(makeMemory({ sessionId: 's1', summary: 'auth module' }));
      store.save(makeMemory({ sessionId: 's2', summary: 'auth service' }));
      store.save(makeMemory({ sessionId: 's3', summary: 'auth controller' }));
      const results = store.query('auth', 2);
      expect(results).toHaveLength(2);
    });

    it('scores exact phrase match higher than partial word match', () => {
      store.save(makeMemory({ sessionId: 's1', summary: 'authentication module' }));
      store.save(makeMemory({ sessionId: 's2', summary: 'auth helper' }));
      const results = store.query('authentication module');
      expect(results[0].sessionId).toBe('s1');
    });
  });

  describe('getRecent', () => {
    it('returns memories sorted by updatedAt descending', () => {
      store.save(makeMemory({ sessionId: 's1', updatedAt: 1000 }));
      store.save(makeMemory({ sessionId: 's2', updatedAt: 3000 }));
      store.save(makeMemory({ sessionId: 's3', updatedAt: 2000 }));
      const recent = store.getRecent();
      expect(recent[0].sessionId).toBe('s2');
      expect(recent[1].sessionId).toBe('s3');
      expect(recent[2].sessionId).toBe('s1');
    });

    it('respects limit', () => {
      store.save(makeMemory({ sessionId: 's1', updatedAt: 1000 }));
      store.save(makeMemory({ sessionId: 's2', updatedAt: 2000 }));
      store.save(makeMemory({ sessionId: 's3', updatedAt: 3000 }));
      expect(store.getRecent(2)).toHaveLength(2);
    });
  });

  describe('size', () => {
    it('returns 0 for empty store', () => {
      expect(store.size()).toBe(0);
    });

    it('returns correct count after saves', () => {
      store.save(makeMemory({ sessionId: 's1' }));
      store.save(makeMemory({ sessionId: 's2' }));
      expect(store.size()).toBe(2);
    });
  });

  describe('serialize + deserialize', () => {
    it('roundtrips data correctly', () => {
      const mem1 = makeMemory({ sessionId: 's1', summary: 'first session' });
      const mem2 = makeMemory({ sessionId: 's2', summary: 'second session', updatedAt: 5000 });
      store.save(mem1);
      store.save(mem2);

      const json = store.serialize();
      const store2 = new SessionMemoryStore();
      store2.deserialize(json);

      expect(store2.size()).toBe(2);
      expect(store2.get('s1')!.summary).toBe('first session');
      expect(store2.get('s2')!.summary).toBe('second session');
    });

    it('clears existing data before deserializing', () => {
      store.save(makeMemory({ sessionId: 'old' }));
      const json = JSON.stringify([makeMemory({ sessionId: 'new' })]);
      store.deserialize(json);
      expect(store.get('old')).toBeUndefined();
      expect(store.get('new')).toBeDefined();
    });
  });

  describe('deserialize handles corrupted data', () => {
    it('silently ignores invalid JSON without clearing existing data', () => {
      store.save(makeMemory({ sessionId: 's1' }));
      store.deserialize('not valid json {{{');
      expect(store.size()).toBe(1);
      expect(store.get('s1')).toBeDefined();
    });

    it('silently ignores non-array JSON', () => {
      store.save(makeMemory({ sessionId: 's1' }));
      store.deserialize('{"foo": "bar"}');
      expect(store.size()).toBe(0);
    });
  });
});
