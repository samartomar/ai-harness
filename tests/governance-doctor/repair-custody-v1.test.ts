import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGovernanceDoctorRepairCustodyV1,
  createGovernanceDoctorRepairMutationGrantV1,
  GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS,
  governanceDoctorRepairCreateDirectoryV1,
  governanceDoctorRepairReadV1,
  governanceDoctorRepairRootSha256V1,
  governanceDoctorRepairWriteFileV1,
} from "../../src/governance-doctor/repair-custody-v1.js";
import { createGovernanceDoctorRepairReceiptV1 } from "../../src/governance-doctor/repair-outcome-v1.js";
import type { GovernanceDoctorRepairPlanV1 } from "../../src/governance-doctor/repair-plan-v1.js";
import {
  REPAIR_FIXTURE_ATTEMPTED_AT,
  REPAIR_FIXTURE_CONSENTED_AT,
  REPAIR_FIXTURE_CONTEXT_DIR,
  REPAIR_FIXTURE_CREATED_AT,
  REPAIR_FIXTURE_EXPIRES_AT,
  type RepairFixtureEffect,
  repairFixtureConsent,
  repairFixtureExecutionContext,
  repairFixturePlan,
  repairFixtureSha256,
} from "./repair-execution-fixture-v1.js";

let root: string;
let outside: string;

const SCOPE = ["canon", "canon/nested", "canon/router.md", "loose.md"] as const;

const LOOSE_BODY = "new\n";
const LOOSE_SHA256 = repairFixtureSha256(LOOSE_BODY);

/**
 * One effect per reachable custody operation. Every managed location a mutation
 * can name now arrives from a Plan-declared effect rather than from the caller, so
 * this list is also the complete set of locations these tests are able to mutate.
 */
const EFFECTS: readonly RepairFixtureEffect[] = [
  { arguments: { path: "canon" }, effectId: "ensure-canon", templateId: "ensure-canon-directory" },
  {
    arguments: { path: "canon/nested" },
    effectId: "ensure-nested",
    templateId: "ensure-canon-directory",
  },
  {
    arguments: { contentSha256: LOOSE_SHA256, path: "loose.md" },
    effectId: "restore-loose",
    templateId: "restore-canon-file",
  },
  {
    arguments: { contentSha256: LOOSE_SHA256, path: "canon/router.md" },
    effectId: "restore-router",
    templateId: "restore-canon-file",
  },
];

beforeEach(() => {
  // A grant re-reads the platform clock at the authority boundary, so a fixture
  // window is only in force while the run observes an instant inside it.
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  root = mkdtempSync(join(tmpdir(), "aih-repair-custody-"));
  outside = mkdtempSync(join(tmpdir(), "aih-repair-outside-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Every scratch name left anywhere under the fixture root. */
function scratchNames(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(directory, entry.name));
      else if (entry.name.startsWith(".aih-repair.")) found.push(entry.name);
    }
  };
  walk(root);
  return found.sort();
}

/** The refusal message a closed failure produced, or an empty string if none did. */
function refusalMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

async function plan(): Promise<GovernanceDoctorRepairPlanV1> {
  return repairFixturePlan({ effects: EFFECTS, root, scopePaths: SCOPE });
}

async function custody() {
  return createGovernanceDoctorRepairCustodyV1({
    contextDir: REPAIR_FIXTURE_CONTEXT_DIR,
    plan: await plan(),
    root,
  });
}

/**
 * One custody plus the exact consent-bound authority a mutation requires. A read
 * snapshot and the grant that spends it must come from the same custody, so both
 * are minted together here.
 */
async function bind() {
  const built = await plan();
  const bound = createGovernanceDoctorRepairCustodyV1({
    contextDir: REPAIR_FIXTURE_CONTEXT_DIR,
    plan: built,
    root,
  });
  const consent = repairFixtureConsent(built);
  const receipt = createGovernanceDoctorRepairReceiptV1({
    attemptedAtEpochMs: REPAIR_FIXTURE_ATTEMPTED_AT,
    consent,
    context: repairFixtureExecutionContext(built),
    effects: built.effects.map((effect) => ({ effectId: effect.effectId, result: "skipped" })),
    plan: built,
  });
  return {
    bound,
    built,
    consent,
    grant: (effectId: string, overrides: Record<string, unknown> = {}) =>
      createGovernanceDoctorRepairMutationGrantV1({
        consent,
        custody: bound,
        effectId,
        receipt,
        ...overrides,
      }),
    receipt,
  };
}

describe("createGovernanceDoctorRepairCustodyV1", () => {
  it("binds only to the exact root identity the plan already recorded", async () => {
    const built = await plan();
    expect(
      governanceDoctorRepairRootSha256V1({ contextDir: REPAIR_FIXTURE_CONTEXT_DIR, root }),
    ).toBe(built.rootSha256);

    expect(() =>
      createGovernanceDoctorRepairCustodyV1({
        contextDir: REPAIR_FIXTURE_CONTEXT_DIR,
        plan: built,
        root: outside,
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() =>
      createGovernanceDoctorRepairCustodyV1({
        contextDir: "other-context",
        plan: built,
        root,
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
  });

  it("is a closed schema over a branded plan and a real absolute root directory", async () => {
    const built = await plan();
    const base = { contextDir: REPAIR_FIXTURE_CONTEXT_DIR, plan: built, root };

    expect(() => createGovernanceDoctorRepairCustodyV1({ ...base, extra: 1 })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() => createGovernanceDoctorRepairCustodyV1({ ...base, plan: { ...built } })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() =>
      createGovernanceDoctorRepairCustodyV1({ ...base, root: join(root, "missing") }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() => createGovernanceDoctorRepairCustodyV1({ ...base, root: "canon" })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
  });

  it("never echoes the offending root back to the caller", async () => {
    const built = await plan();
    const message = refusalMessage(() =>
      createGovernanceDoctorRepairCustodyV1({
        contextDir: REPAIR_FIXTURE_CONTEXT_DIR,
        plan: built,
        root: outside,
      }),
    );

    expect(message).toMatch(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(message).not.toContain(outside);
  });
});

describe("governanceDoctorRepairReadV1", () => {
  it("reports absent, absent-parent, directory, and file states", async () => {
    const bound = await custody();
    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "absent" });
    expect(governanceDoctorRepairReadV1(bound, "canon/router.md")).toEqual({
      state: "absent-parent",
    });

    mkdirSync(join(root, "canon"));
    writeFileSync(join(root, "canon", "router.md"), "body\n");
    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "directory" });
    const live = governanceDoctorRepairReadV1(bound, "canon/router.md");
    expect(live.state).toBe("file");
    expect(live.state === "file" && live.bytes.toString("utf8")).toBe("body\n");
  });

  it("refuses a path the plan never declared", async () => {
    const bound = await custody();
    writeFileSync(join(root, "undeclared.md"), "body\n");
    expect(governanceDoctorRepairReadV1(bound, "undeclared.md")).toEqual({ state: "unsafe" });
  });

  it("refuses a hard-linked file whose bytes are shared with another name", async () => {
    const bound = await custody();
    writeFileSync(join(root, "loose.md"), "body\n");
    linkSync(join(root, "loose.md"), join(root, "alias.md"));
    expect(governanceDoctorRepairReadV1(bound, "loose.md")).toEqual({ state: "unsafe" });
  });

  it("refuses a file larger than the managed bound", async () => {
    const bound = await custody();
    writeFileSync(
      join(root, "loose.md"),
      Buffer.alloc(GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS.maxManagedFileBytes + 1, 0x61),
    );
    expect(governanceDoctorRepairReadV1(bound, "loose.md")).toEqual({ state: "unsafe" });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked leaf and a symlinked parent, inside or outside the root",
    async () => {
      const bound = await custody();
      writeFileSync(join(outside, "target.md"), "outside\n");
      symlinkSync(join(outside, "target.md"), join(root, "loose.md"));
      expect(governanceDoctorRepairReadV1(bound, "loose.md")).toEqual({ state: "unsafe" });

      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real", "router.md"), "inside\n");
      symlinkSync(join(root, "real"), join(root, "canon"));
      expect(governanceDoctorRepairReadV1(bound, "canon/router.md")).toEqual({ state: "unsafe" });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "refuses a junction reparse point standing in for a managed directory",
    async () => {
      const bound = await custody();
      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real", "router.md"), "inside\n");
      symlinkSync(join(root, "real"), join(root, "canon"), "junction");
      expect(governanceDoctorRepairReadV1(bound, "canon/router.md")).toEqual({ state: "unsafe" });
    },
  );

  it("refuses a managed path whose parent is not a directory", async () => {
    const bound = await custody();
    writeFileSync(join(root, "canon"), "not a directory\n");
    expect(governanceDoctorRepairReadV1(bound, "canon/router.md")).toEqual({ state: "unsafe" });
  });

  it("fails closed when the bound root itself is replaced under it", async () => {
    const bound = await custody();
    rmSync(root, { recursive: true, force: true });
    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "unsafe" });
  });

  it("refuses a different real directory installed at the same bound root path", async () => {
    const bound = await custody();
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);

    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "unsafe" });
  });
});

describe("createGovernanceDoctorRepairMutationGrantV1", () => {
  it("is a closed schema that refuses plain custody as its own authority", async () => {
    const { bound, consent, grant, receipt } = await bind();

    expect(() =>
      createGovernanceDoctorRepairMutationGrantV1({ consent, custody: bound, receipt }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() => grant("ensure-canon", { extra: 1 })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() => grant("ensure-canon", { custody: { protocol: "x" } })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
  });

  it("refuses a denied consent, a foreign consent, and an effect the plan never declared", async () => {
    const { built, grant } = await bind();
    const other = await repairFixturePlan({
      effects: EFFECTS,
      planNonce: "1a".repeat(32),
      root,
      scopePaths: SCOPE,
    });

    expect(() =>
      grant("ensure-canon", { consent: repairFixtureConsent(built, { decision: "denied" }) }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() => grant("ensure-canon", { consent: repairFixtureConsent(other) })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() => grant("never-planned")).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
  });

  it("opens the authority window no earlier than the consent instant", async () => {
    const { grant } = await bind();
    expect(REPAIR_FIXTURE_CONSENTED_AT).toBeGreaterThan(REPAIR_FIXTURE_CREATED_AT);

    // Inside the plan lifetime but before anyone consented: not yet authority.
    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_CREATED_AT);
    expect(() => grant("ensure-canon")).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_CONSENTED_AT - 1);
    expect(() => grant("ensure-canon")).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    // The window is half-open: the consent instant is in, the expiry instant is out.
    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_CONSENTED_AT);
    expect(() => grant("ensure-canon")).not.toThrow();
    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_EXPIRES_AT - 1);
    expect(() => grant("ensure-canon")).not.toThrow();
    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_EXPIRES_AT);
    expect(() => grant("ensure-canon")).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
  });

  it("re-reads the clock immediately before the effect, not only at minting time", async () => {
    const { bound, grant } = await bind();
    const directory = grant("ensure-canon");
    const write = grant("restore-loose");
    const live = governanceDoctorRepairReadV1(bound, "loose.md");

    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_EXPIRES_AT);
    expect(() => governanceDoctorRepairCreateDirectoryV1(directory)).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() =>
      governanceDoctorRepairWriteFileV1(write, Buffer.from(LOOSE_BODY, "utf8"), live),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "absent" });
    expect(governanceDoctorRepairReadV1(bound, "loose.md")).toEqual({ state: "absent" });
  });

  it("is one-shot: a spent grant is refused on reuse after success and after failure", async () => {
    const { bound, grant } = await bind();

    // Spent by the mutation it authorized, even though the goal state now holds.
    const spentBySuccess = grant("ensure-canon");
    governanceDoctorRepairCreateDirectoryV1(spentBySuccess);
    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "directory" });
    expect(refusalMessage(() => governanceDoctorRepairCreateDirectoryV1(spentBySuccess))).toMatch(
      /repair mutation grant requires a validated brand/,
    );

    // Spent by a refused mutation too: authority is consumed at the boundary.
    const spentByFailure = grant("restore-loose");
    expect(refusalMessage(() => governanceDoctorRepairCreateDirectoryV1(spentByFailure))).toMatch(
      /repair managed path is not plan-declared/,
    );
    expect(refusalMessage(() => governanceDoctorRepairCreateDirectoryV1(spentByFailure))).toMatch(
      /repair mutation grant requires a validated brand/,
    );

    const spentByWrite = grant("restore-loose");
    governanceDoctorRepairWriteFileV1(
      spentByWrite,
      Buffer.from(LOOSE_BODY, "utf8"),
      governanceDoctorRepairReadV1(bound, "loose.md"),
    );
    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(LOOSE_BODY);
    expect(
      refusalMessage(() =>
        governanceDoctorRepairWriteFileV1(
          spentByWrite,
          Buffer.from("second\n", "utf8"),
          governanceDoctorRepairReadV1(bound, "loose.md"),
        ),
      ),
    ).toMatch(/repair mutation grant requires a validated brand/);
    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(LOOSE_BODY);
  });

  it("re-checks the half-open window against the platform clock, not caller input", async () => {
    const { grant } = await bind();
    expect(() => grant("ensure-canon")).not.toThrow();

    // The receipt still carries an in-window attempt instant; only the actual
    // clock has moved onto the plan's exclusive upper bound.
    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_EXPIRES_AT);
    expect(() => grant("ensure-canon")).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
  });
});

describe("governanceDoctorRepairCreateDirectoryV1", () => {
  it("does not treat Plan-bound read custody as mutation authority", async () => {
    const bound = await custody();
    expect(() => governanceDoctorRepairCreateDirectoryV1(bound)).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "absent" });
  });

  it("creates exactly the declared leaf and is idempotent", async () => {
    const { bound, grant } = await bind();
    governanceDoctorRepairCreateDirectoryV1(grant("ensure-canon"));
    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "directory" });
    governanceDoctorRepairCreateDirectoryV1(grant("ensure-canon"));
    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "directory" });
  });

  it("never creates an absent parent and never recreates one after a race", async () => {
    const { bound, grant } = await bind();
    expect(() => governanceDoctorRepairCreateDirectoryV1(grant("ensure-nested"))).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(governanceDoctorRepairReadV1(bound, "canon")).toEqual({ state: "absent" });
  });

  it("refuses a grant minted for a file-writing effect", async () => {
    const { bound, grant } = await bind();
    expect(() => governanceDoctorRepairCreateDirectoryV1(grant("restore-loose"))).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(governanceDoctorRepairReadV1(bound, "loose.md")).toEqual({ state: "absent" });
  });

  it("refuses to replace an occupied path", async () => {
    const { grant } = await bind();
    writeFileSync(join(root, "canon"), "occupied\n");
    expect(() => governanceDoctorRepairCreateDirectoryV1(grant("ensure-canon"))).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(readFileSync(join(root, "canon"), "utf8")).toBe("occupied\n");
  });
});

describe("governanceDoctorRepairWriteFileV1", () => {
  it("writes a new managed file and preserves every unrelated byte", async () => {
    const { bound, grant } = await bind();
    writeFileSync(join(root, "bystander.md"), "bystander\n");
    governanceDoctorRepairWriteFileV1(
      grant("restore-loose"),
      Buffer.from(LOOSE_BODY, "utf8"),
      governanceDoctorRepairReadV1(bound, "loose.md"),
    );

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(LOOSE_BODY);
    expect(readFileSync(join(root, "bystander.md"), "utf8")).toBe("bystander\n");
  });

  it("rejects an unbranded caller-forged live snapshot before writing", async () => {
    const { bound, grant } = await bind();

    expect(() =>
      governanceDoctorRepairWriteFileV1(grant("restore-loose"), Buffer.from("forged\n", "utf8"), {
        state: "absent",
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(governanceDoctorRepairReadV1(bound, "loose.md")).toEqual({ state: "absent" });
  });

  it("rejects a live snapshot minted by a different custody over the same path", async () => {
    const { grant } = await bind();
    const foreign = await custody();
    writeFileSync(join(root, "loose.md"), "first\n");

    expect(() =>
      governanceDoctorRepairWriteFileV1(
        grant("restore-loose"),
        Buffer.from(LOOSE_BODY, "utf8"),
        governanceDoctorRepairReadV1(foreign, "loose.md"),
      ),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe("first\n");
  });

  it("refuses to commit when the live bytes changed after the read", async () => {
    const { bound, grant } = await bind();
    writeFileSync(join(root, "loose.md"), "first\n");
    const live = governanceDoctorRepairReadV1(bound, "loose.md");
    writeFileSync(join(root, "loose.md"), "raced\n");

    expect(() =>
      governanceDoctorRepairWriteFileV1(
        grant("restore-loose"),
        Buffer.from(LOOSE_BODY, "utf8"),
        live,
      ),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe("raced\n");
  });

  it("refuses a directory grant, an unsafe live state, and an oversize body", async () => {
    const { bound, grant } = await bind();
    expect(() =>
      governanceDoctorRepairWriteFileV1(grant("ensure-canon"), Buffer.from("x", "utf8"), {
        state: "absent",
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() =>
      governanceDoctorRepairWriteFileV1(grant("restore-loose"), Buffer.from("x", "utf8"), {
        state: "unsafe",
      }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() =>
      governanceDoctorRepairWriteFileV1(
        grant("restore-loose"),
        Buffer.alloc(GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS.maxManagedFileBytes + 1, 0x61),
        governanceDoctorRepairReadV1(bound, "loose.md"),
      ),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(governanceDoctorRepairReadV1(bound, "loose.md")).toEqual({ state: "absent" });
  });

  it("binds the commit to what custody read, not to the copy the caller holds", async () => {
    // The snapshot handed back is a copy. A caller that edits it -- here to agree
    // with a state some other writer raced in -- is editing its own object, not
    // the record custody compares against, so the raced file is still protected.
    const { bound, grant } = await bind();
    writeFileSync(join(root, "loose.md"), "first\n");
    const live = governanceDoctorRepairReadV1(bound, "loose.md");
    expect(live.state).toBe("file");

    // In-place overwrite: the inode is unchanged, so only the bytes moved.
    writeFileSync(join(root, "loose.md"), "raced\n");
    if (live.state === "file") live.bytes.write("raced", 0, "utf8");

    expect(
      refusalMessage(() =>
        governanceDoctorRepairWriteFileV1(
          grant("restore-loose"),
          Buffer.from(LOOSE_BODY, "utf8"),
          live,
        ),
      ),
    ).toMatch(/repair managed destination changed before commit/);
    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe("raced\n");
  });

  it("hands every read its own bytes, so one snapshot cannot reach another", async () => {
    const { bound } = await bind();
    writeFileSync(join(root, "loose.md"), "first\n");
    const first = governanceDoctorRepairReadV1(bound, "loose.md");
    const second = governanceDoctorRepairReadV1(bound, "loose.md");
    expect(first.state === "file" && second.state === "file").toBe(true);
    if (first.state !== "file" || second.state !== "file") return;

    expect(first.bytes).not.toBe(second.bytes);
    first.bytes.write("XXXXX", 0, "utf8");
    expect(second.bytes.toString("utf8")).toBe("first\n");
    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe("first\n");
  });

  it("never recreates a parent that disappeared after the read", async () => {
    const { bound, grant } = await bind();
    mkdirSync(join(root, "canon"));
    const live = governanceDoctorRepairReadV1(bound, "canon/router.md");
    expect(live).toEqual({ state: "absent" });

    // The racer removes the whole declared parent between the read and the write.
    rmSync(join(root, "canon"), { recursive: true });

    expect(() =>
      governanceDoctorRepairWriteFileV1(
        grant("restore-router"),
        Buffer.from(LOOSE_BODY, "utf8"),
        live,
      ),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    // The refusal is the whole outcome: no parent is rebuilt to make room.
    expect(existsSync(join(root, "canon"))).toBe(false);
  });

  it("never clobbers a target raced into the name after the read", async () => {
    const { bound, grant } = await bind();
    const live = governanceDoctorRepairReadV1(bound, "loose.md");
    expect(live).toEqual({ state: "absent" });

    writeFileSync(join(root, "loose.md"), "raced\n");

    expect(() =>
      governanceDoctorRepairWriteFileV1(
        grant("restore-loose"),
        Buffer.from(LOOSE_BODY, "utf8"),
        live,
      ),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe("raced\n");
  });

  it("publishes a single-linked file and leaves no scratch behind", async () => {
    const { bound, grant } = await bind();

    governanceDoctorRepairWriteFileV1(
      grant("restore-loose"),
      Buffer.from(LOOSE_BODY, "utf8"),
      governanceDoctorRepairReadV1(bound, "loose.md"),
    );
    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(LOOSE_BODY);
    // Published by link, so the scratch name must be gone before the file is one.
    expect(statSync(join(root, "loose.md")).nlink).toBe(1);
    expect(scratchNames()).toEqual([]);

    // A replacement over the file just published, and then a refused commit.
    governanceDoctorRepairWriteFileV1(
      grant("restore-loose"),
      Buffer.from("second\n", "utf8"),
      governanceDoctorRepairReadV1(bound, "loose.md"),
    );
    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe("second\n");
    expect(statSync(join(root, "loose.md")).nlink).toBe(1);
    expect(scratchNames()).toEqual([]);

    const stale = governanceDoctorRepairReadV1(bound, "loose.md");
    writeFileSync(join(root, "loose.md"), "raced\n");
    expect(() =>
      governanceDoctorRepairWriteFileV1(
        grant("restore-loose"),
        Buffer.from(LOOSE_BODY, "utf8"),
        stale,
      ),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(scratchNames()).toEqual([]);
  });

  it("leaves the prior bytes intact and no scratch file behind when a commit fails", async () => {
    const { bound, grant } = await bind();
    writeFileSync(join(root, "loose.md"), "first\n");
    const live = governanceDoctorRepairReadV1(bound, "loose.md");
    writeFileSync(join(root, "loose.md"), "raced\n");
    expect(() =>
      governanceDoctorRepairWriteFileV1(
        grant("restore-loose"),
        Buffer.from(LOOSE_BODY, "utf8"),
        live,
      ),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(repairFixtureSha256(readFileSync(join(root, "loose.md")))).toBe(
      repairFixtureSha256("raced\n"),
    );
    expect(governanceDoctorRepairReadV1(bound, "loose.md").state).toBe("file");
  });
});
