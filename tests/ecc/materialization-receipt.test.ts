import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import {
  assertOwnedRelativePath,
  ECC_MATERIALIZATION_RECEIPT_FORMAT,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  eccMaterializationReceiptPath,
  parseEccMaterializationReceipt,
  readEccMaterializationReceipt,
  serializeEccMaterializationReceipt,
} from "../../src/ecc/materialization-receipt.js";
import { emptyRegistrationLedger, mergeRegistrationLedger } from "../../src/ecc/registration.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-materialization-receipt-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function authorization(componentId = "skill:tdd-workflow"): BaselineAuthorization {
  return {
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

function provenance() {
  return {
    repository: "affaan-m/ECC",
    commit: "a".repeat(40),
    componentPath: "skills/tdd-workflow",
  };
}

function componentValue() {
  return {
    id: "skill:tdd-workflow",
    authorization: authorization(),
    provenance: provenance(),
    files: [
      {
        path: ".claude/skills/tdd-workflow/SKILL.md",
        operation: "copy-file",
        contentSha256: "d".repeat(64),
      },
    ],
  };
}

function receiptValue(overrides: Record<string, unknown> = {}) {
  return {
    format: ECC_MATERIALIZATION_RECEIPT_FORMAT,
    schemaVersion: 1,
    components: [componentValue()],
    ...overrides,
  };
}

function put(relative: string, contents: string): void {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

/**
 * Whether the shipped machine ledger admits this authorization tuple. The
 * ledger's own strict schema is private, so its exported merge — which parses
 * the merged result — is the oracle. Delegated ruling 1 requires the receipt to
 * pin the tuple exactly as the ledger does; a difference in either direction is
 * a contract drift this test fails on.
 */
function ledgerAccepts(value: unknown): boolean {
  try {
    mergeRegistrationLedger(
      emptyRegistrationLedger(),
      { root, scope: "scoped", components: [], mcps: [] },
      [
        {
          target: "codex",
          components: [{ id: "skill:tdd-workflow", authorization: value as BaselineAuthorization }],
          mcps: [],
        },
      ],
    );
    return true;
  } catch {
    return false;
  }
}

function receiptAccepts(value: unknown): boolean {
  try {
    parseEccMaterializationReceipt(
      JSON.stringify(
        receiptValue({
          components: [
            {
              id: "skill:tdd-workflow",
              authorization: value,
              provenance: provenance(),
              files: [
                {
                  path: ".claude/skills/tdd-workflow/SKILL.md",
                  operation: "copy-file",
                  contentSha256: "d".repeat(64),
                },
              ],
            },
          ],
        }),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

describe("F5 — the destination-scoped materialization receipt document", () => {
  it("round-trips through a canonical, deterministically ordered serialization", () => {
    const receipt = parseEccMaterializationReceipt(
      JSON.stringify(
        receiptValue({
          components: [
            {
              id: "skill:verification-loop",
              authorization: authorization("skill:verification-loop"),
              provenance: provenance(),
              files: [
                {
                  path: ".claude/skills/verification-loop/SKILL.md",
                  operation: "copy-file",
                  contentSha256: "e".repeat(64),
                },
                {
                  path: ".claude/settings.json",
                  operation: "merge-json",
                  contentSha256: "f".repeat(64),
                  ownedKeys: ["statusLine"],
                  createdByAih: true,
                },
              ],
            },
            {
              id: "skill:tdd-workflow",
              authorization: authorization(),
              provenance: provenance(),
              files: [
                {
                  path: ".claude/skills/tdd-workflow/SKILL.md",
                  operation: "copy-file",
                  contentSha256: "d".repeat(64),
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(receipt.components.map((component) => component.id)).toEqual([
      "skill:tdd-workflow",
      "skill:verification-loop",
    ]);
    expect(receipt.components[1]?.files.map((file) => file.path)).toEqual([
      ".claude/settings.json",
      ".claude/skills/verification-loop/SKILL.md",
    ]);

    const text = serializeEccMaterializationReceipt(receipt);
    expect(text.endsWith("\n")).toBe(true);
    expect(serializeEccMaterializationReceipt(parseEccMaterializationReceipt(text))).toBe(text);
  });

  it("refuses a malformed, foreign, or unknown-version receipt instead of guessing", () => {
    expect(() => parseEccMaterializationReceipt("not json")).toThrow(/materialization receipt/i);
    expect(() =>
      parseEccMaterializationReceipt(JSON.stringify(receiptValue({ format: "some-other-tool" }))),
    ).toThrow(/materialization receipt/i);
    expect(() =>
      parseEccMaterializationReceipt(JSON.stringify(receiptValue({ schemaVersion: 2 }))),
    ).toThrow(/materialization receipt/i);
    expect(() =>
      parseEccMaterializationReceipt(JSON.stringify(receiptValue({ surprise: true }))),
    ).toThrow(/materialization receipt/i);
  });

  it("refuses contradictory ownership entries", () => {
    expect(() =>
      parseEccMaterializationReceipt(
        JSON.stringify(receiptValue({ components: [componentValue(), componentValue()] })),
      ),
    ).toThrow(/duplicate component/i);

    expect(() =>
      parseEccMaterializationReceipt(
        JSON.stringify(
          receiptValue({
            components: [
              {
                id: "skill:tdd-workflow",
                authorization: authorization(),
                provenance: provenance(),
                files: [
                  {
                    path: ".claude/skills/tdd-workflow/SKILL.md",
                    operation: "copy-file",
                    contentSha256: "d".repeat(64),
                  },
                  {
                    path: ".claude/skills/tdd-workflow/SKILL.md",
                    operation: "copy-file",
                    contentSha256: "e".repeat(64),
                  },
                ],
              },
            ],
          }),
        ),
      ),
    ).toThrow(/duplicate owned file/i);
  });

  it("keeps the copy-file and merge-json ownership partitions apart", () => {
    expect(() =>
      parseEccMaterializationReceipt(
        JSON.stringify(
          receiptValue({
            components: [
              {
                id: "skill:tdd-workflow",
                authorization: authorization(),
                provenance: provenance(),
                files: [
                  {
                    path: ".claude/settings.json",
                    operation: "merge-json",
                    contentSha256: "d".repeat(64),
                  },
                ],
              },
            ],
          }),
        ),
      ),
    ).toThrow(/materialization receipt/i);

    expect(() =>
      parseEccMaterializationReceipt(
        JSON.stringify(
          receiptValue({
            components: [
              {
                id: "skill:tdd-workflow",
                authorization: authorization(),
                provenance: provenance(),
                files: [
                  {
                    path: ".claude/skills/tdd-workflow/SKILL.md",
                    operation: "copy-file",
                    contentSha256: "d".repeat(64),
                    ownedKeys: ["hooks"],
                    createdByAih: true,
                  },
                ],
              },
            ],
          }),
        ),
      ),
    ).toThrow(/materialization receipt/i);

    expect(() =>
      parseEccMaterializationReceipt(
        JSON.stringify(
          receiptValue({
            components: [
              {
                id: "skill:tdd-workflow",
                authorization: authorization(),
                provenance: provenance(),
                files: [
                  {
                    path: ".claude/settings.json",
                    operation: "merge-json",
                    contentSha256: "d".repeat(64),
                    ownedKeys: ["__proto__"],
                    createdByAih: true,
                  },
                ],
              },
            ],
          }),
        ),
      ),
    ).toThrow(/materialization receipt/i);
  });

  it("pins the evidence authorization tuple exactly as the machine ledger does", () => {
    const mutations: Array<[string, unknown]> = [
      ["valid tuple", authorization()],
      ["unknown field", { ...authorization(), extra: "no" }],
      ["short pinned sha", { ...authorization(), pinnedSha: "a".repeat(39) }],
      ["short tree digest", { ...authorization(), treeSha256: "b".repeat(63) }],
      ["unknown tier", { ...authorization(), tier: "community" }],
      ["empty issuer", { ...authorization(), issuer: "" }],
      ["missing evidence digest", { ...authorization(), evidenceSha256: undefined }],
      ["unknown effective verdict", { ...authorization(), effective: "blocked" }],
      [
        "accepted with conditions",
        {
          ...authorization(),
          effective: "accepted-with-conditions",
          acceptance: {
            decisionId: "decision-1",
            recordSha256: "d".repeat(64),
            acceptedFindingCodes: ["ECC-1"],
          },
        },
      ],
      [
        "acceptance with an unknown field",
        {
          ...authorization(),
          effective: "accepted-with-conditions",
          acceptance: {
            decisionId: "decision-1",
            recordSha256: "d".repeat(64),
            acceptedFindingCodes: ["ECC-1"],
            extra: true,
          },
        },
      ],
      ["not an object", "authorized"],
    ];

    for (const [label, value] of mutations) {
      expect([label, receiptAccepts(value)]).toEqual([label, ledgerAccepts(value)]);
    }
  });

  it("refuses to own a path that escapes the destination root or claims AIH state", () => {
    expect(assertOwnedRelativePath(".claude/skills/tdd-workflow/SKILL.md")).toBe(
      ".claude/skills/tdd-workflow/SKILL.md",
    );
    expect(assertOwnedRelativePath(".claude\\skills\\tdd-workflow\\SKILL.md")).toBe(
      ".claude/skills/tdd-workflow/SKILL.md",
    );

    for (const unsafe of [
      "",
      "..",
      "../escape.md",
      ".claude/../../escape.md",
      "./relative.md",
      "/absolute.md",
      "//server/share.md",
      "C:/absolute.md",
      "trailing/",
      `nul\u0000byte.md`,
      ECC_MATERIALIZATION_RECEIPT_PATH,
      ".aih/ecc/registration-ledger.json",
    ]) {
      expect(() => assertOwnedRelativePath(unsafe), unsafe).toThrow();
    }
  });

  it("reads a valid receipt, an absent one, and a malformed one as distinct states", () => {
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });

    const receipt = parseEccMaterializationReceipt(JSON.stringify(receiptValue()));
    const text = serializeEccMaterializationReceipt(receipt);
    put(ECC_MATERIALIZATION_RECEIPT_PATH, text);
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "valid", receipt, raw: text });

    put(ECC_MATERIALIZATION_RECEIPT_PATH, "{ not json");
    const malformed = readEccMaterializationReceipt(root);
    expect(malformed.state).toBe("malformed");
    if (malformed.state !== "malformed") throw new Error("expected a malformed receipt state");
    expect(malformed.detail).toMatch(/materialization receipt/i);
  });

  it("scopes the receipt to the written root's own AIH area", () => {
    expect(eccMaterializationReceiptPath(root)).toBe(
      join(root, ...ECC_MATERIALIZATION_RECEIPT_PATH.split("/")),
    );
    expect(() => eccMaterializationReceiptPath("relative/root")).toThrow(/absolute/i);
  });
});
