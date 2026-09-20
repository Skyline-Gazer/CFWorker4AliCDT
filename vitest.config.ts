import { defineConfig } from "vitest/config";

export default defineConfig({
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
