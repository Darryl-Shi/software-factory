import { defineConfig } from "vitest/config";
export default defineConfig({ test: { testTimeout: 90_000, hookTimeout: 60_000, pool: "forks", include: ["test/**/*.test.ts"] } });
