import { afterEach, describe, expect, it } from "vitest";
import { type PolicyStudioModel, policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "./studio-test-fixture.js";
import { closeStudios, studio } from "./workbench/shell-parity-harness.js";

afterEach(closeStudios);

/**
 * The template's own escaping, restated here so the test pins the bytes that
 * must reach the page rather than the mechanism that puts them there.
 */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/** The rendered "Evidence & versions" drawer: heading, dt → dd rows, text, element count. */
function evidenceDelivery(model: PolicyStudioModel) {
  const { window } = studio(model);
  const details = window.document.getElementById("evidence-delivery");
  if (details === null) throw new Error("expected the Evidence & versions drawer");
  const rows = new Map<string, string>();
  for (const term of details.querySelectorAll("dt"))
    rows.set(term.textContent ?? "", term.nextElementSibling?.textContent ?? "");
  const list = details.querySelector("dl");
  return {
    heading: details.querySelector("h3")?.textContent ?? "",
    rows,
    text: details.textContent ?? "",
    // Elements inside the dd values: model text never becomes markup.
    elements: list === null ? -1 : list.querySelectorAll("dd *").length,
  };
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
    // The new shell renders the rows from inert page JSON on the organization
    // screen; the assertions read the rendered drawer (id-contract.md, slice B).
    const html = policyStudioHtml(model);
    const delivery = evidenceDelivery(model);
    expect(delivery.heading).toContain("Core 0.5.0");
    expect(delivery.rows.get("This Workbench catalog")).toBe(`sha256:${"c".repeat(64)}`);
    expect(delivery.rows.get("Bundled report lock")).toBe(`sha256:${"d".repeat(64)}`);
    expect(delivery.text).toContain("@aihq/scan 0.3.0");
    expect(delivery.text).toContain("Allowed Scanner publisher");
    expect(delivery.text).toContain("No verified Catalog head is included");
    expect(delivery.text).toContain("Not included in this build");
    expect(delivery.rows.has("Included evidence publisher")).toBe(false);
    expect(html).toContain('id="wb-evidence-delivery"');
    model.evidenceDelivery.publicBaseline = {
      publisher: "fixture/core<script>",
      workflow: "fixture/core/.github/workflows/vendor.yml",
      artifactDigest: `sha256:${"b".repeat(64)}`,
      verifiedAt: "2026-09-06T00:00:00Z",
      validUntil: "2026-09-07T00:00:00Z",
    };
    const prepared = policyStudioHtml(model);
    const preparedDelivery = evidenceDelivery(model);
    expect(preparedDelivery.text).toContain("Verification during Core release preparation");
    expect(preparedDelivery.text).toContain("fixture/core<script>");
    expect(preparedDelivery.elements).toBe(0);
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
    const direct = evidenceDelivery(model).text;
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
    expect(html).toContain('<p class="help" id="baseline-evidence-provenance">Baseline evidence');
    const { window } = studio(model);
    expect(
      window.document
        .getElementById("baseline-evidence-provenance")
        ?.closest("[data-wb-provenance]"),
    ).not.toBeNull();
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
