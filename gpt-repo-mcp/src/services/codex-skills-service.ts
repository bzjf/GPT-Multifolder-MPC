import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CodexReadSkillInput, CodexSkillSource, CodexSkillsInput } from "../contracts/codex-skills.contract.js";
import { RepoReaderError } from "../runtime/errors.js";

const DEFAULT_MAX_RESULTS = 200;
const HARD_MAX_RESULTS = 500;
const MAX_SCAN_DEPTH = 12;
const FRONTMATTER_CHARS = 16_000;
const DEFAULT_SKILL_CONTENT_BYTES = 256_000;
const HARD_SKILL_CONTENT_BYTES = 1_000_000;

type SkillFile = {
  path: string;
  source: CodexSkillSource;
};

type SkillSummary = {
  name: string;
  description?: string;
  source: CodexSkillSource;
  skill_file: string;
  directory: string;
};

export class CodexSkillsService {
  constructor(private readonly codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {}

  async list(options: CodexSkillsInput = {}) {
    const maxResults = Math.min(options.max_results ?? DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS);
    const warnings: string[] = [];
    const skillFiles = await this.findSkillFiles(options, warnings);
    skillFiles.sort((a, b) => a.path.localeCompare(b.path));

    const skills: SkillSummary[] = [];
    for (const skillFile of skillFiles) {
      if (skills.length >= maxResults) {
        addWarning(warnings, "MAX_RESULTS_REACHED");
        break;
      }

      try {
        skills.push(await this.readSkillSummary(skillFile));
      } catch {
        addWarning(warnings, "SKILL_METADATA_READ_FAILED");
      }
    }

    return {
      skills,
      returned_count: skills.length,
      truncated: skillFiles.length > skills.length,
      warnings
    };
  }

  async read(input: CodexReadSkillInput) {
    const warnings: string[] = [];
    const skillFiles = await this.findSkillFiles({
      include_user: input.source ? input.source === "user" : true,
      include_system: input.source ? input.source === "system" : true,
      include_plugins: input.source ? input.source === "plugin" : true
    }, warnings);

    const matches: Array<{ file: SkillFile; summary: SkillSummary }> = [];
    for (const skillFile of skillFiles) {
      try {
        const summary = await this.readSkillSummary(skillFile);
        if (summary.name.toLowerCase() === input.name.toLowerCase()) {
          matches.push({ file: skillFile, summary });
        }
      } catch {
        addWarning(warnings, "SKILL_METADATA_READ_FAILED");
      }
    }

    if (matches.length === 0) {
      const sourceMessage = input.source ? ` in source ${input.source}` : "";
      throw new RepoReaderError("VALIDATION_ERROR", `Codex skill not found by name: ${input.name}${sourceMessage}`);
    }

    if (matches.length > 1) {
      const sources = [...new Set(matches.map((match) => match.summary.source))].sort().join(", ");
      throw new RepoReaderError(
        "VALIDATION_ERROR",
        `Codex skill name is ambiguous: ${input.name}. Matching sources: ${sources}. Pass source to disambiguate.`
      );
    }

    const match = matches[0];
    const maxBytes = Math.min(input.max_bytes ?? DEFAULT_SKILL_CONTENT_BYTES, HARD_SKILL_CONTENT_BYTES);
    const fileText = await readFile(match.file.path, "utf8");
    const buffer = Buffer.from(fileText, "utf8");
    const truncated = buffer.byteLength > maxBytes;
    const content = truncated ? buffer.subarray(0, maxBytes).toString("utf8") : fileText;
    if (truncated) {
      addWarning(warnings, "SKILL_CONTENT_TRUNCATED");
    }

    return {
      skill: match.summary,
      content,
      size_bytes: buffer.byteLength,
      truncated,
      warnings
    };
  }

  private async findSkillFiles(options: CodexSkillsInput, warnings: string[]): Promise<SkillFile[]> {
    const includeUser = options.include_user ?? true;
    const includeSystem = options.include_system ?? true;
    const includePlugins = options.include_plugins ?? true;
    const skillFiles: SkillFile[] = [];

    if (includeUser || includeSystem) {
      await this.collectSkillFiles(join(this.codexHome, "skills"), skillFiles, warnings, 0, {
        includeUser,
        includeSystem,
        includePlugins: false
      });
    }

    if (includePlugins) {
      await this.collectSkillFiles(join(this.codexHome, "plugins", "cache"), skillFiles, warnings, 0, {
        includeUser: false,
        includeSystem: false,
        includePlugins: true
      });
    }

    return skillFiles;
  }

  private async collectSkillFiles(
    directory: string,
    skillFiles: SkillFile[],
    warnings: string[],
    depth: number,
    include: { includeUser: boolean; includeSystem: boolean; includePlugins: boolean }
  ): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) {
      addWarning(warnings, "MAX_SCAN_DEPTH_REACHED");
      return;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      if (depth === 0) {
        addWarning(warnings, "SKILLS_ROOT_NOT_FOUND");
      }
      return;
    }

    const skillEntry = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md");
    if (skillEntry) {
      const skillFile = join(directory, skillEntry.name);
      const source = this.classifySource(skillFile);
      if (isIncludedSource(source, include)) {
        skillFiles.push({ path: skillFile, source });
      }
      return;
    }

    const childDirectories = entries
      .filter((entry) => entry.isDirectory() && !isSkippedDirectory(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const child of childDirectories) {
      await this.collectSkillFiles(join(directory, child.name), skillFiles, warnings, depth + 1, include);
    }
  }

  private async readSkillSummary(skillFile: SkillFile): Promise<SkillSummary> {
    const text = (await readFile(skillFile.path, "utf8")).slice(0, FRONTMATTER_CHARS);
    const frontmatter = extractFrontmatter(text);
    const directory = dirname(skillFile.path);
    return {
      name: parseFrontmatterValue(frontmatter, "name") ?? basename(directory),
      description: parseFrontmatterValue(frontmatter, "description"),
      source: skillFile.source,
      skill_file: skillFile.path,
      directory
    };
  }

  private classifySource(skillFile: string): CodexSkillSource {
    const pluginRoot = join(this.codexHome, "plugins", "cache");
    if (isInside(pluginRoot, skillFile)) {
      return "plugin";
    }

    const systemRoot = join(this.codexHome, "skills", ".system");
    if (isInside(systemRoot, skillFile)) {
      return "system";
    }

    return "user";
  }
}

function extractFrontmatter(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match?.[1] ?? "";
}

function parseFrontmatterValue(frontmatter: string, key: "name" | "description"): string | undefined {
  const expression = new RegExp(`^${key}:\\s*(.*)$`, "im");
  const match = expression.exec(frontmatter);
  if (!match) {
    return undefined;
  }

  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return value.length > 0 ? value : undefined;
}

function isIncludedSource(
  source: CodexSkillSource,
  include: { includeUser: boolean; includeSystem: boolean; includePlugins: boolean }
): boolean {
  return (source === "user" && include.includeUser)
    || (source === "system" && include.includeSystem)
    || (source === "plugin" && include.includePlugins);
}

function isSkippedDirectory(name: string): boolean {
  return name === ".git" || name === "node_modules";
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (Boolean(rel) && !rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}
