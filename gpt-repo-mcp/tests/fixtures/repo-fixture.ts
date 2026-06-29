import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RepoFixture = {
  root: string;
  outside: string;
};

export async function createRepoFixture(): Promise<RepoFixture> {
  const root = await mkdtemp(join(tmpdir(), "repo-reader-fixture-"));
  const outside = await mkdtemp(join(tmpdir(), "repo-reader-outside-"));

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "vendor", "nested", ".git"), { recursive: true });
  await mkdir(join(root, "vendor", "submodule"), { recursive: true });

  await writeFile(join(root, "src", "app.ts"), [
    "export function rawFetch() {",
    "  return fetch('/api/users');",
    "}",
    ""
  ].join("\n"));
  await writeFile(join(root, "src", "controllers.ts"), [
    "export const controller = 'users';",
    "export const token = 'public-token';",
    ""
  ].join("\n"));
  await writeFile(join(root, "src", "admin.controller.ts"), "export const admin = true;\n");
  await writeFile(join(root, "src", "users.controller.ts"), "export const users = true;\n");
  await writeFile(join(root, "docs", "guide.md"), "# Guide\nSearchable docs\n");
  await writeFile(join(root, ".env"), "API_TOKEN=super-secret\n");
  await writeFile(join(root, "config.key"), "private-key\n");
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 'ignored';\n");
  await writeFile(join(root, "dist", "bundle.js"), "console.log('generated');\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, "vendor", "nested", "index.ts"), "export const nested = true;\n");
  await writeFile(join(root, "vendor", "submodule", ".git"), "gitdir: ../.git/modules/vendor/submodule\n");
  await writeFile(join(root, "vendor", "submodule", "README.md"), "# submodule\n");
  await writeFile(join(outside, "secret.txt"), "outside secret\n");
  await symlink(join(outside, "secret.txt"), join(root, "linked-secret.txt"));

  return { root, outside };
}
