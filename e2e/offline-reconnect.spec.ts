import { test, expect } from '@playwright/test';
import { addTodo, todoRow, uniqueName, waitForReady } from './helpers';

// Mirrors the spirit of the unit suite's "Offline pause" tests, but at the
// UI altitude: an offline edit must remain visible, not consume retry
// attempts, and persist to the server once connectivity returns.
test.describe('Offline → mutate → reconnect', () => {
  test('a todo created offline lands on the server after reconnect', async ({ context }) => {
    const page = await context.newPage();
    await waitForReady(page);

    const name = uniqueName('offline');

    await context.setOffline(true);
    await addTodo(page, name);

    // Optimistic row is visible while offline.
    const row = todoRow(page, name);
    await expect(row).toBeVisible();
    // No quarantine banner — the runner is paused, not failing.
    await expect(row.getByText('Failed', { exact: false })).toBeHidden();

    // Come back online. The runner picks the queued ops up via the online
    // event (attachDrainTriggers wires that). Wait for the actual server-
    // side ack before reloading so we don't race the queue drain — we know
    // the row reached the server when the next GetTodos refetch sees it.
    await context.setOffline(false);
    await page.waitForResponse(
      (res) =>
        res.url().includes('/graphql') &&
        res.request().method() === 'POST' &&
        res.ok() &&
        (res.request().postData() ?? '').includes('CreateTodo'),
      { timeout: 10_000 },
    );

    // Reload to prove the row is genuinely server-side, not just an
    // optimistic row still sitting in the queue. Wait for the GetTodos
    // refetch on the fresh page to complete before asserting.
    await page.reload();
    await page.waitForResponse(
      (res) =>
        res.url().includes('/graphql') &&
        res.request().method() === 'POST' &&
        res.ok() &&
        (res.request().postData() ?? '').includes('GetTodos'),
      { timeout: 10_000 },
    );

    // Row is rehydrated from the GraphQL refetch — proving it really
    // landed server-side, not just an optimistic remnant in the queue.
    await expect(todoRow(page, name)).toBeVisible();
  });
});
