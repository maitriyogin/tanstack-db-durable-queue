import { test } from '@playwright/test';

// Cross-tab live update for quarantine state isn't part of the unit suite
// and isn't obviously wired in the app today: each tab has its own
// `mutationQueue.subscribeQuarantine` mirror, and the BrowserCollectionCoordinator
// syncs the *synced cache*, not the queue/quarantine stores. Until there's a
// concrete mechanism (BroadcastChannel, storage event, etc.) the test would
// either flap or pass for the wrong reason.
//
// Re-enable this once cross-tab quarantine sync exists. Suggested shape:
//   - tab A creates a todo while CreateTodo is forced to fail
//   - both tabs render the red "Failed" banner
//   - tab A clicks Retry (route unblocked)
//   - both tabs see the banner clear
test.skip('multi-tab quarantine sync: not wired in the app yet', () => {});