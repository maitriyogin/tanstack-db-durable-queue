import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
} from '@reduxjs/toolkit/query/react';

const GRAPHQL_ENDPOINT = 'http://localhost:4010/graphql';

// The codegen plugin (typescript-rtk-query) emits a single body shape per
// operation: `{ document, variables }`. We accept that shape, post it as
// JSON to /graphql, and lift an optional `clientOpId` from `extraOptions`
// onto the X-Client-Op-Id header — that's how the durable-queue runner's
// idempotency contract reaches the BFF.
//
// Generated mutations carry only `{ variables }` (not clientOpId) in their
// args. The runner threads clientOpId via the per-call `extraOptions`
// argument on `endpoint.initiate(args, { extraOptions: { clientOpId } })`.

export interface GraphqlExtraOptions {
  clientOpId?: string;
}

// The codegen plugin (typescript-rtk-query v2) emits operations as plain
// query strings via `export const FooDocument = \`query Foo { ... }\``. We
// also accept AST `DocumentNode` (loc.source.body) and string-like
// document classes (toString()) so the base query stays plugin-agnostic.
//
// `clientOpId`, when set on the body, becomes the X-Client-Op-Id header.
// That field is added by api.ts's per-mutation `withClientOpId(...)`
// wrapper so codegen-generated mutation args can pass it without polluting
// GraphQL variables.
interface GraphqlBody {
  document:
    | string
    | { loc?: { source?: { body: string } }; toString?: () => string };
  variables?: unknown;
  clientOpId?: string;
}

const rawBaseQuery = fetchBaseQuery({ baseUrl: '' });

const graphqlBaseQuery: BaseQueryFn<
  GraphqlBody,
  unknown,
  FetchBaseQueryError,
  GraphqlExtraOptions
> = async ({ document, variables, clientOpId: bodyOpId }, api, extraOptions) => {
  const query =
    typeof document === 'string'
      ? document
      : (document?.loc?.source?.body ??
          (typeof document?.toString === 'function' ? document.toString() : undefined));
  if (!query) {
    return {
      error: {
        status: 'CUSTOM_ERROR',
        error: 'graphqlBaseQuery: missing document body',
      } as FetchBaseQueryError,
    };
  }
  const fetchArgs: FetchArgs = {
    url: GRAPHQL_ENDPOINT,
    method: 'POST',
    body: { query, variables: variables ?? undefined },
    headers: { 'Content-Type': 'application/json' },
  };
  const clientOpId = bodyOpId ?? extraOptions?.clientOpId;
  if (clientOpId) {
    fetchArgs.headers = {
      ...(fetchArgs.headers as Record<string, string>),
      'X-Client-Op-Id': clientOpId,
    };
  }
  const result = await rawBaseQuery(fetchArgs, api, extraOptions);
  if (result.error) return { error: result.error };
  const json = result.data as { data?: unknown; errors?: Array<{ message?: string }> };
  if (json.errors && json.errors.length > 0) {
    return {
      error: {
        status: 'CUSTOM_ERROR',
        error: json.errors[0]?.message ?? 'GraphQL request failed',
        data: json.errors,
      } as FetchBaseQueryError,
    };
  }
  return { data: json.data };
};

// Empty-shell base. Endpoints are injected by the codegen-emitted module
// (see api.generated.ts) so we get strong types + cache invalidation that
// follows the schema.
export const baseApi = createApi({
  reducerPath: 'api',
  baseQuery: graphqlBaseQuery,
  tagTypes: ['Todos', 'TodoAudits', 'ShoppingLists', 'Budgets'],
  endpoints: () => ({}),
});
