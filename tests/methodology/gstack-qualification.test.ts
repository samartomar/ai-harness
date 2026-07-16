import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  GSTACK_CANONICAL_REPOSITORY,
  qualifyGstackInert,
} from "../../src/methodology/adapters/gstack-qualification.js";
import {
  createHostLoadSurfaceContract,
  hostLoadSurfaces,
} from "../../src/methodology/contracts/host.js";

let root: string;
const resolvedCommit = "a".repeat(40);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-methodology-gstack-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "gstack",
      engines: { bun: ">=1.0.0" },
      bin: { browse: "browse/dist/browse", "make-pdf": "make-pdf/dist/pdf" },
      scripts: { test: "bun test" },
    }),
    "utf8",
  );
  for (const path of [
    "agents",
    "browse",
    "claude",
    "codex",
    "design/src",
    "gstack",
    "hosts",
    "bin",
    "open-gstack-browser",
    "scripts",
  ]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  for (const path of [
    "bin/gstack-team-init",
    "bin/gstack-gbrain-install",
    "scripts/setup-scc.sh",
    "bin/gstack-uninstall",
    "bin/gstack-brain-uninstall",
    "bin/gstack-update-check",
    "bin/gstack-ios-qa-daemon",
    "design/src/daemon.ts",
    "hosts/codex.ts",
    "bin/gstack-codex-probe",
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
    source: { repository: "samartomar/gstack", root, resolvedCommit },
    runner: fakeRunner((argv) => {
      expect(argv).toEqual(["git", "-C", root, "rev-parse", "--verify", "HEAD"]);
      return { stdout: `${resolvedCommit}\n` };
    }),
    host: hostContract(),
    environment: {
      operatingSystem: { family: "windows" as const, version: "10.0.26200", architecture: "x64" },
      isolationMode: "profile-home",
      runtimes: { node: "24.13.1", npm: "11.8.0", bun: "1.3.9" },
      policyVersion: "enterprise-core-v1",
    },
  };
}

describe("gstack inert qualification", () => {
  it("qualifies an exact local checkout as data and blocks an unsupported fork tuple", async () => {
    const result = await qualifyGstackInert(qualificationInput());

    expect(result.providerCodeExecuted).toBe(false);
    expect(result.source).toMatchObject({ repository: "samartomar/gstack", resolvedCommit });
    expect(result.canonicalRepository).toBe(GSTACK_CANONICAL_REPOSITORY);
    expect(result.canonicalSourceMatch).toBe(false);
    expect(result.discovery.providerCodeExecuted).toBe(false);
    expect(result.topology).toMatchObject({
      providerKind: "hybrid-host-setup",
      methodologyClosure: ["agents", "claude", "codex", "gstack", "hosts"],
      setupEntrypoints: [
        "bin/gstack-team-init",
        "bin/gstack-gbrain-install",
        "scripts/setup-scc.sh",
      ],
      uninstallEntrypoints: ["bin/gstack-uninstall", "bin/gstack-brain-uninstall"],
      updateEntrypoint: "bin/gstack-update-check",
      browserPaths: ["browse", "open-gstack-browser"],
      daemonEntrypoints: ["bin/gstack-ios-qa-daemon", "design/src/daemon.ts"],
      codexPaths: ["codex", "hosts/codex.ts", "bin/gstack-codex-probe"],
      teamModeEntrypoints: ["bin/gstack-team-init"],
      declaredRuntimeRequirements: { bun: ">=1.0.0", node: undefined },
      proposedDestinations: [
        { isolationMode: "project-native", destination: "unknown" },
        { isolationMode: "profile-home", destination: "unknown" },
        { isolationMode: "machine-exclusive", destination: "unknown" },
      ],
    });
    expect(result.topology.binEntrypoints).toEqual({
      browse: "browse/dist/browse",
      "make-pdf": "make-pdf/dist/pdf",
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
    const first = await qualifyGstackInert(qualificationInput());
    const exactEvidence = {
      repository: first.source.repository,
      resolvedCommit: first.source.resolvedCommit,
      treeSha256: first.source.treeSha256,
      paths: first.topology.methodologyClosure,
      verdict: "held" as const,
    };
    const withEvidence = await qualifyGstackInert({
      ...qualificationInput(),
      evidence: [exactEvidence],
    });

    expect(withEvidence.exactEvidence).toEqual(exactEvidence);
  });

  it("keeps a canonical source blocked when isolation and updater state remain unproven", async () => {
    const first = await qualifyGstackInert(qualificationInput());
    const result = await qualifyGstackInert({
      ...qualificationInput(),
      source: { repository: GSTACK_CANONICAL_REPOSITORY, root, resolvedCommit },
      supportedCompatibility: [
        {
          ...first.compatibilityKey,
          provider: { ...first.compatibilityKey.provider, repository: GSTACK_CANONICAL_REPOSITORY },
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

  it("treats omitted runtime metadata and absent update files as inert unknowns", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gstack" }), "utf8");
    unlinkSync(join(root, "bin", "gstack-update-check"));
    unlinkSync(join(root, "bin", "gstack-brain-uninstall"));

    const result = await qualifyGstackInert(qualificationInput());

    expect(result.topology).toMatchObject({
      uninstallEntrypoints: ["bin/gstack-uninstall"],
      updateEntrypoint: undefined,
      binEntrypoints: {},
      declaredRuntimeRequirements: { bun: undefined, node: undefined },
    });
  });

  it("fails closed when the selected checkout does not expose the gstack manifest identity", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "not-gstack" }), "utf8");

    await expect(qualifyGstackInert(qualificationInput())).rejects.toMatchObject({
      code: "QUALIFICATION_INCOMPLETE",
    });
  });
});
