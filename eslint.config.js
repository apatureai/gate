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
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
);
