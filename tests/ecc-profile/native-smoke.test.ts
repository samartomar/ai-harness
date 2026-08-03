import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { renderEccProjection } from "../../src/ecc-profile/render.js";
import { evidence, fixtureDirectory, profile, receipt } from "./render-fixture.js";

const pinnedSourceRoot = process.env.AIH_ECC_PINNED_SOURCE_ROOT;
const codexEntrypoint = process.env.AIH_CODEX_NATIVE_ENTRYPOINT;
const claudeExecutable = process.env.AIH_CLAUDE_NATIVE_EXECUTABLE;
const nativeEnabled = Boolean(pinnedSourceRoot && codexEntrypoint && claudeExecutable);

function boundedOutput(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(0, 8_192);
}

async function copyEvidence(root: string): Promise<void> {
  const copies = [
    [join(fixtureDirectory, "review-receipt.json"), join(root, ...receipt.evidencePath.split("/"))],
    [
      join(fixtureDirectory, "projected-source-closure.json"),
      join(root, "evidence", "ecc", "projected-source-closure-v1.json"),
    ],
  ] as const;
  for (const [source, destination] of copies) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

describe.skipIf(!nativeEnabled)("disposable native-client ECC projection smoke", () => {
  it("parses the authenticated projection with installed Claude and Codex clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "aih-ecc-native-smoke-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const evidenceRoot = join(root, "evidence-root");
    try {
      await mkdir(project, { recursive: true });
      await mkdir(home, { recursive: true });
      await copyEvidence(evidenceRoot);
      const projection = await renderEccProjection(profile, evidence, {
        sourceRoot: pinnedSourceRoot ?? "",
        evidenceRoot,
      });
      for (const file of projection.files) {
        const destination = join(project, ...file.destination.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { flag: "wx" });
        if (file.mode === "100755" && process.platform !== "win32") await chmod(destination, 0o755);
      }

      const markdown = projection.files.filter((file) => file.content.startsWith("---\n"));
      for (const document of markdown) {
        const closing = document.content.indexOf("\n---\n", 4);
        expect(closing, document.destination).toBeGreaterThan(4);
        const parsed = parseYaml(document.content.slice(4, closing));
        expect(parsed, document.destination).toBeTypeOf("object");
      }

      const nativeEnvironment = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(project, ".codex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "",
        no_proxy: "",
      };
      const codex = spawnSync(
        process.execPath,
        [codexEntrypoint ?? "", "debug", "prompt-input", "native-smoke"],
        { cwd: project, env: nativeEnvironment, encoding: "utf8", timeout: 30_000 },
      );
      expect(codex.status, boundedOutput(codex)).toBe(0);
      expect(() => JSON.parse(codex.stdout)).not.toThrow();

      const claude = spawnSync(claudeExecutable ?? "", ["doctor"], {
        cwd: project,
        env: nativeEnvironment,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(claude.status, boundedOutput(claude)).toBe(0);

      for (const destination of [
        ".agents/skills/accessibility/SKILL.md",
        ".codex/agents/a11y-architect.toml",
        ".agents/skills/ecc-workflow-code-review/SKILL.md",
        ".agents/skills/ecc-workflow-project-init/SKILL.md",
        ".claude/skills/accessibility/SKILL.md",
        ".claude/agents/a11y-architect.md",
        ".claude/commands/code-review.md",
        ".claude/commands/project-init.md",
      ]) {
        expect(await readFile(join(project, ...destination.split("/")), "utf8")).not.toBe("");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
