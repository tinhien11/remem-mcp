import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use forks (child processes) instead of threads — onnxruntime-node
    // native binding crashes with "Module did not self-register" in worker threads.
    pool: "forks",
    poolOptions: {
      forks: {
        // Single fork keeps native addons happy and is fine for our test count.
        singleFork: true,
      },
    },
    env: {
      REMEM_ENABLE_ADVANCED: "1",
    },
    // Heavy storage tests (1000 sequential puts) exceed the 5s default on
    // slower CI runners — release workflow failed on v0.7.6 for this.
    testTimeout: 30_000,
    // Run integration tests sequentially — they share resources
    // (dist/index.js binary, ~/.claude/settings.json, real DB)
    fileParallelism: false,
  },
});
