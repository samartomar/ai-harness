import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGovernanceDoctorRepairCustodyV1,
  createGovernanceDoctorRepairMutationGrantV1,
  governanceDoctorRepairCreateDirectoryV1,
  governanceDoctorRepairReadV1,
  governanceDoctorRepairWriteFileV1,
} from "../../src/governance-doctor/repair-custody-v1.js";
import { createGovernanceDoctorRepairReceiptV1 } from "../../src/governance-doctor/repair-outcome-v1.js";
import {
  REPAIR_FIXTURE_ATTEMPTED_AT,
  REPAIR_FIXTURE_CONTEXT_DIR,
  type RepairFixtureEffect,
  repairFixtureConsent,
  repairFixtureExecutionContext,
  repairFixturePlan,
  repairFixtureSha256,
} from "./repair-execution-fixture-v1.js";

/**
 * Deterministic filesystem interposition for the managed-write transaction.
 *
 * A concurrent writer cannot be scheduled reliably from a test, so the race is
 * expressed as a seam instead: every publication syscall the transaction issues --
 * each rename that moves an object under a private name and each link that
 * publishes one -- is counted by kind, and a hook may run immediately before or
 * immediately after a chosen occurrence. A directory flush can be failed outright,
 * which is the one post-publication failure that has no filesystem race to stand
 * in for it.
 *
 * Two rules are checked at every one of those points. Nothing this transaction did
 * not create is ever deleted or written over -- a foreign object is put back where
 * it was found, or left parked under a private name when its own name has been
 * taken. And a failure after publication leaves the managed name holding the exact
 * prior, never the new content.
 */
interface InterposedHook {
  readonly nth: number;
  readonly op: "link" | "open-exclusive" | "rename";
  readonly run: () => void;
  readonly when: "after" | "before";
}

/**
 * A seam that never advances would hang the whole suite rather than fail it, so
 * the seam itself stops after a bounded number of calls. Any run that reaches
 * this ceiling has already proved the loop is unbounded.
 */
const STALLED_WRITE_CEILING = 64;

const interposition = vi.hoisted(() => ({
  failDirectorySync: false,
  hooks: [] as InterposedHook[],
  seen: { link: 0, "open-exclusive": 0, rename: 0 } as Record<
    "link" | "open-exclusive" | "rename",
    number
  >,
  /** Every publication syscall in issue order, so a flush can be placed after a recovery. */
  trace: [] as ("directory-sync" | "link" | "rename")[],
  /**
   * How the kernel is made to report progress for the managed body write.
   *
   * `none` and `negative` never let the write advance, which is precisely the
   * defect: a loop that trusts the reported count neither commits nor returns.
   * `fractional` advances by something that is not a count at all, and `over`
   * writes the body in full and then claims to have consumed more than it was
   * handed -- a report that must not be believed even when the bytes it claims
   * to have written happen to be there.
   */
  writeProgress: null as null | "fractional" | "negative" | "none" | "over",
  writes: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const traced =
    <T extends readonly unknown[]>(op: "link" | "rename", operation: (...args: T) => void) =>
    (...args: T): void => {
      interposition.seen[op] += 1;
      interposition.trace.push(op);
      const nth = interposition.seen[op];
      const fire = (when: "after" | "before"): void => {
        for (const hook of interposition.hooks)
          if (hook.op === op && hook.nth === nth && hook.when === when) hook.run();
      };
      fire("before");
      operation(...args);
      fire("after");
    };
  const exclusiveCreate = actual.constants.O_CREAT | actual.constants.O_EXCL;
  const patched = {
    ...actual,
    // The scratch is born at an exclusive create, so the window between the
    // parent's identity proof and the first byte on disk is observable only
    // here. Read-only opens pass through untouched.
    openSync: ((path: string, flags: number | string, mode?: number): number => {
      if (typeof flags !== "number" || (flags & exclusiveCreate) !== exclusiveCreate)
        return actual.openSync(path, flags as number, mode);
      interposition.seen["open-exclusive"] += 1;
      const nth = interposition.seen["open-exclusive"];
      const fire = (when: "after" | "before"): void => {
        for (const hook of interposition.hooks)
          if (hook.op === "open-exclusive" && hook.nth === nth && hook.when === when) hook.run();
      };
      fire("before");
      const fd = actual.openSync(path, flags, mode);
      fire("after");
      return fd;
    }) as typeof actual.openSync,
    // A directory handle is the only thing this may refuse: the scratch flush
    // that precedes publication must still be real.
    fsyncSync: (fd: number): void => {
      const isDirectory = actual.fstatSync(fd).isDirectory();
      // Recorded as an attempt, before the refusal, so a flush is observable even
      // on the run that fails it.
      if (isDirectory) interposition.trace.push("directory-sync");
      if (isDirectory && interposition.failDirectorySync)
        throw Object.assign(new Error("interposed directory flush failure"), { code: "EIO" });
      actual.fsyncSync(fd);
    },
    linkSync: traced("link", actual.linkSync),
    renameSync: traced("rename", actual.renameSync),
    // A kernel is free to consume less than it was handed, but a count that never
    // advances, is not a count, or exceeds what was handed is not progress at all.
    writeSync: ((fd: number, buffer: Buffer, offset: number, length: number): number => {
      interposition.writes += 1;
      const mode = interposition.writeProgress;
      if (mode === null) return actual.writeSync(fd, buffer, offset, length);
      if (interposition.writes > STALLED_WRITE_CEILING)
        throw Object.assign(new Error("interposed stalled write ceiling"), { code: "EIO" });
      if (mode === "over") {
        actual.writeSync(fd, buffer, offset, length);
        return length + 1;
      }
      return mode === "none" ? 0 : mode === "negative" ? -1 : 0.5;
    }) as typeof actual.writeSync,
  };
  return { ...patched, default: patched };
});

let root: string;

const SCOPE = ["canon", "canon/router.md", "loose.md"] as const;
const NEW_BODY = "new\n";
const PRIOR_BODY = "prior\n";
const FOREIGN_BODY = "foreign bytes nobody planned\n";
const SECOND_FOREIGN_BODY = "a second foreign writer got here too\n";
const NOT_COMMITTED = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair managed write did not commit$/;

const EFFECTS: readonly RepairFixtureEffect[] = [
  {
    arguments: { contentSha256: repairFixtureSha256(NEW_BODY), path: "loose.md" },
    effectId: "restore-loose",
    templateId: "restore-canon-file",
  },
  {
    arguments: { contentSha256: repairFixtureSha256(NEW_BODY), path: "canon/router.md" },
    effectId: "restore-router",
    templateId: "restore-canon-file",
  },
];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  root = mkdtempSync(join(tmpdir(), "aih-repair-interpose-"));
  interposition.failDirectorySync = false;
  interposition.hooks = [];
  interposition.seen = { link: 0, "open-exclusive": 0, rename: 0 };
  interposition.trace = [];
  interposition.writeProgress = null;
  interposition.writes = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  interposition.failDirectorySync = false;
  interposition.hooks = [];
  interposition.writeProgress = null;
  rmSync(root, { recursive: true, force: true });
});

function interpose(...hooks: readonly InterposedHook[]): void {
  interposition.seen = { link: 0, "open-exclusive": 0, rename: 0 };
  interposition.trace = [];
  interposition.hooks = [...hooks];
}

/** Truncates a name in place: the same inode now holds bytes nobody planned. */
const overwriteInPlace =
  (path: string, body = FOREIGN_BODY) =>
  (): void => {
    writeFileSync(path, body);
  };

/** Replaces a name outright: a different inode occupies it. */
const replaceWithNewInode =
  (path: string, body = FOREIGN_BODY) =>
  (): void => {
    rmSync(path, { force: true });
    writeFileSync(path, body);
  };

/** Every private name the transaction could have left anywhere under a directory. */
function strayNames(directory: string): readonly string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
      else if (entry.name.startsWith(".aih-repair.")) found.push(join(current, entry.name));
    }
  };
  walk(directory);
  return found.sort();
}

/** One custody plus the exact consent-bound authority a managed write requires. */
async function bind() {
  const built = await repairFixturePlan({ effects: EFFECTS, root, scopePaths: SCOPE });
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
  const write = (effectId: string, live: unknown) =>
    governanceDoctorRepairWriteFileV1(
      createGovernanceDoctorRepairMutationGrantV1({
        consent,
        custody: bound,
        effectId,
        receipt,
      }),
      Buffer.from(NEW_BODY, "utf8"),
      live,
    );
  return {
    read: (path: string) => governanceDoctorRepairReadV1(bound, path),
    write,
  };
}

describe("governanceDoctorRepairWriteFileV1 under filesystem interposition", () => {
  it("preserves a foreign target installed immediately before a new file is published", async () => {
    const { read, write } = await bind();
    const live = read("loose.md");
    expect(live).toEqual({ state: "absent" });

    interpose({
      nth: 1,
      op: "link",
      run: replaceWithNewInode(join(root, "loose.md")),
      when: "before",
    });
    expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(FOREIGN_BODY);
    expect(strayNames(root)).toEqual([]);
  });

  it("preserves a foreign target installed immediately before the prior is displaced", async () => {
    const { read, write } = await bind();
    writeFileSync(join(root, "loose.md"), PRIOR_BODY);
    const live = read("loose.md");
    expect(live.state).toBe("file");

    interpose({
      nth: 1,
      op: "rename",
      run: replaceWithNewInode(join(root, "loose.md")),
      when: "before",
    });
    expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(FOREIGN_BODY);
    expect(strayNames(root)).toEqual([]);
  });

  it("preserves a same-inode foreign rewrite installed immediately before the prior is displaced", async () => {
    const { read, write } = await bind();
    writeFileSync(join(root, "loose.md"), PRIOR_BODY);
    const live = read("loose.md");
    expect(live.state).toBe("file");

    interpose({
      nth: 1,
      op: "rename",
      run: overwriteInPlace(join(root, "loose.md")),
      when: "before",
    });
    expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(FOREIGN_BODY);
    expect(strayNames(root)).toEqual([]);
  });

  it("parks a captured foreign object rather than destroying it when a second one wins the name", async () => {
    const { read, write } = await bind();
    writeFileSync(join(root, "loose.md"), PRIOR_BODY);
    const live = read("loose.md");
    expect(live.state).toBe("file");

    // The displacement captures the first foreign file; the second takes the name
    // back before the capture can be handed to it. The captured object is not this
    // transaction's to delete, so it stays under a private name.
    interpose(
      {
        nth: 1,
        op: "rename",
        run: replaceWithNewInode(join(root, "loose.md")),
        when: "before",
      },
      {
        nth: 1,
        op: "link",
        run: replaceWithNewInode(join(root, "loose.md"), SECOND_FOREIGN_BODY),
        when: "before",
      },
    );
    expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(SECOND_FOREIGN_BODY);
    const parked = strayNames(root);
    expect(parked).toHaveLength(1);
    expect(readFileSync(parked[0] as string, "utf8")).toBe(FOREIGN_BODY);
  });

  it("parks a displaced prior rather than clearing it when another file wins the name", async () => {
    const { read, write } = await bind();
    writeFileSync(join(root, "loose.md"), PRIOR_BODY);
    const live = read("loose.md");
    expect(live.state).toBe("file");

    // The capture is the real prior, and the publication then fails, so there is
    // nothing to supersede it: the foreign file that won the name is untouched and
    // the prior's bytes stay recoverable under a private name rather than being
    // deleted because the name they came from is occupied.
    interpose({
      nth: 1,
      op: "link",
      run: replaceWithNewInode(join(root, "loose.md")),
      when: "before",
    });
    expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(FOREIGN_BODY);
    const parked = strayNames(root);
    expect(parked).toHaveLength(1);
    expect(parked[0] as string).toMatch(/\.displaced$/);
    expect(readFileSync(parked[0] as string, "utf8")).toBe(PRIOR_BODY);
  });

  it("never unlinks a foreign replacement installed immediately after publication", async () => {
    const { read, write } = await bind();
    writeFileSync(join(root, "loose.md"), PRIOR_BODY);
    const live = read("loose.md");
    expect(live.state).toBe("file");

    interpose({
      nth: 1,
      op: "link",
      run: replaceWithNewInode(join(root, "loose.md")),
      when: "after",
    });
    expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(FOREIGN_BODY);
    const parked = strayNames(root);
    expect(parked).toHaveLength(1);
    expect(parked[0] as string).toMatch(/\.displaced$/);
    expect(readFileSync(parked[0] as string, "utf8")).toBe(PRIOR_BODY);
  });

  it("never unlinks foreign bytes written into the published inode after the scratch is retired", async () => {
    const { read, write } = await bind();
    writeFileSync(join(root, "loose.md"), PRIOR_BODY);
    const live = read("loose.md");
    expect(live.state).toBe("file");

    // The identity at the managed name is still the one this transaction
    // published; only the bytes are somebody else's. Ownership that stopped at
    // identity would delete them here.
    interpose({
      nth: 2,
      op: "rename",
      run: overwriteInPlace(join(root, "loose.md")),
      when: "after",
    });
    expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(FOREIGN_BODY);
    const parked = strayNames(root);
    expect(parked).toHaveLength(1);
    expect(parked[0] as string).toMatch(/\.displaced$/);
    expect(readFileSync(parked[0] as string, "utf8")).toBe(PRIOR_BODY);
  });

  it("restores the exact prior when validation fails after publication", async () => {
    const { read, write } = await bind();
    writeFileSync(join(root, "loose.md"), PRIOR_BODY);
    const live = read("loose.md");
    expect(live.state).toBe("file");

    // A second name for the published object makes it unreadable as a managed
    // file. The publication is undone, the prior comes back, and the alias -- a
    // name this transaction did not create -- is left exactly where it is.
    interpose({
      nth: 2,
      op: "rename",
      run: () => {
        interposition.hooks = [];
        writeFileSync(join(root, "alias.md"), "");
        rmSync(join(root, "alias.md"));
        linkSync(join(root, "loose.md"), join(root, "alias.md"));
      },
      when: "after",
    });
    expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(PRIOR_BODY);
    expect(readFileSync(join(root, "alias.md"), "utf8")).toBe(NEW_BODY);
    expect(strayNames(root)).toEqual([]);
  });

  it("flushes the parent after rolling back a new file it published with no prior", async () => {
    const { read, write } = await bind();
    const live = read("loose.md");
    expect(live).toEqual({ state: "absent" });

    // Nothing was displaced, so the recovery has nothing to give back -- it only
    // removes what this transaction published. That removal still has to be made
    // durable: an unflushed unlink can leave the managed name pointing at a file
    // the caller was told did not commit.
    interpose({
      nth: 1,
      op: "rename",
      run: () => {
        interposition.hooks = [];
        linkSync(join(root, "loose.md"), join(root, "alias.md"));
      },
      when: "after",
    });
    expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    expect(existsSync(join(root, "loose.md"))).toBe(false);
    expect(readFileSync(join(root, "alias.md"), "utf8")).toBe(NEW_BODY);
    expect(strayNames(root)).toEqual([]);
    // Publish, retire the scratch, the alias this hook interposed, and then -- in
    // the recovery -- retire the published name and flush the parent that no longer
    // names it. Windows exposes no directory handle to flush, so there the sequence
    // simply ends at the removal.
    expect(interposition.trace).toEqual(
      process.platform === "win32"
        ? ["link", "rename", "link", "rename"]
        : ["link", "rename", "link", "rename", "directory-sync"],
    );
  });

  it("installs nothing at the managed name when the bound parent is replaced mid-transaction", async () => {
    const { read, write } = await bind();
    mkdirSync(join(root, "canon"));
    writeFileSync(join(root, "canon", "router.md"), PRIOR_BODY);
    const live = read("canon/router.md");
    expect(live.state).toBe("file");

    interpose({
      nth: 2,
      op: "rename",
      run: () => {
        interposition.hooks = [];
        renameSync(join(root, "canon"), join(root, "canon-moved"));
        mkdirSync(join(root, "canon"));
      },
      when: "after",
    });
    expect(() => write("restore-router", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

    // A parent it can no longer prove is a parent it must not touch, so the
    // recovery stops rather than acting inside a directory somebody else installed.
    expect(existsSync(join(root, "canon", "router.md"))).toBe(false);
    expect(strayNames(join(root, "canon"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "restores the exact prior when the directory flush fails after publication",
    async () => {
      const { read, write } = await bind();
      writeFileSync(join(root, "loose.md"), PRIOR_BODY);
      const live = read("loose.md");
      expect(live.state).toBe("file");

      interposition.failDirectorySync = true;
      expect(() => write("restore-loose", live)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);

      expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(PRIOR_BODY);
      expect(strayNames(root)).toEqual([]);
    },
  );

  /**
   * Resolved -- the reviewed zero-progress defect. The managed body write added
   * whatever `writeSync` reported straight into its own loop bound, so a kernel
   * that consumed nothing, that went backwards, or that answered with something
   * which is not a count at all spun the transaction forever. That is the one
   * outcome worse than refusing: the run neither publishes nor returns, and no
   * test timeout can interrupt a synchronous loop.
   *
   * The bound is now progress, not patience -- exactly as the durable claim
   * writer already stated it -- so every one of these is refused on the first
   * report it cannot believe.
   */
  for (const progress of ["fractional", "negative", "none", "over"] as const)
    it(`refuses a managed write reporting ${progress} progress rather than looping on it`, async () => {
      const { read, write } = await bind();
      writeFileSync(join(root, "loose.md"), PRIOR_BODY);
      const live = read("loose.md");
      expect(live.state).toBe("file");

      interposition.writeProgress = progress;
      expect(() => write("restore-loose", live)).toThrow(NOT_COMMITTED);

      // Bounded: the refusal is taken on the first report that cannot be believed,
      // never after a spin -- and never on a report of more than was handed merely
      // because the resulting size happened to disagree.
      expect(interposition.writes).toBe(1);
      // Nothing reached the managed name, and the only object the recovery removed
      // is the scratch this transaction created under its own private name.
      expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(PRIOR_BODY);
      expect(strayNames(root)).toEqual([]);
    });

  it("commits an uninterposed replacement and leaves no private name behind", async () => {
    const { read, write } = await bind();
    writeFileSync(join(root, "loose.md"), PRIOR_BODY);

    write("restore-loose", read("loose.md"));

    expect(readFileSync(join(root, "loose.md"), "utf8")).toBe(NEW_BODY);
    expect(strayNames(root)).toEqual([]);
  });

  /**
   * The window between the parent's identity proof and the scratch's exclusive
   * create is the earliest point a swapped directory can capture the
   * transaction. Whatever the swap is made of, nothing may ever be *published* --
   * a managed name coming into existence in a tree the proof did not bind is the
   * one outcome these two tests exist to refuse. A stray private scratch in the
   * substituted tree is tolerated, exactly as strays are tolerated everywhere
   * else in this suite; a published managed name is not.
   */
  it("publishes nothing through a parent replaced with a fresh directory before the scratch exists", async () => {
    mkdirSync(join(root, "canon"));
    const { read, write } = await bind();
    const live = read("canon/router.md");
    expect(live.state).toBe("absent");

    const stolen = join(root, ".stolen");
    interpose({
      nth: 1,
      op: "open-exclusive",
      run: () => {
        renameSync(join(root, "canon"), stolen);
        mkdirSync(join(root, "canon"));
      },
      when: "before",
    });
    expect(() => write("restore-router", live)).toThrow(NOT_COMMITTED);

    expect(existsSync(join(root, "canon", "router.md"))).toBe(false);
    expect(existsSync(join(stolen, "router.md"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "publishes nothing outside the root through a parent swapped to a symlink",
    async () => {
      mkdirSync(join(root, "canon"));
      const victim = mkdtempSync(join(tmpdir(), "aih-repair-victim-"));
      try {
        const { read, write } = await bind();
        const live = read("canon/router.md");
        expect(live.state).toBe("absent");

        interpose({
          nth: 1,
          op: "open-exclusive",
          run: () => {
            renameSync(join(root, "canon"), join(root, ".stolen"));
            symlinkSync(victim, join(root, "canon"), "dir");
          },
          when: "before",
        });
        expect(() => write("restore-router", live)).toThrow(NOT_COMMITTED);

        // The canonical root's boundary holds: no managed name was published
        // into the tree the symlink pointed at.
        expect(existsSync(join(victim, "router.md"))).toBe(false);
      } finally {
        rmSync(victim, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "collapses a directory-flush failure during a managed create into the closed label",
    async () => {
      const built = await repairFixturePlan({
        effects: [
          {
            arguments: { path: "canon" },
            effectId: "ensure-canon",
            templateId: "ensure-canon-directory",
          },
        ],
        root,
        scopePaths: ["canon"],
      });
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
        effects: [{ effectId: "ensure-canon", result: "skipped" }],
        plan: built,
      });
      const live = governanceDoctorRepairReadV1(bound, "canon");
      expect(live.state).toBe("absent");

      interposition.failDirectorySync = true;
      // The flush failure is an OS error; the refusal must still be the module's
      // own closed label, never the raw error the hostile tree could speak through.
      expect(() =>
        governanceDoctorRepairCreateDirectoryV1(
          createGovernanceDoctorRepairMutationGrantV1({
            consent,
            custody: bound,
            effectId: "ensure-canon",
            receipt,
          }),
        ),
      ).toThrow(/^GOVERNANCE_DOCTOR_REPAIR_V1: repair managed directory was not created$/);
    },
  );
});
