import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(scriptDir);
const requireFromPackage = createRequire(new URL("../gpt-repo-mcp/package.json", import.meta.url));
const { ESLint } = requireFromPackage("eslint");

const eslint = new ESLint({
  cwd: rootDir,
  overrideConfigFile: path.join(rootDir, "eslint.config.mjs")
});
const results = await eslint.lintFiles([
  "scripts/lint-control-panel.mjs",
  "scripts/mcp-control-panel.mjs",
  "scripts/control-panel"
]);
const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);
if (output) console.log(output);
if (results.some((result) => result.errorCount > 0)) process.exitCode = 1;
