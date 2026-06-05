import { test, expect } from '@playwright/test';
import { addTodo, todoRow, uniqueName, waitForReady } from './helpers';

// Mirrors Task #4 (temp ids + reconciliation) at the UI altitude. The unit
// suite proves the binding survives a process restart at the API level; here
// we prove the user-visible analogue: a row created with a temp_* id keeps
// its identity across a page reload after the server has bound the real id.
//
// Note: we deliberately do NOT reload while still offline — Chromium can't
// navigate to the FE without a server, so a reload-while-offline always
// errors with ERR_INTERNET_DISCONNECTED. The unit suite already covers
// "binding survives a process restart" without that browser constraint.
test.describe('Temp-id aliasing across reload', () => {
  test('offline-created row keeps the same identity after the queue drains and the page reloads', async ({
    context,
  }) => {
    const page = await context.newPage();
    await waitForReady(page);

    await context.setOffline(true);
    const name = uniqueName('temp-reload');
    await addTodo(page, name);

    // Optimistic row is visible while offline (still keyed by temp_*).
    await expect(todoRow(page, name)).toBeVisible();

    // Come online → queue drains → temp→server binding established.
    await context.setOffline(false);
    await page.waitForResponse(
      (res) =>
        res.url().includes('/graphql') &&
        res.request().method() === 'POST' &&
        res.ok() &&
        (res.request().postData() ?? '').includes('CreateTodo'),
      { timeout: 10_000 },
    );

    // Reload — row must still appear, now keyed by the server-assigned uuid.
    // If the alias didn't survive the queue drain, the row would either
    // disappear or duplicate (one cached temp_*, one fresh server row).
    await page.reload();
    await waitForReady(page);

    const matches = page.locator('div.bg-\\[\\#1a1a1a\\]').filter({ hasText: name });
    await expect(matches).toHaveCount(1);
  });
});