import { useEffect, useState, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { store, persistor } from './store';
import { runner } from '../queue/runner';
import { attachDrainTriggers } from '../queue/drainTriggers';
// Side-effect: registers each collection's runtime against the runner.
import './todoRuntime';
import './shoppingRuntime';

function DBLoading() {
  return (
    <p className="text-gray-400 text-center mt-8">Initializing local store…</p>
  );
}

// Once the persisted state has rehydrated and the cold-boot sweep has
// finished, kick off the runner and wire browser drain triggers. Renders
// children once started so the rest of the app sees a hot runner.
function RuntimeBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let detach: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        await runner.start();
        if (cancelled) return;
        detach = attachDrainTriggers({ runner });
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      detach?.();
    };
  }, []);
  if (!ready) return <DBLoading />;
  return <>{children}</>;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  return (
    <Provider store={store}>
      <PersistGate loading={<DBLoading />} persistor={persistor}>
        <RuntimeBootstrap>{children}</RuntimeBootstrap>
      </PersistGate>
    </Provider>
  );
}
