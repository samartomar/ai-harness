import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

/**
 * The template's own escaping, restated here so the test pins the bytes that
 * must reach the page rather than the mechanism that puts them there.
 */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function scriptCloseCount(html: string): number {
  return (html.match(/<\/script>/g) ?? []).length;
}

describe("policy workbench data embedding", () => {
  it("distinguishes preparation pins from evidence and Catalog actually included", () => {
    const model = tinyStudioModel();
    model.evidenceDelivery = {
      coreVersion: "0.5.0",
      workbenchCatalogDigest: `sha256:${"c".repeat(64)}`,
      vendorLockDigest: `sha256:${"d".repeat(64)}`,
      scannerLibraryVersion: "0.3.0",
      expectedScannerPublisher: {
        repository: "fixture/scan",
        workflow: "fixture/scan/.github/workflows/publish.yml",
        ref: "refs/heads/main",
        commit: "a".repeat(40),
      },
    };
    const html = policyStudioHtml(model);
    expect(html).toContain('id="evidence-delivery"');
    expect(html).toContain("Core 0.5.0");
    expect(html).toContain(
      `This Workbench catalog</strong></dt><dd style="overflow-wrap:anywhere">sha256:${"c".repeat(64)}`,
    );
    expect(html).toContain(
      `Bundled report lock</strong></dt><dd style="overflow-wrap:anywhere">sha256:${"d".repeat(64)}`,
    );
    expect(html).toContain("@aihq/scan 0.3.0");
    expect(html).toContain("Allowed Scanner publisher");
    expect(html).toContain("No verified Catalog head is included");
    expect(html).toContain("Not included in this build");
    expect(html).not.toContain("Included evidence publisher</strong>");
    model.evidenceDelivery.publicBaseline = {
      publisher: "fixture/core<script>",
      workflow: "fixture/core/.github/workflows/vendor.yml",
      artifactDigest: `sha256:${"b".repeat(64)}`,
      verifiedAt: "2026-09-06T00:00:00Z",
      validUntil: "2026-09-07T00:00:00Z",
    };
    const prepared = policyStudioHtml(model);
    expect(prepared).toContain("Verification during Core release preparation");
    expect(prepared).toContain("fixture/core&lt;script&gt;");
    expect(prepared).not.toContain("fixture/core<script>");
    delete model.evidenceDelivery.publicBaseline;
    model.evidenceDelivery.expectedCatalogPublisher = {
      repository: "fixture/catalog",
      workflow: "fixture/catalog/.github/workflows/publish.yml",
      catalogCommit: "b".repeat(40),
      version: 1,
    };
    model.evidenceDelivery.scanPublications = [
      {
        source: "fixture",
        publisher: "fixture/scan",
        commit: "a".repeat(40),
        digest: `sha256:${"e".repeat(64)}`,
      },
    ];
    model.evidenceDelivery.qualificationPublications = [
      {
        publisher: "fixture/catalog",
        commit: "b".repeat(40),
        catalogDigest: `sha256:${"f".repeat(64)}`,
        receiptSetDigest: `sha256:${"a".repeat(64)}`,
      },
    ];
    const direct = policyStudioHtml(model);
    expect(direct).toContain("expire after 90 days");
    expect(direct).toContain("Allowed Catalog publisher");
    expect(direct).toContain("fixture Scanner publication");
    expect(direct).toContain("Included Catalog qualification publication");
    expect(direct).not.toContain("No verified Catalog head is included");
    expect(direct).not.toContain("Not included in this build");
  });
  it("embeds a model carrying replacement-pattern characters verbatim", () => {
    const model = tinyStudioModel();
    const hooks = model.catalog.eccHookControls as unknown as {
      disabledHooks: { detail: string };
    };
    // `$'`, `$&`, `$\`` and `$$` are String.replace's replacement patterns. A
    // replacement STRING interprets them, so `$'` splices everything after the
    // match — the template's own trailing bytes, its </script> included — into
    // the middle of the inline script. Escaping angle brackets does not help:
    // the spliced bytes come from the template, not from the model.
    hooks.disabledHooks.detail = "replacement patterns $' and $& and $$ and $` here";
    const html = policyStudioHtml(model);
    expect(html).toContain(embeddedJson(model));
    // Nothing spliced a second copy of the template's tail into the page.
    expect(scriptCloseCount(html)).toBe(scriptCloseCount(policyStudioHtml(tinyStudioModel())));
  });

  it("validates explicit provenance and preparation inputs", () => {
    expect(() => policyStudioModel(undefined, { schemaVersion: 1 } as never)).toThrow(
      /baseline evidence provenance/,
    );
    expect(() =>
      policyStudioModel(undefined, undefined, {
        organizationManifestBytes: ["not an organization manifest"],
      }),
    ).toThrow();
    expect(() =>
      policyStudioModel(undefined, undefined, {
        freshOrganizationPreparations: [{} as never],
      }),
    ).toThrow();
  });
  it("embeds only bounded baseline evidence provenance fields", () => {
    const model = policyStudioModel(undefined, {
      ageSeconds: 12,
      attestationUrl: "https://leak.example.test/attestation",
      digest: "a".repeat(64),
      localPath: "C:\\secret\\baseline",
      rawAttestation: "signature bytes",
      resolvedAt: "2026-08-21T00:00:00Z",
      schemaVersion: 1,
      sourceIds: ["ecc", "superpowers"],
      tier: "last-downloaded",
    } as never);
    const html = policyStudioHtml(model);
    expect(model.baselineEvidenceProvenance).toEqual({
      ageSeconds: 12,
      digest: "a".repeat(64),
      resolvedAt: "2026-08-21T00:00:00Z",
      schemaVersion: 1,
      sourceIds: ["ecc", "superpowers"],
      tier: "last-downloaded",
    });
    expect(html).toContain("Baseline evidence");
    expect(html).not.toContain("leak.example.test");
    expect(html).not.toContain("C:\\secret\\baseline");
    expect(html).not.toContain("signature bytes");
    const defaultModel = policyStudioModel();
    expect(defaultModel.baselineEvidenceProvenance).toBeUndefined();
    expect(defaultModel.workbenchBundle).toEqual(model.workbenchBundle);
    expect(defaultModel.workbenchBundle).not.toBe(model.workbenchBundle);
    model.workbenchBundle.evidence = {};
    expect(policyStudioModel().workbenchBundle.evidence).toEqual(
      defaultModel.workbenchBundle.evidence,
    );
  });
});
