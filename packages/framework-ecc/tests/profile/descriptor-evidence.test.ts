import "../core-invocation.js";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanContext } from "../../../../src/internals/plan.js";
import { fakeRunner } from "../../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../../src/platform/detect.js";
import { UPSTREAM } from "../../src/identity.js";
import { currentEccInvocation, withEccInvocation } from "../../src/invocation.js";
import {
  executeEccProfileLifecycleCommand,
  materializeEccProfileEvidence,
} from "../../src/profile/command.js";
import {
  ECC_PROFILE_EVIDENCE_FORMAT,
  EccProfileEvidenceRefusalError,
  readEccProfileEvidenceV1,
} from "../../src/profile/descriptor-evidence.js";
import { descriptorFromDocument, fixtureDescriptorDocument } from "../context.js";
import { TRUSTED_PROJECTED_SOURCE } from "./pinned-profile-fixture.js";
import { evidence, fixtureDirectory, profile, receipt } from "./render-fixture.js";

const FIXTURE_COMMIT = "0c1d7be9a750627fb2a6534c78a998cc46d03f9c";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The test evidence (ECC 0c1d7be9) in the descriptor section shape Catalog must carry. */
function fixtureSection(): Record<string, unknown> {
  const receiptText = readFileSync(join(fixtureDirectory, "review-receipt.json"), "utf8");
  const closureText = readFileSync(join(fixtureDirectory, "projected-source-closure.json"), "utf8");
  return {
    format: ECC_PROFILE_EVIDENCE_FORMAT,
    version: 1,
    repository: "affaan-m/ECC",
    sourceCommit: FIXTURE_COMMIT,
    profile: structuredClone(profile),
    pinnedSourceEvidence: structuredClone(evidence),
    projectedSource: {
      id: TRUSTED_PROJECTED_SOURCE.id,
      evidencePath: TRUSTED_PROJECTED_SOURCE.evidencePath,
      evidenceSha256: sha256(closureText),
      fileCount: TRUSTED_PROJECTED_SOURCE.fileCount,
      totalBytes: TRUSTED_PROJECTED_SOURCE.totalBytes,
      aggregateSha256: TRUSTED_PROJECTED_SOURCE.aggregateSha256,
    },
    documents: [
      { path: receipt.evidencePath, sha256: sha256(receiptText), text: receiptText },
      {
        path: TRUSTED_PROJECTED_SOURCE.evidencePath,
        sha256: sha256(closureText),
        text: closureText,
      },
    ],
  };
}

function context(operation: string): { ctx: PlanContext; calls: () => number } {
  let calls = 0;
  const run = fakeRunner(() => {
    calls += 1;
    return { code: 0, stdout: "" };
  });
  return {
    ctx: {
      root: "/repo",
      contextDir: "ai-coding",
      posture: "enterprise",
      apply: false,
      verify: false,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: { lifecycle: operation },
    },
    calls: () => calls,
  };
}

function refusalOf(action: () => unknown): EccProfileEvidenceRefusalError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(EccProfileEvidenceRefusalError);
    return error as EccProfileEvidenceRefusalError;
  }
  throw new Error("expected a refusal");
}

describe("ECC profile evidence from the Catalog descriptor", () => {
  it("refuses with a label and next route while the descriptor carries no profileEvidence", () => {
    const refusal = refusalOf(() => readEccProfileEvidenceV1(undefined));
    expect(refusal.reason).toBe("framework-profile-evidence-unavailable");
    expect(refusal.code).toBe("AIH_FRAMEWORK_PLUGIN");
    expect(refusal.label).toMatch(/carries no sections\.profileEvidence/);
    expect(refusal.nextRoute).toContain(`affaan-m/ECC@${UPSTREAM.commit}`);
    expect(refusal.message).toMatch(/^framework-profile-evidence-unavailable: .+\. Next: install/);
  });

  it("requires the evidence commit to equal the plugin's one upstream commit", () => {
    const refusal = refusalOf(() => readEccProfileEvidenceV1(fixtureSection()));
    expect(refusal.reason).toBe("framework-profile-evidence-incompatible");
    expect(refusal.message).toContain(`affaan-m/ECC@${FIXTURE_COMMIT}`);
    expect(refusal.message).toContain(`affaan-m/ECC@${UPSTREAM.commit}`);
  });

  it("accepts digest-bound documents whose every commit agrees", () => {
    const verified = readEccProfileEvidenceV1(fixtureSection(), FIXTURE_COMMIT);
    expect(verified.sourceCommit).toBe(FIXTURE_COMMIT);
    expect(verified.trust).toMatchObject({
      sourceCommit: FIXTURE_COMMIT,
      aggregateSha256: TRUSTED_PROJECTED_SOURCE.aggregateSha256,
    });
    expect([...verified.documents.keys()].sort()).toEqual(
      [receipt.evidencePath, TRUSTED_PROJECTED_SOURCE.evidencePath].sort(),
    );
    const materialized = materializeEccProfileEvidence(verified);
    try {
      for (const [path, text] of verified.documents) {
        expect(readFileSync(join(materialized.evidenceRoot, ...path.split("/")), "utf8")).toBe(
          text,
        );
      }
    } finally {
      rmSync(materialized.evidenceRoot, { recursive: true, force: true });
    }
  });

  it("refuses tampered, extra, unknown or contradictory evidence", () => {
    const tampered = fixtureSection();
    const documents = tampered.documents as { text: string }[];
    documents[0] = { ...documents[0], text: `${documents[0]?.text} ` } as { text: string };
    expect(() => readEccProfileEvidenceV1(tampered, FIXTURE_COMMIT)).toThrow(
      /does not match its SHA-256/,
    );

    const extra = fixtureSection();
    (extra.documents as unknown[]).push({ path: "other.json", sha256: sha256("{}"), text: "{}" });
    expect(() => readEccProfileEvidenceV1(extra, FIXTURE_COMMIT)).toThrow(
      /framework-profile-evidence-incompatible/,
    );

    expect(() =>
      readEccProfileEvidenceV1({ ...fixtureSection(), extra: true }, FIXTURE_COMMIT),
    ).toThrow(/framework-profile-evidence-incompatible/);

    const other = "a".repeat(40);
    expect(() =>
      readEccProfileEvidenceV1({ ...fixtureSection(), sourceCommit: other }, other),
    ).toThrow(/framework-profile-evidence-incompatible/);
  });

  it("refuses an ordinary profile install before any acquisition when Catalog lacks the section", async () => {
    const { ctx, calls } = context("install");
    await expect(executeEccProfileLifecycleCommand(ctx)).rejects.toThrow(
      /framework-profile-evidence-unavailable/,
    );
    const update = context("update");
    await expect(executeEccProfileLifecycleCommand(update.ctx)).rejects.toThrow(
      /framework-profile-evidence-unavailable/,
    );
    expect(calls() + update.calls()).toBe(0);
  });

  it("refuses an ordinary profile install whose descriptor evidence names another commit", async () => {
    const document = fixtureDescriptorDocument() as { sections: Record<string, unknown> };
    document.sections.profileEvidence = fixtureSection();
    const { ctx, calls } = context("install");
    const runtime = currentEccInvocation().runtime;
    await expect(
      withEccInvocation({ descriptor: descriptorFromDocument(document), host: { runtime } }, () =>
        executeEccProfileLifecycleCommand(ctx),
      ),
    ).rejects.toThrow(
      new RegExp(`framework-profile-evidence-incompatible: .*affaan-m/ECC@${FIXTURE_COMMIT}`),
    );
    expect(calls()).toBe(0);
  });

  it("embeds no profile evidence in production code", () => {
    const profileSource = join(import.meta.dirname, "../../src/profile");
    expect(existsSync(join(profileSource, "data"))).toBe(false);
    for (const file of readdirSync(profileSource)) {
      const text = readFileSync(join(profileSource, file), "utf8");
      expect(text, file).not.toMatch(/from "[^"]+\.json"/);
      expect(text, file).not.toContain(
        "f610d0999ba4300be2ac3c08428da1249cdd53d7bf8d74722433fef0b013448e",
      );
    }
  });
});

describe("ECC profile evidence strictness", () => {
  type Mutable = Record<string, unknown>;
  const at = (value: unknown, key: string | number): Mutable =>
    (value as Record<string | number, unknown>)[key] as Mutable;

  const injections: ReadonlyArray<[string, (evidence: Mutable) => Mutable]> = [
    ["pinnedSourceEvidence.source.unexpected", (e) => at(e, "source")],
    ["pinnedSourceEvidence.reviewReceipt.unexpected", (e) => at(e, "reviewReceipt")],
    ["pinnedSourceEvidence.profilesManifest.unexpected", (e) => at(e, "profilesManifest")],
    [
      "pinnedSourceEvidence.profilesManifest.profiles.core.unexpected",
      (e) => at(at(at(e, "profilesManifest"), "profiles"), "core"),
    ],
    ["pinnedSourceEvidence.componentsManifest.unexpected", (e) => at(e, "componentsManifest")],
    [
      "pinnedSourceEvidence.componentsManifest.components.0.unexpected",
      (e) => at(at(at(e, "componentsManifest"), "components"), 0),
    ],
    ["pinnedSourceEvidence.modulesManifest.unexpected", (e) => at(e, "modulesManifest")],
    [
      "pinnedSourceEvidence.modulesManifest.modules.0.unexpected",
      (e) => at(at(at(e, "modulesManifest"), "modules"), 0),
    ],
  ];

  it.each(injections)("refuses an unknown key at %s, naming its path", (path, target) => {
    const section = fixtureSection();
    target(section.pinnedSourceEvidence as Mutable).unexpected = true;
    const refusal = refusalOf(() => readEccProfileEvidenceV1(section, FIXTURE_COMMIT));
    expect(refusal.reason).toBe("framework-profile-evidence-incompatible");
    expect(refusal.label).toContain(`sections.profileEvidence.${path}`);
  });

  it("refuses an unknown key in the profile document, naming its path", () => {
    const section = fixtureSection();
    at(at(section.profile, "source"), "reviewReceipt").unexpected = true;
    const refusal = refusalOf(() => readEccProfileEvidenceV1(section, FIXTURE_COMMIT));
    expect(refusal.reason).toBe("framework-profile-evidence-incompatible");
    expect(refusal.label).toContain(
      "sections.profileEvidence.profile.source.reviewReceipt.unexpected",
    );
  });

  it("refuses a supported field of the wrong type, naming its path", () => {
    const section = fixtureSection();
    at(at(at(section.pinnedSourceEvidence, "componentsManifest"), "components"), 0).family = 7;
    const refusal = refusalOf(() => readEccProfileEvidenceV1(section, FIXTURE_COMMIT));
    expect(refusal.label).toContain(
      "sections.profileEvidence.pinnedSourceEvidence.componentsManifest.components.0.family",
    );
  });
});
