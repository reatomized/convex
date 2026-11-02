// @ts-check

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Type-aware rules for the Reatom client and the workspace packages. */
const typescript = (files, project) => ({
  files,
  plugins: { "@typescript-eslint": tseslint.plugin },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { project: [project], tsconfigRootDir: import.meta.dirname },
  },
  rules: {
    "no-undef": "off",
    "no-redeclare": "off",
    "@typescript-eslint/no-redeclare": "error",
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/restrict-template-expressions": "error",
    "@typescript-eslint/consistent-type-assertions": [
      "error",
      { assertionStyle: "as" },
    ],
    eqeqeq: ["error", "always"],
    "no-console": "error",
  },
});

// Lints the Reatom client, the workspace packages and the scripts. The other
// files under src/ are upstream's, with public Convex peer imports.
export default [
  { ignores: ["**/dist", "**/node_modules"] },
  js.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  typescript(["src/browser/reatom/**/*.ts"], "./tsconfig.json"),
  typescript(
    ["packages/convex-storybook/{src,test}/**/*.ts"],
    "./packages/convex-storybook/tsconfig.json",
  ),
];
