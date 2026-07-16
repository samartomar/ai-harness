import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  ECC_CANONICAL_REPOSITORY,
  qualifyEccInert,
} from "../../src/methodology/adapters/ecc-qualification.js";
import {
  createHostLoadSurfaceContract,
  hostLoadSurfaces,
} from "../../src/methodology/contracts/host.js";

let root: string;
const resolvedCommit = "a".repeat(40);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-methodology-ecc-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "ecc-universal",
      engines: { node: ">=18" },
      packageManager: "yarn@4.9.2",
      bin: { ecc: "scripts/ecc.js", "ecc-install": "scripts/install-apply.js" },
      scripts: { test: "node tests/run-all.js" },
    }),
    "utf8",
  );
  for (const path of [
    ".agents",
    ".codex",
    "agents",
    "commands",
    "hooks",
    "mcp-configs",
    "rules",
    "skills",
    "scripts",
  ]) {
    mkdirSync(join(root, path));
  }
  for (const path of [
    "install.ps1",
    "install.sh",
    "scripts/ecc.js",
    "scripts/install-apply.js",
    "scripts/install-plan.js",
    "scripts/uninstall.js",
    "scripts/repair.js",
    "scripts/auto-update.js",
  ]) {
    writeFileSync(join(root, path), "throw new Error('must not run');", "utf8");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function hostContract() {
  return createHostLoadSurfaceContract({
    id: "codex-0.144.1-windows-x64-v1",
    host: { id: "codex", version: "0.144.1", build: "cbacbb97" },
    surfaces: hostLoadSurfaces.map((surface) => ({
      surface,
      coverage:
        surface === "cache-and-session-persistence" ? ("partial" as const) : ("complete" as const),
      evidence: ["fixture"],
      positiveProbe: "designed",
      negativeProbe: "designed",
    })),
  });
}

function qualificationInput() {
  return {
    source: { repository: "samartomar/ECC", root, resolvedCommit },
    runner: fakeRunner((argv) => {
      expect(argv).toEqual(["git", "-C", root, "rev-parse", "--verify", "HEAD"]);
      return { stdout: `${resolvedCommit}\n` };
    }),
    host: hostContract(),
    environment: {
      operatingSystem: { family: "windows" as const, version: "10.0.26200", architecture: "x64" },
      isolationMode: "profile-home",
      runtimes: { node: "24.13.1", npm: "11.8.0" },
      policyVersion: "enterprise-core-v1",
    },
  };
}

describe("ECC inert qualification", () => {
  it("qualifies an exact local checkout as data and blocks an unsupported fork tuple", async () => {
    const result = await qualifyEccInert(qualificationInput());

    expect(result.providerCodeExecuted).toBe(false);
    expect(result.source).toMatchObject({ repository: "samartomar/ECC", resolvedCommit });
    expect(result.canonicalRepository).toBe(ECC_CANONICAL_REPOSITORY);
    expect(result.canonicalSourceMatch).toBe(false);
    expect(result.discovery.providerCodeExecuted).toBe(false);
    expect(result.topology).toMatchObject({
      providerKind: "hybrid-catalog-runtime",
      methodologyClosure: [
        ".agents",
        ".codex",
        "agents",
        "commands",
        "hooks",
        "mcp-configs",
        "rules",
        "skills",
      ],
      installerEntrypoints: [
        "install.ps1",
        "install.sh",
        "scripts/install-apply.js",
        "scripts/install-plan.js",
        "scripts/uninstall.js",
      ],
      updateEntrypoint: "scripts/auto-update.js",
      repairEntrypoint: "scripts/repair.js",
      declaredRuntimeRequirements: { node: ">=18", packageManager: "yarn@4.9.2" },
      proposedDestinations: [
        { isolationMode: "project-native", destination: "unknown" },
        { isolationMode: "profile-home", destination: "unknown" },
        { isolationMode: "machine-exclusive", destination: "unknown" },
      ],
    });
    expect(result.topology.binEntrypoints).toEqual({
      ecc: "scripts/ecc.js",
      "ecc-install": "scripts/install-apply.js",
    });
    expect(result.plan.providerCodeExecuted).toBe(false);
    expect(result.compatibility.status).toBe("unknown");
    expect(result.qualification).toMatchObject({
      classification: "QUALIFICATION_BLOCKED",
      supportLevel: "plannable",
      findings: ["ADAPTER_COMPATIBILITY_UNKNOWN", "PROVIDER_REPOSITORY_NONCANONICAL"],
      providerCodeExecuted: false,
    });
    expect(result.exactEvidence).toBeUndefined();
  });

  it("joins evidence only for the exact source and complete methodology closure", async () => {
    const first = await qualifyEccInert(qualificationInput());
    const exactEvidence = {
      repository: first.source.repository,
      resolvedCommit: first.source.resolvedCommit,
      treeSha256: first.source.treeSha256,
      paths: first.topology.methodologyClosure,
      verdict: "held" as const,
    };
    const withEvidence = await qualifyEccInert({
      ...qualificationInput(),
      evidence: [exactEvidence],
    });

    expect(withEvidence.exactEvidence).toEqual(exactEvidence);
  });

  it("keeps a canonical source blocked when isolation and updater state remain unproven", async () => {
    const first = await qualifyEccInert(qualificationInput());
    const result = await qualifyEccInert({
      ...qualificationInput(),
      source: { repository: ECC_CANONICAL_REPOSITORY, root, resolvedCommit },
      supportedCompatibility: [
        {
          ...first.compatibilityKey,
          provider: { ...first.compatibilityKey.provider, repository: ECC_CANONICAL_REPOSITORY },
        },
      ],
    });

    expect(result.canonicalSourceMatch).toBe(true);
    expect(result.compatibility.status).toBe("supported");
    expect(result.qualification).toMatchObject({
      classification: "QUALIFICATION_BLOCKED",
      findings: ["QUALIFICATION_INCOMPLETE"],
    });
    expect(result.qualification.findings).not.toContain("PROVIDER_REPOSITORY_NONCANONICAL");
  });

  it("treats omitted installer metadata and absent update files as inert unknowns", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ecc-universal" }), "utf8");
    unlinkSync(join(root, "scripts", "auto-update.js"));
    unlinkSync(join(root, "scripts", "repair.js"));
    unlinkSync(join(root, "scripts", "uninstall.js"));

    const result = await qualifyEccInert(qualificationInput());

    expect(result.topology).toMatchObject({
      installerEntrypoints: [
        "install.ps1",
        "install.sh",
        "scripts/install-apply.js",
        "scripts/install-plan.js",
      ],
      updateEntrypoint: undefined,
      repairEntrypoint: undefined,
      binEntrypoints: {},
      declaredRuntimeRequirements: { node: undefined, packageManager: undefined },
    });
  });

  it("fails closed when the selected checkout does not expose the ECC manifest identity", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "not-ecc" }), "utf8");

    await expect(qualifyEccInert(qualificationInput())).rejects.toMatchObject({
      code: "QUALIFICATION_INCOMPLETE",
    });
  });
});
