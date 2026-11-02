import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

// Tests run against the core sources, so they don't need its build.
const core = (file: string) =>
  fileURLToPath(new URL(`../../src/browser/reatom/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@reatomized\/convex\/testing$/,
        replacement: core("testing.ts"),
      },
      { find: /^@reatomized\/convex$/, replacement: core("index.ts") },
    ],
  },
  test: { name: "convex-storybook", include: ["test/**/*.test.ts"] },
});
