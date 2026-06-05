import { expect, type Page, type Route, type Locator } from '@playwright/test';

export const GRAPHQL_URL = 'http://localhost:4010/graphql';

export type GraphQLOpName =
  | 'CreateTodo'
  | 'UpdateTodo'
  | 'DeleteTodo'
  | 'CreateTodoAudit'
  | 'GetTodos'
  | 'AllTodoAudits';

export interface FailMutationOptions {
  // GraphQL operation names that should be failed.
  ops: ReadonlyArray<GraphQLOpName>;
  // If 'always', every matching call fails. If a number, the first N matching
  // calls fail and the rest pass through.
  count?: number | 'always';
  // Message returned in the GraphQL `errors[0].message` payload. The runner
  // surfaces this as op.quarantineError.
  message?: string;
}

// Install a page.route() handler that intercepts /graphql and selectively
// returns errors for the named operations. Pass-through everything else
// (queries, other mutations) so the rest of the app keeps working. Returns
// a function to remove the handler.
export async function failMutations(
  page: Page,
  opts: FailMutationOptions,
): Promise<() => Promise<void>> {
  const { ops, count = 'always', message = 'forced-failure' } = opts;
  let remaining = count === 'always' ? Infinity : count;

  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    let body: { query?: string; operationName?: string; variables?: unknown };
    try {
      body = req.postDataJSON() as typeof body;
    } catch {
      return route.continue();
    }
    const opName = body.operationName ?? extractOpName(body.query ?? '');
    if (opName && (ops as ReadonlyArray<string>).includes(opName) && remaining > 0) {
      remaining--;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ errors: [{ message }] }),
      });
    }
    return route.continue();
  };

  await page.route(GRAPHQL_URL, handler);
  return async () => {
    await page.unroute(GRAPHQL_URL, handler);
  };
}

function extractOpName(query: string): string | undefined {
  // Falls back to parsing `mutation Name(...)` / `query Name(...)` from the
  // raw GraphQL document when Apollo omits operationName.
  const m = query.match(/\b(?:mutation|query)\s+(\w+)/);
  return m?.[1];
}

// Wait for OPFS init + collection preload. The app shows the Suspense
// fallback "Initializing local database…" while dbReady is pending, and
// then "Loading todos..." while the first GraphQL fetch is in flight.
// We wait for the form input to be present — that's our proxy for "the
// TodoList component has rendered past its loading branch".
export async function waitForReady(page: Page) {
  await page.goto('/');
  await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible({
    timeout: 15_000,
  });
}

export async function addTodo(page: Page, name: string) {
  const input = page.getByPlaceholder('What needs to be done?');
  await input.fill(name);
  await page.getByRole('button', { name: 'Add Todo' }).click();
  // The form clears once the optimistic insert lands, which is synchronous.
  await expect(input).toHaveValue('');
}

// Locate the row containing a given todo name. The component renders each
// row as a div with the name as an <h3>. Scoping to the parent div lets us
// query the count badge / Failed banner / Retry button per-row.
export function todoRow(page: Page, name: string): Locator {
  return page.locator('div.bg-\\[\\#1a1a1a\\]').filter({ hasText: name }).first();
}

export async function clearLocalData(page: Page) {
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Clear local data' }).click();
}

// Shared name generator so each test asserts only on its own rows. The BFF
// keeps its sqlite dev.db across runs, so we never compare list lengths
// globally — only "does my row exist?".
export function uniqueName(prefix: string): string {
  const id = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${id}`;
}

