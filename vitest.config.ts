import { defineConfig } from "vitest/config";

export default defineConfig({
  // `node:sqlite` is newer than Vite's builtin list, so it is externalized
  // explicitly. Without this the schema contract tests fail to resolve it and
  // the D1 migration could only be tested by deploying, which is not acceptable.
  //
  // The tests also load it via `createRequire` rather than a static `import`,
  // because Vite rewrites a `node:sqlite` specifier to a bare `sqlite` one that
  // it then cannot resolve. Both measures are needed; neither alone is enough.
  ssr: {
    external: ["node:sqlite"],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
    // Every test must run offline. A test that reaches the network is a defect
    // (SPEC §12), and a hanging fetch would otherwise stall CI.
    globals: false,
    restoreMocks: true,
  },
});
