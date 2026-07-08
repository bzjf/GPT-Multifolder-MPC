import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { validateRepoPath } from "./path-sandbox.js";

const execFileAsync = promisify(execFile);

export type GitCommandRunner = (args: string[], maxBuffer?: number) => Promise<string>;

export class GitService {
  private readonly runCommand: GitCommandRunner;

  constructor(private readonly root: string, runCommand?: GitCommandRunner) {
    this.runCommand = runCommand ?? ((args, maxBuffer) => this.runGitProcess(args, maxBuffer));
  }

  async headSha(): Promise<string> {
    return (await this.runCommand(["rev-parse", "HEAD"])).trim();
  }

  async status() {
    const raw = await this.runCommand([
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all",
      "--renames"
    ]);
    const parsed = parsePorcelainV2Status(raw);
    const counts: Record<string, number> = {};
    for (const file of parsed.files) {
      const key = `${file.index}${file.worktree}`.trim() || "clean";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return {
      branch: parsed.branch,
      head_sha: parsed.headSha,
      clean: parsed.files.length === 0,
      files: parsed.files,
      counts
    };
  }

  async diff(options: {
    base?: string;
    compare?: string;
    staged?: boolean;
    unstaged?: boolean;
    paths?: string[];
    max_bytes?: number;
    context_lines?: number;
  }) {
    const paths = options.paths?.map(validateRepoPath);
    const args = ["diff", "--find-renames", `--unified=${options.context_lines ?? 3}`];
    if (options.staged) args.push("--cached");
    if (options.base && options.compare) {
      args.push(`${options.base}...${options.compare}`);
    } else if (options.base) {
      args.push(options.base);
    }
    if (paths?.length) args.push("--", ...paths);

    const maxBytes = Math.min(options.max_bytes ?? DEFAULT_LIMITS.max_diff_bytes, DEFAULT_LIMITS.max_diff_bytes);
    const raw = await this.runCommand(args, DEFAULT_LIMITS.max_diff_bytes + 1);
    const truncated = Buffer.byteLength(raw) > maxBytes;
    const text = truncated ? raw.slice(0, maxBytes) : raw;
    return {
      base: options.base,
      compare: options.compare,
      staged: options.staged,
      unstaged: options.unstaged,
      files: parseDiff(text),
      truncated,
      warnings: truncated
        ? [`Diff truncated by max_bytes (${maxBytes}). Increase max_bytes or pass paths to narrow the diff before reviewing.`]
        : []
    };
  }

  private async runGitProcess(args: string[], maxBuffer: number = DEFAULT_LIMITS.max_diff_bytes): Promise<string> {
    try {
      const result = await execFileAsync("git", args, {
        cwd: this.root,
        maxBuffer,
        env: { PATH: process.env.PATH ?? "" }
      });
      return result.stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git command failed";
      throw new RepoReaderError("GIT_ERROR", message);
    }
  }
}

type StatusFile = {
  path: string;
  original_path?: string;
  index: string;
  worktree: string;
};

type DiffFile = {
  path: string;
  original_path?: string;
  status?: string;
  hunks: string[];
};

function parsePorcelainV2Status(raw: string): {
  branch: string;
  headSha: string;
  files: StatusFile[];
} {
  let branch = "HEAD";
  let headSha = "";
  const files: StatusFile[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      headSha = line.slice("# branch.oid ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? "HEAD" : value;
      continue;
    }
    const parsed = parsePorcelainV2File(line);
    if (parsed) files.push(parsed);
  }

  if (!headSha || headSha === "(initial)") {
    throw new RepoReaderError("GIT_ERROR", "Git repository does not have a readable HEAD commit.");
  }
  return { branch, headSha, files };
}

function parsePorcelainV2File(line: string): StatusFile | undefined {
  if (line.startsWith("? ")) {
    return { index: "?", worktree: "?", path: unquoteGitPath(line.slice(2)) };
  }
  if (line.startsWith("! ")) return undefined;

  const fields = line.split(" ");
  const recordType = fields[0];
  const xy = fields[1];
  if (!xy || xy.length !== 2) return undefined;

  if (recordType === "1") {
    return {
      index: normalizeStatusChar(xy[0]),
      worktree: normalizeStatusChar(xy[1]),
      path: unquoteGitPath(fields.slice(8).join(" "))
    };
  }

  if (recordType === "2") {
    const pathData = fields.slice(9).join(" ");
    const separator = pathData.indexOf("\t");
    const path = separator >= 0 ? pathData.slice(0, separator) : pathData;
    const originalPath = separator >= 0 ? pathData.slice(separator + 1) : undefined;
    return {
      index: normalizeStatusChar(xy[0]),
      worktree: normalizeStatusChar(xy[1]),
      path: unquoteGitPath(path),
      ...(originalPath ? { original_path: unquoteGitPath(originalPath) } : {})
    };
  }

  if (recordType === "u") {
    return {
      index: normalizeStatusChar(xy[0]),
      worktree: normalizeStatusChar(xy[1]),
      path: unquoteGitPath(fields.slice(10).join(" "))
    };
  }

  return undefined;
}

function normalizeStatusChar(value: string | undefined): string {
  return !value || value === "." ? " " : value;
}

function unquoteGitPath(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

function parseDiff(diff: string) {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let currentHunk: string[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        if (currentHunk.length) current.hunks.push(currentHunk.join("\n"));
        files.push(current);
      }
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: match?.[2] ?? "unknown", hunks: [] };
      currentHunk = [];
      continue;
    }
    if (!current) continue;
    if (line.startsWith("rename from ")) {
      current.original_path = line.slice("rename from ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("new file mode ")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("@@")) {
      current.status ??= "modified";
      if (currentHunk.length) current.hunks.push(currentHunk.join("\n"));
      currentHunk = [line];
      continue;
    }
    if (currentHunk.length) currentHunk.push(line);
  }
  if (current) {
    if (currentHunk.length) current.hunks.push(currentHunk.join("\n"));
    files.push(current);
  }
  return files;
}
