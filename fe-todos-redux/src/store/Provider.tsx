import type { ReactNode } from 'react';
import { Provider as ReduxProvider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { store, persistor } from './store';
import { queryClient } from './queryClient';
// Side-effect import: builds the queue singleton + registers collections.
import './queue';

// Root provider stack. PersistGate blocks render until rehydration finishes
// so selectors don't briefly see the post-bootstrap empty state and flash
// "no todos" before the persisted ones land.
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ReduxProvider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </PersistGate>
    </ReduxProvider>
  );
}
