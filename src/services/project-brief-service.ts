import { extname } from "node:path";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import type { RepoConfig } from "./root-registry.js";
import type { PathSandbox } from "./path-sandbox.js";
import { RepoTreeService } from "./repo-tree-service.js";
import { GitService } from "./git-service.js";
import { readFilePrefix } from "./bounded-read.js";
import type { ProjectBriefInclude, ProjectBriefInput } from "../contracts/project.contract.js";

const DEFAULT_INCLUDE: ProjectBriefInclude[] = ["package", "readme", "architecture", "scripts", "recent_git", "todos"];
const MAX_DOCS = 5;
const MAX_ENTRYPOINTS = 12;
const MAX_SCRIPTS = 20;
const MAX_TREE_ENTRIES = 500;

type ProjectBriefOptions = Omit<ProjectBriefInput, "repo_id">;

type PackageJson = {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  type?: unknown;
};

export class ProjectBriefService {
  constructor(private readonly repo: RepoConfig, private readonly sandbox: PathSandbox) {}

  async brief(options: ProjectBriefOptions = {}) {
    const include = new Set(options.include ?? DEFAULT_INCLUDE);
    const warnings: string[] = [];
    const tree = await new RepoTreeService(this.repo.root, this.sandbox).tree({
      include_files: true,
      max_depth: 4,
      page_size: MAX_TREE_ENTRIES,
      respect_default_excludes: true
    });
    const filePaths = tree.entries.filter((entry) => entry.type === "file").map((entry) => entry.path);
    if (tree.truncated) {
      warnings.push("TREE_TRUNCATED");
    }

    const packageJson = include.has("package") || include.has("scripts") ? await this.readPackageJson(filePaths, warnings) : undefined;
    const allScripts = include.has("scripts") && packageJson?.scripts ? normalizeScripts(packageJson.scripts) : [];
    const scripts = allScripts.slice(0, MAX_SCRIPTS);
    const docs = include.has("readme") || include.has("architecture") || include.has("todos") ? await this.readKeyDocs(filePaths, include, warnings) : [];
    const recentGitWarnings = include.has("recent_git") ? await this.collectRecentGitWarnings(warnings) : [];
    warnings.push(...recentGitWarnings);

    return {
      repo: {
        repo_id: this.repo.repo_id,
        display_name: this.repo.display_name
      },
      project_type: detectProjectType(packageJson, filePaths),
      languages: detectLanguages(filePaths),
      package_managers: detectPackageManagers(filePaths),
      scripts,
      key_docs: docs,
      likely_entrypoints: detectEntrypoints(filePaths, packageJson),
      test_commands: detectTestCommands(scripts, filePaths),
      truncated: tree.truncated || allScripts.length > scripts.length,
      warnings
    };
  }

  private async readPackageJson(filePaths: string[], warnings: string[]): Promise<PackageJson | undefined> {
    if (!filePaths.includes("package.json")) {
      return undefined;
    }
    const text = await this.readTextIfPresent("package.json", warnings);
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text) as PackageJson;
    } catch {
      warnings.push("PACKAGE_JSON_PARSE_ERROR");
      return undefined;
    }
  }

  private async readKeyDocs(filePaths: string[], include: Set<ProjectBriefInclude>, warnings: string[]) {
    const candidates = filePaths.filter((path) => isDocCandidate(path, include)).slice(0, MAX_DOCS);
    const docs = [];
    for (const path of candidates) {
      const text = await this.readTextIfPresent(path, warnings);
      if (!text) {
        continue;
      }
      docs.push({ path, summary: summarizeMarkdown(text) });
    }
    return docs;
  }

  private async collectRecentGitWarnings(warnings: string[]): Promise<string[]> {
    try {
      const status = await new GitService(this.repo.root).status();
      return status.clean ? [] : [`GIT_DIRTY:${status.files.length}`];
    } catch {
      warnings.push("GIT_STATUS_UNAVAILABLE");
      return [];
    }
  }

  private async readTextIfPresent(path: string, warnings: string[]): Promise<string | undefined> {
    try {
      const resolved = await this.sandbox.resolve(path);
      const result = await readFilePrefix(resolved.absolutePath, DEFAULT_LIMITS.max_project_brief_doc_bytes);
      if (result.truncated) {
        warnings.push(`FILE_TRUNCATED:${path}`);
      }
      return result.buffer.toString("utf8");
    } catch {
      warnings.push(`READ_SKIPPED:${path}`);
      return undefined;
    }
  }
}

function normalizeScripts(scripts: Record<string, unknown>) {
  return Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, command]) => ({ name, command }));
}

function detectProjectType(packageJson: PackageJson | undefined, filePaths: string[]): string | undefined {
  if (packageJson) {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if ("@modelcontextprotocol/sdk" in deps) {
      return "mcp-server";
    }
    if ("next" in deps) {
      return "nextjs-app";
    }
    if ("vite" in deps) {
      return "vite-app";
    }
    return packageJson.type === "module" ? "node-module" : "node-project";
  }
  if (filePaths.some((path) => path.endsWith("pyproject.toml"))) {
    return "python-project";
  }
  if (filePaths.some((path) => path.endsWith("Cargo.toml"))) {
    return "rust-project";
  }
  return undefined;
}

function detectLanguages(filePaths: string[]): string[] {
  const languages = new Set<string>();
  for (const path of filePaths) {
    const language = languageByExtension(extname(path));
    if (language) {
      languages.add(language);
    }
  }
  return [...languages].sort();
}

function languageByExtension(extension: string): string | undefined {
  return {
    ".cjs": "JavaScript",
    ".css": "CSS",
    ".go": "Go",
    ".html": "HTML",
    ".java": "Java",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".md": "Markdown",
    ".mjs": "JavaScript",
    ".py": "Python",
    ".rs": "Rust",
    ".tsx": "TypeScript",
    ".ts": "TypeScript"
  }[extension];
}

function detectPackageManagers(filePaths: string[]): string[] {
  const managers = [];
  if (filePaths.includes("package-lock.json")) {
    managers.push("npm");
  }
  if (filePaths.includes("pnpm-lock.yaml")) {
    managers.push("pnpm");
  }
  if (filePaths.includes("yarn.lock")) {
    managers.push("yarn");
  }
  if (filePaths.includes("bun.lockb") || filePaths.includes("bun.lock")) {
    managers.push("bun");
  }
  if (filePaths.includes("pyproject.toml")) {
    managers.push("python");
  }
  if (filePaths.includes("Cargo.lock") || filePaths.includes("Cargo.toml")) {
    managers.push("cargo");
  }
  return managers;
}

function detectEntrypoints(filePaths: string[], packageJson: PackageJson | undefined): string[] {
  const preferredNames = new Set([
    "src/index.ts",
    "src/index.js",
    "src/server.ts",
    "src/server.js",
    "src/main.ts",
    "src/main.js",
    "src/app.ts",
    "src/app.js",
    "index.ts",
    "index.js",
    "server.ts",
    "server.js"
  ]);
  const entrypoints = filePaths.filter((path) => preferredNames.has(path));
  if (packageJson && filePaths.includes("package.json")) {
    entrypoints.unshift("package.json");
  }
  return [...new Set(entrypoints)].slice(0, MAX_ENTRYPOINTS);
}

function detectTestCommands(scripts: Array<{ name: string; command: string }>, filePaths: string[]): string[] {
  const commands = scripts
    .filter((script) => /test|lint|typecheck|build/i.test(script.name))
    .map((script) => `npm run ${script.name}`);
  if (commands.length > 0) {
    return commands;
  }
  if (filePaths.some((path) => path.endsWith("pytest.ini") || path.startsWith("tests/"))) {
    return ["pytest"];
  }
  return [];
}

function isDocCandidate(path: string, include: Set<ProjectBriefInclude>): boolean {
  const lower = path.toLowerCase();
  if (include.has("readme") && /(^|\/)readme\.md$/.test(lower)) {
    return true;
  }
  if (include.has("architecture") && /(^|\/)(architecture|arch|design|overview)\.md$/.test(lower)) {
    return true;
  }
  if (include.has("todos") && /(^|\/)(todo|todos|roadmap)\.md$/.test(lower)) {
    return true;
  }
  return false;
}

function summarizeMarkdown(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines.find((line) => line.startsWith("#"));
  const firstBody = lines.find((line) => !line.startsWith("#"));
  return [heading, firstBody].filter(Boolean).join(" ").slice(0, 240);
}
