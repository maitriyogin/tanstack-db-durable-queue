# Data-layer coverage — solutions log

How each box from [`data-layer-scenarios.md`](./data-layer-scenarios.md) is covered in the `fe-todos` implementation. One entry per task, in implementation order.

## Architecture in one paragraph

A new collection-options creator, `durableQueueCollectionOptions`, composes `queryCollectionOptions` (sync via TanStack Query) and `persistedCollectionOptions` (SQLite durability via `@tanstack/browser-db-sqlite-persistence`) and replaces the user-supplied `onInsert/onUpdate/onDelete` with handlers that **enqueue** into a durable mutation queue. A separate `MutationQueue` (`createMutationQueue(persistence)`) owns the drain loop, FIFO ordering, and per-op completion deferreds. Components keep using `useLiveQuery` against the wrapped collection unchanged.

Files touched:
- `src/db/durableQueueCollection.ts` — the wrapper itself.
- `src/db/mutationQueue.ts` — the durable runner + ID-binding store.
- `src/db/persistence.ts` — production browser SQLite handle + coordinator + queue instance.
- `src/db/client.ts` — `todosCollection` migrated to use the wrapper.
- `test/bunSqliteDriver.ts` — `bun:sqlite`-backed `SQLiteDriver` so tests run in Bun.
- `test/durableQueueCollection.test.ts` — integration tests, one `describe` block per task.

---

## Task #1 — Scaffold the collection-options creator

**Coverage box:** none (foundation).

**Solution.** Created `durableQueueCollectionOptions<T>(config)` that today is a thin pass-through:
```
durableQueueCollectionOptions(args)
  -> persistedCollectionOptions({ ...queryCollectionOptions(args), persistence, schemaVersion })
```
Migrated `todosCollection` to use it. Components and live queries unchanged. This established the seam every later task layers into without rewriting consumers.

Persistence is **injected** as a parameter (`persistence`, `queue`) rather than imported from a singleton, so tests can supply a Bun-SQLite-backed instance.

---

## Task #2 — Immediate local apply + durable ordered queue

**Coverage box:** ☑ Immediate local apply + durable ordered queue.

**Solution.** A second persisted local-only collection, `mutation-queue`, sharing the same SQLite DB. One row per op (`{id, collectionId, type, key, payload, enqueuedAt, seq, attempts, status}`). The wrapper rewrites the user's mutation handlers so they:
1. Apply the optimistic state (TanStack DB does this automatically).
2. Enqueue an op record durably.
3. `await queue.awaitOpCompletion(opId)` so TanStack DB keeps the optimistic state until the queue runner finishes the user's actual server work (or rejects).

The runner is a singleton per `MutationQueue`, drains FIFO by a monotonic `seq` counter (not `Date.now()`, which collides within a tick), and dispatches via per-collection registered handlers.

**Bug found by the test.** `Date.now()` ties broke ordering for concurrent inserts. Fixed with the `seq` counter as the primary sort key. `enqueuedAt` is retained as wall-clock for diagnostics.

---

## Task #3 — Ack reconciliation + refetch

**Coverage box:** ☑ Ack reconciliation + refetch.

**Solution.** The primary collection's own query already auto-refetches via `queryCollectionOptions` once a handler resolves, so the *primary* side of ack reconciliation rides for free. The gap was **sibling collections** — today's code manually called `queryClient.invalidateQueries(['todoAuditCounts'])` inside `recordAudit`, which every consumer would have to remember.

Added an `invalidates: QueryKey[] | (op) => QueryKey[]` option to the wrapper. After the user's handler resolves, the wrapper invalidates each declared sibling key. `client.ts` now declares `invalidates: [['todoAuditCounts']]` and `recordAudit` no longer invalidates — that's the wrapper's job.

---

## Task #4 — Temp ID generation + crash-safe reconciliation + render-key alias

**Coverage box:** ☑ Temp ID generation, crash-safe reconciliation, render-key alias.

**Solution.** Three coordinated pieces:

1. **Temp ID minting.** `mintTempId()` returns `temp_<uuid>` — recognizable without a side table. `addTodo` uses it instead of a raw UUID. Inserts with non-temp ids are treated as already-server-assigned (no binding needed).
2. **Insert handlers may return `{serverId}`.** `onInsert` for `todosCollection` returns `{ serverId: created.id }` from the GraphQL response. The runner detects `serverId !== op.key` and binds.
3. **Persisted ID-binding store.** Third persisted local-only collection, `id-bindings`, sharing the same SQLite DB. Rows are `{id: "${collectionId}:${tempId}", collectionId, tempId, serverId, boundAt}`. The runner **awaits** the binding's `tx.isPersisted.promise` before settling the parent op, so a crash mid-bind doesn't lose the mapping.
4. **Queue rewrite on bind.** `rewriteKeyForDispatch(op)` substitutes the bound server id into update/delete ops at dispatch time, so a "toggle while create still pending" still hits the right server row.
5. **Render-key alias.** `queue.aliasFor(collectionId, key)` returns the temp id for a known binding, otherwise the input. Components key React lists off this so the row doesn't unmount when the underlying id flips temp→server. (No component change yet — the API is in place for box #11/#12 wiring.)

**Bug found and fixed in the test driver.** The custom `bun:sqlite` SQLiteDriver was using `AsyncLocalStorage` to track transaction depth, which leaked across awaits and caused the persistence layer to emit `BEGIN IMMEDIATE` inside an existing transaction (the "cannot start a transaction within a transaction" warnings we'd seen since Task #2 — flagged but harmless then, blocking now). Replaced with an instance-level `inTransaction` flag now that the driver also serializes via an `enqueue` chain. Cleaner, faster, no more warnings.

---

## Task #5 — Scoped rollback preserving concurrent local edits

**Coverage box:** ☑ Scoped rollback that preserves concurrent local edits.

**Solution. No new code.** Verified by test that the existing architecture already satisfies both halves of the box, by accident of two prior decisions:

- The runner's catch-block deletes only the head op and settles only its deferred — other queued ops are untouched. (Free from Task #2.)
- TanStack DB creates one `Transaction` per `collection.update(...)` call. Rolling back one transaction doesn't touch another's optimistic state. Our wrapper doesn't bundle them — it sees one mutation per transaction at the handler level. (Free from TanStack DB itself.)

Two tests now lock the contract in place:
- `failed op rolls back only itself; later queued op for the same row remains` — same-row concurrent edits.
- `unrelated rows are untouched when one row fails` — different-row independence.

---

## Task #6 — Multi-collection projections (atomic rollback/quarantine)

**Coverage box:** ☑ Multi-collection projections that roll back / quarantine atomically.

**Solution.** Added a `projections` option on the wrapper config:
```ts
projections: {
  [name]: {
    apply: (op) => Promise<void>,            // server-side projection write
    optimistic?: (op) => () => void,         // optional optimistic apply, returns rollback thunk
    onError?: 'cascade' | 'tolerate' | 'quarantine',  // default 'tolerate'
  }
}
```

Projections run **after** the parent's server apply succeeds, in declared order. Each projection's `optimistic()` is invoked synchronously and returns a rollback thunk; `apply()` then performs the server write.

Per-projection error policy:
- **`tolerate`** (default): failure is `console.warn`-logged, this projection's optimistic state is rolled back, the parent continues. Matches today's audit-log "fire and forget" behavior.
- **`cascade`**: failure rolls back the projection's optimistic state, then *all earlier projections' optimistic state in reverse order*, then rethrows so the parent op's optimistic state is also rolled back. Use for hard dependencies (e.g. inventory decrement on a sale).
- **`quarantine`**: behaves like `tolerate` until task #9 wires actual quarantine semantics; the policy is reserved on the type so consumers can declare intent now.

`client.ts` migrated: the audit-log write moved from inline `recordAudit(...)` calls inside each user handler into a single `projections.audit` declaration. The parent handlers (`onInsert`/`onUpdate`/`onDelete`) now do only the GraphQL todo write — the audit happens once, automatically, after each ack. Eliminates the "remember to audit" footgun. A new `auditInputForOp(op)` helper picks the right audit shape (added/updated/deleted, with diffed `changes` for updates) from the queued op's payload.

Tests cover: parent-then-projection ordering, tolerate policy doesn't fail the parent, cascade policy fails the parent, cascade also rolls back earlier projections' optimistic state in reverse order.

---

## Task #7 — Per-op `retrySafe` flag

**Coverage box:** ☑ Per-op `retrySafe` flag honored.

**Solution.** Added `retrySafe` to the wrapper config in two forms:

```ts
// Object form (sugar): per-op-type defaults
retrySafe: { insert: false, update: true, delete: false }

// Function form: per-op decision
retrySafe: (op) => op.type === 'update' && !op.key.startsWith('lock_')
```

Defaults: only `update` is retryable. `insert` and `delete` are non-retryable (without server-side idempotency keys, repeating them risks dup rows or "already deleted" errors). Consumers explicitly opt their inserts/deletes in.

The runner consults `queue.registerRetryPolicy(collectionId, isRetrySafe)` after a handler throws:
- If retryable and below `MAX_ATTEMPTS` (5), the op flips back to `pending` and the runner picks it up again. Today this is *immediate* retry; box #8 inserts exponential backoff at this point.
- Otherwise, the op is terminal: deleted from the queue and the parent transaction rejects (today's behavior preserved).

`MAX_ATTEMPTS` is hardcoded at 5 as a safety cap until box #9 adds proper quarantine. The cap compares against `head.attempts + 1` because `head` is the pre-update snapshot.

Two existing Task #5 tests had to opt out of retry explicitly (`retrySafe: { update: false }`) — the rollback semantics test expects a *terminal* failure, not a retry. Worth flagging because that pattern will recur for any test that wants to assert clean-failure behavior.

Tests cover: retryable update succeeds on its second attempt, non-retryable insert fails terminally on first error, function-form retrySafe makes per-op decisions and terminates at the attempt cap.

---

## Task #8 — Persistent exponential backoff with reload-safe schedule

**Coverage box:** ☑ Persistent exponential backoff with reload-safe schedule.

**Solution.** Three pieces:

1. **`QueueOp.nextAttemptAt: number | null`** — wall-clock ms when the op becomes eligible. Persisted with the op row, so survives reload "for free." `null` means eligible now.
2. **Backoff curve.** On a retryable failure, the runner sets `nextAttemptAt = now() + min(2^attempts × base, cap)`. Defaults `base=500ms`, `cap=30s`. Configurable per `MutationQueue` via `createMutationQueue(persistence, { backoff: { base, cap } })`.
3. **Wake-up timer.** When `pickNextPending(now)` finds nothing eligible, the runner schedules a single `setTimeout` for the earliest scheduled `nextAttemptAt` and exits. The timer fires `drain()`. Multiple drain triggers don't stack — `scheduleWake` clears any existing timer before re-arming.

`pickNextPending` now takes a `currentTime` and skips ops with `nextAttemptAt > currentTime`. `earliestScheduledTime` finds the next due time among all backed-off ops.

**Reload semantics tested.** A test opens session 1, lets the runner schedule a retry for `+1000ms`, then "crashes" (closes the DB) and reopens with a new clock 200ms later. The persisted op still has `nextAttemptAt = 10_000_000 + 1000` so the remaining 800ms of wait is preserved — no premature retry, no reset.

**Clock injection for tests.** `createMutationQueue` accepts `{ now, setTimeout, clearTimeout }`. Production uses globals; tests use a `createFakeClock()` harness that fires due timers when `advance(ms)` is called and flushes microtasks between fires so the runner's awaited persistence updates settle. `setupHarness` defaults to zero backoff so existing tests aren't impacted.

**Edge case fixed during implementation.** When `delay === 0` (zero-backoff in tests), going through `setTimeout(fn, 0)` with the fake clock would lose the runner because the optimistic `queue.update(...)` hadn't propagated yet. Special-cased: `delay > 0` schedules a wake; `delay === 0` falls through `continue` to the next loop iteration, where the update has settled.

Three new tests:
- Backoff curve doubles per attempt and caps at `cap`.
- Runner waits the full backoff before retrying (asserts `attempts` doesn't change halfway through).
- Persisted `nextAttemptAt` survives a session restart with the original due time.

---

## Task #9 — Quarantine boundary + cascade grouping by correlation key

**Coverage box:** ☑ Quarantine boundary + cascade grouping by correlation key.

**Solution.** Three new pieces:

1. **Third persisted collection: `mutation-quarantine`.** Same SQLite handle as the live queue and id-bindings. Quarantined ops keep their original payload, plus three new fields: `quarantineReason: 'parent' | 'cascade'`, `quarantineError?: string` (populated on the parent only), `quarantinedAt: number`.
2. **`correlationKey` on every op.** Stamped at enqueue time. Default is `${collectionId}:${resolveServerId(key)}` — so a queued update on `temp_X` is grouped with its insert *and* keeps the same correlation key after the temp→server bind. Consumers can override via `durableQueueCollectionOptions({ correlationKey: (op) => ... })` for cross-row groupings.
3. **`quarantineCascade(parent, error)`** in the runner. Replaces the prior "delete + reject" terminal path. Inserts a row into `mutation-quarantine` for the parent, settles its transaction with the error. **Cascades only when the parent is an `insert`** — otherwise two unrelated updates on the same server-bound row would over-quarantine each other (Box #5's contract). Cascaded sibling ops get `quarantineReason: 'cascade'`, no error, and reject with `Cascaded from quarantined op "..."`.

**Box #5 collision found and fixed during implementation.** First version cascaded any ops sharing a correlation key. Box #5's "two updates on the same row" test failed because the second update was also being cascaded. The data-layer doc's example is *create → toggle → toggle on the same row* — the create is the anchor; non-insert failures aren't anchors. New rule: only insert quarantines cascade. Documented in the test "failed update on a server-bound row does NOT cascade unrelated edits."

**API surface:** `queue.quarantineList()` returns the persisted quarantined ops for inspection. Box #10 will add `retry` / `discard` / `discard-anchor-requeue-rest` actions on top of this store.

Four new tests:
- Non-retryable failure quarantines the op (live queue empties, quarantine has the row).
- Failed insert pulls queued updates on the same row (the create→child cascade case).
- Failed update on a server-bound row doesn't cascade other edits (preserves Box #5 contract).
- Quarantine survives a process restart.

---

## Task #10 — Retry / discard / discard-anchor-requeue-rest recovery actions

**Coverage box:** ☑ Retry / discard / discard-anchor-requeue-rest recovery actions.

**Solution.** Three new methods on `MutationQueue`:

```ts
queue.retryCascade(correlationKey)              // requeue the whole group
queue.discardCascade(correlationKey)            // drop the whole group, rollback optimistic
queue.discardAnchorRequeueRest(correlationKey)  // drop the parent, retry the children
```

**Critical design pivot during implementation.** The first attempt was: when an op quarantines, `settle(parent.id, { ok: false, error })` rejects the parent transaction, then a `connectQuarantineReapplier(...)` helper writes the optimistic state back into the synced cache via `collection.utils.writeInsert`. Two problems:

1. `collection.insert(...)` in the reapplier would re-trigger the wrapper's `onInsert` handler and re-enqueue, infinite loop.
2. Switching to `writeInsert` (direct synced-cache write) didn't help because `queryCollectionOptions` auto-refetches after every handler resolution; the refetch overwrote the reapply with the empty `queryFn` result.

**The fix.** *Don't settle the parent transaction on quarantine.* TanStack DB keeps an unresolved transaction's optimistic state active indefinitely, so the row stays visible without any reapply machinery. Recovery actions are what eventually settle it:
- `retryCascade(key)` moves group ops from quarantine back to the active queue (via `moveOpFromQuarantineToActive`, which clears `attempts`/`status`/`nextAttemptAt`/quarantine fields and stamps a fresh `seq`). Each op's deferred is still alive — the next drain attempt either resolves it (success) or quarantines again (failure).
- `discardCascade(key)` settles each group op's deferred with a `Discarded after quarantine: ...` rejection, which makes TanStack DB roll back the optimistic state. Deletes the quarantine rows.
- `discardAnchorRequeueRest(key)` rejects only the anchor (parent) op's deferred — rolling back its row — and moves the dependents back to the active queue.

`connectQuarantineReapplier(...)` is now a no-op stub, kept exported so the `client.ts` import line doesn't break. Annotated as such; can be removed entirely once the API contract is firm.

**Test fan-out.** The pivot also meant updating Task #2/#5/#6/#7/#8/#9 tests that previously asserted `await tx.isPersisted.promise.rejects.toThrow(...)` on terminal failures — the parent now stays pending, so those tests were rewritten to assert quarantine state via `flushMicrotasks()` + `queue.quarantineList()`. Net effect: terminal-failure assertions are slightly more verbose (no implicit "the transaction rejected") but the contract they express is the right one (the row stays visible until the user picks recovery).

**`flushMicrotasks` deepened.** Added a couple of `setImmediate` cycles between microtask rounds so the runner's setTimeout-deferred wake fires before assertions.

Four new tests:
- Quarantined optimistic state stays visible in the live collection.
- `retryCascade` requeues the group and the next attempt can succeed.
- `discardCascade` drops the group and rolls back optimistic state.
- `discardAnchorRequeueRest` drops the failed insert but retries dependents.

---

## Task #11 — Drain on reconnect + auth flip behind a single mutex

**Coverage box:** ☑ Drain on reconnect + auth flip behind a single mutex.

**Solution.** Three small additions:

1. **`queue.triggerDrain()`** — canonical "nudge" entrypoint. Force-clears `nextAttemptAt` on backed-off pending ops (so reconnect skips the rest of the wait), then calls `drain()`. The same mutex the wake timer uses applies, so concurrent triggers don't double-dispatch.

2. **Mutex follow-on flag**. The runner already had a `draining` flag; concurrent calls returned early. Box #11 needed the additional invariant: **a trigger that fires while draining must produce one more pass after the current one finishes**, otherwise an op enqueued or unblocked mid-drain gets stranded. Implemented as a `drainRequestedDuringDrain` boolean — set when `drain()` is called while already draining; checked in the `finally` block; if true, `void drain()` chains another pass.

3. **`src/db/drainTriggers.ts`** — opt-in helper `attachDrainTriggers({ queue, windowTarget?, onAuthFlip? })`. Wires `online` / `focus` browser events to `triggerDrain()`. Auth flips are caller-supplied (no standard event), so the consumer passes a subscription callback. Returns a teardown function for tests and HMR. Defaults `windowTarget` to `globalThis` for browsers; pass `null` to skip.

Refetch on reconnect for queries: leaned on TanStack Query's built-in `refetchOnReconnect` (default `true` for `queryCollectionOptions`), no wrapper-level work needed.

Four new tests:
- `triggerDrain` forces a backed-off retry to fire immediately (would otherwise wait the full backoff).
- Mutex coalesces three concurrent `triggerDrain()` calls into a single dispatch (verified by holding the user handler open and asserting `dispatched === 1`).
- `attachDrainTriggers` wires `online` events on a custom `EventTarget` through to the queue.
- `attachDrainTriggers` honors a custom auth-flip subscription callback.

---

## Task #12 — Cold-boot sweep + crash-vs-in-flight disambiguation

**Coverage box:** ☑ Cold-boot sweep + crash-vs-in-flight disambiguation.

**Solution.** Two related pieces:

1. **Per-process `SESSION_ID`.** Each `createMutationQueue(...)` call mints a fresh `crypto.randomUUID()`. Stamped onto every op when the runner flips it to `inflight`. If a later session sees an op with `status: 'inflight'` whose `sessionId` doesn't match, that op was left mid-write by a previous (crashed) session.
2. **`coldBootSweep()`** runs at the end of `queue.ready()`, after the underlying collections have preloaded. Walks every persisted op once and reconciles with this session's reality:
   - **stale `inflight` (foreign sessionId)** → demote to `pending`, set `recoveredFromCrash: true`. `attempts` is preserved (the previous session may already have hit the server, so the next try counts as `attempts + 1`).
   - **`attempts >= MAX_ATTEMPTS` at boot** → straight to quarantine via `quarantineCascade(op, 'Recovered after crash and exceeded retry cap')`. Catches the case where a previous session retried up to the cap and crashed before quarantining.
   - **regular `pending` with future `nextAttemptAt`** → leave as-is. Drain's existing `scheduleWake()` re-arms the timer.
3. **`recoveredFromCrash` is sticky until the next attempt.** When the runner flips an op back to `inflight`, it clears the flag and stamps the current `SESSION_ID`. So the UI only shows "Recovered after crash" while the op is *waiting* in this session, not while it's *being tried*. That preserves a clean three-state UI: pending-recovered (Recovered after crash), inflight (Sending…), quarantined (Failed).
4. **`queue.sessionId()`** exposed on the `MutationQueue` interface, mostly for tests/debugging.

Four new tests:
- Inflight op left by a crashed session is demoted to pending with `recoveredFromCrash` and successfully retries in session 2.
- The flag is set during sweep and cleared on next attempt (asserts the flag flip in either possible interleaving order, since `ready()` also kicks a drain).
- Sweep finds an op that already exceeds `MAX_ATTEMPTS` and routes it to quarantine.
- Each `createMutationQueue` call has a unique `sessionId`.

---

## Coverage complete

All 11 boxes from `data-layer-scenarios.md` are now satisfied:

- [x] Immediate local apply + durable ordered queue
- [x] Ack reconciliation + refetch
- [x] Temp ID generation, crash-safe reconciliation, render-key alias
- [x] Scoped rollback that preserves concurrent local edits
- [x] Multi-collection projections that roll back / quarantine atomically
- [x] Per-op `retrySafe` flag honored
- [x] Persistent exponential backoff with reload-safe schedule
- [x] Quarantine boundary + cascade grouping by correlation key
- [x] Retry / discard / discard-anchor-requeue-rest recovery actions
- [x] Drain on reconnect + auth flip behind a single mutex
- [x] Cold-boot sweep + crash-vs-in-flight disambiguation

**38 integration tests** covering each box, all passing under `bun test`.

---

## Follow-up — Offline-mutation gap (post-Task #12)

**Bug found.** Going offline, mutating a todo, then coming back online sometimes resulted in the mutation never reaching the server. Logs showed the op `enqueue` → `pick` → `inflight` → `reject` (`ERR_INTERNET_DISCONNECTED`) → `retry-scheduled (500ms)` → `pick` → `inflight` → `reject` … Backoff curve (base=500, cap=30s) would burn through MAX_ATTEMPTS=5 in ~7.5 seconds, after which the op was quarantined and the live queue was empty. Coming back online after that did nothing — the op was no longer there to drain.

Two compounding causes:

1. **`attachDrainTriggers` was never wired in `client.ts`.** The Task #11 helper existed but wasn't called, so even ops still in the active backoff window weren't nudged on the `online` event.
2. **Connectivity errors were burning through `MAX_ATTEMPTS`.** Server failures (5xx, validation) deserve the cap; "the world is offline" doesn't. The right fix is to *not attempt the op* when the network is unreachable — nothing to attempt = nothing to fail = no attempt consumed.

**Fix.**

- New `isOnline?: () => boolean` option on `createMutationQueue`. Defaults to `navigator.onLine` in the browser and `true` in Node/tests.
- `drain()` now checks `isOnline()` at the top of each loop iteration; when false, it logs a `offline-paused` stage and exits without picking. The `online` event (via `attachDrainTriggers` in `client.ts`) fires `triggerDrain()`, which re-enters the loop.
- New `offline-paused` log stage so the console trace makes the cause obvious.

Two new tests lock the contract:
- "runner pauses while isOnline returns false; resumes on triggerDrain" — proves the op never increments `attempts` while offline, and resumes successfully when back online.
- "a long offline window does NOT exhaust MAX_ATTEMPTS" — repeatedly nudges the queue while still offline; `attempts` stays 0 and the op never quarantines.

---

## Follow-up — Offline-capable audit collection

**Bug found.** Audit count badge stayed stale offline because it was reading from `todoAuditCountsCollection`, a server-fetched collection that nobody writes to. Even after the offline-pause fix above, audits piggy-backed on the parent todo op's `projection.audit.apply`, which only ran when the parent's server call succeeded — and that's exactly when we're offline.

**Fix.** Audits are now their own first-class wrapped collection.

- New BFF query `allTodoAudits: [TodoAudit!]!` (DAO `findAll`, service `listAll`, resolver `allTodoAudits`).
- New FE `todoAuditsCollection` wrapped via `durableQueueCollectionOptions`. Inserts go through the same durable queue as todos, so an offline-recorded audit waits in SQLite until the network returns. `getKey: (audit) => audit.id` with the temp→server bind handling the id flip.
- Removed `projections.audit` from `todosCollection`. Each `onInsert/onUpdate/onDelete` now calls `enqueueAudit({...})`, which inserts a temp-id row into the audit collection. The wrapper queues the server POST independently.
- Removed the now-unused `todoAuditCountsCollection`. Counts are derived in `TodoList.tsx` via a live query over `todoAuditsCollection` and a synchronous groupBy, so badges update instantly on offline writes.
- Audits and todos are *independent ops* — they don't share a correlation key. If a todo create quarantines, its audits drain on their own (you can end up with audit rows whose todo never landed). Acceptable for an audit log; flagged as a knob to revisit if this becomes important.

**Bug found in this same change.** First pass put `enqueueAudit(...)` *inside* the todo's `onInsert/onUpdate/onDelete` handlers — i.e. only after `await graphql.updateTodo(...)` resolved. Offline that line never resolved (runner paused), so the audit never got into the queue, so the badge stayed flat until reconnect.

**Fix.** Hoisted `enqueueAudit(...)` into intent-time helpers `addTodo` / `updateTodo` / `deleteTodo` exported from `client.ts`. The audit goes into the durable queue the moment the user clicks, *before* the todo's server call. Components migrated from `todosCollection.update/delete(...)` to the new `updateTodo` / `deleteTodo` helpers so the audit-and-todo pairing isn't a footgun.

The `updateTodo` helper diffs `todosCollection.get(id)` before and after the optimistic update so the audit's `changes` payload still captures only audited fields. The `before` snapshot has to come *before* `todosCollection.update(...)` because TanStack DB's optimistic overlay would otherwise mask the prior state.

---

## Follow-up — BFF "XXX" error trigger for exercising the recovery UX

**Why.** The durable queue's failure paths (quarantine, retry/discard/anchor-requeue, cascade) were verified by unit tests but couldn't be exercised against a real running BFF without taking the server offline or bricking the database. Wanted a stable, repeatable way to trip a server-side failure from the UI.

**Trigger.** Any todo whose `name` contains `"XXX"` is rejected at the service layer with a `ForbiddenException`. Implemented in `bff-todos/src/todos/todo.service.ts`:

```ts
const FORBIDDEN_NAME_TOKEN = 'XXX';
function assertNameAllowed(name: string | undefined) {
  if (name && name.includes(FORBIDDEN_NAME_TOKEN)) {
    throw new ForbiddenException({
      code: 'FORBIDDEN_NAME',
      message: `Todo name cannot contain "${FORBIDDEN_NAME_TOKEN}"`,
    });
  }
}
```

`assertNameAllowed` is called from `createTodo` and `updateTodo`. Service-layer placement (vs. resolver or DTO validator) keeps the rule applied to any future transport (REST, CLI), and keeps the resolver thin.

Apollo serializes the `ForbiddenException` into a GraphQL error with `extensions.code = 'FORBIDDEN'` and `originalError.code = 'FORBIDDEN_NAME'`, so the FE can both surface the human message and branch on the structured code.

**Expected FE durable-queue trace** when a user creates `"buy XXX milk"`:

```
[durableQueue] enqueue { type: 'insert', key: 'temp_…', correlationKey: 'todos:temp_…' }
[durableQueue] pick    { attempts: 0 }
[durableQueue] inflight { attempt: 1 }
[durableQueue] reject  { error: 'Todo name cannot contain "XXX"' }
[durableQueue] quarantine { reason: 'parent', error: '…XXX…' }
```

Insert is non-retryable by default (Task #7), so the op quarantines on first failure. The optimistic todo row stays visible (Task #10 invariant: parent transaction is *not* settled on quarantine), and `mutationQueue.quarantineList()` carries the failure metadata. `retryCascade(correlationKey)` re-enqueues (and fails again until the user changes the name); `discardCascade(correlationKey)` settles with rejection and rolls the optimistic row back.

**Open follow-up.** ~~`TodoList.tsx` doesn't yet render a "Failed — Retry / Discard" affordance off `quarantineList()`.~~ **Resolved** — see "Quarantine UI affordance" below.

---

## Follow-up — Quarantine UI affordance

**Why.** Recovery actions (`retryCascade` / `discardCascade`) were wired in the queue and unit-tested, but the UI didn't expose them. With the BFF "XXX" trigger above in place, the only way to drive recovery was from the DevTools console — fine for verifying mechanics, not fine for actually using the app.

**Solution.**

1. **`MutationQueue.subscribeQuarantine(listener)`** — a small subscription API on the queue. Wraps the underlying `quarantine` collection's `subscribeChanges(...)`; returns an unsubscribe. Lets React subscribe without TanStack DB live-query overhead (the quarantine list is plain metadata, not part of `useLiveQuery`'s query graph).
2. **`useQuarantineFor(collectionId)`** — `useSyncExternalStore`-based hook. Returns the current quarantined ops for one collection, re-renders on change. Caches the snapshot per `(collectionId, revision)` because `useSyncExternalStore` requires referential stability between calls or React tears the render.
3. **Inline failure band per todo row** — `TodoList.tsx` builds a `Map<rowId, QueueOp>` of `quarantineReason: 'parent'` entries and renders, when a row matches:
   - The whole row gets a red border instead of the default cream.
   - A red panel appears below the row with the warning icon, the `quarantineError` message, and **Retry** / **Discard** buttons.
   - Buttons call `mutationQueue.retryCascade(correlationKey)` / `mutationQueue.discardCascade(correlationKey)` directly. The queue's existing flow handles the rest: retry re-enqueues (and may quarantine again if "XXX" is still in the name), discard settles with rejection and rolls the optimistic row back.

**`discardAnchorRequeueRest` deliberately not surfaced.** Most XXX-style failures are anchor-only — no dependent ops to requeue. Adding a third button would mean detecting cascades in the UI; rare in this app, can layer in if a real use case shows up.

**Audits intentionally have no failure UI.** Audit failures stay silent (a failed audit shouldn't block a user). `useQuarantineFor('todos')` is scoped to the todos collection only, so audit quarantine entries don't leak into the band.

Files:
- `src/db/mutationQueue.ts` — `subscribeQuarantine` on the interface and impl.
- `src/db/useQuarantine.ts` — new hook.
- `src/components/TodoList.tsx` — band rendering, red border, Retry/Discard wiring.

---

## Follow-up — Shopping list per todo

**Why.** Todos already had nested action affordances (toggle, delete, retry, discard); shopping was a separate top-level page. Threading a shopping list under each todo gives a more concrete data shape to test the durable queue against — nested item adds/removes, server-id binding for the outer list, and offline parity with todos.

**Schema.** Optional 1:1: `ShoppingList.todoId String?` plus `@@index([todoId])`. Standalone lists keep `todoId = null`. Migration `20260604153739_add_shopping_list_todo_id` applied via `prisma migrate dev`.

**BFF.**
- `ShoppingList` model + `CreateShoppingListInput` DTO grew an optional `todoId` field.
- DAO's `create` writes `todoId: input.todoId ?? null`.
- Resolver and service unchanged — `todoId` rides through the existing `createShoppingList` mutation.

**FE — collection migrated to the durable wrapper.** `shoppingListsCollection` was previously plain `queryCollectionOptions`. Wrapped now via `durableQueueCollectionOptions` with the same `persistence` and `mutationQueue` instances todos use. Notes:
- The handler signatures didn't change; the existing `syncItems(original, modified)` in `onUpdate` still does the diff-and-fan-out for nested item adds/removes/updates. It now happens behind the queue's enqueue+await contract.
- Outer list ids use `mintTempId()` so the wrapper recognizes them and binds to the server-assigned id on ack. The `onUpdate` reads `transaction.mutations[0].key` (which the queue rewrites at dispatch time via `rewriteKeyForDispatch`), so item-level GraphQL calls always use the bound server id.
- Inner item ids also use `mintTempId()` for stable React keys, but they don't roundtrip through the binding map — the GraphQL call returns the server-assigned item id and the next refetch reconciles.

**FE — helpers.**
- New `addShoppingListForTodo(todoId, input)` convenience wrapping `addShoppingList({ ...input, todoId })`.
- Existing `addItemToShoppingList`, `updateShoppingListItem`, `removeItemFromShoppingList` unchanged in API; they now flow through the durable queue automatically.

**FE — UI.** New `TodoShoppingPanel` component rendered under each todo row.
- Filters `useLiveQuery(shoppingListsCollection)` client-side for `list.todoId === todoId`.
- If no list yet: a single "+ Add shopping list" button that calls `addShoppingListForTodo(todoId, { name: 'Shopping list', items: [] })`.
- Once a list exists: an expand/collapse "🛒 Shopping list (N) ▸" toggle. Expanded panel shows existing items, an inline "Add item" form with quantity, and an `✕` removal control per item. All mutations go through the wrapped collection helpers, so they queue offline and drain on reconnect just like todos.

**Standalone shopping page** (`ShoppingList.tsx`) left untouched — it lists every list including ones linked to a todo. Flagging as a UX consideration if duplicate visibility is undesirable; would just need to filter out `list.todoId != null`.

---

## Follow-up — Budget table per shopping list

**Why.** Wanted a concrete projection target wired through the durable-queue's projection mechanism, not just the audit log. A budget makes a good test bed because (a) it's not nested inside the parent collection, (b) the deduction is a real monetary-style invariant where rollback semantics matter, and (c) it forces both parent (list) and projection (budget) to coordinate offline.

**Schema.** New `Budget` model with a 1:1 to `ShoppingList` and a `cost Int @default(0)` column on `ShoppingListItem`. Migration `20260604191954_add_budget`.

**BFF.**
- `Budget` GraphQL type added to `shopping-list.model.ts`.
- `CreateShoppingListInput.budgetTotal: Int?` plumbed through DAO; the list's `create` writes a `Budget` row in the same Prisma transaction with `remaining = total − sum(items.cost)`.
- `ShoppingListItem.cost`, `CreateShoppingListItemInput.cost`, `AddShoppingListItemInput.cost` all carry an integer cost.
- New resolver actions: `budgets`, `budgetForShoppingList(id)`, `decrementBudget(shoppingListId, amount)`. The mutation does an atomic `decrement` via Prisma.

**FE.**
- Random helpers: `randInt(70, 100)` for the initial budget total at list creation; `randInt(10, 15)` for each new item's cost. Both rolled client-side so offline writes get a value immediately.
- New wrapped `budgetsCollection` (read-mostly: `queryFn = fetchBudgets`, no `onInsert/onUpdate/onDelete`). Server is the source of truth; the FE only writes to it via the projection's optimistic update.
- `shoppingListsCollection` now declares `invalidates: [['budgets']]` so the synced cache catches up on every list ack, and a `projections.budgetDeduct`:
  - `optimistic(op)` — sums newly-added item costs (items present in `modified` but not in `original`), looks up the budget row by `shoppingListId`, calls `budgetsCollection.utils.writeUpdate({ ...prev, remaining: prev.remaining - delta })` for instant UI feedback, returns a rollback thunk that restores `prev.remaining` if the projection fails.
  - `apply(op)` — same delta, dispatches `graphql.decrementBudget(listId, delta)` against the server.
  - `onError: 'tolerate'` — a budget hiccup is logged but doesn't undo the item add itself.
- The projection runs on both `insert` (initial items in a freshly-created list) and `update` (items added later). For the `insert` path the server already deducted in its create transaction, so the projection's `apply` would double-deduct — guard: `sumNewItemCosts(undefined, modified)` runs against the empty `original` and returns the full sum. To avoid double-deduction the BFF's `create` already applies the `total - sum(items.cost)` math, and the FE's optimistic `writeUpdate` reads the server-fresh `remaining` from `budgetsCollection.get(...)` after the next refetch. **Caveat for the `insert` case**: the optimistic budget decrement could briefly overshoot until `invalidates` triggers a refetch. Acceptable for now; flagged as a sharper-projection refinement if the UI flicker becomes noticeable.
- `TodoShoppingPanel` adds a `💰 $remaining / $total` pill next to the "Shopping list" toggle. Each item line shows `($X)` in muted text. The pill turns red when `remaining < 0` so over-budget is visually obvious.

**File touches:**
- `bff-todos/prisma/schema.prisma` — `Budget` model + `ShoppingListItem.cost`.
- `bff-todos/src/shopping-lists/{model,input,dao,service,resolver}.ts` — Budget type, mutation, read endpoints; cost on item DTOs; budget-create on list-create.
- `fe-todos/src/db/types.ts` — `Budget`, `ShoppingListItem.cost`, `CreateShoppingListInput.budgetTotal`.
- `fe-todos/src/db/graphql.ts` — `BUDGET_FIELDS`, `fetchBudgets`, `decrementBudget`.
- `fe-todos/src/db/shoppingListClient.ts` — `budgetsCollection`, `randInt`, `sumNewItemCosts`, projection on `shoppingListsCollection`, costs threaded through helpers.
- `fe-todos/src/components/TodoShoppingPanel.tsx` — budget pill + per-item cost display.

---

## Follow-up — Split Budget into its own module + collection

**Why.** Initial budget pass landed Budget inside `shopping-lists/` (BFF) and the `budgetsCollection` as a read-only stub inside `shoppingListClient.ts` (FE). Two problems:
1. `Budget` is a separate table; co-locating its resolver with `ShoppingListResolver` made the boundary fuzzy.
2. The FE `budgetsCollection` had no `onInsert`/`onUpdate`, so optimistic budget changes used direct cache writes (`utils.writeUpdate`). Cache writes don't survive the synced cache's next refetch — the budget's "remaining" would briefly overshoot then reconcile.

**BFF refactor.**
- New module: `bff-todos/src/budgets/` mirroring the other modules' shape — `budget.model.ts`, `budget.input.ts`, `budget.dao.ts`, `budget.service.ts`, `budget.resolver.ts`, `budgets.module.ts`. Registered in `AppModule`.
- New `createBudget(input: { shoppingListId, total })` mutation. The shopping-list `create` no longer touches Budget — the FE drives it as a separate op.
- Existing `budgets`, `budgetForShoppingList`, `decrementBudget` moved over.
- `shopping-lists/` cleansed: `Budget` removed from `shopping-list.model.ts`, `budgetTotal` removed from `CreateShoppingListInput`, the budget-create branch removed from `ShoppingListsDao.create`, `listBudgets`/`getBudget`/`decrementBudget` removed from service/dao, and the budget queries/mutation removed from the resolver.

**FE refactor.**
- New file `fe-todos/src/db/budgetClient.ts`. Hosts a fully-wrapped `budgetsCollection` with real `onInsert` (POSTs `createBudget`) and `onUpdate` (POSTs `decrementBudget` with the `original.remaining − modified.remaining` delta). Two helpers: `addBudgetForShoppingList(shoppingListId, total)` (queues the budget create after the list create) and `decrementBudgetForShoppingList(shoppingListId, delta)` (does a normal `collection.update`, going through the queue).
- The budget's `onInsert` resolves the list temp id to its server id via `mutationQueue.resolveServerId('shoppingLists', shoppingListId)` before POSTing — `shoppingListId` is a payload field, not the budget row's key, so the queue's automatic `rewriteKeyForDispatch` doesn't help here. Same trick on `onUpdate`. So a budget op queued before its list create acks still resolves the right server id when it eventually drains.
- `addShoppingList` now: optimistically inserts the list with a temp id, then immediately calls `addBudgetForShoppingList(tempListId, randInt(70,100))`. Two separate ops, two queue rows, both temp-id-bound to the list's server id once it arrives.
- `shoppingListsCollection`'s projection rewritten: it now only fires on `update` (item-add path), and the optimistic side-effect is `decrementBudgetForShoppingList(...)` — a normal `collection.update` on the wrapped budgets collection — instead of a direct cache write. Any budget mutation flows through the durable queue exactly like a parent list mutation. `apply` is now a no-op (the budget update is already queued by `optimistic`); `onError: 'tolerate'` still applies. The `invalidates: [['budgets']]` on the list wrapper is gone — the budget collection's own ack auto-refetches.
- Removed double-deduct path: the BFF's create no longer deducts (it doesn't touch Budget at all), and the projection no longer fires on the list's `insert` path. The initial budget row arrives via its own `createBudget` op.

**One subtlety on item costs at create time.** When you create a list with initial items, each item has a cost but the budget is created separately (and *after*) so no decrement applies to those initial items. The budget remains at `total`. This is correct under the split: the budget only deducts via the projection on item-add, and "items in the original create" aren't an "add" event the projection sees. If you want initial items to deduct too, the cleanest path is to roll them into a queued `update` right after `addBudgetForShoppingList`, but it's not implemented here.

**Files touched:**
- `bff-todos/src/budgets/*` (new module).
- `bff-todos/src/app.module.ts` — registers `BudgetsModule`.
- `bff-todos/src/shopping-lists/{model,input,dao,service,resolver}.ts` — Budget removed.
- `fe-todos/src/db/budgetClient.ts` (new).
- `fe-todos/src/db/graphql.ts` — `createBudget` helper.
- `fe-todos/src/db/shoppingListClient.ts` — projection rewritten, queues budget separately.
- `fe-todos/src/components/TodoShoppingPanel.tsx` — imports `budgetsCollection` from new location.

---

## Coverage status

All 11 boxes from `data-layer-scenarios.md` complete (see Tasks #1–#12 above), plus twelve follow-up patches:

- **Offline-mutation gap.** `isOnline` gate on the runner + `attachDrainTriggers` wired in `client.ts`.
- **Offline-capable audit collection.** Audits are now a first-class durable-queue-backed collection; counts derived via live-query groupBy.
- **BFF `XXX` error trigger.** Service-layer rejection used to exercise the recovery UX against a running server.
- **Quarantine UI affordance.** `subscribeQuarantine` + `useQuarantineFor` hook + inline Failed/Retry/Discard band in `TodoList.tsx`.
- **Shopping list per todo.** Optional 1:1 link, durable-queue-wrapped `shoppingListsCollection`, inline expand/collapse panel under each todo row.
- **Budget table per shopping list.** Budget model, per-item `cost`, projection on the list wrapper that decrements optimistically and reconciles via refetch.
- **Budget split into its own module + queued collection.** Dedicated `budgets/` BFF module with `createBudget` mutation; FE `budgetClient.ts` with a fully-wrapped collection; deduction goes through the queue as a real op via the projection on item-add only.
- **Budget refund on item removal.** New BFF `incrementBudget` mutation; FE budget collection's `onUpdate` branches on the sign of `original.remaining − modified.remaining` and POSTs decrement vs increment accordingly. Projection's `sumNewItemCosts` replaced with `netItemCostDelta` (added − removed) and routed through `adjustBudgetForShoppingList` so a removal queues an increment op the same way an add queues a decrement.
- **Nested item temp→server id binding.** Bug found: offline-added items that were then deleted before reconnect came back when the queue drained, because the remove op captured the item's temp id while `addShoppingListItem` returned a fresh server id we were throwing away. Fix: after each `addShoppingListItem` ack, bind the temp→server id under a synthetic `shoppingListItems` collection namespace via `mutationQueue.bindServerId(...)`. `syncItems` now resolves item ids through that map for `removeShoppingListItem` / `updateShoppingListItem`. Adds run first via a leading `await Promise.all(added)` so any same-batch add-then-remove of the same item lands its bind before the remove translates the id.
- **Cascade-delete shopping list when todo deleted.** `Todo` and `ShoppingList` had a soft link via `ShoppingList.todoId String?` — deleting a todo left the linked shopping list (and its items + budget) orphaned server-side. Fix in two places: (1) Prisma schema converts `todoId` into a real relation `todo Todo? @relation(... onDelete: Cascade)` plus a `shoppingList ShoppingList?` back-reference on Todo. Migration `20260605044218_todo_shopping_list_cascade`. With the cascade Prisma now deletes the linked ShoppingList when a Todo is deleted, which in turn cascades to its items and budget via the existing `onDelete: Cascade` on those relations. (2) FE `deleteTodo(todoId)` helper iterates `shoppingListsCollection` for `list.todoId === todoId` and calls `shoppingListsCollection.delete(list.id)` *before* `todosCollection.delete(todoId)` so the panel disappears immediately rather than waiting for a refetch.
- **Post-bind flicker fix (write-through-bind).** Bug found: offline create + delete of the same shopping list would *briefly* show the list on reconnect, then disappear after refresh. Cause: the create's queryFn auto-refetch lands the new server-id row in the synced cache before the queued delete (still keyed under the temp id) drains. TanStack DB's optimistic-state map keys the delete under the temp id, so it doesn't suppress the server-id row. Fix: `MutationQueue.subscribeBindings(listener)` + `pendingOpsFor(collectionId, key)`. The wrapper's `connectQuarantineReapplier(...)` (formerly a no-op stub) now subscribes; on each bind it walks queued ops with the matching tempId and projects their intent under the bound serverId via `utils.writeDelete` / `utils.writeUpsert` — bypassing the queue so we don't loop, but masking the row in the synced cache before queryCollection's auto-refetch lands. Wired for `todosCollection`, `shoppingListsCollection`, and `budgetsCollection`. Audits skipped (insert-only — temp ids never have queued updates/deletes).
- **Idempotent at-least-once delivery (server dedup).** Closes the gap where the BFF ran a mutation but the ack was lost in transit, so the queue retries and double-writes. Implementation:
  - **BFF.** New Prisma `ClientOpResult { clientOpId @id, responseJson, createdAt }` model + migration. New `IdempotencyService.guardOrReplay(clientOpId, work)` (in `bff-todos/src/idempotency/`) — on first call it runs the work and persists `(clientOpId, JSON.stringify(result))`; on a retry with the same id it returns the parsed cached response without re-running the resolver. New `@ClientOpId()` param decorator pulls the header off the GraphQL context. Every mutation resolver (`todo`, `todoAudit`, `shoppingList` + items, `budget`) wraps its body in `idem.guardOrReplay(opId, () => svc.…)`. Each feature module imports `IdempotencyModule` for DI. Header is optional — missing header falls through to plain execution.
  - **First implementation pivot.** Initial pass was a `NestInterceptor` that returned `of(replay)` on a cache hit. Apollo's resolver pipeline expects each Observable emission to be a thenable / Promise — a plain object trips `innerFrom` with `"You provided an invalid object where a stream was expected"`. Tried `of(Promise.resolve(replay))` — same error, since Apollo ultimately tries to `from()` the mergeMap output again. Pivoted to a per-resolver service helper: no rxjs, no Apollo gymnastics, every resolver explicitly opts in.
  - **Replay fidelity gotcha.** `JSON.stringify(result)` flattens Prisma `Date` objects to ISO strings. Apollo's `DateTime` scalar's `serialize()` returns null for plain strings (it expects a `Date` instance), so the second call would 500 with `Expected DateTime.serialize(...) to return non-nullable value, returned: null`. Fix: `JSON.parse(json, reviveDates)` — a reviver that turns ISO-8601 strings back into `Date` instances.
  - **FE.** Each durable-queue op already has a stable UUID (`op.id` in `mutationQueue.ts`). The wrapper in `durableQueueCollection.ts` now exposes it on the synthetic transaction object as `transaction.clientOpId`, so handlers pass it to `graphqlRequest(query, vars, clientOpId)`. The shared `graphqlRequest` helper sets the `X-Client-Op-Id` header when present. Every mutation helper in `graphql.ts` accepts an optional `clientOpId` arg and forwards it. All mutation handlers in `client.ts`, `shoppingListClient.ts`, `budgetClient.ts` thread the field through.
  - **Fan-out sub-ids.** A single shopping-list `update` op fans out into N HTTP calls inside `syncItems` (one `addShoppingListItem` per added item, one `removeShoppingListItem` per removed item, one `updateShoppingListItem` per changed item). Each needs its own dedup id, so we derive `${parentOpId}:add:${itemId}` / `:remove:` / `:update:` per call. Deterministic across retries (same parent op + same item id = same sub-id), but distinct per HTTP request so the cache doesn't collide.
  - **Verified.** Manual smoke test: two `createTodo` mutations sent back-to-back with the same `X-Client-Op-Id` returned identical responses, only one row appeared in `Todo`, one row appeared in `ClientOpResult`. Documented in `data-layer-scenarios.md` under the new "Deduplication" section.
  - Files: `bff-todos/prisma/schema.prisma`, `bff-todos/prisma/migrations/20260607152429_add_client_op_result/`, `bff-todos/src/idempotency/{idempotency.module,idempotency.service,client-op-id.decorator}.ts`, `bff-todos/src/{todos,todos-audit,shopping-lists,budgets}/*.{module,resolver}.ts`, `bff-todos/src/app.module.ts`, `fe-todos/src/db/{graphql,durableQueueCollection,client,shoppingListClient,budgetClient}.ts`.

- **`clearAll` — local-only reset.** New `clearAll()` exported from `client.ts` plus a "Clear local data" button next to the Todos header. Two-step orchestration: (1) `mutationQueue.clearLocalState()` rejects every pending `awaitOpCompletion` deferred (so parent transactions don't hang), cancels the wake timer, deletes every row from the `mutation-queue` / `mutation-quarantine` / `id-bindings` collections, clears in-memory `tempToServer` / `serverToTemp` mirrors, resets the `draining` flag. (2) `clearCollectionCache(collection)` (new helper in `durableQueueCollection.ts`) iterates each wrapped collection's keys and calls `utils.writeBatch(() => utils.writeDelete(key))` — bypasses `onDelete` so we don't queue server deletes against rows we're trying to forget. **No automatic refetch** — caches stay empty until the next focus / online / mutation trigger. Server data is untouched, so the data will reappear via natural triggers; the "clear" verb only describes the local state. Button is gated by a `confirm(...)` dialog so it's not a one-click footgun.

**38 integration tests**, all passing under `bun test` (or `bun run test` from the repo root).

---

## Sibling port — `fe-todos-legend` (Legend State + TanStack Query)

A second FE app at `fe-todos-legend/` on port 3003, wired to the same BFF as `fe-todos`. Same coverage list, swapped state container. Built on the `legend-state-durable-queue` branch; `fe-todos` remains the TanStack DB reference.

### Architecture in one paragraph

A single `state$ = observable({ todos: { byId }, queue: { ops, bindings, nextSeq } })` holds local state. `syncObservable(state$, { persist: { plugin: ObservablePersistLocalStorage } })` writes the whole tree to `localStorage` on every change and hydrates synchronously on module load. A hand-rolled `MutationQueue` runner reads the queue via `state$.queue.ops.get()` and writes via `state$.queue.ops[id].set(...)`. Reads in components go through `useSelector(() => computeTodos())` — Legend State tracks each `.get()` call inside the callback and re-renders on change. TanStack Query drives reads (the `useTodosQuery` effect lifts results into `state$.todos.byId`); the runner invalidates after each ack.

### Why not `synced()` / `syncedCrud()` from `@legendapp/state/sync`

The Legend State sync plugins do retries + persistence for free, but they own the queue and don't expose three things this exercise needs:

1. **Per-op idempotency keys.** No surface for forwarding `X-Client-Op-Id` so the BFF dedupes retries.
2. **Quarantine boundary.** Failed ops are aggregate (`syncState(obs$).error.get()` / `getPendingChanges()`) — no per-op identity for a Failed/Retry/Discard UI.
3. **Temp→server id reconciliation.** No mapping from an insert response's id back to the optimistic temp id.

Wrapping all three on top of `synced()` would be more code than the runner. So Legend State here is just the state container + persistence; the runner owns ops, retry policy, quarantine, and dispatch.

### Coverage mapping (TanStack DB → Legend State)

| Coverage box | TanStack DB | Legend State port |
|---|---|---|
| #1 Local apply + durable queue | wrapper enqueues into `mutation-queue` collection | `state$.queue.ops[id].set(...)` (persisted via `syncObservable`) |
| #2 Optimistic state visible | TanStack DB transaction overlay | `computeTodos()` overlays `state$.queue.ops` on `state$.todos.byId` in seq order |
| #3 Ack reconciliation | wrapper `invalidates` + queryCollection auto-refetch | runner calls `queryClient.invalidateQueries(...)` after each ack |
| #4 Render-key alias | `queue.aliasFor(...)` | `aliasFor(key)` reads `state$.queue.bindings`, parent passes it as React `key=` |
| #5 Scoped rollback | one TanStack DB tx per op | runner mutates only the failed op's row, settles only that deferred |
| #6 Multi-collection projections | `projections` config on the wrapper | identical `projections` config on `CollectionHandlers`, runner runs them after parent ack |
| #7 `retrySafe` flag | `retrySafe` on the wrapper | identical map/function form on `CollectionHandlers` |
| #8 Persistent backoff | `nextAttemptAt` on the persisted op | same field on the op, persisted via `syncObservable` |
| #9 Quarantine boundary + cascade | separate `mutation-quarantine` collection | one extra `status: 'quarantined'` value (no separate observable — selectors filter it out of the active drain) |
| #10 Recovery actions | `retryCascade` / `discardCascade` / `discardAnchorRequeueRest` on the queue | identical methods, identical contract |
| #11 Drain triggers + mutex | `attachDrainTriggers` helper | same helper, same flag-based mutex |
| #12 Cold-boot sweep | `coldBootSweep()` in `ready()` | identical, called from `ready()` after `syncObservable` rehydrates |

Every coverage box is satisfied by the same logic shape; only the read/write API changed.

### Why `registerTodosCollection` exists (and how it maps to TanStack DB's collection options)

The runner (`createMutationQueue`) is **collection-agnostic**. It knows how to:

- Pick the next pending op from `state$.queue.ops` by `seq`.
- Rewrite temp→server keys at dispatch.
- Run retry / backoff / quarantine / recovery.
- Invalidate TQ keys after acks.

What it doesn't know is **how to actually call the BFF for a given op type**. That's collection-specific. `registerTodosCollection` is the seam where the runner is taught that knowledge:

```ts
queue.registerCollection<Todo>(TODOS_COLLECTION_ID, {
  primaryQueryKey: TODOS_QUERY_KEY,    // refetch this after every ack
  invalidates: [],                      // and these siblings
  onInsert: async (op) => { ...; return { serverId: created.id } },
  onUpdate: async (op) => { ... },
  onDelete: async (op) => { ... },
});
```

When the runner picks an op it looks up `handlersByCollection.get(op.collectionId)` and calls the matching method. No registration → `"No handlers registered for collection 'todos'"` thrown at dispatch time. A second collection means a second `registerXCollection(queue)` call; the runner is unchanged.

**It mirrors TanStack DB's collection options.** Side-by-side on the same `MutationQueue` contract:

| TanStack DB (`fe-todos`) | Legend / Redux / Expo ports |
|---|---|
| `createCollection(durableQueueCollectionOptions({ collectionId, queryKey, queryFn, queryClient, getKey, onInsert, onUpdate, onDelete, invalidates, projections, retrySafe, correlationKey }))` | `queue.registerCollection<T>(collectionId, { primaryQueryKey, invalidates, onInsert, onUpdate, onDelete, retrySafe, projections })` plus a separate `useQuery({ queryKey, queryFn })` for reads |
| `onInsert: async ({ transaction }) => { ...; return { serverId } }` | `onInsert: async (op) => { ...; return { serverId } }` |
| `onUpdate: async ({ transaction }) => { ... }` | `onUpdate: async (op) => { ... }` |
| `onDelete: async ({ transaction }) => { ... }` | `onDelete: async (op) => { ... }` |
| `invalidates: [['todoAuditCounts']]` | `invalidates: [['todoAuditCounts']]` (identical) |
| `retrySafe: { insert: false, update: true, delete: false }` | `retrySafe: { insert: false, update: true, delete: false }` (identical) |
| `projections: { audit: { apply, optimistic, onError } }` | `projections: { audit: { apply, optimistic, onError } }` (identical) |

The handler payload differs slightly — TanStack DB hands you a `transaction` with one or more `mutations`; the ports hand you a single `QueueOp` with `op.payload.modified` / `op.payload.original` / `op.payload.changes`. But the **contract is the same**: do the server work, return `{ serverId }` from inserts, throw to fail. `invalidates`, `projections`, and `retrySafe` are byte-for-byte identical configs.

**Why TanStack DB hides the registration step.** TanStack DB couples *state container* and *handler registration* in `createCollection(durableQueueCollectionOptions(...))` — when you create the collection, you've also told it how to mutate. It can do that because each collection is its own first-class state object. Legend State (and Redux) work differently: state is one big tree, collections are just branches under it. So registration has to live somewhere on its own — the runner needs a `collectionId → handlers` map independent of where the data is stored. Two-step setup instead of one-step, but every option that mattered in `durableQueueCollectionOptions` is available here too.

### Files

- `fe-todos-legend/src/store/state.ts` — the single observable and `syncObservable` wiring.
- `fe-todos-legend/src/store/mutationQueue.ts` — the runner. Same drain loop, retry policy, quarantine, recovery actions, cold-boot sweep as `fe-todos-redux`'s runner; reads/writes go through `state$` instead of a redux store.
- `fe-todos-legend/src/store/todosClient.ts` — `registerTodosCollection` (handlers that POST to the BFF and forward `op.id` as `X-Client-Op-Id`), plus `computeTodos` / `aliasFor` / `computeQuarantineByRowId` / `computeQueueDepth` / `addTodo` / `updateTodo` / `deleteTodo`.
- `fe-todos-legend/src/store/useTodosQuery.ts` — TQ hook that lifts refetch results into `state$.todos.byId`.
- `fe-todos-legend/src/store/queue.ts` — singleton: `createMutationQueue`, `registerTodosCollection`, `attachDrainTriggers`, `ready()`. Module-init order matters because `ready()` reads from `state$` and assumes `syncObservable` has hydrated (which is synchronous on `localStorage`).
- `fe-todos-legend/src/store/drainTriggers.ts` — `online`/`focus` event wiring; identical shape to `fe-todos`/`fe-todos-redux`.
- `fe-todos-legend/src/components/TodoList.tsx` — `useSelector(() => computeTodos())` etc., plus a Failed/Retry/Discard band per quarantined row that calls `mutationQueue.retryCascade(correlationKey)` / `mutationQueue.discardCascade(correlationKey)`.
- Workspace registration in root `package.json`; `bun run dev` brings up BFF + `fe-todos` + `fe-todos-legend` (ports 4010 / 3000 / 3003).

### Verified

- `bunx tsc --noEmit` clean.
- BFF + FE boot; `http://localhost:3003/` renders and the bundle includes `createMutationQueue`, `coldBootSweep`, `retryCascade`, `@legendapp/state` symbols.
- BFF idempotency dedup hits against the `op.id`-as-`X-Client-Op-Id` shape that the runner forwards (smoke-tested with two identical `createTodo` requests sharing one id; identical responses, one Todo row).
- Scope is limited to the `todos` collection (no shopping lists / budgets / audits / projections in this build) — the runner supports projections via `CollectionHandlers.projections` but no consumer wires them. Adding the other collections would be mechanical (more `registerCollection` calls, more `compute…` helpers); no design decisions left.

### Sibling port — `fe-todos-expo` (Expo + Legend State + expo-sqlite)

A React Native build at `fe-todos-expo/`, also on the `legend-state-durable-queue` branch. Same store/runner code as `fe-todos-legend`; only the platform shims differ.

**What's reused verbatim** (copied 1:1 from `fe-todos-legend/src/store/`):
- `types.ts` — domain + queue op shapes.
- `mutationQueue.ts` — the runner. All 12 boxes (drain mutex, retrySafe, exponential backoff, quarantine, recovery actions, cold-boot sweep) — no platform code.
- `todosClient.ts` — handlers, `computeTodos`, `aliasFor`, the user-facing add/update/delete helpers.
- `queryClient.ts` and `useTodosQuery.ts` — TQ wiring.

**What's RN-specific:**
- `state.ts` — swaps `ObservablePersistLocalStorage` for `observablePersistSqlite(ExpoSQLiteStorage)` from `@legendapp/state/persist-plugins/expo-sqlite`. The plugin uses Expo's KV-store API on top of SQLite; durable across reloads, fast K/V access pattern. Exports `syncHandle` (the sync state observable) so the bootstrap can `await when(syncHandle.isPersistLoaded)` before kicking the sweep — expo-sqlite's plugin is async, unlike localStorage.
- `graphql.ts` — endpoint reads from `EXPO_PUBLIC_BFF_URL` (defaults to `http://localhost:4010/graphql` for the iOS sim). Document recommends `http://10.0.2.2:4010/graphql` for Android emu and `http://<dev-machine-ip>:4010/graphql` for physical devices.
- `drainTriggers.ts` — replaces `online` / `focus` window events with `NetInfo.addEventListener` (network connectivity) + `AppState.addEventListener('change', ...)` (foreground/background). Same `triggerDrain()` contract on the queue.
- `queue.ts` — module-init wraps the cold-boot sweep in `await when(syncHandle.isPersistLoaded); await mutationQueue.ready()` so SQLite has finished hydrating before the runner reads `state$.queue.ops`.
- `polyfills.ts` — imports `react-native-get-random-values` and falls back to a v4-shaped `crypto.randomUUID` shim if the runtime doesn't ship one. Imported first thing in `app/_layout.tsx`.

**Expo plumbing:**
- `app.json` — minimal SDK 56 config, `newArchEnabled: true`, `expo-router` plugin.
- `app/_layout.tsx` — root stack inside `GestureHandlerRootView` + `SafeAreaProvider` + `QueryClientProvider`. Side-effect imports `@/store/queue` so the runner is wired once at app start.
- `app/index.tsx` — single screen rendering the RN `<TodoList>`.
- `src/components/TodoList.tsx` — `View` / `Text` / `Pressable` / `Switch` / `FlatList` / `TextInput` instead of DOM. Failed/Retry/Discard band per quarantined row using the same `mutationQueue.retryCascade(correlationKey)` / `mutationQueue.discardCascade(correlationKey)` API.

**Verified:**
- `bunx tsc --noEmit` clean.
- `bunx expo export --platform ios --dev` produces an 8.7 MB dev bundle. `grep` over the bundle confirms `createMutationQueue`, `coldBootSweep`, `retryCascade`, `attachDrainTriggers`, `expo-sqlite`, `legendapp`, and `EXPO_PUBLIC_BFF_URL` all land in the output.
- Workspace registered (`fe-todos-expo` in root `package.json` workspaces); root `dev:expo` script proxies to `expo start`. Not in the concurrent `dev` script — Expo's CLI is interactive, you run it on its own.

### Sibling port — `fe-todos-redux` (Redux Toolkit + TanStack Query)

A parallel branch (`redux-tq-durable-queue`) with the same shape: RTK slices for `queue.ops` / `queue.bindings` / `todos.byId`, `redux-persist` against `localStorage`, the same hand-rolled runner reading/writing through the redux store. Same coverage. Same trade-off versus the framework's built-ins (here it's `RTK Query` and `redux-offline` rather than `synced()`). Same file shape under `fe-todos-redux/src/store/`. Listed alongside Legend State to make the comparison easier — three FE apps, same BFF, same coverage list, three different state containers.
