import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  ArtifactEvidenceBundleV1Schema,
  ArtifactEvidenceBundleV2Schema,
} from "../../src/trust/artifact-evidence.js";
import { trustScanCommand } from "../../src/trust/scan.js";

const COMMIT = "a".repeat(40);
const REGISTRY_INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-artifact-intake-scan-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function intake(): Record<string, unknown> {
  return {
    format: "aih-artifact-intake",
    version: 1,
    authority: { state: "not-authority" },
    defaults: { accountableOwner: "platform@acme.example" },
    items: [
      {
        id: "firecrawl-mcp",
        kind: "mcp",
        source: {
          type: "npm",
          registry: "https://registry.npmjs.org",
          package: "firecrawl-mcp",
          version: "3.24.0",
          integrity: REGISTRY_INTEGRITY,
        },
      },
      {
        id: "security-skill",
        kind: "skill",
        source: {
          type: "github",
          repository: "acme/security-assets",
          commit: COMMIT,
          path: "skills/security/SKILL.md",
        },
      },
      {
        id: "review-agent",
        kind: "agent",
        source: {
          type: "github",
          repository: "acme/security-assets",
          commit: COMMIT,
          path: "agents/reviewer.md",
        },
      },
    ],
  };
}

function directoryIntake(): Record<string, unknown> {
  return {
    format: "aih-artifact-intake",
    version: 2,
    authority: { state: "not-authority" },
    defaults: { accountableOwner: "platform@acme.example" },
    items: [
      {
        id: "firecrawl-primary",
        kind: "mcp",
        source: {
          type: "directory",
          provider: "pulsemcp",
          url: "https://www.pulsemcp.com/servers/firecrawl",
        },
      },
      {
        id: "firecrawl-secondary",
        kind: "mcp",
        source: {
          type: "directory",
          provider: "pulsemcp",
          url: "https://www.pulsemcp.com/servers/firecrawl",
        },
      },
      {
        id: "exact-review-agent",
        kind: "agent",
        source: {
          type: "github",
          repository: "acme/security-assets",
          commit: COMMIT,
          path: "agents/reviewer.md",
        },
      },
    ],
  };
}

function context(apply: boolean): PlanContext {
  const run = fakeRunner((argv) => {
    if (argv[0] === "npm" && argv[1] === "pack") return { code: 0, stdout: "[]" };
    if (argv[0] !== process.execPath || argv[1] !== "-e") return undefined;
    const input = JSON.parse(argv[3] ?? "{}") as Record<string, unknown>;
    const treePath = String(input.treePath);
    const metadataPath = String(input.metadataPath);
    if (input.kind === "artifact-directory") {
      const directoryPath = String(input.directoryPath);
      const registryPath = String(input.registryPath);
      const directory =
        "<h1>Firecrawl</h1><p>NAME io.github.firecrawl/firecrawl-mcp-server</p><p>Current Version: 3.7.4</p>";
      const registry = JSON.stringify({
        servers: [
          {
            server: {
              name: "io.github.firecrawl/firecrawl-mcp-server",
              version: "3.24.0",
              repository: {
                url: "https://github.com/firecrawl/firecrawl-mcp-server",
                source: "github",
              },
              packages: [
                {
                  registryType: "npm",
                  identifier: "firecrawl-mcp",
                  version: "3.24.0",
                  transport: { type: "stdio" },
                  environmentVariables: [{ name: "FIRECRAWL_API_KEY", isSecret: true }],
                },
              ],
            },
          },
        ],
        metadata: { count: 1 },
      });
      writeFileSync(directoryPath, directory, "utf8");
      writeFileSync(registryPath, registry, "utf8");
      writeFileSync(
        metadataPath,
        JSON.stringify({
          kind: "artifact-directory",
          provider: input.provider,
          directoryUrl: input.directoryUrl,
          registryUrl: input.registryUrl,
          directoryPath,
          registryPath,
          directorySha256: `sha256:${createHash("sha256").update(directory).digest("hex")}`,
          registrySha256: `sha256:${createHash("sha256").update(registry).digest("hex")}`,
        }),
        "utf8",
      );
      return { code: 0 };
    }
    mkdirSync(treePath, { recursive: true });
    if (input.kind === "artifact-intake-npm") {
      writeFileSync(
        join(treePath, "package.json"),
        JSON.stringify({ name: input.package, version: input.version }),
        "utf8",
      );
      writeFileSync(
        metadataPath,
        JSON.stringify({
          kind: "artifact-intake-npm",
          package: input.package,
          version: input.version,
          registry: input.registry,
          registryIntegrity: input.registryIntegrity,
          tarballSha256: `sha256:${"b".repeat(64)}`,
          treePath,
        }),
        "utf8",
      );
      return { code: 0 };
    }
    writeFileSync(join(treePath, "SKILL.md"), "# Security\n", "utf8");
    mkdirSync(join(treePath, "skills", "security"), { recursive: true });
    mkdirSync(join(treePath, "agents"), { recursive: true });
    writeFileSync(join(treePath, "skills", "security", "SKILL.md"), "# Security\n", "utf8");
    writeFileSync(join(treePath, "agents", "reviewer.md"), "# Reviewer\n", "utf8");
    writeFileSync(
      metadataPath,
      JSON.stringify({
        kind: "github",
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        pinnedSha: input.pin,
        source: `${String(input.owner)}/${String(input.repo)}`,
        treePath,
      }),
      "utf8",
    );
    return { code: 0 };
  });
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    posture: "vibe",
    options: {
      target: "artifact-intake.json",
      evidenceOut: "artifact-evidence.json",
    },
  };
}

describe("trust scan artifact intake", () => {
  it("plans one acquisition for duplicate exact sources and no installation", async () => {
    write("artifact-intake.json", JSON.stringify(intake()));
    const commandPlan = await trustScanCommand.plan(context(false));
    const fetches = commandPlan.actions.filter((action) => action.kind === "exec");

    expect(
      fetches.filter((action) => action.describe.startsWith("fetch acme/security-assets@")),
    ).toHaveLength(1);
    expect(
      fetches.filter((action) => action.describe.includes("firecrawl-mcp@3.24.0")),
    ).toHaveLength(2);
    expect(fetches.every((action) => !action.describe.toLowerCase().includes("install"))).toBe(
      true,
    );
    expect(
      trustScanCommand.options?.find((option) => option.flags.startsWith("--evidence-out")),
    ).toBeDefined();
  });

  it("writes one reviewable evidence bundle for the entire batch", async () => {
    write("artifact-intake.json", JSON.stringify(intake()));
    const ctx = context(true);
    const result = await executePlan(await trustScanCommand.plan(ctx), ctx);

    expect(result.execs.filter((entry) => entry.ran)).toHaveLength(3);
    expect(existsSync(join(root, "artifact-evidence.json"))).toBe(true);
    const bundle = ArtifactEvidenceBundleV1Schema.parse(
      JSON.parse(readFileSync(join(root, "artifact-evidence.json"), "utf8")),
    );
    expect(bundle.results).toHaveLength(3);
    expect(bundle.evidence.map((record) => record.itemId).sort()).toEqual([
      "firecrawl-mcp",
      "review-agent",
      "security-skill",
    ]);
    expect(bundle.evidence.every((record) => record.authority.state === "not-authority")).toBe(
      true,
    );
  });

  it("requires an explicit evidence output on apply", async () => {
    write("artifact-intake.json", JSON.stringify(intake()));
    const ctx = context(true);
    delete ctx.options.evidenceOut;
    await expect(trustScanCommand.plan(ctx)).rejects.toThrow(/--evidence-out/);
  });

  it("refuses a hard-linked intake before planning any acquisition", async () => {
    write("artifact-intake-source.json", JSON.stringify(intake()));
    linkSync(join(root, "artifact-intake-source.json"), join(root, "artifact-intake.json"));

    await expect(trustScanCommand.plan(context(false))).rejects.toThrow(/single-link regular JSON/);
  });

  it("contains the explicitly named evidence output to the target root", async () => {
    write("artifact-intake.json", JSON.stringify(intake()));
    const ctx = context(true);
    ctx.options.evidenceOut = "../escaped-evidence.json";

    await expect(trustScanCommand.plan(ctx)).rejects.toThrow(/outside the target root/);
  });

  it("fetches each directory claim once and emits review options beside exact-source evidence", async () => {
    write("artifact-intake.json", JSON.stringify(directoryIntake()));
    const dryPlan = await trustScanCommand.plan(context(false));
    const directoryFetches = dryPlan.actions.filter(
      (action) => action.kind === "exec" && action.describe.includes("PulseMCP"),
    );

    expect(directoryFetches).toHaveLength(1);
    const directoryFetch = directoryFetches[0];
    if (directoryFetch?.kind !== "exec") throw new Error("expected directory fetch action");
    expect(() => new Script(directoryFetch.argv[2] ?? "")).not.toThrow();
    expect(
      dryPlan.actions
        .filter((action) => action.kind === "exec")
        .every((action) => !/install|activate/i.test(action.describe)),
    ).toBe(true);

    const ctx = context(true);
    await executePlan(await trustScanCommand.plan(ctx), ctx);
    const bundle = ArtifactEvidenceBundleV2Schema.parse(
      JSON.parse(readFileSync(join(root, "artifact-evidence.json"), "utf8")),
    );

    expect(bundle.results).toHaveLength(3);
    expect(bundle.evidence.map((record) => record.itemId)).toEqual(["exact-review-agent"]);
    expect(bundle.resolutions.map((record) => record.itemId).sort()).toEqual([
      "firecrawl-primary",
      "firecrawl-secondary",
    ]);
    expect(bundle.resolutions.every((record) => record.authority.state === "not-authority")).toBe(
      true,
    );
    expect(bundle.resolutions[0]?.resolution).toMatchObject({
      state: "mismatched",
      conflicts: [
        expect.objectContaining({
          code: "directory.version-mismatch",
          claimed: "3.7.4",
          observed: "3.24.0",
        }),
      ],
      options: [
        expect.objectContaining({
          source: expect.objectContaining({
            type: "npm",
            package: "firecrawl-mcp",
            version: "3.24.0",
          }),
          execution: { transport: "stdio" },
          secrets: ["FIRECRAWL_API_KEY"],
        }),
      ],
    });
    expect(JSON.stringify(bundle)).not.toContain("FIRECRAWL_API_KEY=");
  });
});
