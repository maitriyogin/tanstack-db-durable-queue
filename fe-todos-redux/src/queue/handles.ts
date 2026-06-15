// Per-process state that is intentionally NOT in Redux.
// PatchCollection handles from RTK Query's updateQueryData are closures —
// they cannot be serialized and they do not need to survive a reload (the
// cold-boot sweep re-derives optimistic state from the persisted queue).
//
// Deferreds also cannot live in state; the runner resolves/rejects these
// when an op acks or is discarded.

export interface OpHandle {
  patches: Array<{ undo: () => void }>;
  deferred: { resolve: () => void; reject: (e: unknown) => void };
  // True while the op sits in the quarantine slice. Retry flips it back to
  // false; discard calls patch.undo() and removes the entry entirely.
  quarantined: boolean;
}

const handles = new Map<string, OpHandle>();

export function makeDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function recordHandle(opId: string, handle: OpHandle): void {
  handles.set(opId, handle);
}

export function pushPatch(opId: string, patch: { undo: () => void }): void {
  const h = handles.get(opId);
  if (h) h.patches.push(patch);
}

export function getHandle(opId: string): OpHandle | undefined {
  return handles.get(opId);
}

export function markHandleQuarantined(opId: string, quarantined: boolean): void {
  const h = handles.get(opId);
  if (h) h.quarantined = quarantined;
}

export function clearHandle(opId: string): void {
  // Drop without undoing — used on ack, where the refetch will overwrite.
  handles.delete(opId);
}

export function undoAndClearHandle(opId: string): void {
  const h = handles.get(opId);
  if (!h) return;
  for (const p of h.patches) {
    try {
      p.undo();
    } catch {
      // best-effort
    }
  }
  handles.delete(opId);
}

export function rejectHandle(opId: string, err: unknown): void {
  const h = handles.get(opId);
  if (!h) return;
  h.deferred.reject(err);
}

export function resolveHandle(opId: string): void {
  const h = handles.get(opId);
  if (!h) return;
  h.deferred.resolve();
}

export function clearAllHandles(): void {
  for (const [, h] of handles) {
    try {
      h.deferred.reject(new Error('Local state cleared'));
    } catch {
      // ignore
    }
  }
  handles.clear();
}