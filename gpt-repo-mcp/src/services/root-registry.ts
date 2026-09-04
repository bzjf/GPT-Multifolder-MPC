import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { resolveRuntimeLimits, type RuntimeLimits } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { RepoReaderConfigSchema, type RepoConfig as RepoConfigDocument } from "../config/schema.js";

export type RepoReaderConfig = z.infer<typeof RepoReaderConfigSchema>;
export type RepoConfig = RepoConfigDocument;
type RepoReaderConfigInput = z.input<typeof RepoReaderConfigSchema>;

export class RootRegistry {
  private constructor(
    private readonly repos: RepoConfig[],
    readonly limits: RuntimeLimits
  ) {}

  static async fromConfig(config: RepoReaderConfigInput): Promise<RootRegistry> {
    const parsed = RepoReaderConfigSchema.parse(config);
    const repos = [];
    for (const repo of parsed.repos) {
      repos.push({ ...repo, root: await realpath(repo.root) });
    }
    return new RootRegistry(repos, resolveRuntimeLimits(parsed.limits));
  }

  static async fromFile(configPath: string): Promise<RootRegistry> {
    const raw = await readFile(configPath, "utf8");
    return RootRegistry.fromConfig(JSON.parse(raw));
  }

  list(): Array<Pick<RepoConfig, "repo_id" | "display_name" | "root">> {
    return this.repos.map((repo) => ({
      repo_id: repo.repo_id,
      display_name: repo.display_name,
      root: repo.root
    }));
  }

  get(repoId: string): RepoConfig {
    const repo = this.repos.find((candidate) => candidate.repo_id === repoId);
    if (!repo) {
      throw new RepoReaderError("UNKNOWN_REPO", `Unknown repo_id: ${repoId}`);
    }
    return repo;
  }
}
