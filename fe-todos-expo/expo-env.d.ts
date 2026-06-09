/// <reference types="expo-router/types" />

// expo-cli replaces process.env.EXPO_PUBLIC_* at build time. TS needs a
// minimal `process` declaration to know the access is legal — RN's
// runtime Hermes shim ships `process.env` either way.
declare const process: {
  env: {
    EXPO_PUBLIC_BFF_URL?: string;
    NODE_ENV?: 'development' | 'production' | 'test';
  };
};
