import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "tools-server/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // A promise you forget to await is a step that runs out of order (LLD 4.5).
      "@typescript-eslint/no-floating-promises": "error",
    },
    languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.js", "vitest.config.ts"] } } },
  },
);
