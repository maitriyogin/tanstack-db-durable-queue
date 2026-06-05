import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from '@tanstack/browser-db-sqlite-persistence';
import { createMutationQueue, type MutationQueue } from './mutationQueue';
import { consoleLogger } from './consoleLogger';

const DB_NAME = 'fe-todos';

// Async init kept off the module's top-level so this file resolves
// synchronously and other modules can import its bindings without being
// blocked on TLA. App.tsx awaits `dbReady` via `React.use(dbReady)` and
// then dynamically imports the modules that *do* construct collections,
// so by the time client.ts / shoppingListClient.ts evaluate, persistence
// is real.
let _persistence: ReturnType<typeof createBrowserWASQLitePersistence> | null = null;
let _mutationQueue: MutationQueue | null = null;

export const dbReady: Promise<void> = (async () => {
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: `${DB_NAME}.sqlite`,
  });
  const coordinator = new BrowserCollectionCoordinator({ dbName: DB_NAME });
  _persistence = createBrowserWASQLitePersistence({ database, coordinator });
  _mutationQueue = createMutationQueue(_persistence, { logger: consoleLogger });
  // Expose on window for DevTools introspection. Call
  //   mutationQueue.logSnapshot()
  // from the console to print the current contents of the active queue,
  // quarantine store, and temp→server bindings.
  if (typeof window !== 'undefined') {
    (window as any).mutationQueue = _mutationQueue;
  }
})();

// These exports look like ordinary singletons but are only safe to *touch*
// after `dbReady` resolves. Modules that construct collections (client.ts,
// shoppingListClient.ts) are dynamically imported by App.tsx after the
// suspense gate, so by the time their top-level statements run these are
// populated.
export const persistence: ReturnType<typeof createBrowserWASQLitePersistence> = new Proxy(
  {} as any,
  {
    get(_t, prop) {
      if (!_persistence) {
        throw new Error(
          'persistence accessed before dbReady resolved — make sure the importing module is gated by App.tsx\'s React.use(dbReady).',
        );
      }
      return (_persistence as any)[prop];
    },
  },
);

export const mutationQueue: MutationQueue = new Proxy({} as MutationQueue, {
  get(_t, prop) {
    if (!_mutationQueue) {
      throw new Error(
        'mutationQueue accessed before dbReady resolved — make sure the importing module is gated by App.tsx\'s React.use(dbReady).',
      );
    }
    return (_mutationQueue as any)[prop];
  },
});