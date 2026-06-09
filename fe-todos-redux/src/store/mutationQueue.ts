import type { QueryClient } from '@tanstack/react-query';
import { queueActions } from './queueSlice';
import type { AppDispatch, RootState } from './store';
import type { QueueOp } from './types';

// Per-collection wiring: how each op type is dispatched against the server,
// what queries to invalidate after an ack, what render alias the row uses.
// The TanStack DB version did this by composing collection options; here we
// just register handlers explicitly. Closer to the metal, more boilerplate.
export type InsertHandlerResult = { serverId?: string } | void;

export interface CollectionHandlers<T = unknown> {
  onInsert?: (op: QueueOp<T>) => Promise<InsertHandlerResult>;
  onUpdate?: (op: QueueOp<T>) => Promise<void>;
  onDelete?: (op: QueueOp<T>) => Promise<void>;
  // After a successful op, refetch these TQ queries. Same shape as the
  // TanStack DB `invalidates` option. The primary's own refetch is wired
  // separately in registerCollection so consumers don't have to remember it.
  invalidates?: ReadonlyArray<readonly unknown[]>;
  // The TQ query key for the primary read. Invalidated on every successful
  // op for this collection — that's box #3 (ack reconciliation + refetch).
  primaryQueryKey: readonly unknown[];
}

export interface MutationQueue {
  registerCollection<T>(collectionId: string, handlers: CollectionHandlers<T>): void;
  // Caller-facing "I want to enqueue this op and wait until it lands or
  // terminally fails." Mirrors awaitOpCompletion in the TanStack DB version.
  enqueueAndAwait<T>(op: Omit<QueueOp<T>, 'seq'>): Promise<void>;
  // Prods the runner. Called from outside on focus/online/etc — task #11
  // will wire those triggers.
  triggerDrain(): void;
  // Temp→server id resolution. The runner uses this internally to rewrite
  // ops before dispatch; consumers may use it to keep handlers idempotent
  // when payloads include foreign-key references (e.g. shoppingListId on a
  // budget row in the larger fe-todos demo).
  resolveServerId(collectionId: string, key: string): string;
}

export interface MutationQueueOptions {
  store: { getState: () => RootState; dispatch: AppDispatch };
  queryClient: QueryClient;
  // Connectivity gate. When false the runner pauses instead of attempting
  // ops — matches the TanStack DB version's offline-paused behavior.
  isOnline?: () => boolean;
  // Test-injectable clock. Production uses globals.
  now?: () => number;
}

export function createMutationQueue(opts: MutationQueueOptions): MutationQueue {
  const { store, queryClient } = opts;
  const now = opts.now ?? (() => Date.now());
  const isOnline =
    opts.isOnline ??
    (() => {
      const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
      return nav?.onLine ?? true;
    });

  const handlersByCollection = new Map<string, CollectionHandlers<any>>();
  // One deferred per queued op, kept in-process. If the page reloads, the
  // op survives in the persisted store but its caller is gone — no one to
  // resolve. Box #12 handles this on the TanStack DB side; here we'll do
  // the same in a later task.
  const completions = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();

  let draining = false;
  let drainRequestedDuringDrain = false;

  function settle(opId: string, result: { ok: true } | { ok: false; error: unknown }) {
    const d = completions.get(opId);
    if (!d) return;
    completions.delete(opId);
    if (result.ok) d.resolve();
    else d.reject(result.error);
  }

  // Pick the next eligible op from the store. Pending status, nextAttemptAt
  // either null or in the past, lowest seq wins. Reading from the store
  // means the selection is always against current state, no stale snapshot.
  function pickNext(currentTime: number): QueueOp | undefined {
    const ops = store.getState().queue.ops;
    let best: QueueOp | undefined;
    for (const op of Object.values(ops) as QueueOp[]) {
      if (op.status !== 'pending') continue;
      if (op.nextAttemptAt != null && op.nextAttemptAt > currentTime) continue;
      if (!best || op.seq < best.seq) best = op;
    }
    return best;
  }

  function resolveServerIdInternal(collectionId: string, key: string): string {
    const bindings = store.getState().queue.bindings;
    const entry = bindings[`${collectionId}:${key}`];
    return entry ? entry.serverId : key;
  }

  // For update/delete ops queued under a temp id, swap in the bound server
  // id at dispatch time. Insert ops keep the temp id — that's the contract
  // their handler signed up for (they'll return the server id back).
  function rewriteForDispatch<T>(op: QueueOp<T>): QueueOp<T> {
    if (op.type === 'insert') return op;
    const serverId = resolveServerIdInternal(op.collectionId, op.key);
    return serverId === op.key ? op : { ...op, key: serverId };
  }

  async function runOp(op: QueueOp): Promise<void> {
    const handlers = handlersByCollection.get(op.collectionId);
    if (!handlers) {
      throw new Error(`No handlers registered for collection "${op.collectionId}"`);
    }
    const dispatchOp = rewriteForDispatch(op);
    if (op.type === 'insert') {
      const handler = handlers.onInsert;
      if (!handler) throw new Error(`No insert handler for "${op.collectionId}"`);
      const result = await handler(dispatchOp);
      const serverId = result?.serverId;
      if (serverId && serverId !== op.key) {
        store.dispatch(
          queueActions.bindServerId({
            collectionId: op.collectionId,
            tempId: op.key,
            serverId,
          }),
        );
      }
      return;
    }
    const handler = op.type === 'update' ? handlers.onUpdate : handlers.onDelete;
    if (!handler) throw new Error(`No ${op.type} handler for "${op.collectionId}"`);
    await handler(dispatchOp);
  }

  // After a successful ack: invalidate the primary query and any declared
  // siblings. TanStack Query's invalidate triggers a refetch which writes
  // back into the synced cache via the query layer (see provider.tsx for
  // the wiring). That closes box #3.
  async function invalidateAfterAck(op: QueueOp) {
    const handlers = handlersByCollection.get(op.collectionId);
    if (!handlers) return;
    const keys = [handlers.primaryQueryKey, ...(handlers.invalidates ?? [])];
    await Promise.all(
      keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  }

  async function drain(): Promise<void> {
    if (draining) {
      drainRequestedDuringDrain = true;
      return;
    }
    draining = true;
    drainRequestedDuringDrain = false;
    try {
      while (true) {
        if (!isOnline()) return;
        const head = pickNext(now());
        if (!head) return;

        store.dispatch(
          queueActions.patchOp({
            id: head.id,
            patch: {
              status: 'inflight',
              attempts: head.attempts + 1,
              nextAttemptAt: null,
            },
          }),
        );

        try {
          await runOp(head);
          // Remove first, then invalidate. Invalidate is async; if we
          // awaited it before removing, the optimistic overlay would still
          // show the row patched by this op while TQ is mid-refetch. The
          // synced cache will land in todosSlice once the refetch's
          // onSuccess fires.
          store.dispatch(queueActions.removeOp(head.id));
          settle(head.id, { ok: true });
          await invalidateAfterAck(head);
        } catch (error) {
          // Tasks #7–#9 add retrySafe / backoff / quarantine. For #1–#3
          // we simply terminate the op on first failure — caller's
          // awaitOpCompletion deferred rejects, and (since this is task
          // #1's foundation) future tasks layer the recovery semantics
          // back on top.
          store.dispatch(queueActions.removeOp(head.id));
          settle(head.id, { ok: false, error });
        }
      }
    } finally {
      draining = false;
      if (drainRequestedDuringDrain) {
        drainRequestedDuringDrain = false;
        void drain();
      }
    }
  }

  return {
    registerCollection<T>(collectionId: string, handlers: CollectionHandlers<T>) {
      handlersByCollection.set(collectionId, handlers);
    },
    enqueueAndAwait<T>(op: Omit<QueueOp<T>, 'seq'>) {
      return new Promise<void>((resolve, reject) => {
        completions.set(op.id, { resolve, reject });
        store.dispatch(queueActions.enqueue(op as Omit<QueueOp, 'seq'>));
        void drain();
      });
    },
    triggerDrain() {
      void drain();
    },
    resolveServerId: resolveServerIdInternal,
  };
}

// Temp ids — same scheme as fe-todos so the BFF dedup store and any logs
// stay legible across both apps.
export const TEMP_ID_PREFIX = 'temp_';
export function mintTempId(): string {
  return `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
}
export function isTempId(id: string): boolean {
  return id.startsWith(TEMP_ID_PREFIX);
}
