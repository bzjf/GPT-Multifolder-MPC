import { createRequire } from "node:module";

const requireFromPackage = createRequire(new URL("./gpt-repo-mcp/package.json", import.meta.url));
const js = requireFromPackage("@eslint/js");
const globals = requireFromPackage("globals");

export default [
  {
    ignores: [
      ".git/**",
      ".runtime/**",
      "engineering-skill-stack/**",
      "gpt-repo-mcp/**",
      "node_modules/**"
    ]
  },
  {
    ...js.configs.recommended,
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        AbortController: "readonly",
        Response: "readonly",
        URL: "readonly",
        fetch: "readonly"
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  }
];
