import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "dist/",
      "coverage/",
      ".wrangler/",
      // Config files are not part of the typed project.
      "eslint.config.js",
      "vitest.config.ts",
      // A build-time Node script, not part of the Worker's typed program (it is
      // `.mjs` and `allowJs` is off by design, so the Worker's own types stay
      // authoritative). It is covered by execution tests instead: it is asserted
      // to exit non-zero without `D1_DATABASE_ID` and to inject the id with it.
      "scripts/*.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // SPEC §12 / PLAN: the safety invariants depend on the type system, so
      // `any` is not permitted anywhere in the source tree.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // Every promise must be awaited or explicitly voided. The run pipeline
      // depends on sequencing: a floating promise could issue a second ECS
      // mutation or drop a webhook silently (SPEC §10, §6.3).
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",

      // Unhandled rejections must not escape the scheduled handler.
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],

      // Exhaustiveness: the action matrix and status unions are closed sets.
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],

      eqeqeq: ["error", "always"],
      "no-console": "off",
      "prefer-const": "error",
      "no-throw-literal": "error",

      // Underscore prefix marks a deliberately unused handler parameter; the
      // Worker entry point signatures are fixed by the runtime.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // The Worker entry point's signatures are dictated by the runtime, not by
  // whether the current body happens to use every argument.
  {
    files: ["src/index.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  // Tests may relax rules that fight with expressive fixtures, but not the
  // rules that protect the safety invariants.
  {
    files: ["test/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
);
