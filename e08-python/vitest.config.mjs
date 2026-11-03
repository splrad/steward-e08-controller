import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['e08-python/fixed-content-sdk.test.mjs'],environment:'node',setupFiles:['packages/runner/test/offline-setup.ts']}});
