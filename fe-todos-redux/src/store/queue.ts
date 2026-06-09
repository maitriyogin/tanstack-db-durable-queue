import { createMutationQueue } from './mutationQueue';
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
