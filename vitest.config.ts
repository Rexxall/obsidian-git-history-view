import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 1,
    testTimeout: 15_000
  },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/obsidian-runtime.ts", import.meta.url))
    }
  }
});
