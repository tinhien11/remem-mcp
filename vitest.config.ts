import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    env: {
      TDAI_ENABLE_ADVANCED: "1",
    },
  },
});
