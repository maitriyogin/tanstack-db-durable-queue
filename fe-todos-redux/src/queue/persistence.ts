import { combineReducers } from '@reduxjs/toolkit';
import { persistReducer, createTransform } from 'redux-persist';
import { queueReducer, type QueueState } from './queueSlice';
import { idBindingsReducer } from './idBindingsSlice';
import { quarantineReducer } from './quarantineSlice';

// Inline localStorage adapter. We avoid `import storage from 'redux-persist/lib/storage'`
// because Bun's bundler doesn't unwrap that file's `module.exports.default`,
// and the resulting `storage` ends up as the module namespace whose
// `.getItem` is undefined. Writing the three methods we need is trivial
// and dodges the CJS interop entirely.
//
// Falls back to an in-memory map when localStorage is unavailable (SSR,
// disabled storage). Keeps the same async signatures redux-persist expects.
function createWebStorage(): {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
} {
  const hasLS = typeof window !== 'undefined' && !!window.localStorage;
  if (hasLS) {
    return {
      getItem: (key) => Promise.resolve(window.localStorage.getItem(key)),
      setItem: (key, value) => {
        window.localStorage.setItem(key, value);
        return Promise.resolve();
      },
      removeItem: (key) => {
        window.localStorage.removeItem(key);
        return Promise.resolve();
      },
    };
  }
  const mem = new Map<string, string>();
  return {
    getItem: (key) => Promise.resolve(mem.get(key) ?? null),
    setItem: (key, value) => {
      mem.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      mem.delete(key);
      return Promise.resolve();
    },
  };
}

const storage = createWebStorage();

// Strip the in-memory sessionId + sweepComplete from the persisted blob —
// both are session-scoped and must be regenerated each cold boot.
const stripQueueRuntime = createTransform<QueueState, QueueState>(
  (inbound) => ({ ...inbound, sessionId: '', sweepComplete: false }),
  (outbound) => ({ ...outbound, sessionId: '', sweepComplete: false }),
  { whitelist: ['queue'] },
);

const rootReducer = combineReducers({
  queue: queueReducer,
  idBindings: idBindingsReducer,
  quarantine: quarantineReducer,
});

export type QueuePersistedState = ReturnType<typeof rootReducer>;

export const queuePersistConfig = {
  key: 'mutation-queue-v1',
  storage,
  whitelist: ['queue', 'idBindings', 'quarantine'],
  throttle: 250,
  transforms: [stripQueueRuntime],
};

// redux-persist v6's persistReducer typing wraps the inner state in
// Partial<...> — incompatible with combineReducers' default-state contract.
// Casting through unknown keeps the types honest at the call sites.
export const persistedQueueReducer = persistReducer(
  queuePersistConfig,
  rootReducer as any,
);