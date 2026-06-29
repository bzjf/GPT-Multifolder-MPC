import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RepoReaderConfigSchema, type RepoReaderConfig } from "./schema.js";

export function resolveConfigPath(options: {
  cliConfigPath?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): string {
  const selected = options.cliConfigPath
    ?? options.env.GPT_REPO_CONFIG
    ?? options.env.REPO_READER_CONFIG
    ?? "./config.local.json";
  return resolve(options.cwd, selected);
}

export async function loadConfig(configPath: string): Promise<RepoReaderConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return RepoReaderConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isNotFoundError(error)) {
      return RepoReaderConfigSchema.parse({});
    }
    throw error;
  }
}

export async function readConfigDocument(configPath: string): Promise<unknown> {
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw);
}

export async function writeConfigAtomic(configPath: string, config: RepoReaderConfig): Promise<void> {
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, configPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Best effort cleanup.
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
  );
}
