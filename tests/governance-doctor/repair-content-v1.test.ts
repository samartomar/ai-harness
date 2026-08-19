import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGovernanceDoctorRepairContentV1,
  GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS,
  governanceDoctorRepairAttemptExpectedV1,
  governanceDoctorRepairContentBytesV1,
  governanceDoctorRepairContentDigestsV1,
  governanceDoctorRepairMarkerBeginLineV1,
  governanceDoctorRepairMarkerBlockBodyV1,
  governanceDoctorRepairMarkerEndLineV1,
  normalizeGovernanceDoctorRepairLineEndingsV1,
  recordGovernanceDoctorRepairAttemptEvidenceV1,
  rewriteGovernanceDoctorRepairMarkerBlockV1,
} from "../../src/governance-doctor/repair-content-v1.js";
import { createGovernanceDoctorRepairReceiptV1 } from "../../src/governance-doctor/repair-outcome-v1.js";
import {
  REPAIR_FIXTURE_ATTEMPTED_AT,
  type RepairFixtureEffect,
  repairFixtureConsent,
  repairFixtureExecutionContext,
  repairFixturePlan,
  repairFixtureSha256,
} from "./repair-execution-fixture-v1.js";

/**
 * Attempt evidence is pure bookkeeping over records, never over a tree, so this
 * root is only ever hashed into a plan identity. Nothing here resolves it, reads
 * it, or creates it.
 */
const EVIDENCE_ROOT = "/aih-repair-content-evidence";
const EVIDENCE_SCOPE = ["canon", "canon/router.md"] as const;
const EVIDENCE_EFFECTS: readonly RepairFixtureEffect[] = [
  { arguments: { path: "canon" }, effectId: "ensure-canon", templateId: "ensure-canon-directory" },
  {
    arguments: { contentSha256: repairFixtureSha256("router body\n"), path: "canon/router.md" },
    effectId: "restore-router",
    templateId: "restore-canon-file",
  },
];

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");

const utf8 = (text: string): Buffer => Buffer.from(text, "utf8");

function content(...bodies: readonly (Buffer | string)[]) {
  return createGovernanceDoctorRepairContentV1({
    entries: bodies.map((body) => {
      const bytes = typeof body === "string" ? utf8(body) : body;
      return { bytes, contentSha256: sha256(bytes) };
    }),
  });
}

const BEGIN = governanceDoctorRepairMarkerBeginLineV1("canon-block");
const END = governanceDoctorRepairMarkerEndLineV1("canon-block");

describe("createGovernanceDoctorRepairContentV1", () => {
  it("admits only bytes that independently hash to their declared digest", () => {
    const bytes = utf8("router body\n");
    const trusted = createGovernanceDoctorRepairContentV1({
      entries: [{ bytes, contentSha256: sha256(bytes) }],
    });

    expect(governanceDoctorRepairContentDigestsV1(trusted)).toEqual([sha256(bytes)]);
    expect(governanceDoctorRepairContentBytesV1(trusted, sha256(bytes))).toEqual(bytes);
  });

  it("refuses bytes that do not match their declared digest", () => {
    expect(() =>
      createGovernanceDoctorRepairContentV1({
        entries: [{ bytes: utf8("router body\n"), contentSha256: sha256("other body\n") }],
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
  });

  it("is a closed schema: extra fields, proxies, and duplicates are refused", () => {
    const bytes = utf8("body\n");
    expect(() =>
      createGovernanceDoctorRepairContentV1({
        entries: [{ bytes, contentSha256: sha256(bytes) }],
        extra: 1,
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() =>
      createGovernanceDoctorRepairContentV1({
        entries: [{ bytes, contentSha256: sha256(bytes), mode: 420 }],
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() =>
      createGovernanceDoctorRepairContentV1({
        entries: [
          { bytes, contentSha256: sha256(bytes) },
          { bytes, contentSha256: sha256(bytes) },
        ],
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() => createGovernanceDoctorRepairContentV1({ entries: new Proxy([], {}) })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
  });

  it("bounds entry count and byte length", () => {
    const oversize = Buffer.alloc(
      GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS.maxContentBytes + 1,
      0x61,
    );
    expect(() =>
      createGovernanceDoctorRepairContentV1({
        entries: [{ bytes: oversize, contentSha256: sha256(oversize) }],
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    const many = Array.from(
      { length: GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS.maxContentEntries + 1 },
      (_unused, index) => {
        const bytes = utf8(`body ${index}\n`);
        return { bytes, contentSha256: sha256(bytes) };
      },
    );
    expect(() => createGovernanceDoctorRepairContentV1({ entries: many })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
  });

  it("hands out defensive copies and refuses an unregistered digest", () => {
    const trusted = content("router body\n");
    const first = governanceDoctorRepairContentBytesV1(trusted, sha256("router body\n"));
    first.fill(0);
    expect(governanceDoctorRepairContentBytesV1(trusted, sha256("router body\n"))).toEqual(
      utf8("router body\n"),
    );
    expect(() => governanceDoctorRepairContentBytesV1(trusted, sha256("absent\n"))).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() => governanceDoctorRepairContentBytesV1({ protocol: "x" }, sha256("a"))).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
  });
});

describe("normalizeGovernanceDoctorRepairLineEndingsV1", () => {
  it("rewrites CRLF to LF and leaves an already-normalized file byte-identical", () => {
    expect(normalizeGovernanceDoctorRepairLineEndingsV1(utf8("a\r\nb\r\n"))).toEqual(
      utf8("a\nb\n"),
    );
    const normalized = utf8("a\nb\n");
    expect(normalizeGovernanceDoctorRepairLineEndingsV1(normalized)).toEqual(normalized);
  });

  it("refuses ambiguous or unsafe encodings rather than interpreting them", () => {
    expect(normalizeGovernanceDoctorRepairLineEndingsV1(utf8("a\rb"))).toBeNull();
    expect(normalizeGovernanceDoctorRepairLineEndingsV1(utf8("a\r"))).toBeNull();
    expect(
      normalizeGovernanceDoctorRepairLineEndingsV1(Buffer.from([0xef, 0xbb, 0xbf, 0x61])),
    ).toBeNull();
    expect(
      normalizeGovernanceDoctorRepairLineEndingsV1(Buffer.from([0x61, 0x00, 0x62])),
    ).toBeNull();
    expect(
      normalizeGovernanceDoctorRepairLineEndingsV1(Buffer.from([0xff, 0xfe, 0x61])),
    ).toBeNull();
  });
});

describe("governanceDoctorRepairMarkerBlockBodyV1", () => {
  it("reads exactly one well-formed region and preserves its body verbatim", () => {
    const file = utf8(`preamble\n${BEGIN}\nold body\n${END}\ntrailer\n`);
    expect(governanceDoctorRepairMarkerBlockBodyV1(file, "canon-block")).toEqual(utf8("old body"));
  });

  it("refuses malformed, duplicate, inverted, and overlapping regions", () => {
    const other = governanceDoctorRepairMarkerBeginLineV1("other-block");
    const otherEnd = governanceDoctorRepairMarkerEndLineV1("other-block");
    const cases = [
      `${BEGIN}\nbody\n`,
      `body\n${END}\n`,
      `${END}\nbody\n${BEGIN}\n`,
      `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`,
      `${BEGIN}\na\n${other}\nb\n${otherEnd}\n${END}\n`,
      "<!-- AIH-REPAIR-BEGIN Canon-Block -->\nbody\n<!-- AIH-REPAIR-END Canon-Block -->\n",
      `  ${BEGIN}\nbody\n${END}\n`,
      `${BEGIN} trailing\nbody\n${END}\n`,
      "plain file without markers\n",
    ];
    for (const text of cases)
      expect(governanceDoctorRepairMarkerBlockBodyV1(utf8(text), "canon-block"), text).toBeNull();
  });

  it("refuses a file whose bytes are unsafe for a deterministic splice", () => {
    expect(
      governanceDoctorRepairMarkerBlockBodyV1(
        utf8(`${BEGIN}\r\nbody\r\n${END}\r\n`),
        "canon-block",
      ),
    ).toBeNull();
    expect(
      governanceDoctorRepairMarkerBlockBodyV1(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(`${BEGIN}\nbody\n${END}\n`)]),
        "canon-block",
      ),
    ).toBeNull();
  });
});

describe("rewriteGovernanceDoctorRepairMarkerBlockV1", () => {
  it("replaces only the fenced body and preserves every unrelated byte", () => {
    const file = utf8(`preamble\n\n${BEGIN}\nold body\n${END}\n\ntrailer\n`);
    const next = rewriteGovernanceDoctorRepairMarkerBlockV1(file, "canon-block", utf8("new body"));
    expect(next?.toString("utf8")).toBe(`preamble\n\n${BEGIN}\nnew body\n${END}\n\ntrailer\n`);
  });

  it("is deterministic and idempotent for the same body", () => {
    const file = utf8(`${BEGIN}\nold\n${END}\n`);
    const once = rewriteGovernanceDoctorRepairMarkerBlockV1(file, "canon-block", utf8("new"));
    const twice = rewriteGovernanceDoctorRepairMarkerBlockV1(
      once as Buffer,
      "canon-block",
      utf8("new"),
    );
    expect(once).toEqual(twice);
    expect(governanceDoctorRepairMarkerBlockBodyV1(once as Buffer, "canon-block")).toEqual(
      utf8("new"),
    );
  });

  it("round-trips a multi-line body including its trailing newline", () => {
    const body = utf8("line one\nline two\n");
    const next = rewriteGovernanceDoctorRepairMarkerBlockV1(
      utf8(`${BEGIN}\nold\n${END}\n`),
      "canon-block",
      body,
    );
    expect(governanceDoctorRepairMarkerBlockBodyV1(next as Buffer, "canon-block")).toEqual(body);
  });

  it("refuses a body that could forge, close, or corrupt a fence", () => {
    const file = utf8(`${BEGIN}\nold\n${END}\n`);
    const hostile = [
      utf8(`${BEGIN}\n`),
      utf8(`${END}\n`),
      utf8("text <!-- AIH-REPAIR-END canon-block --> text"),
      utf8("a\r\nb"),
      Buffer.from([0x61, 0x00]),
      Buffer.from([0xef, 0xbb, 0xbf, 0x61]),
      Buffer.from([0xc3, 0x28]),
    ];
    for (const body of hostile)
      expect(rewriteGovernanceDoctorRepairMarkerBlockV1(file, "canon-block", body)).toBeNull();
  });

  it("refuses a malformed target region rather than repairing it", () => {
    expect(
      rewriteGovernanceDoctorRepairMarkerBlockV1(
        utf8(`${BEGIN}\nbody\n`),
        "canon-block",
        utf8("x"),
      ),
    ).toBeNull();
  });

  it("refuses an unpaired or duplicate foreign marker anywhere in the file", () => {
    const foreignBegin = governanceDoctorRepairMarkerBeginLineV1("other-block");
    const foreignEnd = governanceDoctorRepairMarkerEndLineV1("other-block");
    const target = utf8(`${BEGIN}\nold\n${END}\n`);

    expect(
      rewriteGovernanceDoctorRepairMarkerBlockV1(
        Buffer.concat([target, utf8(`${foreignBegin}\nforeign\n`)]),
        "canon-block",
        utf8("new"),
      ),
    ).toBeNull();
    expect(
      governanceDoctorRepairMarkerBlockBodyV1(
        utf8(`${foreignBegin}\nforeign\n${foreignEnd}\n${foreignEnd}\n${BEGIN}\nold\n${END}\n`),
        "canon-block",
      ),
    ).toBeNull();
  });

  it("refuses a second complete region for any block id, target or foreign", () => {
    const foreignBegin = governanceDoctorRepairMarkerBeginLineV1("other-block");
    const foreignEnd = governanceDoctorRepairMarkerEndLineV1("other-block");
    const twice = utf8(
      `${foreignBegin}
a
${foreignEnd}
${foreignBegin}
b
${foreignEnd}
${BEGIN}
old
${END}
`,
    );

    // The whole file's fences have to be unambiguous, not just the target's: a
    // block that owns two closed regions is a file nobody can splice safely.
    expect(governanceDoctorRepairMarkerBlockBodyV1(twice, "canon-block")).toBeNull();
    expect(
      rewriteGovernanceDoctorRepairMarkerBlockV1(twice, "canon-block", utf8("new")),
    ).toBeNull();
  });

  it("refuses crossed regions anywhere in the file, target or not", () => {
    const lines = (...rows: readonly string[]) => Buffer.from(`${rows.join("\n")}\n`, "utf8");
    const begin = governanceDoctorRepairMarkerBeginLineV1;
    const end = governanceDoctorRepairMarkerEndLineV1;

    // Properly nested foreign regions remain readable: nesting is legal.
    const nested = lines(
      begin("target"),
      "body",
      end("target"),
      begin("alpha"),
      begin("beta"),
      end("beta"),
      end("alpha"),
    );
    expect(governanceDoctorRepairMarkerBlockBodyV1(nested, "target")?.toString("utf8")).toBe(
      "body",
    );

    // The same markers crossed rather than nested have no single reading, even
    // though every one of them is paired and none of them touches the target.
    const crossed = lines(
      begin("target"),
      "body",
      end("target"),
      begin("alpha"),
      begin("beta"),
      end("alpha"),
      end("beta"),
    );
    expect(governanceDoctorRepairMarkerBlockBodyV1(crossed, "target")).toBeNull();
    expect(
      rewriteGovernanceDoctorRepairMarkerBlockV1(crossed, "target", Buffer.from("next", "utf8")),
    ).toBeNull();

    // A region crossed with the target itself is refused from either side.
    const tangled = lines(begin("target"), begin("alpha"), end("target"), end("alpha"));
    expect(governanceDoctorRepairMarkerBlockBodyV1(tangled, "target")).toBeNull();
    expect(governanceDoctorRepairMarkerBlockBodyV1(tangled, "alpha")).toBeNull();
  });

  it("refuses a block id outside the closed managed-token syntax", () => {
    expect(() => governanceDoctorRepairMarkerBeginLineV1("Canon Block")).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(
      rewriteGovernanceDoctorRepairMarkerBlockV1(utf8(`${BEGIN}\nb\n${END}\n`), "", utf8("x")),
    ).toBeNull();
  });

  it("bounds the file it will splice", () => {
    const oversize = Buffer.alloc(
      GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS.maxContentBytes + 1,
      0x61,
    );
    expect(governanceDoctorRepairMarkerBlockBodyV1(oversize, "canon-block")).toBeNull();
    expect(
      rewriteGovernanceDoctorRepairMarkerBlockV1(oversize, "canon-block", utf8("x")),
    ).toBeNull();
  });
});

describe("governance doctor repair attempt evidence", () => {
  /**
   * Every receipt below is minted by the outcome contract itself, over a real
   * plan, a real granted consent, and a real execution context. A structural
   * look-alike is exactly what this boundary has to refuse, so it can never also
   * be the thing the suite records against.
   */
  async function minted(...results: readonly ("applied" | "failed" | "skipped")[]) {
    const built = await repairFixturePlan({
      effects: EVIDENCE_EFFECTS,
      root: EVIDENCE_ROOT,
      scopePaths: EVIDENCE_SCOPE,
    });
    const receipt = createGovernanceDoctorRepairReceiptV1({
      attemptedAtEpochMs: REPAIR_FIXTURE_ATTEMPTED_AT,
      consent: repairFixtureConsent(built),
      context: repairFixtureExecutionContext(built),
      effects: built.effects.map((effect, index) => ({
        effectId: effect.effectId,
        result: results[index] ?? "applied",
      })),
      plan: built,
    });
    return {
      directory: built.effects[0]?.effectSha256 as string,
      file: built.effects[1]?.effectSha256 as string,
      receipt,
    };
  }

  it("hands back only what an executor recorded, as a defensive copy", async () => {
    const { directory, file, receipt } = await minted();
    const bytes = utf8("post state\n");
    recordGovernanceDoctorRepairAttemptEvidenceV1(receipt, [
      { bytes, effectSha256: file, state: "file" },
      { effectSha256: directory, state: "directory" },
    ]);

    const held = governanceDoctorRepairAttemptExpectedV1(receipt, file);
    expect(held?.state).toBe("file");
    expect(held?.state === "file" && held.bytes).toEqual(bytes);
    if (held?.state === "file") held.bytes.fill(0);
    expect(
      governanceDoctorRepairAttemptExpectedV1(receipt, file) as { bytes: Buffer },
    ).toMatchObject({ bytes });

    expect(governanceDoctorRepairAttemptExpectedV1(receipt, sha256("effect-c"))).toBeUndefined();
    expect(
      governanceDoctorRepairAttemptExpectedV1(Object.freeze({}), sha256("effect-a")),
    ).toBeUndefined();
  });

  it("is one-shot: recorded attempt evidence can never be replaced", async () => {
    const { file, receipt } = await minted();
    const applied = utf8("what the executor actually wrote\n");
    recordGovernanceDoctorRepairAttemptEvidenceV1(receipt, [
      { bytes: applied, effectSha256: file, state: "file" },
    ]);

    expect(() =>
      recordGovernanceDoctorRepairAttemptEvidenceV1(receipt, [
        { bytes: utf8("whatever happens to be on disk\n"), effectSha256: file, state: "file" },
      ]),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(
      governanceDoctorRepairAttemptExpectedV1(receipt, file) as { bytes: Buffer },
    ).toMatchObject({ bytes: applied });
  });

  it("refuses evidence that names one effect identity twice", async () => {
    const { directory, receipt } = await minted();
    expect(() =>
      recordGovernanceDoctorRepairAttemptEvidenceV1(receipt, [
        { effectSha256: directory, state: "directory" },
        { effectSha256: directory, state: "directory" },
      ]),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
  });

  it("records against the authentic minted receipt and nothing that merely resembles one", async () => {
    const { directory, receipt } = await minted();
    const evidence = [{ effectSha256: directory, state: "directory" as const }];
    const forgeries: readonly unknown[] = [
      // A hand-built look-alike, a structural clone of the real record, a record
      // with a substituted identity, a bare object, an array, a string, and null:
      // not one of them was minted by the outcome contract.
      Object.freeze({ protocol: "GovernanceDoctorRepairReceiptV1" }),
      { ...receipt },
      Object.freeze({ ...receipt, receiptSha256: sha256("forged") }),
      Object.freeze({}),
      [],
      "GovernanceDoctorRepairReceiptV1",
      null,
    ];

    for (const forged of forgeries)
      expect(() => recordGovernanceDoctorRepairAttemptEvidenceV1(forged, evidence)).toThrow(
        /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
      );

    // The real one still records, so the refusals above are about authenticity.
    expect(() => recordGovernanceDoctorRepairAttemptEvidenceV1(receipt, evidence)).not.toThrow();
  });

  it("refuses evidence for an effect the receipt never carries or never applied", async () => {
    const { file, receipt } = await minted("applied", "failed");
    const other = await minted();

    // An identity from no attempt at all cannot be introduced.
    expect(() =>
      recordGovernanceDoctorRepairAttemptEvidenceV1(receipt, [
        { effectSha256: sha256("some other effect"), state: "directory" },
      ]),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    // Nor can a real identity this receipt records as failed rather than applied.
    expect(() =>
      recordGovernanceDoctorRepairAttemptEvidenceV1(receipt, [
        { bytes: utf8("never written\n"), effectSha256: file, state: "file" },
      ]),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    // The same identity under a receipt that did apply it is accepted.
    expect(() =>
      recordGovernanceDoctorRepairAttemptEvidenceV1(other.receipt, [
        { bytes: utf8("written\n"), effectSha256: other.file, state: "file" },
      ]),
    ).not.toThrow();
  });

  it("refuses a mutated, hostile, or unbounded evidence entry without reading an accessor", async () => {
    const { directory, file, receipt } = await minted();
    let observed = 0;
    const accessor = Object.defineProperty({ state: "directory" }, "effectSha256", {
      configurable: true,
      enumerable: true,
      get: () => {
        observed += 1;
        return directory;
      },
    });
    const oversize = Buffer.alloc(
      GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS.maxContentBytes + 1,
      0x61,
    );
    const hostile: readonly unknown[] = [
      accessor,
      new Proxy({ effectSha256: directory, state: "directory" }, {}),
      // Mutated shapes: an unknown state, a malformed digest, an extra field, a
      // missing body, a body that is not bytes, and a body past the bound.
      { effectSha256: directory, state: "created" },
      { effectSha256: "not-a-digest", state: "directory" },
      { effectSha256: directory, extra: 1, state: "directory" },
      { effectSha256: file, state: "file" },
      { bytes: "post state\n", effectSha256: file, state: "file" },
      { bytes: oversize, effectSha256: file, state: "file" },
    ];

    for (const entry of hostile)
      expect(() => recordGovernanceDoctorRepairAttemptEvidenceV1(receipt, [entry])).toThrow(
        /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
      );
    expect(observed).toBe(0);

    // An array-like and a proxied evidence set are refused as the set itself.
    expect(() =>
      recordGovernanceDoctorRepairAttemptEvidenceV1(receipt, {
        0: { effectSha256: directory, state: "directory" },
        length: 1,
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() =>
      recordGovernanceDoctorRepairAttemptEvidenceV1(
        receipt,
        new Proxy([{ effectSha256: directory, state: "directory" }], {}),
      ),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
  });
});
