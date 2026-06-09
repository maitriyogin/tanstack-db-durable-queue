import NetInfo from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';
import type { MutationQueue } from './mutationQueue';

// Box #11 for RN. The browser-equivalent listened for `online` + `focus`;
// here the analogues are NetInfo (network state changes) and AppState
// (foreground/background transitions). Same `triggerDrain()` contract on
// the queue.
export interface DrainTriggerOptions {
  queue: MutationQueue;
  onAuthFlip?: (drain: () => void) => () => void;
}

export function attachDrainTriggers(opts: DrainTriggerOptions): () => void {
  const { queue, onAuthFlip } = opts;
  const drain = () => queue.triggerDrain();
  const teardowns: Array<() => void> = [];

  // NetInfo: fire whenever the device transitions to connected. Skip
  // intermediate "obtaining IP" / "captive portal" states — `isConnected`
  // alone is the right gate; the queue's own runtime `isOnline` check
  // handles the case where TCP works but the BFF is unreachable.
  let prevConnected = true;
  const netInfoUnsub = NetInfo.addEventListener((state) => {
    const connected = state.isConnected === true;
    if (connected && !prevConnected) drain();
    prevConnected = connected;
  });
  teardowns.push(netInfoUnsub);

  // AppState: drain on foreground. `active` is only fired when the user
  // actually returns from background; transient states (`inactive` on
  // iOS during the app switcher) don't fire.
  let lastAppState: AppStateStatus = AppState.currentState;
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (lastAppState !== 'active' && next === 'active') drain();
    lastAppState = next;
  });
  teardowns.push(() => appStateSub.remove());

  if (onAuthFlip) teardowns.push(onAuthFlip(drain));

  return () => {
    for (const t of teardowns) {
      try { t(); } catch { /* ignore */ }
    }
  };
}