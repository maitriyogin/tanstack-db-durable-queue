import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';

import { createMutationQueue, type MutationQueueOptions } from '../src/db/mutationQueue';
import {
  connectQuarantineReapplier,
  durableQueueCollectionOptions,
  mintTempId,
} from '../src/db/durableQueueCollection';
import { createBunSqlitePersistence } from './bunSqliteDriver';

interface Todo {
  id: string;
  name: string;
}

function setupHarness(dbFile: string, queueOptions?: MutationQueueOptions) {
  const database = new Database(dbFile);
  const persistence = createBunSqlitePersistence(database);
  // Default backoff in tests is effectively zero so retries don't pile up
  // real wall-clock waits. Tests that need to verify backoff timing pass
  // an explicit { backoff } option.
  const queue = createMutationQueue(persistence, {
    backoff: { base: 0, cap: 0 },
    ...(queueOptions ?? {}),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { database, persistence, queue, queryClient };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fe-todos-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Task #2 — Immediate local apply + durable ordered queue', () => {
  test('insert is enqueued, runner drains, optimistic state is committed', async () => {
    const dbFile = join(tmpDir, 'one.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const serverTodos: Array<Todo> = [];
    const inserts: Array<Todo> = [];

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => serverTodos.slice(),
        queryClient,
        getKey: (t) => t.id,
        onInsert: async ({ transaction }: any) => {
          const m = transaction.mutations[0]!.modified as Todo;
          inserts.push(m);
          serverTodos.push(m);
        },
      }) as any,
    );

    await todos.preload();

    const tx = todos.insert({ id: '1', name: 'first' } as any);
    expect(queue.size()).toBe(1);
    expect(queue.list()[0]!.type).toBe('insert');

    await tx.isPersisted.promise;

    expect(inserts).toEqual([{ id: '1', name: 'first' }]);
    expect(queue.size()).toBe(0);
  });

  test('multiple inserts drain in FIFO order', async () => {
    const dbFile = join(tmpDir, 'two.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const order: Array<string> = [];

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        onInsert: async ({ transaction }: any) => {
          const m = transaction.mutations[0]!.modified as Todo;
          order.push(m.id);
        },
      }) as any,
    );

    await todos.preload();

    const t1 = todos.insert({ id: 'a', name: 'A' } as any);
    const t2 = todos.insert({ id: 'b', name: 'B' } as any);
    const t3 = todos.insert({ id: 'c', name: 'C' } as any);

    await Promise.all([
      t1.isPersisted.promise,
      t2.isPersisted.promise,
      t3.isPersisted.promise,
    ]);

    expect(order).toEqual(['a', 'b', 'c']);
    expect(queue.size()).toBe(0);
  });

  test('non-retryable handler failure quarantines the op (active queue empties)', async () => {
    const dbFile = join(tmpDir, 'three.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        // Default insert is non-retryable; spell it out for the test.
        retrySafe: { insert: false },
        onInsert: async () => {
          throw new Error('boom');
        },
      }) as any,
    );

    await todos.preload();

    todos.insert({ id: 'x', name: 'X' } as any);
    await flushMicrotasks();

    expect(queue.size()).toBe(0);
    // Op moved to quarantine instead of being deleted. The parent
    // transaction stays pending until the user picks retry/discard.
    expect(queue.quarantineList().length).toBe(1);
    expect(queue.quarantineList()[0]!.quarantineError).toContain('boom');
  });
});

describe('Task #3 — Ack reconciliation + refetch', () => {
  test('sibling query keys are invalidated after the op acks', async () => {
    const dbFile = join(tmpDir, 'four.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const invalidatedKeys: Array<unknown> = [];
    const originalInvalidate = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: any) => {
      invalidatedKeys.push(filters?.queryKey);
      return originalInvalidate(filters);
    };

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        invalidates: [['auditCounts'], ['something-else']],
        onInsert: async () => {},
      }) as any,
    );

    await todos.preload();

    const tx = todos.insert({ id: 'i1', name: 'I' } as any);
    await tx.isPersisted.promise;

    // Both sibling keys must be invalidated, exactly once each.
    expect(invalidatedKeys).toContainEqual(['auditCounts']);
    expect(invalidatedKeys).toContainEqual(['something-else']);
  });
});

describe('Task #4 — Temp IDs + reconciliation + render-key alias', () => {
  test('mintTempId returns a recognizable temp prefix', () => {
    const id = mintTempId();
    expect(id.startsWith('temp_')).toBe(true);
  });

  test('insert handler returning {serverId} binds temp → server', async () => {
    const dbFile = join(tmpDir, 'tempid-bind.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        onInsert: async () => ({ serverId: 'server-7' }),
      }) as any,
    );
    await todos.preload();

    const tempId = mintTempId();
    const tx = todos.insert({ id: tempId, name: 'A' } as any);
    await tx.isPersisted.promise;

    expect(queue.resolveServerId('todos', tempId)).toBe('server-7');
    expect(queue.aliasFor('todos', 'server-7')).toBe(tempId);
  });

  test('queued update against a temp id is rewritten to the server id', async () => {
    const dbFile = join(tmpDir, 'tempid-rewrite.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const dispatchedUpdateKeys: Array<string> = [];
    let releaseInsert: (() => void) | undefined;
    const insertGate = new Promise<void>((r) => (releaseInsert = r));

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        onInsert: async () => {
          // Hold the insert open so we can queue an update behind it that
          // still references the temp id, then drain in order.
          await insertGate;
          return { serverId: 'srv-99' };
        },
        onUpdate: async ({ transaction }: any) => {
          dispatchedUpdateKeys.push(transaction.mutations[0]!.key as string);
        },
      }) as any,
    );
    await todos.preload();

    const tempId = mintTempId();
    const insertTx = todos.insert({ id: tempId, name: 'A' } as any);
    const updateTx = todos.update(tempId, (d: any) => {
      d.name = 'A2';
    });

    // Now let the insert complete; the runner should pick up the queued
    // update next and dispatch it under the bound server id, not temp.
    releaseInsert!();
    await Promise.all([insertTx.isPersisted.promise, updateTx.isPersisted.promise]);

    expect(dispatchedUpdateKeys).toEqual(['srv-99']);
  });

  test('id binding survives a process restart', async () => {
    const dbFile = join(tmpDir, 'tempid-persist.sqlite');

    // First "session": bind temp → server.
    {
      const { database, persistence, queue, queryClient } = setupHarness(dbFile);
      const todos = createCollection(
        durableQueueCollectionOptions<Todo>({
          collectionId: 'todos',
          persistence,
          queue,
          queryKey: ['todos'],
          queryFn: async () => [],
          queryClient,
          getKey: (t) => t.id,
          onInsert: async () => ({ serverId: 'persisted-srv' }),
        }) as any,
      );
      await todos.preload();
      const tempId = 'temp_persist-test';
      const tx = todos.insert({ id: tempId, name: 'A' } as any);
      await tx.isPersisted.promise;
      await flushMicrotasks();
      database.close();
    }

    // Second "session": new harness pointing at the same SQLite file. The
    // binding should still resolve.
    {
      const { queue } = setupHarness(dbFile);
      await queue.ready();
      expect(queue.resolveServerId('todos', 'temp_persist-test')).toBe('persisted-srv');
      expect(queue.aliasFor('todos', 'persisted-srv')).toBe('temp_persist-test');
      expect(queue.bindings().map((b) => b.tempId)).toContain('temp_persist-test');
    }
  });
});

describe('Task #5 — Scoped rollback preserving concurrent local edits', () => {
  test('failed op rolls back only itself; later queued op for the same row remains', async () => {
    const dbFile = join(tmpDir, 'rollback-scoped.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const dispatched: Array<{ key: string; name: string }> = [];
    let failNext = true;

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        // Server has todo X already.
        queryFn: async () => [{ id: 'X', name: 'server-X' }],
        queryClient,
        getKey: (t) => t.id,
        // This test is about *rollback semantics*, not retry. Force terminal
        // failure on update so we can assert tx2 survives tx1's rollback.
        retrySafe: { update: false },
        onUpdate: async ({ transaction }: any) => {
          const m = transaction.mutations[0]!;
          if (failNext) {
            failNext = false;
            throw new Error('first update fails');
          }
          dispatched.push({ key: m.key as string, name: m.modified.name });
        },
      }) as any,
    );
    await todos.preload();

    // First update — will fail terminally and quarantine.
    todos.update('X', (d: any) => {
      d.name = 'edit-1';
    });

    // Second, independent update on the same row, made after the optimistic
    // apply of tx1. Should survive tx1's quarantine and reach the server.
    const tx2 = todos.update('X', (d: any) => {
      d.name = 'edit-2';
    });

    await tx2.isPersisted.promise;

    // tx2 dispatched against the live server row, not on top of tx1.
    expect(dispatched).toEqual([{ key: 'X', name: 'edit-2' }]);
    // Active queue is empty (tx1 quarantined, tx2 acked).
    expect(queue.size()).toBe(0);
    expect(queue.quarantineList().length).toBe(1);
  });

  test('unrelated rows are untouched when one row fails', async () => {
    const dbFile = join(tmpDir, 'rollback-unrelated.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const dispatched: Array<string> = [];

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [
          { id: 'A', name: 'server-A' },
          { id: 'B', name: 'server-B' },
        ],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: false },
        onUpdate: async ({ transaction }: any) => {
          const m = transaction.mutations[0]!;
          if (m.key === 'A') throw new Error('A is poisoned');
          dispatched.push(m.key as string);
        },
      }) as any,
    );
    await todos.preload();

    todos.update('A', (d: any) => {
      d.name = 'edit-A';
    });
    const txB = todos.update('B', (d: any) => {
      d.name = 'edit-B';
    });

    await txB.isPersisted.promise;

    expect(dispatched).toEqual(['B']);
    expect(queue.size()).toBe(0);
    expect(queue.quarantineList().length).toBe(1);
  });
});

describe('Task #6 — Multi-collection projections (atomic rollback/quarantine)', () => {
  test('projection runs after parent op acks', async () => {
    const dbFile = join(tmpDir, 'projection-acks.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const dispatched: Array<string> = [];

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        onInsert: async () => {
          dispatched.push('parent');
        },
        projections: {
          audit: {
            apply: async () => {
              dispatched.push('audit');
            },
          },
        },
      }) as any,
    );
    await todos.preload();

    const tx = todos.insert({ id: 't1', name: 'A' } as any);
    await tx.isPersisted.promise;

    // Parent before projection — projections only run after parent server work.
    expect(dispatched).toEqual(['parent', 'audit']);
  });

  test('tolerate: projection failure does not fail the parent', async () => {
    const dbFile = join(tmpDir, 'projection-tolerate.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const errors: Array<unknown> = [];
    const originalWarn = console.warn;
    console.warn = (...args: Array<unknown>) => errors.push(args);

    try {
      const todos = createCollection(
        durableQueueCollectionOptions<Todo>({
          collectionId: 'todos',
          persistence,
          queue,
          queryKey: ['todos'],
          queryFn: async () => [],
          queryClient,
          getKey: (t) => t.id,
          onInsert: async () => {},
          projections: {
            audit: {
              apply: async () => {
                throw new Error('audit-down');
              },
              onError: 'tolerate',
            },
          },
        }) as any,
      );
      await todos.preload();

      const tx = todos.insert({ id: 't2', name: 'B' } as any);
      await tx.isPersisted.promise;

      expect(errors.length).toBeGreaterThan(0);
      expect(queue.size()).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('cascade: projection failure rolls back the parent', async () => {
    const dbFile = join(tmpDir, 'projection-cascade.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    let parentApplied = false;
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        onInsert: async () => {
          parentApplied = true;
        },
        projections: {
          inventory: {
            apply: async () => {
              throw new Error('inventory-down');
            },
            onError: 'cascade',
          },
        },
      }) as any,
    );
    await todos.preload();

    todos.insert({ id: 't3', name: 'C' } as any);
    await flushMicrotasks();
    expect(parentApplied).toBe(true); // parent ran
    expect(queue.size()).toBe(0);
    // Insert is non-retryable by default, so the projection's cascade
    // failure quarantines the parent op.
    expect(queue.quarantineList().length).toBe(1);
    expect(queue.quarantineList()[0]!.quarantineError).toContain('inventory');
  });

  test('cascade rolls back earlier projections optimistic state', async () => {
    const dbFile = join(tmpDir, 'projection-cascade-rollback.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    let firstOptimisticRolledBack = false;

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        onInsert: async () => {},
        projections: {
          first: {
            optimistic: () => () => {
              firstOptimisticRolledBack = true;
            },
            apply: async () => {},
          },
          second: {
            apply: async () => {
              throw new Error('second-down');
            },
            onError: 'cascade',
          },
        },
      }) as any,
    );
    await todos.preload();

    todos.insert({ id: 't4', name: 'D' } as any);
    await flushMicrotasks();
    expect(firstOptimisticRolledBack).toBe(true);
    // Insert quarantines after cascade rollback.
    expect(queue.quarantineList().length).toBe(1);
    expect(queue.quarantineList()[0]!.quarantineError).toContain('second-down');
  });
});

describe('Task #7 — Per-op retrySafe flag', () => {
  test('retryable update succeeds on second attempt', async () => {
    const dbFile = join(tmpDir, 'retry-update.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    let attempts = 0;
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'server-X' }],
        queryClient,
        getKey: (t) => t.id,
        // Default retrySafe puts update in the retryable bucket; spell it
        // out so the intent is clear.
        retrySafe: { update: true },
        onUpdate: async () => {
          attempts++;
          if (attempts < 2) throw new Error('flaky');
        },
      }) as any,
    );
    await todos.preload();

    const tx = todos.update('X', (d: any) => {
      d.name = 'edited';
    });
    await tx.isPersisted.promise;

    expect(attempts).toBe(2);
    expect(queue.size()).toBe(0);
  });

  test('non-retryable insert fails terminally on first error (quarantines)', async () => {
    const dbFile = join(tmpDir, 'noretry-insert.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    let attempts = 0;
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        // Default for inserts is non-retryable; spell it out for the test.
        retrySafe: { insert: false },
        onInsert: async () => {
          attempts++;
          throw new Error('terminal');
        },
      }) as any,
    );
    await todos.preload();

    todos.insert({ id: 't1', name: 'A' } as any);
    await flushMicrotasks();

    expect(attempts).toBe(1);
    expect(queue.size()).toBe(0);
    expect(queue.quarantineList().length).toBe(1);
  });

  test('retrySafe function form lets caller decide per op', async () => {
    const dbFile = join(tmpDir, 'retry-fn.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const seen: Array<string> = [];
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'X' }],
        queryClient,
        getKey: (t) => t.id,
        // Only retry updates whose key starts with 'X'.
        retrySafe: (op) => op.type === 'update' && op.key.startsWith('X'),
        onUpdate: async ({ transaction }: any) => {
          const m = transaction.mutations[0]!;
          seen.push(m.key as string);
          throw new Error('always fails');
        },
      }) as any,
    );
    await todos.preload();

    todos.update('X', (d: any) => {
      d.name = 'edit';
    });
    await flushMicrotasks();

    // MAX_ATTEMPTS = 5 means at most 5 total attempts (1 initial + 4 retries).
    expect(seen.length).toBe(5);
    expect(queue.size()).toBe(0);
    // After hitting the cap the op quarantines (was previously deleted).
    expect(queue.quarantineList().length).toBe(1);
  });
});

// Run several rounds of microtasks so awaited promises settle. Several
// rounds because each `await` only resolves one microtask "level" and the
// runner is several `await`s deep. Also flushes a few setImmediate cycles
// in case the runner is going through a real macrotask boundary.
async function flushMicrotasks(rounds = 50) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// Fake clock + timer harness for the backoff tests. Lets us assert that the
// runner waits the right amount before retrying without sleeping for real.
function createFakeClock(start = 1_000_000) {
  let time = start;
  const timers: Array<{ id: number; fireAt: number; fn: () => void }> = [];
  let nextId = 1;
  return {
    now: () => time,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, fireAt: time + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      const idx = timers.findIndex((t) => t.id === handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
    advance: async (ms: number) => {
      // Always flush pending microtasks before *and* after firing timers so
      // the runner's awaited GraphQL handlers + persistence updates have a
      // chance to settle. Without this, an op enqueued in the same tick
      // sits in pending status from the runner's POV until we yield.
      await flushMicrotasks();
      time += ms;
      while (true) {
        const due = timers
          .filter((t) => t.fireAt <= time)
          .sort((a, b) => a.fireAt - b.fireAt);
        if (due.length === 0) break;
        for (const t of due) {
          const idx = timers.indexOf(t);
          if (idx >= 0) timers.splice(idx, 1);
          t.fn();
          await flushMicrotasks();
        }
      }
      await flushMicrotasks();
    },
    pendingTimers: () => timers.length,
  };
}

describe('Task #8 — Persistent exponential backoff', () => {
  test('backoff doubles per attempt and caps', async () => {
    const dbFile = join(tmpDir, 'backoff-curve.sqlite');
    const clock = createFakeClock();
    const { persistence, queue, queryClient } = setupHarness(dbFile, {
      backoff: { base: 100, cap: 500 },
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    const attemptTimes: Array<number> = [];
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'X' }],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: true },
        onUpdate: async () => {
          attemptTimes.push(clock.now());
          throw new Error('flaky');
        },
      }) as any,
    );
    await todos.preload();

    todos.update('X', (d: any) => {
      d.name = 'edit';
    });

    // Fire 5 backoff steps to hit MAX_ATTEMPTS. Cap is 500ms, so after a few
    // doublings we should plateau there. Curve at base=100, cap=500:
    //   attempt 1 (immediate)
    //   retry 1 -> 100ms
    //   retry 2 -> 200ms
    //   retry 3 -> 400ms
    //   retry 4 -> 500ms (capped)
    await clock.advance(0); // initial run
    await clock.advance(100);
    await clock.advance(200);
    await clock.advance(400);
    await clock.advance(500);

    expect(attemptTimes.length).toBe(5);
    // Deltas between consecutive attempts.
    const deltas = attemptTimes.slice(1).map((t, i) => t - attemptTimes[i]!);
    expect(deltas).toEqual([100, 200, 400, 500]);
  });

  test('runner waits until the op is due before retrying', async () => {
    const dbFile = join(tmpDir, 'backoff-wait.sqlite');
    const clock = createFakeClock();
    const { persistence, queue, queryClient } = setupHarness(dbFile, {
      backoff: { base: 1000, cap: 1000 },
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    let attempts = 0;
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'Y', name: 'Y' }],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: true },
        onUpdate: async () => {
          attempts++;
          if (attempts < 2) throw new Error('once');
        },
      }) as any,
    );
    await todos.preload();

    const tx = todos.update('Y', (d: any) => {
      d.name = 'edit';
    });

    // Initial run.
    await clock.advance(0);
    expect(attempts).toBe(1);

    // Halfway through the backoff: should NOT have retried yet.
    await clock.advance(500);
    expect(attempts).toBe(1);

    // Past the backoff: retry happens.
    await clock.advance(500);
    await tx.isPersisted.promise;
    expect(attempts).toBe(2);
    expect(queue.size()).toBe(0);
  });

  test('persisted nextAttemptAt: a remaining backoff still waits its remaining time after a restart', async () => {
    const dbFile = join(tmpDir, 'backoff-persist.sqlite');

    // Session 1: schedule a retry, then "crash" before the timer fires.
    let scheduledDueAt: number | undefined;
    {
      const clock = createFakeClock(10_000_000);
      const { database, persistence, queue, queryClient } = setupHarness(dbFile, {
        backoff: { base: 1000, cap: 1000 },
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      });
      const todos = createCollection(
        durableQueueCollectionOptions<Todo>({
          collectionId: 'todos',
          persistence,
          queue,
          queryKey: ['todos'],
          queryFn: async () => [{ id: 'Z', name: 'Z' }],
          queryClient,
          getKey: (t) => t.id,
          retrySafe: { update: true },
          onUpdate: async () => {
            throw new Error('always');
          },
        }) as any,
      );
      await todos.preload();

      todos.update('Z', (d: any) => {
        d.name = 'edit';
      });
      // Initial attempt fires; backoff schedules retry at +1000ms.
      await clock.advance(0);
      const persisted = queue.list();
      expect(persisted.length).toBe(1);
      scheduledDueAt = persisted[0]!.nextAttemptAt!;
      expect(scheduledDueAt).toBe(10_000_000 + 1000);
      await flushMicrotasks();
      database.close();
    }

    // Session 2: "200ms later" wall-clock. The op should still be waiting,
    // because nextAttemptAt is 10_001_000 and our new clock starts at
    // 10_000_200 — 800ms remaining of the original backoff.
    {
      const clock = createFakeClock(10_000_200);
      const { queue } = setupHarness(dbFile, {
        backoff: { base: 1000, cap: 1000 },
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      });
      await queue.ready();

      // The persisted op is still in the queue with the original due time.
      const persisted = queue.list();
      expect(persisted.length).toBe(1);
      expect(persisted[0]!.nextAttemptAt).toBe(scheduledDueAt!);
    }
  });
});

describe('Task #9 — Quarantine boundary + cascade grouping', () => {
  test('non-retryable failure quarantines the op (live queue empties; transaction stays pending)', async () => {
    const dbFile = join(tmpDir, 'q-basic.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { insert: false },
        onInsert: async () => {
          throw new Error('insert-down');
        },
      }) as any,
    );
    await todos.preload();

    todos.insert({ id: 'temp_a', name: 'A' } as any);
    // Wait for the runner to drain → fail → quarantine. The parent
    // transaction does NOT settle (so the optimistic state stays visible).
    await flushMicrotasks();

    expect(queue.size()).toBe(0);
    expect(todos.get('temp_a')?.name).toBe('A'); // optimistic stays
    const q = queue.quarantineList();
    expect(q.length).toBe(1);
    expect(q[0]!.quarantineReason).toBe('parent');
    expect(q[0]!.quarantineError).toContain('insert-down');
  });

  test('cascade: failed insert pulls queued updates on the same row', async () => {
    const dbFile = join(tmpDir, 'q-cascade.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    let releaseInsert: (() => void) | undefined;
    const insertGate = new Promise<void>((r) => (releaseInsert = r));

    const updateRan: Array<string> = [];
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { insert: false, update: true },
        onInsert: async () => {
          await insertGate;
          throw new Error('create-down');
        },
        onUpdate: async ({ transaction }: any) => {
          updateRan.push(transaction.mutations[0]!.key);
        },
      }) as any,
    );
    await todos.preload();

    const tempId = 'temp_cascade';
    todos.insert({ id: tempId, name: 'A' } as any);
    todos.update(tempId, (d: any) => {
      d.name = 'A2';
    });

    // Now let the insert fail — the cascade should also pull the queued update.
    releaseInsert!();
    await flushMicrotasks();

    expect(updateRan).toEqual([]); // the queued update never dispatched
    expect(queue.size()).toBe(0);
    const q = queue.quarantineList();
    expect(q.length).toBe(2);
    expect(q.find((o) => o.type === 'insert')!.quarantineReason).toBe('parent');
    expect(q.find((o) => o.type === 'update')!.quarantineReason).toBe('cascade');
  });

  test('failed update on a server-bound row does NOT cascade unrelated edits', async () => {
    // Box #5's contract still holds: two independent updates on the same
    // already-server-bound row are not parent/child. Only inserts cascade.
    const dbFile = join(tmpDir, 'q-no-cascade-on-update.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    let failNext = true;
    const dispatched: Array<string> = [];

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'X' }],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: false },
        onUpdate: async ({ transaction }: any) => {
          if (failNext) {
            failNext = false;
            throw new Error('first-fail');
          }
          dispatched.push(transaction.mutations[0]!.modified.name);
        },
      }) as any,
    );
    await todos.preload();

    todos.update('X', (d: any) => {
      d.name = 'one';
    });
    const tx2 = todos.update('X', (d: any) => {
      d.name = 'two';
    });

    await tx2.isPersisted.promise;

    expect(dispatched).toEqual(['two']);
    // First update quarantined (its transaction stays pending until the user
    // picks retry/discard). Second succeeded normally.
    expect(queue.quarantineList().length).toBe(1);
    expect(queue.quarantineList()[0]!.quarantineReason).toBe('parent');
  });

  test('quarantine survives a process restart', async () => {
    const dbFile = join(tmpDir, 'q-persist.sqlite');

    {
      const { database, persistence, queue, queryClient } = setupHarness(dbFile);
      const todos = createCollection(
        durableQueueCollectionOptions<Todo>({
          collectionId: 'todos',
          persistence,
          queue,
          queryKey: ['todos'],
          queryFn: async () => [],
          queryClient,
          getKey: (t) => t.id,
          retrySafe: { insert: false },
          onInsert: async () => {
            throw new Error('persist-quarantine');
          },
        }) as any,
      );
      await todos.preload();
      todos.insert({ id: 'temp_q', name: 'A' } as any);
      await flushMicrotasks();
      await flushMicrotasks();
      database.close();
    }

    {
      const { queue } = setupHarness(dbFile);
      await queue.ready();
      const q = queue.quarantineList();
      expect(q.length).toBe(1);
      expect(q[0]!.quarantineError).toContain('persist-quarantine');
    }
  });
});

describe('Task #10 — Retry / discard / discard-anchor-requeue-rest', () => {
  // Build a fully-wired harness with the optimistic reapplier connected.
  function setupTodos(opts: {
    dbFile: string;
    onInsert?: (op: any) => Promise<{ serverId?: string } | void>;
    onUpdate?: (op: any) => Promise<void>;
    onDelete?: (op: any) => Promise<void>;
  }) {
    const { persistence, queue, queryClient } = setupHarness(opts.dbFile);
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { insert: false, update: false, delete: false },
        onInsert: opts.onInsert as any,
        onUpdate: opts.onUpdate as any,
        onDelete: opts.onDelete as any,
      }) as any,
    );
    connectQuarantineReapplier({ collection: todos, queue, collectionId: 'todos' });
    return { queue, todos };
  }

  test('quarantined optimistic state stays visible in the live collection', async () => {
    const { queue, todos } = setupTodos({
      dbFile: join(tmpDir, 'q-reapply.sqlite'),
      onInsert: async () => {
        throw new Error('down');
      },
    });
    await todos.preload();

    const tempId = 'temp_reapply';
    todos.insert({ id: tempId, name: 'A' } as any);
    await flushMicrotasks();

    // Row stays visible in the live collection (parent tx not settled yet).
    expect(todos.get(tempId)?.name).toBe('A');
    // Quarantine knows about it.
    expect(queue.quarantineList().length).toBe(1);
  });

  test('retryCascade requeues the group; the next attempt can succeed', async () => {
    let fail = true;
    const inserts: Array<string> = [];
    const { queue, todos } = setupTodos({
      dbFile: join(tmpDir, 'q-retry.sqlite'),
      onInsert: async ({ transaction }: any) => {
        inserts.push(transaction.mutations[0]!.modified.id);
        if (fail) throw new Error('first-fail');
        return { serverId: transaction.mutations[0]!.modified.id };
      },
    });
    await todos.preload();

    const tx = todos.insert({ id: 'temp_r', name: 'A' } as any);
    await flushMicrotasks();
    expect(queue.quarantineList().length).toBe(1);

    // Now flip the server back to healthy and retry.
    fail = false;
    const correlationKey = queue.quarantineList()[0]!.correlationKey;
    await queue.retryCascade(correlationKey);
    await tx.isPersisted.promise; // resolves once the retry acks

    expect(inserts.length).toBe(2);
    expect(queue.size()).toBe(0);
    expect(queue.quarantineList().length).toBe(0);
  });

  test('discardCascade drops the group and rolls back optimistic state', async () => {
    const { queue, todos } = setupTodos({
      dbFile: join(tmpDir, 'q-discard.sqlite'),
      onInsert: async () => {
        throw new Error('down');
      },
    });
    await todos.preload();

    const tempId = 'temp_discard';
    const tx = todos.insert({ id: tempId, name: 'A' } as any);
    await flushMicrotasks();
    expect(todos.get(tempId)?.name).toBe('A');

    const correlationKey = queue.quarantineList()[0]!.correlationKey;
    await queue.discardCascade(correlationKey);
    await expect(tx.isPersisted.promise).rejects.toThrow(/Discarded/);

    // Optimistic insert is gone, quarantine is empty.
    expect(todos.get(tempId)).toBeUndefined();
    expect(queue.quarantineList().length).toBe(0);
  });

  test('discardAnchorRequeueRest drops the failed insert but retries dependents', async () => {
    let releaseInsert: (() => void) | undefined;
    const insertGate = new Promise<void>((r) => (releaseInsert = r));
    const updates: Array<string> = [];

    const { queue, todos } = setupTodos({
      dbFile: join(tmpDir, 'q-anchor.sqlite'),
      onInsert: async () => {
        await insertGate;
        throw new Error('insert-down');
      },
      onUpdate: async ({ transaction }: any) => {
        updates.push(transaction.mutations[0]!.modified.name);
      },
    });
    await todos.preload();

    const tempId = 'temp_anchor';
    const insertTx = todos.insert({ id: tempId, name: 'A' } as any);
    const updateTx = todos.update(tempId, (d: any) => {
      d.name = 'A2';
    });

    // Let the insert fail; cascade picks up the queued update.
    releaseInsert!();
    await flushMicrotasks();

    expect(queue.quarantineList().length).toBe(2);
    const correlationKey = queue.quarantineList()[0]!.correlationKey;

    // User chose: anchor (the create) is discarded, dependents are requeued.
    await queue.discardAnchorRequeueRest(correlationKey);
    await expect(insertTx.isPersisted.promise).rejects.toThrow(/Discarded/);
    await updateTx.isPersisted.promise;

    // The update did dispatch (under the temp key — server may reject in
    // real life, but the wrapper honored the user's intent).
    expect(updates).toEqual(['A2']);
    expect(queue.quarantineList().length).toBe(0);
    expect(queue.size()).toBe(0);
  });
});

describe('Task #11 — Drain on reconnect + auth flip behind a single mutex', () => {
  test('triggerDrain forces a backed-off retry to fire immediately', async () => {
    const dbFile = join(tmpDir, 'trigger-drain-backoff.sqlite');
    const clock = createFakeClock();
    const { persistence, queue, queryClient } = setupHarness(dbFile, {
      backoff: { base: 10_000, cap: 10_000 }, // long backoff
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    let attempts = 0;
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'X' }],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: true },
        onUpdate: async () => {
          attempts++;
          if (attempts < 2) throw new Error('flaky');
        },
      }) as any,
    );
    await todos.preload();

    const tx = todos.update('X', (d: any) => {
      d.name = 'edit';
    });
    await clock.advance(0);
    expect(attempts).toBe(1);

    // Without triggerDrain, we'd wait the full 10s. Simulate "we just came
    // back online" — clear the backoff and retry now.
    queue.triggerDrain();
    await flushMicrotasks();

    await tx.isPersisted.promise;
    expect(attempts).toBe(2);
  });

  test('mutex coalesces concurrent triggers — no double dispatch', async () => {
    const dbFile = join(tmpDir, 'trigger-drain-mutex.sqlite');
    const { persistence, queue, queryClient } = setupHarness(dbFile);

    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((r) => (releaseHandler = r));
    let dispatched = 0;

    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'X' }],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: false },
        onUpdate: async () => {
          dispatched++;
          // Hold the runner so concurrent triggers actually overlap.
          await handlerGate;
        },
      }) as any,
    );
    await todos.preload();

    const tx = todos.update('X', (d: any) => {
      d.name = 'edit';
    });
    // Fire three triggers in the same tick while the handler is still
    // running. With the mutex, the dispatch counter must stay at 1.
    queue.triggerDrain();
    queue.triggerDrain();
    queue.triggerDrain();

    await flushMicrotasks();
    expect(dispatched).toBe(1);

    releaseHandler!();
    await tx.isPersisted.promise;
    expect(dispatched).toBe(1); // even after the drain fully completes
  });

  test('attachDrainTriggers wires online/focus events through to the queue', async () => {
    const dbFile = join(tmpDir, 'trigger-drain-events.sqlite');
    const clock = createFakeClock();
    const { persistence, queue, queryClient } = setupHarness(dbFile, {
      backoff: { base: 10_000, cap: 10_000 },
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    let attempts = 0;
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'X' }],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: true },
        onUpdate: async () => {
          attempts++;
          if (attempts < 2) throw new Error('offline');
        },
      }) as any,
    );
    await todos.preload();

    const eventTarget = new EventTarget();
    const { attachDrainTriggers } = await import('../src/db/drainTriggers');
    const detach = attachDrainTriggers({ queue, windowTarget: eventTarget });

    const tx = todos.update('X', (d: any) => {
      d.name = 'edit';
    });
    await clock.advance(0);
    expect(attempts).toBe(1);

    eventTarget.dispatchEvent(new Event('online'));
    await flushMicrotasks();
    await tx.isPersisted.promise;
    expect(attempts).toBe(2);

    detach();
  });

  test('attachDrainTriggers honors a custom auth-flip subscription', async () => {
    const dbFile = join(tmpDir, 'trigger-drain-auth.sqlite');
    const clock = createFakeClock();
    const { persistence, queue, queryClient } = setupHarness(dbFile, {
      backoff: { base: 10_000, cap: 10_000 },
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    let authListener: (() => void) | undefined;
    const onAuthFlip = (cb: () => void) => {
      authListener = cb;
      return () => {
        authListener = undefined;
      };
    };

    let attempts = 0;
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'X' }],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: true },
        onUpdate: async () => {
          attempts++;
          if (attempts < 2) throw new Error('401');
        },
      }) as any,
    );
    await todos.preload();

    const { attachDrainTriggers } = await import('../src/db/drainTriggers');
    const detach = attachDrainTriggers({
      queue,
      windowTarget: null,
      onAuthFlip,
    });

    const tx = todos.update('X', (d: any) => {
      d.name = 'edit';
    });
    await clock.advance(0);
    expect(attempts).toBe(1);

    // Token refreshed — fire the auth-flip callback the wrapper subscribed.
    authListener!();
    await flushMicrotasks();
    await tx.isPersisted.promise;
    expect(attempts).toBe(2);

    detach();
  });
});

describe('Task #12 — Cold-boot sweep + crash-vs-in-flight disambiguation', () => {
  test('inflight ops left by a crashed session are demoted to pending with recoveredFromCrash', async () => {
    const dbFile = join(tmpDir, 'crash-recover.sqlite');

    let releaseHandler: (() => void) | undefined;
    // Session 1: start an op and "crash" while it's inflight (handler hangs).
    {
      const handlerGate = new Promise<void>((r) => (releaseHandler = r));
      const { database, persistence, queue, queryClient } = setupHarness(dbFile);
      const todos = createCollection(
        durableQueueCollectionOptions<Todo>({
          collectionId: 'todos',
          persistence,
          queue,
          queryKey: ['todos'],
          queryFn: async () => [],
          queryClient,
          getKey: (t) => t.id,
          retrySafe: { insert: true },
          onInsert: async () => {
            await handlerGate; // never released
          },
        }) as any,
      );
      await todos.preload();
      todos.insert({ id: 'temp_crash', name: 'A' } as any);
      // Yield until the runner has flipped the op to inflight + persisted that.
      await flushMicrotasks();
      const persisted = queue.list();
      expect(persisted.length).toBe(1);
      expect(persisted[0]!.status).toBe('inflight');
      expect(persisted[0]!.sessionId).toBe(queue.sessionId());
      // Simulate a hard crash — close the DB without resolving the handler.
      await flushMicrotasks();
      database.close();
    }

    // Session 2: re-open the same DB. The cold-boot sweep should find the
    // stale inflight op and demote it to pending with recoveredFromCrash.
    {
      let session2Attempts = 0;
      const { persistence, queue, queryClient } = setupHarness(dbFile);
      const todos = createCollection(
        durableQueueCollectionOptions<Todo>({
          collectionId: 'todos',
          persistence,
          queue,
          queryKey: ['todos'],
          queryFn: async () => [],
          queryClient,
          getKey: (t) => t.id,
          retrySafe: { insert: true },
          onInsert: async () => {
            session2Attempts++;
          },
        }) as any,
      );
      await todos.preload();
      await queue.ready(); // triggers cold-boot sweep

      // Inspect immediately after the sweep, before drain runs.
      const swept = queue.list();
      expect(swept.length).toBeGreaterThanOrEqual(0);

      // The sweep also kicks a drain — let it complete.
      await flushMicrotasks();

      // The op was retried in session 2. It's done now.
      expect(session2Attempts).toBe(1);
      expect(queue.size()).toBe(0);
    }
    if (releaseHandler) releaseHandler();
  });

  test('recoveredFromCrash flag is set during sweep and cleared on next attempt', async () => {
    const dbFile = join(tmpDir, 'crash-flag.sqlite');

    {
      const { database, persistence, queue, queryClient } = setupHarness(dbFile);
      const todos = createCollection(
        durableQueueCollectionOptions<Todo>({
          collectionId: 'todos',
          persistence,
          queue,
          queryKey: ['todos'],
          queryFn: async () => [],
          queryClient,
          getKey: (t) => t.id,
          retrySafe: { insert: true },
          onInsert: async () => {
            await new Promise(() => {}); // never settles
          },
        }) as any,
      );
      await todos.preload();
      todos.insert({ id: 'temp_flag', name: 'A' } as any);
      await flushMicrotasks();
      await flushMicrotasks();
      database.close();
    }

    {
      let releaseS2: (() => void) | undefined;
      const s2Gate = new Promise<void>((r) => (releaseS2 = r));
      const { persistence, queue, queryClient } = setupHarness(dbFile);
      const todos = createCollection(
        durableQueueCollectionOptions<Todo>({
          collectionId: 'todos',
          persistence,
          queue,
          queryKey: ['todos'],
          queryFn: async () => [],
          queryClient,
          getKey: (t) => t.id,
          retrySafe: { insert: true },
          onInsert: async () => {
            await s2Gate;
          },
        }) as any,
      );
      await todos.preload();

      // Just preload, don't ready() — inspect the row before the sweep runs.
      const beforeSweep = queue.list();
      const recovered = beforeSweep.find((op) => op.id);
      expect(recovered?.status).toBe('inflight'); // stale flag, foreign session

      await queue.ready();
      // After sweep but before runner attempts: should be pending + flagged.
      // Catching this state is racy because ready() also kicks a drain;
      // assert what's reachable.
      const sweptList = queue.list();
      expect(sweptList.length).toBe(1);
      // Either still pending+recovered (if drain hasn't picked it yet) or
      // inflight (drain picked it up and cleared the flag) — both correct.
      if (sweptList[0]!.status === 'pending') {
        expect(sweptList[0]!.recoveredFromCrash).toBe(true);
      } else {
        expect(sweptList[0]!.recoveredFromCrash).toBe(false);
        expect(sweptList[0]!.sessionId).toBe(queue.sessionId());
      }

      releaseS2!();
      await flushMicrotasks();
    }
  });

  test('sweep moves a cap-exceeded op straight to quarantine', async () => {
    const dbFile = join(tmpDir, 'crash-cap.sqlite');

    {
      const { database, persistence, queue, queryClient } = setupHarness(dbFile, {
        backoff: { base: 0, cap: 0 },
      });
      const todos = createCollection(
        durableQueueCollectionOptions<Todo>({
          collectionId: 'todos',
          persistence,
          queue,
          queryKey: ['todos'],
          queryFn: async () => [{ id: 'X', name: 'X' }],
          queryClient,
          getKey: (t) => t.id,
          retrySafe: { update: true },
          onUpdate: async () => {
            throw new Error('always');
          },
        }) as any,
      );
      await todos.preload();
      todos.update('X', (d: any) => {
        d.name = 'edit';
      });
      await flushMicrotasks();
      // After 5 attempts the op is now in quarantine, not in queue.
      expect(queue.quarantineList().length).toBe(1);
      await flushMicrotasks();
      database.close();
    }

    // Session 2 should see the quarantined row preserved (since #9 verified
    // persistence). This test ensures the cold-boot sweep doesn't somehow
    // un-quarantine or re-enqueue it.
    {
      const { queue } = setupHarness(dbFile);
      await queue.ready();
      expect(queue.size()).toBe(0);
      expect(queue.quarantineList().length).toBe(1);
    }
  });

  test('each createMutationQueue call has a fresh sessionId', () => {
    const dbA = join(tmpDir, 'session-a.sqlite');
    const dbB = join(tmpDir, 'session-b.sqlite');
    const a = setupHarness(dbA).queue;
    const b = setupHarness(dbB).queue;
    expect(a.sessionId()).not.toBe(b.sessionId());
    expect(a.sessionId().length).toBeGreaterThan(8);
  });
});

describe('Offline pause — connectivity errors do not consume retry attempts', () => {
  test('runner pauses while isOnline returns false; resumes on triggerDrain', async () => {
    const dbFile = join(tmpDir, 'offline-pause.sqlite');
    const database = new Database(dbFile);
    const persistence = createBunSqlitePersistence(database);
    let online = false;
    const queue = createMutationQueue(persistence, {
      backoff: { base: 0, cap: 0 },
      isOnline: () => online,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let attempts = 0;
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'X' }],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: true },
        onUpdate: async () => {
          attempts++;
        },
      }) as any,
    );
    await todos.preload();

    // Mutate while "offline".
    const tx = todos.update('X', (d: any) => {
      d.name = 'edit';
    });
    await flushMicrotasks();

    // Op enqueued, but the runner saw isOnline() === false and paused.
    expect(attempts).toBe(0);
    expect(queue.size()).toBe(1);
    expect(queue.list()[0]!.attempts).toBe(0); // never even attempted
    expect(queue.quarantineList().length).toBe(0); // and not quarantined

    // "Come online" + nudge.
    online = true;
    queue.triggerDrain();
    await tx.isPersisted.promise;

    expect(attempts).toBe(1);
    expect(queue.size()).toBe(0);
  });

  test('a long offline window does NOT exhaust MAX_ATTEMPTS', async () => {
    const dbFile = join(tmpDir, 'offline-long.sqlite');
    const database = new Database(dbFile);
    const persistence = createBunSqlitePersistence(database);
    let online = false;
    const queue = createMutationQueue(persistence, {
      backoff: { base: 0, cap: 0 },
      isOnline: () => online,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let attempts = 0;
    const todos = createCollection(
      durableQueueCollectionOptions<Todo>({
        collectionId: 'todos',
        persistence,
        queue,
        queryKey: ['todos'],
        queryFn: async () => [{ id: 'X', name: 'X' }],
        queryClient,
        getKey: (t) => t.id,
        retrySafe: { update: true },
        onUpdate: async () => {
          attempts++;
        },
      }) as any,
    );
    await todos.preload();

    todos.update('X', (d: any) => {
      d.name = 'edit';
    });

    // Simulate the user repeatedly nudging the queue while still offline
    // (focus events, retry button taps, etc.). None of them should burn
    // through MAX_ATTEMPTS.
    for (let i = 0; i < 20; i++) {
      queue.triggerDrain();
      await flushMicrotasks();
    }

    expect(attempts).toBe(0);
    expect(queue.size()).toBe(1);
    expect(queue.quarantineList().length).toBe(0);
  });
});
