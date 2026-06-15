import type { CodegenConfig } from '@graphql-codegen/cli';

// Generates a typed injectEndpoints module from .graphql operation files.
//
// The base api with the GraphQL base query (and X-Client-Op-Id plumbing) lives
// in src/api/baseApi.ts. The generated module references it via
// `importBaseApiFrom` and emits an `injectEndpoints({...}).enhanceEndpoints(...)`
// call that adds every operation as a strongly-typed endpoint with hooks.
const config: CodegenConfig = {
  schema: '../bff-todos/src/schema.gql',
  documents: 'src/api/operations/**/*.graphql',
  emitLegacyCommonJSImports: false,
  generates: {
    'src/api/api.generated.ts': {
      // typescript: schema-level types (Todo, CreateTodoInput, ...).
      // typescript-operations: per-operation Query/Variables types
      // (GetTodosQuery, CreateTodoMutationVariables, ...).
      // typescript-rtk-query: emits `injectedRtkApi` against the base api,
      // plus the matching React hooks (`useGetTodosQuery`, etc.).
      plugins: [
        'typescript',
        'typescript-operations',
        'typescript-rtk-query',
      ],
      config: {
        importBaseApiFrom: './baseApi',
        importBaseApiAlternateName: 'baseApi',
        // Mutation/Query hooks ride on injectEndpoints, so the base api
        // is the single source of cache wiring + middleware.
        exportHooks: true,
      },
    },
  },
};

export default config;
