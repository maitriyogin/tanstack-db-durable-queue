Short answer: the queue does NOT halt. Quarantine removes the failed op from the active queue entirely, so the runner just keeps draining other ops.

Walk-through with the code:

1. Op exhausts retries (or is non-retryable on first failure). Inside drain()'s catch block (mutationQueue.ts ~line 580):
   await quarantineCascade(head, error);
2. quarantineCascade(parent, error) (mutationQueue.ts:352) does three things:
   - quarantine.insert(parentRow) — copies the op into the separate mutation-quarantine SQLite collection.
   - queue.delete(parent.id) — removes the op from the live queue.
   - For an insert parent, it scans queued siblings sharing correlationKey, copies them to quarantine with reason: 'cascade', and deletes them from the live queue too.
3. Crucially, it does not settle the op's deferred. The parent transaction stays pending (this is the Task #10 invariant — keeps the optimistic state visible until a recovery action). But that's per-op state, not a queue-wide
   pause.
4. The drain loop continues. After quarantineCascade returns, the while (true) loop iterates and pickNextPending(now) looks at the live queue collection, which no longer contains the failed op or its cascaded siblings. So
   unrelated ops drain unhindered.
5. Cold-boot is the same shape. coldBootSweep() calls quarantineCascade on cap-exceeded ops before it kicks the first drain() — so by the time the runner runs, the bad ops are already out of the active queue.

Concretely, what is "halted":
- The quarantined op itself doesn't retry on its own. It needs an explicit retryCascade(correlationKey) / discardCascade(...) / discardAnchorRequeueRest(...) call to leave quarantine.
- Its correlation group is halted — child ops that were queued behind a failed insert (same correlation key) are pulled out together so they don't dispatch against a row that doesn't exist server-side.

What is not halted:
- The drain loop.
- Other unrelated ops (different correlationKey).
- Other collections sharing the same queue.

This was a deliberate choice. The alternative — pause the entire queue on any quarantine — would be simpler but would freeze unrelated work. The cascade rule (only quarantine ops that share correlation key, and only cascade
off insert anchors) gives the quarantined group its own isolation without affecting siblings.

If you want to look at the code paths together: mutationQueue.ts lines ~352–410 (quarantineCascade), 514–575 (drain loop catch), 412–484 (recovery actions), and 635–680 (coldBootSweep).
