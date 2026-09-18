/**
 * The new shell's scan screen (NEW-SHELL-PLAN.md admin-scan): preserved
 * authority receipts and evidence, the imported decision, the finding model.
 * The receipt assertions are those of generate.test.ts "keeps curation and
 * preserved evidence detail…" (whose curation half waits for the acme screen).
 */
import { afterEach, describe, expect, it } from "vitest";
import { tinyStudioModel } from "../studio-test-fixture.js";
import { closeStudios, importFile, preview, sha, studio } from "./shell-parity-harness.js";

afterEach(closeStudios);

function newShell() {
  return studio(tinyStudioModel()).window;
}

const evidence = {
  id: "audit-evidence-2026-08",
  candidate: "custom-mcp",
  kind: "mcp",
  sourceDigest: sha("b"),
  identityDigest: sha("c"),
  state: "failed",
  waivable: true,
  detectors: [{ id: "semgrep", required: true, status: "pass", reportDigest: sha("e") }],
  findings: ["prompt-injection"],
  futureInspectorField: "<img src=x onerror=alert(1)>",
};
const approval = { id: "approval-2026-08", issuer: "security-team", candidate: "custom-mcp" };

describe("new shell scan screen", () => {
  it("mounts in the scan screen with nothing imported", () => {
    const document = newShell().document;
    const screen = document.querySelector('[data-wb-screen-panel="scan"] [data-wb-scan]');
    expect(screen?.querySelector("#approval-rows")).not.toBeNull();
    expect(document.querySelector('[data-wb-pending-screen="scan"]')).toBeNull();
    expect(document.getElementById("receipt-state")?.textContent).toBe(
      "No authority receipt imported.",
    );
    expect(document.getElementById("decision-state")?.textContent).toBe(
      "No standalone decision imported.",
    );
    expect(
      (document.getElementById("copy-approvals") as unknown as { disabled: boolean }).disabled,
    ).toBe(true);
  });

  it("preserves imported receipt subjects as inert, escaped preflight rows", async () => {
    const window = newShell();
    const document = window.document;
    const before = preview(window);
    const message = await importFile(
      window,
      "evidence-file",
      JSON.stringify({ approvals: [approval], evidence: [evidence] }),
    );
    expect(message).toContain("preflight only");
    const receiptText = document.getElementById("approval-rows")?.textContent;
    for (const label of [
      "approval-2026-08",
      "security-team — preserved/preflight-only",
      "audit-evidence-2026-08",
      "failed evidence — preserved/preflight-only",
      "Not verified / not effective",
      '"candidate": "custom-mcp"',
      '"waivable": true',
      '"futureInspectorField"',
      "preserved/preflight-only; not verified or effective",
    ])
      expect(receiptText).toContain(label);
    expect(document.querySelector("#approval-rows img")).toBeNull();
    expect(document.getElementById("approval-rows")?.innerHTML).toContain("&lt;img");
    expect(document.querySelectorAll("#approval-rows .receipt-details[open]")).toHaveLength(0);
    expect(document.getElementById("receipt-state")?.textContent).toBe(
      "Receipt preserved for preflight only; this browser does not verify it or create effective approval.",
    );
    expect(
      (document.getElementById("copy-approvals") as unknown as { disabled: boolean }).disabled,
    ).toBe(true);
    expect(preview(window)).toBe(before);
  });

  it("opens the evidence and decision file inputs from the scan screen", () => {
    const window = newShell();
    const document = window.document;
    const opened: string[] = [];
    for (const id of ["evidence-file", "decision-file"])
      document.getElementById(id)?.addEventListener("click", (event) => {
        event.preventDefault();
        opened.push(id);
      });
    for (const kind of ["evidence", "decision"])
      document
        .querySelector(`[data-wb-scan-import="${kind}"]`)
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(opened).toEqual(["evidence-file", "decision-file"]);
  });
});
