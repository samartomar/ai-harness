import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

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
  it("embeds a model carrying replacement-pattern characters verbatim", () => {
    const model = structuredClone(policyStudioModel());
    const entry = model.catalog.hookRegistry.entries[0];
    if (entry === undefined) throw new Error("expected a hook registry entry");
    // `$'`, `$&`, `$\`` and `$$` are String.replace's replacement patterns. A
    // replacement STRING interprets them, so `$'` splices everything after the
    // match — the template's own trailing bytes, its </script> included — into
    // the middle of the inline script. Escaping angle brackets does not help:
    // the spliced bytes come from the template, not from the model.
    entry.description = "replacement patterns $' and $& and $$ and $` here";
    const html = policyStudioHtml(model);
    expect(html).toContain(embeddedJson(model));
    // Nothing spliced a second copy of the template's tail into the page.
    expect(scriptCloseCount(html)).toBe(scriptCloseCount(policyStudioHtml(policyStudioModel())));
  });

  it("mirrors the server fence against remote MCP projection to Kiro", () => {
    const html = policyStudioHtml(policyStudioModel());
    expect(html).toContain('candidate.source.type==="remote"');
    expect(html).toContain('candidate.targets.includes("kiro")');
    expect(html).toContain("Kiro MCP projection supports stdio catalog entries only");
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
  });
});
