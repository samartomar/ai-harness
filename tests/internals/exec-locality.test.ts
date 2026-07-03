import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_COMMAND_SPEC_PATHS, ALL_COMMAND_SPECS } from "../../src/commands/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { CommandSpec, ExecAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { marketplaceBuildCommand } from "../../src/marketplace/build.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

// Apply-time exec locality guardrail (#161).
//
// Deny-list intent: no planned exec may mutate a remote system. Banned shapes
// include git push, GitHub PR/release/repo mutations, npm publish, mutating cloud
// CLIs, terraform/kubectl apply/destroy/delete, and mutating curl methods. The
// documented remote-touching carve-outs are release/bundle signing and
// verification: `cosign sign-blob` and `gh attestation sign|verify`.

const PIN = "a".repeat(40);

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-exec-locality-"));
  home = mkdtempSync(join(tmpdir(), "aih-exec-locality-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function ctx(options: Record<string, unknown> = {}, over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { HOME: home, USERPROFILE: home } }),
    env: { HOME: home, USERPROFILE: home },
    options,
    ...over,
  };
}

function write(rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function evidenceBody(name: string): string {
  return `{"schemaVersion":1,"verdict":"GREEN","skill":"${name}"}\n`;
}

function skillCard(name: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name,
    source: `owner/repo@${PIN}`,
    commit: PIN,
    license: "MIT License",
    installScope: "repo",
    riskClass: "green",
    requiresMcp: false,
    requiresShell: false,
    scanEvidence: [`.aih/skill-reports/owner-repo-${name}.json`],
  };
}

async function seedMarketplaceArtifact(): Promise<void> {
  const name = "alpha";
  write("ai-coding/skills/owner-repo/alpha/SKILL.md", "# alpha\n");
  write(`ai-coding/skill-cards/${name}.json`, `${JSON.stringify(skillCard(name))}\n`);
  write(`.aih/skill-reports/owner-repo-${name}.json`, evidenceBody(name));
  write(
    "aih-skills.lock.json",
    JSON.stringify({
      schemaVersion: 1,
      skills: [
        {
          name,
          source: `owner/repo@${PIN}`,
          commit: PIN,
          verdict: "GREEN",
          scope: "repo",
          card: `ai-coding/skill-cards/${name}.json`,
          evidenceSha256: sha(evidenceBody(name)),
          approvedBy: "docs-platform",
          approvedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  const c = ctx({}, { apply: true });
  await executePlan(await marketplaceBuildCommand.plan(c), c);
}

function allowedRemoteTouching(argv: readonly string[]): boolean {
  return (
    (argv[0] === "cosign" && argv[1] === "sign-blob") ||
    (argv[0] === "gh" && argv[1] === "attestation" && (argv[2] === "sign" || argv[2] === "verify"))
  );
}

function deniedRemoteMutation(argv: readonly string[]): string | undefined {
  if (allowedRemoteTouching(argv)) return undefined;
  const head = argv.slice(0, 4).join(" ");
  if (argv[0] === "git" && argv.includes("push")) return "git push";
  if (argv[0] === "npm" && argv[1] === "publish") return "npm publish";
  if (
    argv[0] === "gh" &&
    ["pr", "release", "repo"].includes(argv[1] ?? "") &&
    ["close", "create", "delete", "edit", "merge", "reopen", "set-default", "upload"].includes(
      argv[2] ?? "",
    )
  ) {
    return `gh mutation: ${head}`;
  }
  if (
    (argv[0] === "kubectl" && ["apply", "delete", "patch", "replace"].includes(argv[1] ?? "")) ||
    (argv[0] === "terraform" && ["apply", "destroy"].includes(argv[1] ?? "")) ||
    (["aws", "az", "gcloud"].includes(argv[0] ?? "") &&
      ["create", "delete", "deploy", "put", "set", "update"].some((word) => argv.includes(word)))
  ) {
    return `cloud mutation: ${head}`;
  }
  if (
    argv[0] === "curl" &&
    argv.some(
      (arg, index) => arg === "-X" && /^(POST|PUT|PATCH|DELETE)$/i.test(argv[index + 1] ?? ""),
    )
  ) {
    return `curl remote mutation: ${head}`;
  }
  return undefined;
}

async function collectExecs(
  spec: CommandSpec,
  options: Record<string, unknown>,
): Promise<ExecAction[]> {
  const c = ctx(options);
  try {
    const planned = await spec.plan(c);
    return planned.actions.filter((action): action is ExecAction => action.kind === "exec");
  } catch {
    return [];
  }
}

describe("apply-time exec locality — no remote mutation argv (#161)", () => {
  it("the matcher goes red for representative remote mutations and allows signing carve-outs", () => {
    expect(deniedRemoteMutation(["git", "push", "origin", "main"])).toBe("git push");
    expect(deniedRemoteMutation(["gh", "release", "create", "v9"])).toContain("gh mutation");
    expect(deniedRemoteMutation(["npm", "publish"])).toBe("npm publish");
    expect(deniedRemoteMutation(["kubectl", "apply", "-f", "prod.yaml"])).toContain(
      "cloud mutation",
    );
    expect(deniedRemoteMutation(["curl", "-X", "POST", "https://example.test"])).toContain(
      "curl remote mutation",
    );
    expect(deniedRemoteMutation(["cosign", "sign-blob", "SHA256SUMS"])).toBeUndefined();
    expect(deniedRemoteMutation(["gh", "attestation", "sign", "SHA256SUMS"])).toBeUndefined();
    expect(deniedRemoteMutation(["gh", "attestation", "verify", "SHA256SUMS"])).toBeUndefined();
  });

  it("checks every registered CommandSpec plus explicit signing scenarios", async () => {
    const violations: string[] = [];
    for (const [index, path] of ALL_COMMAND_SPEC_PATHS.entries()) {
      const spec = ALL_COMMAND_SPECS[index];
      if (spec === undefined) throw new Error(`missing spec for ${path.join(" ")}`);
      for (const exec of await collectExecs(spec, {})) {
        const denied = deniedRemoteMutation(exec.argv);
        if (denied !== undefined)
          violations.push(`${path.join(" ")}: ${denied}: ${exec.argv.join(" ")}`);
      }
    }

    const { command: bundleCommand } = await import("../../src/bundle/index.js");
    const { evidenceBuildCommand } = await import("../../src/evidence/build.js");
    const { marketplacePublishCommand } = await import("../../src/marketplace/publish.js");
    await seedMarketplaceArtifact();
    const signingScenarios: Array<[string, CommandSpec, Record<string, unknown>]> = [
      ["bundle cosign", bundleCommand, { sign: "cosign" }],
      ["bundle gh", bundleCommand, { sign: "gh" }],
      ["evidence cosign", evidenceBuildCommand, { sign: "cosign" }],
      ["evidence gh", evidenceBuildCommand, { sign: "gh" }],
      ["marketplace cosign", marketplacePublishCommand, { signer: "cosign" }],
      ["marketplace gh", marketplacePublishCommand, { signer: "gh" }],
    ];
    for (const [label, spec, options] of signingScenarios) {
      for (const exec of await collectExecs(spec, options)) {
        const denied = deniedRemoteMutation(exec.argv);
        if (denied !== undefined) violations.push(`${label}: ${denied}: ${exec.argv.join(" ")}`);
      }
    }

    expect(
      violations,
      `remote-mutating exec argv found; update the command to doc/probe/local-only, or document a deliberate signing carve-out:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
