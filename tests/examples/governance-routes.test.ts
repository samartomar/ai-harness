import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/index.js";

/**
 * The route examples are documentation that has to keep working, so they are run
 * here, each in its own node process, against the package's own build: inside this
 * repository `@aihq/core` resolves to it through the package's export map. They must
 * reach Core only by its package name, never through `dist/` or `src/`.
 */
const root = resolve(import.meta.dirname, "..", "..");
const built = existsSync(resolve(root, "dist", "index.js"));
const read = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/gu, "\n");
const EXAMPLES = ["examples/catalog-route.mjs", "examples/organization-route.mjs"];

const scratch: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "aih-route-example-"));
  scratch.push(path);
  return path;
}
afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

function run(script: string, args: readonly string[]) {
  const env = { ...process.env };
  delete env.AIH_ORG_POLICY;
  const result = spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The consumed result is the last JSON document the example prints. */
function consumed(stdout: string) {
  return JSON.parse(stdout.slice(stdout.indexOf("{\n"))) as {
    status: Record<string, string>;
    evidenceClaim?: string;
    subjectDigest?: string;
    diagnostics: Array<{ code: string }>;
  };
}

// A one-entry catalog index shaped like @aihq/catalog's, for the identity the
// governance-input tests already use. Provided data, not an authenticated fact.
const source = {
  type: "aih",
  release: "0.6.0",
  revision: `sha256:${"32ce6e9dea74ba84fe56b71ba6516e032f18aa4132e6ef7ebca507512d8735f7"}`,
};
const sourceDigest = governanceDecisionSourceDigestV2(source as never);
const subjectDigest = governanceDecisionSubjectDigestV2({
  kind: "agent",
  id: "governance-quality",
  sourceDigest,
});
function indexFile(overrides: Record<string, unknown> = {}): string {
  const path = join(directory(), "catalog-index.json");
  writeFileSync(
    path,
    JSON.stringify({
      format: "aih-catalog-index",
      version: 1,
      organizationAdmission: "not-authoritative",
      entries: [
        {
          entryId: "agent.aih.governance-quality.core-0-6-2",
          subject: { kind: "agent", id: "governance-quality", source, sourceDigest, subjectDigest },
          ...overrides,
        },
      ],
    }),
  );
  return path;
}

describe("governance route examples", () => {
  it("reach Core only through its package name and carry the fictional-organization caveat", () => {
    for (const script of EXAMPLES) {
      const source = read(script);
      expect(source, script).toMatch(/from "@aihq\/core";/u);
      expect(source, script).not.toMatch(/dist\/|\.\.\/src\/|from "\.\.?\//u);
      expect(source, script).toContain("FICTIONAL ORGANIZATION.");
      expect(source, script).toContain("never production approval");
      expect(source, script).toContain("never installs, applies or executes anything");
    }
  });

  it("are named by the README's Node-only section, with no browser claim", () => {
    const readme = read("README.md");
    const section = readme.slice(readme.indexOf("## Node-only interfaces"));
    expect(section).toContain("Every JavaScript entry of `@aihq/core` is Node-only.");
    expect(section).toContain("There is no browser build");
    expect(section).toContain("requires `@types/node`");
    for (const script of EXAMPLES)
      expect(section).toContain(`https://github.com/samartomar/ai-harness/blob/main/${script}`);
    const manifest = JSON.parse(read("package.json")) as Record<string, unknown>;
    for (const field of ["browser", "module", "unpkg", "jsdelivr"])
      expect(manifest[field], field).toBeUndefined();
  });

  it.runIf(built)("runs the catalog route across two processes and fails closed", () => {
    const out = directory();
    const result = run(EXAMPLES[0] as string, ["--out", out, "--index", indexFile()]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("catalog organizationAdmission: not-authoritative");
    expect(result.stdout).toContain("saved governance-input.json sha256:");
    expect(existsSync(join(out, ".aih/evidence/organization-evidence.json"))).toBe(true);
    const report = consumed(result.stdout);
    expect(report.subjectDigest).toBe(subjectDigest);
    expect(report.evidenceClaim).toBe("organization-assertion");
    expect(report.status).toMatchObject({
      structure: "valid",
      authority: "unverified",
      execution: "not-attempted",
      outcome: "refused",
      reason: "authority-unverified",
    });
  });

  it.runIf(built)("refuses a catalog entry whose provided digests do not recompute", () => {
    const out = directory();
    const tampered = indexFile({
      subject: {
        kind: "agent",
        id: "governance-quality",
        source,
        sourceDigest,
        subjectDigest: `sha256:${"9".repeat(64)}`,
      },
    });
    const result = run(EXAMPLES[0] as string, ["--out", out, "--index", tampered]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("does not recompute");
    expect(existsSync(join(out, "governance-input.json"))).toBe(false);
  });

  it.runIf(built)("runs the organization route and refuses evidence it cannot read", () => {
    const out = directory();
    const result = run(EXAMPLES[1] as string, ["--out", out]);
    expect(result.status).toBe(3);
    expect(consumed(result.stdout).status).toMatchObject({
      structure: "valid",
      authority: "unverified",
      outcome: "refused",
      reason: "authority-unverified",
    });

    // Operator-supplied evidence of another contract version refuses before anything is saved.
    const operator = directory();
    const evidence = join(operator, "evidence.json");
    const text = canonicalOrganizationEvidenceEnvelopeV1({
      format: "aih-organization-evidence",
      version: 1,
      subjectDigest,
      evidence: {
        kind: "operator-assertion",
        id: "example-org-review",
        summary: "Fictional example-org assertion; not evidence.",
        payloadDigest: `sha256:${"b".repeat(64)}`,
        artifactDigests: [`sha256:${"c".repeat(64)}`],
      },
      attestor: "example-org-review-board",
      issuedAt: "2026-01-01T00:00:00.000Z",
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-08T00:00:00.000Z",
    }).replace('"version":1', '"version":2');
    writeFileSync(evidence, text);
    const refused = run(EXAMPLES[1] as string, [
      "--out",
      join(operator, "out"),
      "--evidence",
      evidence,
    ]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('"reason": "unknown-contract-version"');
    expect(existsSync(join(operator, "out"))).toBe(false);
  });
});
