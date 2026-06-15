import { configureStore, combineReducers } from '@reduxjs/toolkit';
import {
  persistReducer,
  persistStore,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
} from 'redux-persist';
import { setupListeners } from '@reduxjs/toolkit/query/react';
import { api } from '../api/api';
import { queuePersistConfig } from '../queue/persistence';
import { queueReducer } from '../queue/queueSlice';
import { idBindingsReducer } from '../queue/idBindingsSlice';
import { quarantineReducer } from '../queue/quarantineSlice';
import { bootstrapListener } from '../queue/bootstrap';
import { runner } from '../queue/runner';

const queueRoot = combineReducers({
  queue: queueReducer,
  idBindings: idBindingsReducer,
  quarantine: quarantineReducer,
});

// redux-persist's typing wraps state in Partial; reducer below treats it as
// the full shape (it always is, post-rehydrate). Cast through any to silence
// the spurious mismatch.
const persistedQueueRoot = persistReducer(queuePersistConfig, queueRoot as any);

const rootReducer = combineReducers({
  queueRoot: persistedQueueRoot,
  [api.reducerPath]: api.reducer,
});

export const store = configureStore({
  reducer: rootReducer,
  middleware: (gdm) =>
    gdm({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    })
      .prepend(bootstrapListener.middleware)
      .concat(api.middleware),
});

export const persistor = persistStore(store);

setupListeners(store.dispatch);

runner.attachStore(store as any);
runner.setInvalidateTags((tags) => {
  store.dispatch(api.util.invalidateTags(tags as any));
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
