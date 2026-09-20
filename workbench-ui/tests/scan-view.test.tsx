import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import {
  alertText,
  createTestHost,
  fixtureModel,
  golden,
  jsonFile,
  statusText,
} from "./test-host.js";

/**
 * Editors 5, 6 and 10: the evidence receipt import, the governance decision
 * import / inspect / download, and the Scan view that shows them. The intent
 * is ported from `tests/org-policy/workbench/new-shell-scan.test.ts` and the
 * receipt/decision parts of `new-shell-download-compat.test.ts`.
 */

const EVIDENCE_PRESERVED =
  "Authority/audit data preserved for preflight only; it is not verified and does not create effective approval.";
const EVIDENCE_FAILED = "Evidence import failed: valid JSON object required.";
const DECISION_IMPORTED = "Decision imported for inspection only: unverified and not effective.";
const DECISION_DOWNLOADED =
  "Canonical decision download started; it remains unverified and not effective.";
const NO_RECEIPT = "No authority receipt imported.";
const NO_DECISION = "No standalone decision imported.";
const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">';

const sha = (letter: string) => `sha256:${letter.repeat(64)}`;

function decisionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "aih-governance-decision",
    version: 1,
    id: "decision-workbench",
    disposition: "accepted-with-conditions",
    candidate: "code-review-graph",
    kind: "mcp",
    targets: ["claude"],
    effects: ["managed-settings"],
    policyVersion: "2026.08",
    sourceDigest: sha("a"),
    evidenceDigest: sha("b"),
    reviewedControlDigest: sha("c"),
    issuer: "platform-security",
    actor: "security-admin",
    reason: "Decision reason",
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-10T00:00:00+00:00",
    reviewBy: "2026-08-05T00:00:00+00:00",
    acceptedFindings: ["prompt-injection"],
    acceptedGaps: [],
    conditions: ["Review before expiry"],
    ...overrides,
  };
}

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

async function openScan(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Scan Review" }));
  return screen.getByRole("dialog", { name: "Scan review" });
}

async function importEvidence(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.upload(screen.getByLabelText("Import evidence"), jsonFile("evidence.json", text));
}

async function importDecision(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.upload(
    screen.getByLabelText("Import decision (inspection only)"),
    jsonFile("decision.json", text),
  );
}

describe("scan view", () => {
  it("shows the catalog's report totals and the two finding groups", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const scan = await openScan(user);
    const glance = within(scan).getByRole("region", { name: "The scan at a glance" });
    // Each figure is named by a pill, never by colour alone.
    for (const pill of ["Passed", "Review", "Not scanned"])
      expect(within(glance).getByText(pill)).toBeDefined();
    expect(glance.textContent).toMatch(/Scan Review — \d+ need review/u);
    expect(glance.textContent).toMatch(/\d+ catalog items/u);

    const groups = within(scan).getByRole("region", {
      name: "Needs review, grouped by what it means",
    });
    expect(groups.textContent).toMatch(/Findings an administrator decides — \d+ kinds/u);
    expect(groups.textContent).toMatch(/Nobody can decide these — \d+ hard blockers/u);
  });

  it("starts with no receipt, no decision, and no decision download", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const scan = await openScan(user);
    expect(within(scan).getByText(NO_RECEIPT)).toBeDefined();
    expect(within(scan).getByText(NO_DECISION)).toBeDefined();
    expect(
      (within(scan).getByRole("button", { name: "Download decision" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("preserves an imported receipt for preflight only and lists its subjects", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const scan = await openScan(user);
    await importEvidence(
      user,
      JSON.stringify({
        approvals: [{ id: "approval-1", issuer: "platform-security" }],
        evidence: [{ id: "evidence-1", state: "current" }],
      }),
    );

    expect(statusText()).toContain(EVIDENCE_PRESERVED);
    const receipt = within(scan).getByRole("region", { name: "Approval / evidence" });
    expect(within(receipt).getByText("approval-1")).toBeDefined();
    expect(receipt.textContent).toContain("platform-security — preserved/preflight-only");
    expect(within(receipt).getByText("evidence-1")).toBeDefined();
    expect(receipt.textContent).toContain("current evidence — preserved/preflight-only");
    // Every row says what it is worth, in words.
    expect(within(receipt).getAllByText("Not verified / not effective")).toHaveLength(2);
    expect(within(receipt).getAllByText("Awaiting")).toHaveLength(2);
  });

  it("refuses evidence that is not a JSON object", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const scan = await openScan(user);
    await importEvidence(user, "[]");
    expect(alertText()).toContain(EVIDENCE_FAILED);
    expect(within(scan).getByText(NO_RECEIPT)).toBeDefined();
  });

  it("imports a decision for inspection only and downloads it byte-for-byte", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    render(<App host={host} model={fixtureModel()} />);

    const scan = await openScan(user);
    await importDecision(user, JSON.stringify(decisionFixture()));

    expect(statusText()).toContain(DECISION_IMPORTED);
    const card = within(scan).getByRole("region", { name: "Imported governance decision" });
    expect(card.textContent).toContain("id: decision-workbench");
    expect(card.textContent).toContain("disposition: accepted-with-conditions");

    await user.click(within(scan).getByRole("button", { name: "Download decision" }));
    expect(host.save).toHaveBeenCalledTimes(1);
    expect(host.save.mock.calls[0]?.[0]).toEqual({
      name: "aih-governance-decision.json",
      text: golden("aih-governance-decision.json"),
    });
    expect(statusText()).toContain(DECISION_DOWNLOADED);
  });

  it("keeps the prior decision when a later import is rejected", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const scan = await openScan(user);
    await importDecision(user, JSON.stringify(decisionFixture()));
    await importDecision(user, JSON.stringify(decisionFixture({ id: "not-a-decision-id" })));

    expect(alertText()).toContain("Decision import rejected: ");
    const card = within(scan).getByRole("region", { name: "Imported governance decision" });
    expect(card.textContent).toContain("id: decision-workbench");
    expect(
      (within(scan).getByRole("button", { name: "Download decision" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("writes hostile receipt and decision text as text, never as markup", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const scan = await openScan(user);
    await importEvidence(user, JSON.stringify({ approvals: [{ id: HOSTILE, issuer: HOSTILE }] }));
    // A rejected decision is still shown back to the person, as its message.
    await importDecision(user, JSON.stringify(decisionFixture({ reason: HOSTILE, id: HOSTILE })));

    const receipt = within(scan).getByRole("region", { name: "Approval / evidence" });
    expect(within(receipt).getAllByText(HOSTILE).length).toBeGreaterThan(0);
    expect(scan.querySelectorAll("img")).toHaveLength(0);
    expect(within(scan).queryAllByRole("img")).toEqual([]);
    expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});
