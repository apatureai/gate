// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // apps/** are standalone Next.js apps with their own toolchain (next lint +
    // their own tsconfig); they are intentionally outside this monorepo harness
    // (root eslint/tsc -b/vitest), so the root lint must not try to parse their TSX.
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "apps/**", "**/.next/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Fixture apps are plain Node ESM scripts spawned as child processes (they
    // stand in for a repo's `preview-command`), so they are outside the
    // TypeScript project but still linted — they just need the Node globals.
    files: ["packages/*/fixtures/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        setInterval: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
);
