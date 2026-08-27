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
    // Run integration tests sequentially — they share resources
    // (dist/index.js binary, ~/.claude/settings.json, real DB)
    fileParallelism: false,
  },
});
