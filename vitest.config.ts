import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "convex",
          include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
        },
      },
      "packages/*",
    ],
  },
});
