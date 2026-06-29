import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ProjectBriefService } from "../src/services/project-brief-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("ProjectBriefService", () => {
  test("returns bounded project signals from package, docs, scripts, and entrypoints", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), "# Demo App\nA useful project.\n");
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({
      type: "module",
      scripts: {
        build: "tsc",
        lint: "eslint .",
        test: "vitest"
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.0.0"
      },
      devDependencies: {
        typescript: "^5.0.0"
      }
    }, null, 2));
    await writeFile(join(fixture.root, "package-lock.json"), "{}\n");

    const result = await new ProjectBriefService({
      repo_id: "fixture",
      display_name: "Fixture",
      root: fixture.root
    }, new PathSandbox(fixture.root)).brief();

    expect(result.repo).toEqual({ repo_id: "fixture", display_name: "Fixture" });
    expect(result.project_type).toBe("mcp-server");
    expect(result.languages).toContain("TypeScript");
    expect(result.package_managers).toContain("npm");
    expect(result.scripts).toEqual(expect.arrayContaining([
      { name: "build", command: "tsc" },
      { name: "test", command: "vitest" }
    ]));
    expect(result.key_docs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", summary: expect.stringContaining("Demo App") })
    ]));
    expect(result.likely_entrypoints).toContain("package.json");
    expect(result.likely_entrypoints).toContain("src/app.ts");
    expect(result.test_commands).toEqual(expect.arrayContaining(["npm run build", "npm run test"]));
    expect(result.truncated).toBe(false);
  });

  test("honors include filters", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), "# Demo\n");
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest"
      }
    }, null, 2));

    const result = await new ProjectBriefService({
      repo_id: "fixture",
      display_name: "Fixture",
      root: fixture.root
    }, new PathSandbox(fixture.root)).brief({ include: ["readme"] });

    expect(result.key_docs.map((doc) => doc.path)).toEqual(["README.md"]);
    expect(result.scripts).toEqual([]);
    expect(result.test_commands).toEqual([]);
  });

  test("bounds project document reads and reports truncation", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), `# Large Doc\n${"x".repeat(33_000)}\n`);

    const result = await new ProjectBriefService({
      repo_id: "fixture",
      display_name: "Fixture",
      root: fixture.root
    }, new PathSandbox(fixture.root)).brief({ include: ["readme"] });

    expect(result.key_docs).toEqual([
      expect.objectContaining({ path: "README.md", summary: expect.stringContaining("Large Doc") })
    ]);
    expect(result.warnings).toContain("FILE_TRUNCATED:README.md");
  });


  test("keeps dependency and secret candidate files out of project signals", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "node_modules", "hidden"), { recursive: true });
    await writeFile(join(fixture.root, "node_modules", "hidden", "index.ts"), "export const hidden = true;\n");
    await writeFile(join(fixture.root, "secret.key"), "SECRET\n");

    const result = await new ProjectBriefService({
      repo_id: "fixture",
      display_name: "Fixture",
      root: fixture.root
    }, new PathSandbox(fixture.root)).brief();

    expect(result.likely_entrypoints).not.toContain("node_modules/hidden/index.ts");
    expect(result.languages).not.toContain("Binary");
    expect(result.key_docs.map((doc) => doc.path)).not.toContain("secret.key");
  });
});
