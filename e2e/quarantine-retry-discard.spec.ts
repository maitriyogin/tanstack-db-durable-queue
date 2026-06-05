import { test, expect } from '@playwright/test';
import {
  addTodo,
  failMutations,
  todoRow,
  uniqueName,
  waitForReady,
} from './helpers';

// Mirrors Task #9 (quarantine boundary) + Task #10 (retry / discard).
// At the UI altitude: a non-retryable failure must surface the red "Failed"
// banner with Retry/Discard, and clicking those buttons must do what the
// label says.
test.describe('Quarantine UI', () => {
  test('failed insert quarantines, Retry recovers it', async ({ context }) => {
    const page = await context.newPage();
    await waitForReady(page);

    // Fail exactly the first CreateTodo. Subsequent ones (the retry) succeed.
    const stop = await failMutations(page, {
      ops: ['CreateTodo'],
      count: 1,
      message: 'simulated server outage',
    });

    const name = uniqueName('q-retry');
    await addTodo(page, name);

    const row = todoRow(page, name);
    await expect(row).toBeVisible();

    // Failed banner appears — sourced from quarantineError on the queue op.
    await expect(row.getByText('Failed', { exact: true })).toBeVisible();
    await expect(row.getByText('simulated server outage')).toBeVisible();

    // Retry: triggers retryCascade(correlationKey) on the queue. With the
    // route handler exhausted, the next CreateTodo call passes through.
    await row.getByRole('button', { name: 'Retry' }).click();

    // Banner clears once the retry acks.
    await expect(row.getByText('Failed', { exact: true })).toBeHidden({ timeout: 10_000 });

    // Reload to confirm the row is genuinely on the server, not just a
    // lingering optimistic row.
    await stop();
    await page.reload();
    await waitForReady(page);
    await expect(todoRow(page, name)).toBeVisible();
  });

  test('Discard drops the optimistic row and the queue op', async ({ context }) => {
    const page = await context.newPage();
    await waitForReady(page);

    const stop = await failMutations(page, {
      ops: ['CreateTodo'],
      count: 'always',
      message: 'permanent failure',
    });

    const name = uniqueName('q-discard');
    await addTodo(page, name);

    const row = todoRow(page, name);
    await expect(row.getByText('Failed', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Discard' }).click();

    // Discard rolls back the optimistic insert — the row should disappear.
    await expect(todoRow(page, name)).toHaveCount(0);

    await stop();
  });
});