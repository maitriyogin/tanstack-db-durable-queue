import { when } from '@legendapp/state';
import { syncHandle } from './state';
import { createMutationQueue } from './mutationQueue';
import { attachDrainTriggers } from './drainTriggers';
import { queryClient } from './queryClient';
import { registerTodosCollection } from './todosClient';

// Module-init order:
//   1. createMutationQueue: builds the runner. Reads no observable yet.
//   2. registerTodosCollection: hooks the todos handlers into the queue.
//   3. attachDrainTriggers: NetInfo + AppState wiring.
//   4. ready(): cold-boot sweep. MUST wait for syncObservable's
//      `isPersistLoaded` before reading state$ — expo-sqlite's plugin is
//      async, unlike fe-todos-legend's synchronous localStorage.
//
// The sweep runs in a fire-and-forget Promise. Components subscribe to
// state$ regardless; their selectors get the optimistic overlay as soon
// as persisted ops land. If the user mutates *before* the sweep
// completes, the new ops queue alongside the recovered ones (the runner
// drains in seq order, so post-recovery ops drain last anyway).
export const mutationQueue = createMutationQueue({ queryClient });
registerTodosCollection(mutationQueue);
attachDrainTriggers({ queue: mutationQueue });

void (async () => {
  await when(syncHandle.isPersistLoaded);
  await mutationQueue.ready();
})();
