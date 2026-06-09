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
import storage from 'redux-persist/lib/storage';
import { queueReducer } from './queueSlice';
import { todosReducer } from './todosSlice';

const rootReducer = combineReducers({
  todos: todosReducer,
  queue: queueReducer,
});

// Persist *everything* — the queue must survive reload (the whole point of
// "durable") and persisting the synced cache too gives us instant first
// paint after a cold start, even before TQ refetches. The only field we
// could safely skip is `todos.status`, but persisting it is harmless: the
// runner re-marks loading on next mount.
const persistConfig = {
  key: 'fe-todos-redux',
  version: 1,
  storage,
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefault) =>
    getDefault({
      // redux-persist dispatches non-serializable actions during hydration;
      // these are the well-known set its docs say to ignore.
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
