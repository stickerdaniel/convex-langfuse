import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    exclude: ["scratch/**", ".claude/**", "dist/**", "**/node_modules/**"],
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
});
