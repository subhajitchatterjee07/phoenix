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
  {
    // Workflow code is replayed after a crash, so it must make the same decisions every time
    // (LLD §4.5). Anything unpredictable goes through a step.
    files: ["src/workflows.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Use `await now(ctx)` from step.ts: replay must see the same time." },
        { object: "Math", property: "random", message: "Use `await random(ctx)` from step.ts: replay must see the same number." },
        { object: "crypto", property: "randomUUID", message: "Derive ids from task and step, or draw them inside a step." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "Use `await now(ctx)` from step.ts." },
        { selector: "ImportSpecifier[imported.name='randomUUID']", message: "Derive ids from task and step, or draw them inside a step." },
      ],
      "no-restricted-globals": ["error", { name: "fetch", message: "Network calls belong inside a step." }],
    },
  },
);
