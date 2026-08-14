import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import {
  assertOwnedRelativePath,
  ECC_MATERIALIZATION_RECEIPT_FORMAT,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  eccMaterializationAuthorizationSchema,
  eccMaterializationReceiptPath,
  ownedFragmentSha256,
  parseEccMaterializationReceipt,
  readEccMaterializationReceipt,
  serializeEccMaterializationReceipt,
} from "../../src/ecc/materialization-receipt.js";
import {
  AuthorizationSchema,
  emptyRegistrationLedger,
  mergeRegistrationLedger,
} from "../../src/ecc/registration.js";

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

function runtimeAuthorization(
  overrides: Partial<BaselineAuthorization> = {},
): BaselineAuthorization {
  return {
    ...authorization("runtime:ecc-kiro"),
    treeSha256: "e".repeat(64),
    ...overrides,
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
 * Whether the shipped machine ledger admits this authorization tuple. Parity is
 * structural — the receipt imports the ledger's own exported schema rather than
 * restating it — and these cases are the regression net proving the reference
 * is live, including a field the ledger would reject.
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

  it("keeps legacy non-Kiro version-one receipts readable without content authorization", () => {
    const parsed = parseEccMaterializationReceipt(JSON.stringify(receiptValue()));

    expect(parsed.components[0]?.files[0]).not.toHaveProperty("contentAuthorization");
  });

  it("round-trips separate selected and exact Kiro runtime authorization", () => {
    const contentAuthorization = runtimeAuthorization();
    const receipt = parseEccMaterializationReceipt(
      JSON.stringify(
        receiptValue({
          components: [
            {
              ...componentValue(),
              files: [
                {
                  path: ".kiro/skills/tdd-workflow/SKILL.md",
                  operation: "copy-file",
                  contentSha256: "d".repeat(64),
                  contentAuthorization,
                  contentSourcePath: ".kiro/skills/tdd-workflow/SKILL.md",
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(receipt.components[0]).toMatchObject({
      id: "skill:tdd-workflow",
      authorization: expect.objectContaining({ treeSha256: "b".repeat(64) }),
      files: [
        {
          contentAuthorization: expect.objectContaining({ treeSha256: "e".repeat(64) }),
          contentSourcePath: ".kiro/skills/tdd-workflow/SKILL.md",
        },
      ],
    });
    expect(parseEccMaterializationReceipt(serializeEccMaterializationReceipt(receipt))).toEqual(
      receipt,
    );
  });

  it("accepts only the governed direct-copy custody shapes in durable receipts", () => {
    const contentAuthorization = runtimeAuthorization();
    const file = (path: string) => ({
      path,
      operation: "copy-file" as const,
      contentSha256: "d".repeat(64),
      contentAuthorization,
      contentSourcePath: path,
    });
    const receipt = parseEccMaterializationReceipt(
      JSON.stringify(
        receiptValue({
          components: [
            {
              id: "skill:tdd-workflow",
              authorization: authorization(),
              provenance: provenance(),
              files: [file(".kiro/skills/tdd-workflow/SKILL.md")],
            },
            {
              id: "agent:code-reviewer",
              authorization: authorization("agent:code-reviewer"),
              provenance: { ...provenance(), componentPath: "agents/code-reviewer.md" },
              files: [
                file(".kiro/agents/code-reviewer.json"),
                {
                  path: ".kiro/agents/code-reviewer.md",
                  operation: "copy-file" as const,
                  contentSha256: "d".repeat(64),
                  contentAuthorization: authorization("agent:code-reviewer"),
                  contentSourcePath: "agents/code-reviewer.md",
                },
              ],
            },
            {
              id: "baseline:rules",
              authorization: authorization("baseline:rules"),
              provenance: { ...provenance(), componentPath: "rules" },
              files: [file(".kiro/steering/00-canon.md")],
            },
          ],
        }),
      ),
    );

    expect(receipt.components.map((component) => component.id)).toEqual([
      "agent:code-reviewer",
      "baseline:rules",
      "skill:tdd-workflow",
    ]);
  });

  it("retains independent component-scoped acceptance decisions", () => {
    const selectedAuthorization: BaselineAuthorization = {
      ...authorization(),
      effective: "accepted-with-conditions",
      acceptance: {
        decisionId: "selected-decision",
        recordSha256: "1".repeat(64),
        acceptedFindingCodes: ["SELECTED-1"],
      },
    };
    const contentAuthorization = runtimeAuthorization({
      effective: "accepted-with-conditions",
      acceptance: {
        decisionId: "runtime-decision",
        recordSha256: "2".repeat(64),
        acceptedFindingCodes: ["RUNTIME-1"],
      },
    });
    const receipt = parseEccMaterializationReceipt(
      JSON.stringify(
        receiptValue({
          components: [
            {
              ...componentValue(),
              authorization: selectedAuthorization,
              files: [
                {
                  path: ".kiro/skills/tdd-workflow/SKILL.md",
                  operation: "copy-file",
                  contentSha256: "d".repeat(64),
                  contentAuthorization,
                  contentSourcePath: ".kiro/skills/tdd-workflow/SKILL.md",
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(receipt.components[0]?.authorization.acceptance?.decisionId).toBe("selected-decision");
    expect(receipt.components[0]?.files[0]?.contentAuthorization?.acceptance?.decisionId).toBe(
      "runtime-decision",
    );
  });

  it("rejects unsupported Kiro receipt operations and surfaces", () => {
    const candidates = [
      { path: ".kiro/settings/mcp.json", operation: "copy-file" },
      { path: ".kiro/hooks/on-save.json", operation: "copy-file" },
      { path: ".kiro/scripts/install.sh", operation: "copy-file" },
      { path: ".kiro/agents/reviewer.txt", operation: "copy-file" },
      { path: ".kiro/agents/nested/reviewer.md", operation: "copy-file" },
      {
        path: ".kiro/steering/product.json",
        operation: "merge-json",
        ownedKeys: ["product"],
        createdByAih: true,
      },
    ];

    for (const candidate of candidates) {
      expect(
        () =>
          parseEccMaterializationReceipt(
            JSON.stringify(
              receiptValue({
                components: [
                  {
                    ...componentValue(),
                    files: [
                      {
                        ...candidate,
                        contentSha256: "d".repeat(64),
                        contentAuthorization: runtimeAuthorization({
                          treeSha256: "b".repeat(64),
                        }),
                        contentSourcePath: candidate.path,
                      },
                    ],
                  },
                ],
              }),
            ),
          ),
        candidate.path,
      ).toThrow(/unsupported Kiro materialization/i);
    }
  });

  it("rejects Kiro receipt paths mislabeled under another selected component", () => {
    const cases = [
      ["skill:tdd-workflow", ".kiro/skills/other/SKILL.md"],
      ["agent:code-reviewer", ".kiro/agents/other.md"],
      ["command:review", ".kiro/steering/review.md"],
    ] as const;

    for (const [id, path] of cases) {
      expect(
        () =>
          parseEccMaterializationReceipt(
            JSON.stringify(
              receiptValue({
                components: [
                  {
                    ...componentValue(),
                    id,
                    authorization: authorization(id),
                    files: [
                      {
                        path,
                        operation: "copy-file",
                        contentSha256: "d".repeat(64),
                        contentAuthorization: runtimeAuthorization({
                          treeSha256: "b".repeat(64),
                        }),
                        contentSourcePath: path,
                      },
                    ],
                  },
                ],
              }),
            ),
          ),
        path,
      ).toThrow(/unsupported Kiro materialization/i);
    }
  });

  it("matches repository identity case-insensitively while preserving recorded spelling", () => {
    const selectedAuthorization = { ...authorization(), source: "Affaan-M/ECC" };
    const contentAuthorization = runtimeAuthorization({ source: "affaan-m/ecc" });
    const receipt = parseEccMaterializationReceipt(
      JSON.stringify(
        receiptValue({
          components: [
            {
              ...componentValue(),
              authorization: selectedAuthorization,
              provenance: { ...provenance(), repository: "AFFAAN-M/Ecc" },
              files: [
                {
                  path: ".kiro/skills/tdd-workflow/SKILL.md",
                  operation: "copy-file",
                  contentSha256: "d".repeat(64),
                  contentAuthorization,
                  contentSourcePath: ".kiro/skills/tdd-workflow/SKILL.md",
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(receipt.components[0]?.authorization.source).toBe("Affaan-M/ECC");
    expect(receipt.components[0]?.files[0]?.contentAuthorization?.source).toBe("affaan-m/ecc");
  });

  it("rejects mismatched selected, provenance, and Kiro content evidence identities", () => {
    const valid = {
      ...componentValue(),
      files: [
        {
          path: ".kiro/skills/tdd-workflow/SKILL.md",
          operation: "copy-file" as const,
          contentSha256: "d".repeat(64),
          contentAuthorization: runtimeAuthorization(),
          contentSourcePath: ".kiro/skills/tdd-workflow/SKILL.md",
        },
      ],
    };
    const cases: Array<[string, unknown]> = [
      ["selected component", { ...valid, authorization: authorization("skill:other") }],
      [
        "content source path",
        {
          ...valid,
          files: [{ ...valid.files[0], contentSourcePath: ".kiro/skills/other/SKILL.md" }],
        },
      ],
      [
        "provenance repository",
        { ...valid, provenance: { ...provenance(), repository: "other/ECC" } },
      ],
      ["provenance pin", { ...valid, provenance: { ...provenance(), commit: "d".repeat(40) } }],
      ...(
        [
          ["content component", { componentId: "runtime:other" }],
          ["content repository", { source: "other/ECC" }],
          ["content pin", { pinnedSha: "d".repeat(40) }],
          ["content tier", { tier: "org" }],
          ["content issuer", { issuer: "other issuer" }],
          ["content evidence", { evidenceSha256: "d".repeat(64) }],
        ] as Array<[string, Partial<BaselineAuthorization>]>
      ).map(([label, overrides]): [string, unknown] => [
        label,
        {
          ...valid,
          files: [
            {
              ...valid.files[0],
              contentAuthorization: runtimeAuthorization(overrides),
            },
          ],
        },
      ]),
    ];

    for (const [label, component] of cases) {
      expect(
        () =>
          parseEccMaterializationReceipt(JSON.stringify(receiptValue({ components: [component] }))),
        label,
      ).toThrow(/materialization receipt/i);
    }
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

  it("validates the authorization tuple through the ledger's own exported schema", () => {
    expect(eccMaterializationAuthorizationSchema).toBe(AuthorizationSchema);
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
      `bell\u0007.md`,
      "D:relative-to-drive.md",
      "weird:name.md",
      ECC_MATERIALIZATION_RECEIPT_PATH,
      ".aih/ecc/registration-ledger.json",
    ]) {
      expect(() => assertOwnedRelativePath(unsafe), unsafe).toThrow(/unsafe|AIH|state/i);
    }
  });

  it("refuses AIH's own state area whatever its case, and the sibling governance marker", () => {
    for (const reserved of [
      ".aih/ecc/materialization-v1.json",
      ".AIH/ecc/materialization-v1.json",
      ".Aih/anything.json",
      ".aih-config.json",
      ".AIH-CONFIG.json",
    ]) {
      expect(() => assertOwnedRelativePath(reserved), reserved).toThrow(/AIH/i);
    }
    // Git's own directory is never a materialization destination: a hook file
    // written there is executed by Git regardless of its mode bit.
    for (const git of [".git/hooks/pre-commit", ".GIT/config"]) {
      expect(() => assertOwnedRelativePath(git), git).toThrow(/git/i);
    }
    expect(assertOwnedRelativePath(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml");
  });

  it("refuses a pathologically nested owned value instead of blowing the stack", () => {
    let nested: Record<string, unknown> = { end: true };
    for (let depth = 0; depth < 5_000; depth += 1) nested = { nested };

    expect(() => ownedFragmentSha256({ deep: nested })).toThrow(/nest|depth/i);
  });

  it("wraps a rejected serialization instead of leaking a raw schema error", () => {
    const receipt = parseEccMaterializationReceipt(JSON.stringify(receiptValue()));
    const broken = {
      ...receipt,
      components: [{ ...receipt.components[0], id: "NOT A COMPONENT ID" }],
    } as unknown as Parameters<typeof serializeEccMaterializationReceipt>[0];

    expect(() => serializeEccMaterializationReceipt(broken)).toThrow(
      /invalid ECC materialization receipt/i,
    );
  });

  it("reads a valid receipt, an absent one, and a malformed one as distinct states", () => {
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });

    const receipt = parseEccMaterializationReceipt(JSON.stringify(receiptValue()));
    const text = serializeEccMaterializationReceipt(receipt);
    put(ECC_MATERIALIZATION_RECEIPT_PATH, text);
    expect(readEccMaterializationReceipt(root)).toEqual({
      state: "valid",
      receipt,
      raw: text,
      sourceBytes: Buffer.from(text, "utf8"),
      sourceSha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    });

    put(ECC_MATERIALIZATION_RECEIPT_PATH, "{ not json");
    const malformed = readEccMaterializationReceipt(root);
    expect(malformed.state).toBe("malformed");
    if (malformed.state !== "malformed") throw new Error("expected a malformed receipt state");
    expect(malformed.detail).toMatch(/materialization receipt/i);
  });

  it("hashes the exact opened receipt bytes instead of normalized decoded text", () => {
    const receipt = parseEccMaterializationReceipt(JSON.stringify(receiptValue()));
    const canonical = serializeEccMaterializationReceipt(receipt);
    const crlf = canonical.replace(/\n/g, "\r\n");
    put(ECC_MATERIALIZATION_RECEIPT_PATH, crlf);

    const read = readEccMaterializationReceipt(root);
    expect(read.state).toBe("valid");
    if (read.state !== "valid") throw new Error("expected a valid receipt state");
    expect(read.receipt).toEqual(receipt);
    expect(read.raw).toBe(crlf);
    expect(read.sourceBytes).toEqual(Buffer.from(crlf, "utf8"));
    expect(read.sourceSha256).toBe(
      createHash("sha256").update(Buffer.from(crlf, "utf8")).digest("hex"),
    );
    expect(read.sourceSha256).not.toBe(
      createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex"),
    );

    read.sourceBytes[0] = 0;
    const reread = readEccMaterializationReceipt(root);
    expect(reread.state).toBe("valid");
    if (reread.state !== "valid") throw new Error("expected a valid receipt state");
    expect(reread.sourceBytes).toEqual(Buffer.from(crlf, "utf8"));
  });

  it("rejects malformed UTF-8 even when replacement text would satisfy the schema", () => {
    const value = receiptValue({
      components: [
        {
          ...componentValue(),
          files: [
            {
              path: ".claude/settings.json",
              operation: "merge-json",
              contentSha256: "f".repeat(64),
              ownedKeys: ["safeKey"],
              createdByAih: true,
            },
          ],
        },
      ],
    });
    const text = serializeEccMaterializationReceipt(
      parseEccMaterializationReceipt(JSON.stringify(value)),
    );
    const bytes = Buffer.from(text, "utf8");
    const ownedKeyOffset = bytes.indexOf("safeKey");
    if (ownedKeyOffset < 0) throw new Error("expected owned key in serialized receipt");
    bytes[ownedKeyOffset + 1] = 0xff;
    mkdirSync(dirname(eccMaterializationReceiptPath(root)), { recursive: true });
    writeFileSync(eccMaterializationReceiptPath(root), bytes);

    expect(readEccMaterializationReceipt(root).state).toBe("malformed");
  });

  it("refuses non-regular, linked, and oversized receipt files", () => {
    mkdirSync(eccMaterializationReceiptPath(root), { recursive: true });
    expect(readEccMaterializationReceipt(root).state).toBe("malformed");
    rmSync(eccMaterializationReceiptPath(root), { recursive: true, force: true });

    const target = join(root, "receipt-target.json");
    writeFileSync(
      target,
      serializeEccMaterializationReceipt(
        parseEccMaterializationReceipt(JSON.stringify(receiptValue())),
      ),
      "utf8",
    );
    mkdirSync(dirname(eccMaterializationReceiptPath(root)), { recursive: true });
    symlinkSync(target, eccMaterializationReceiptPath(root));
    expect(readEccMaterializationReceipt(root).state).toBe("malformed");
    rmSync(eccMaterializationReceiptPath(root), { force: true });

    writeFileSync(eccMaterializationReceiptPath(root), "x".repeat(4 * 1024 * 1024 + 1), "utf8");
    expect(readEccMaterializationReceipt(root).state).toBe("malformed");
  });

  it("scopes the receipt to the written root's own AIH area", () => {
    expect(eccMaterializationReceiptPath(root)).toBe(
      join(root, ...ECC_MATERIALIZATION_RECEIPT_PATH.split("/")),
    );
    expect(() => eccMaterializationReceiptPath("relative/root")).toThrow(/absolute/i);
  });
});
