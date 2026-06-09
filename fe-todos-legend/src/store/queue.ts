import { createMutationQueue } from './mutationQueue';
import { attachDrainTriggers } from './drainTriggers';
import { queryClient } from './queryClient';
import { registerTodosCollection } from './todosClient';

// Module-init order:
//   1. createMutationQueue: builds the runner (handlers map, deferreds,
//      timer state). Doesn't read from the observable yet.
//   2. registerTodosCollection: hooks the todos handlers into the queue.
//   3. attachDrainTriggers: wires online/focus events to triggerDrain.
//   4. ready(): runs the cold-boot sweep against state$ (which is
//      already hydrated by syncObservable's synchronous localStorage
//      load) and kicks the first drain.
export const mutationQueue = createMutationQueue({ queryClient });
registerTodosCollection(mutationQueue);
attachDrainTriggers({ queue: mutationQueue });
void mutationQueue.ready();
