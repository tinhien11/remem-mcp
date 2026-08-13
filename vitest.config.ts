import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    env: {
      TDAI_ENABLE_ADVANCED: "1",
    },
    // Run integration tests sequentially — they share resources
    // (dist/index.js binary, ~/.claude/settings.json, real DB)
    fileParallelism: false,
  },
});
