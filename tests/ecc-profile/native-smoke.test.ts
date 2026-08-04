import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { executeEccProfileLifecycleCommand } from "../../src/ecc-profile/command.js";
import {
  ECC_PROFILE_OWNERSHIP_PATH,
  readEccProfileOwnership,
} from "../../src/ecc-profile/lifecycle.js";
import {
  buildNativeEccRegistration,
  NATIVE_ECC_REGISTRATION_RECEIPT,
} from "../../src/ecc-profile/native-registration.js";
import { renderEccProjection } from "../../src/ecc-profile/render.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { evidence, fixtureDirectory, profile, receipt } from "./render-fixture.js";

const pinnedSourceRoot = process.env.AIH_ECC_PINNED_SOURCE_ROOT;
const codexEntrypoint = process.env.AIH_CODEX_NATIVE_ENTRYPOINT;
const claudeExecutable = process.env.AIH_CLAUDE_NATIVE_EXECUTABLE;
const nativeEnabled = Boolean(pinnedSourceRoot && codexEntrypoint && claudeExecutable);

function nativeSmokeEnvironment(
  inherited: NodeJS.ProcessEnv,
  home: string,
  project: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
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
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ]) {
    if (inherited[key] !== undefined) environment[key] = inherited[key];
  }
  if (environment.PATH === undefined && environment.Path !== undefined) {
    environment.PATH = environment.Path;
  }
  return environment;
}

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

function applyContext(root: string, operation: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({
      platform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "darwin"
            : "linux",
      run,
      env: {},
    }),
    env: {},
    options: { lifecycle: operation },
  };
}

describe.skipIf(!nativeEnabled)("disposable native-client ECC projection smoke", () => {
  it("checks root config and doctor parsing with materialized canaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "aih-ecc-native-smoke-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const evidenceRoot = join(root, "evidence-root");
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    try {
      await mkdir(project, { recursive: true });
      await mkdir(home, { recursive: true });
      await mkdir(stateRoot, { recursive: true });
      await mkdir(runtimeRoot, { recursive: true });
      const runtimeCli = join(runtimeRoot, "cli.js");
      await writeFile(runtimeCli, "// disposable native smoke runtime\n");
      await copyEvidence(evidenceRoot);
      const projection = await renderEccProjection(profile, evidence, {
        sourceRoot: pinnedSourceRoot ?? "",
        evidenceRoot,
      });
      const registration = buildNativeEccRegistration({
        root: project,
        stateRoot,
        executable: process.execPath,
        cliScript: runtimeCli,
      });
      const deps = {
        loadProjection: async () => projection,
        loadNativeRegistration: () => registration,
      };
      const installed = await executeEccProfileLifecycleCommand(
        applyContext(project, "install"),
        deps,
      );
      expect(installed.applied).toBe(true);
      const repeated = await executeEccProfileLifecycleCommand(
        applyContext(project, "install"),
        deps,
      );
      expect(repeated.writes).toEqual([]);
      const installedSource = readEccProfileOwnership(project)?.source;
      expect(installedSource).toBeDefined();

      const repairCanary = join(project, ".claude", "skills", "accessibility", "SKILL.md");
      await rm(repairCanary);
      await executeEccProfileLifecycleCommand(applyContext(project, "repair"), {
        ...deps,
        installedSourceTrust: installedSource ? [installedSource] : [],
      });
      expect(await readFile(repairCanary, "utf8")).not.toBe("");
      const markdown = projection.files.filter((file) => file.content.startsWith("---\n"));
      for (const document of markdown) {
        const closing = document.content.indexOf("\n---\n", 4);
        expect(closing, document.destination).toBeGreaterThan(4);
        const parsed = parseYaml(document.content.slice(4, closing));
        expect(parsed, document.destination).toBeTypeOf("object");
      }

      const nativeEnvironment = nativeSmokeEnvironment(process.env, home, project);
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
      expect(await readFile(join(project, ".claude", "settings.json"), "utf8")).toContain(
        "AIH ECC profile policies",
      );
      expect(await readFile(join(project, ".mcp.json"), "utf8")).toContain('"serena"');
      expect(await readFile(join(project, ".codex", "config.toml"), "utf8")).toContain(
        "ecc-native-registration",
      );

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

      await executeEccProfileLifecycleCommand(applyContext(project, "uninstall"), {
        ...deps,
        installedSourceTrust: installedSource ? [installedSource] : [],
      });
      expect(existsSync(join(project, ECC_PROFILE_OWNERSHIP_PATH))).toBe(false);
      expect(existsSync(join(project, NATIVE_ECC_REGISTRATION_RECEIPT))).toBe(false);
      expect(existsSync(repairCanary)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("native smoke environment boundary", () => {
  it("does not inherit provider credentials or unrelated caller variables", () => {
    const environment = nativeSmokeEnvironment(
      {
        PATH: "fixture-path",
        SystemRoot: "fixture-system-root",
        ANTHROPIC_API_KEY: "must-not-cross-boundary",
        OPENAI_API_KEY: "must-not-cross-boundary",
        AWS_SECRET_ACCESS_KEY: "must-not-cross-boundary",
        UNRELATED_CALLER_VALUE: "must-not-cross-boundary",
      },
      "fixture-home",
      "fixture-project",
    );
    expect(environment.PATH).toBe("fixture-path");
    expect(environment.SystemRoot).toBe("fixture-system-root");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.UNRELATED_CALLER_VALUE).toBeUndefined();
  });
});
