import { createMutationQueue } from './mutationQueue';
import { attachDrainTriggers } from './drainTriggers';
import { queryClient } from './queryClient';
import { store } from './store';
import { registerTodosCollection } from './todosClient';

// One process-wide queue. Constructed lazily so test harnesses can build
// their own with a different store/queryClient if needed.
export const mutationQueue = createMutationQueue({
  store,
  queryClient,
});

// Register collections at module-init. The runner ignores enqueues for
// unknown collections, so registration must happen before the first user
// action — easiest place is right here, alongside the singleton.
registerTodosCollection(mutationQueue);

// Box #11: wire online/focus events to the runner's trigger. Auth flips
// are caller-supplied; this app has no auth, so we skip onAuthFlip.
attachDrainTriggers({ queue: mutationQueue });

// Box #12: cold-boot sweep. PersistGate has gated render until rehydration
// finished, so by the time anything imports `mutationQueue` the persisted
// state is fully loaded. ready() reconciles inflight ops left by a
// crashed session and kicks the first drain.
void mutationQueue.ready();
