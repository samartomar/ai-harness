import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitMaterializationSteps } from "../../src/ecc/materialization-fs.js";
import {
  type OwnedFilePolicy,
  OwnedFileTransaction,
  resolveOwnedFileRoot,
} from "../../src/internals/owned-file-transaction.js";

let root: string;

const policy: OwnedFilePolicy = {
  label: "owned file transaction",
  maxFileBytes: 1024,
  contentDirectoryMode: 0o755,
  stateDirectoryMode: 0o700,
  statePaths: new Set([".state/receipt.json"]),
  assertOwnedPath(path) {
    if (path.startsWith("forbidden/")) throw new Error("owned path is forbidden");
  },
  assertResolvedSegments(segments) {
    if (segments.includes("forbidden")) throw new Error("resolved path is forbidden");
  },
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function transaction(rename?: (from: string, to: string) => void): OwnedFileTransaction {
  return new OwnedFileTransaction(resolveOwnedFileRoot(root, policy.label), policy, { rename });
}

function customTransaction(
  policyOverrides: Record<string, unknown> = {},
  deps: Record<string, unknown> = {},
): OwnedFileTransaction {
  return new OwnedFileTransaction(
    resolveOwnedFileRoot(root, policy.label),
    { ...policy, ...policyOverrides } as never,
    deps as never,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-owned-file-transaction-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("OwnedFileTransaction", () => {
  it("snapshots binary Buffers and scalar step data before the first announcement", () => {
    const contents = Buffer.from([0x00, 0xff, 0x41]);
    const prior = Buffer.from([0x10, 0x11]);
    writeFileSync(join(root, "existing.bin"), prior);
    const steps = [
      {
        path: "existing.bin",
        mode: 0o640,
        contents,
        expect: { sha256: sha256(prior) },
        prior,
        priorMode: 0o600,
        announce: () => {
          contents.fill(0x22);
          prior.fill(0x33);
          const firstStep = steps[0];
          if (firstStep === undefined) throw new Error("expected transaction fixture");
          firstStep.path = "mutated.bin";
        },
      },
    ];

    transaction().commit(steps);

    expect(readFileSync(join(root, "existing.bin"))).toEqual(Buffer.from([0x00, 0xff, 0x41]));
    expect(existsSync(join(root, "mutated.bin"))).toBe(false);
  });

  it("prevalidates every descriptor without invoking accessors or touching earlier steps", () => {
    let getterCalls = 0;
    let announcements = 0;
    const hostile = {
      mode: 0o644,
      contents: Buffer.from("hostile"),
      expect: { absent: true },
    };
    Object.defineProperty(hostile, "path", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "\u001b[2Jleaked.txt";
      },
    });

    let message = "";
    try {
      transaction().commit([
        {
          path: "first.txt",
          mode: 0o644,
          contents: Buffer.from("first"),
          expect: { absent: true },
          announce: () => {
            announcements += 1;
          },
        },
        hostile as never,
      ]);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe("invalid owned file transaction steps");
    expect(message).not.toContain("leaked");
    expect(getterCalls).toBe(0);
    expect(announcements).toBe(0);
    expect(existsSync(join(root, "first.txt"))).toBe(false);

    let prototypeTraps = 0;
    const proxy = new Proxy([], {
      getPrototypeOf() {
        prototypeTraps += 1;
        return Array.prototype;
      },
    });
    expect(() => transaction().commit(proxy as never)).toThrow(
      "invalid owned file transaction steps",
    );
    expect(prototypeTraps).toBe(0);
  });

  it("preserves exact caller order and chained repeated-path expectations", () => {
    const first = Buffer.from("first\n");
    const second = Buffer.from("second\n");
    const order: string[] = [];

    transaction().commit([
      {
        path: "same.txt",
        mode: 0o644,
        contents: first,
        expect: { absent: true },
        announce: () => order.push("first"),
      },
      {
        path: "same.txt",
        mode: 0o640,
        contents: second,
        expect: { sha256: sha256(first) },
        prior: first,
        priorMode: 0o644,
        announce: () => order.push("second"),
      },
    ]);

    expect(order).toEqual(["first", "second"]);
    expect(readFileSync(join(root, "same.txt"))).toEqual(second);
  });

  it("rolls repeated writes back in reverse and restores prior bytes and mode", () => {
    const original = Buffer.from("original\n");
    const first = Buffer.from("first\n");
    const second = Buffer.from("second\n");
    writeFileSync(join(root, "same.txt"), original, { mode: 0o600 });

    expect(() =>
      transaction().commit([
        {
          path: "same.txt",
          mode: 0o640,
          contents: first,
          expect: { sha256: sha256(original) },
          prior: original,
          priorMode: 0o600,
        },
        {
          path: "same.txt",
          mode: 0o644,
          contents: second,
          expect: { sha256: sha256(first) },
          prior: first,
          priorMode: 0o640,
        },
        {
          path: "never.txt",
          mode: 0o644,
          contents: Buffer.from("never"),
          expect: { absent: true },
          announce: () => {
            throw new Error("injected boundary failure");
          },
        },
      ]),
    ).toThrow("injected boundary failure");

    expect(readFileSync(join(root, "same.txt"))).toEqual(original);
    if (process.platform !== "win32") {
      expect(lstatSync(join(root, "same.txt")).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(join(root, "never.txt"))).toBe(false);
  });

  it("preserves and reports an operator replacement instead of deleting it on rollback", () => {
    let message = "";
    try {
      transaction().commit([
        {
          path: "managed.txt",
          mode: 0o644,
          contents: Buffer.from("generated\n"),
          expect: { absent: true },
        },
        {
          path: "later.txt",
          mode: 0o644,
          contents: Buffer.from("later\n"),
          expect: { absent: true },
          announce: () => {
            writeFileSync(join(root, "managed.txt"), "operator\n");
            throw new Error("injected failure");
          },
        },
      ]);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("injected failure");
    expect(message).toContain("rollback did not restore managed.txt");
    expect(readFileSync(join(root, "managed.txt"), "utf8")).toBe("operator\n");
  });

  it("rejects incoherent, oversized, and late-invalid steps before any effect", () => {
    const cases = [
      {
        path: "missing-prior.txt",
        mode: 0o644,
        contents: Buffer.from("x"),
        expect: { sha256: "a".repeat(64) },
      },
      {
        path: "oversized.bin",
        mode: 0o644,
        contents: Buffer.alloc(1025),
        expect: { absent: true },
      },
      {
        path: "../escape.txt",
        mode: 0o644,
        contents: Buffer.from("x"),
        expect: { absent: true },
      },
      {
        path: "C:/escape",
        mode: 0o644,
        contents: Buffer.from("x"),
        expect: { absent: true },
      },
      {
        path: "D:relative",
        mode: 0o644,
        contents: Buffer.from("x"),
        expect: { absent: true },
      },
      {
        path: "safe.txt:stream",
        mode: 0o644,
        contents: Buffer.from("x"),
        expect: { absent: true },
      },
    ];

    for (const candidate of cases) {
      expect(() =>
        transaction().commit([
          {
            path: "first.txt",
            mode: 0o644,
            contents: Buffer.from("first"),
            expect: { absent: true },
          },
          candidate as never,
        ]),
      ).toThrow();
      expect(existsSync(join(root, "first.txt"))).toBe(false);
    }
  });

  it("rejects nonregular and multiply-linked destinations", () => {
    mkdirSync(join(root, "directory-target"));
    expect(() =>
      transaction().commit([
        {
          path: "directory-target",
          mode: 0o644,
          contents: Buffer.from("replacement"),
          expect: { absent: true },
        },
      ]),
    ).toThrow(/unreadable|regular file/i);

    writeFileSync(join(root, "original.txt"), "original");
    try {
      linkSync(join(root, "original.txt"), join(root, "hardlink.txt"));
    } catch {
      return;
    }
    const prior = Buffer.from("original");
    expect(() =>
      transaction().commit([
        {
          path: "hardlink.txt",
          mode: 0o644,
          contents: Buffer.from("replacement"),
          expect: { sha256: sha256(prior) },
          prior,
        },
      ]),
    ).toThrow(/unreadable|unambiguous/i);
    expect(readFileSync(join(root, "original.txt"), "utf8")).toBe("original");
  });

  it("keeps the ECC wrapper's omitted-priorMode rollback fallback", () => {
    const original = Buffer.from("original\n");
    const generated = Buffer.from("generated\n");
    writeFileSync(join(root, "managed.txt"), original, { mode: 0o600 });

    expect(() =>
      commitMaterializationSteps(root, [
        {
          path: "managed.txt",
          mode: 0o640,
          contents: generated,
          expect: { sha256: sha256(original) },
          prior: original,
        },
        {
          path: "later.txt",
          mode: 0o644,
          contents: Buffer.from("later"),
          expect: { absent: true },
          announce: () => {
            throw new Error("injected wrapper failure");
          },
        },
      ]),
    ).toThrow("injected wrapper failure");

    expect(readFileSync(join(root, "managed.txt"))).toEqual(original);
    if (process.platform !== "win32") {
      expect(lstatSync(join(root, "managed.txt")).mode & 0o777).toBe(0o640);
    }
  });

  it("uses state/content directory modes and refuses static symlink targets", () => {
    transaction().commit([
      {
        path: "content/file.txt",
        mode: 0o644,
        contents: Buffer.from("content"),
        expect: { absent: true },
      },
      {
        path: ".state/receipt.json",
        mode: 0o600,
        contents: Buffer.from("state"),
        expect: { absent: true },
      },
    ]);
    if (process.platform !== "win32") {
      expect(lstatSync(join(root, "content")).mode & 0o777).toBe(0o755);
      expect(lstatSync(join(root, ".state")).mode & 0o777).toBe(0o700);
    }

    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    try {
      symlinkSync(outside, join(root, "link.txt"));
    } catch {
      return;
    }
    expect(() =>
      transaction().commit([
        {
          path: "link.txt",
          mode: 0o644,
          contents: Buffer.from("replacement"),
          expect: { absent: true },
        },
      ]),
    ).toThrow(/symlink/i);
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("keeps injected rename sequencing and cleans temporary files after failure", () => {
    let renames = 0;
    const txn = transaction((from, to) => {
      renames += 1;
      if (renames > 1) throw new Error("injected rename failure");
      renameSync(from, to);
    });
    expect(() =>
      txn.commit([
        {
          path: "first.txt",
          mode: 0o644,
          contents: Buffer.from("first"),
          expect: { absent: true },
        },
        {
          path: "second.txt",
          mode: 0o644,
          contents: Buffer.from("second"),
          expect: { absent: true },
        },
      ]),
    ).toThrow("injected rename failure");
    expect(renames).toBe(2);
    expect(existsSync(join(root, "first.txt"))).toBe(false);
    expect(existsSync(join(root, "second.txt"))).toBe(false);
  });

  it("supports explicit assertions without effects and enforces optional modes", () => {
    const path = join(root, "owned.txt");
    writeFileSync(path, "owned", { mode: 0o640 });
    const observed = transaction().inspect("owned.txt");
    expect(observed.state).toBe("present");
    if (observed.state !== "present") throw new Error("expected present fixture");

    customTransaction().commit([
      {
        action: "assert",
        path: "owned.txt",
        mode: 0o600,
        expect: { sha256: sha256(Buffer.from("owned")), mode: observed.mode },
      },
    ] as never);
    expect(readFileSync(path, "utf8")).toBe("owned");
    expect(lstatSync(path).mode & 0o777).toBe(observed.mode);

    const ephemeral = Buffer.from("ephemeral");
    customTransaction().commit([
      {
        action: "write",
        path: "ephemeral.txt",
        mode: 0o600,
        contents: ephemeral,
        expect: { absent: true },
      },
      {
        action: "remove",
        path: "ephemeral.txt",
        mode: 0o600,
        expect: { sha256: sha256(ephemeral), mode: 0o600 },
        prior: ephemeral,
        priorMode: 0o600,
      },
    ] as never);
    expect(existsSync(join(root, "ephemeral.txt"))).toBe(false);

    expect(() =>
      customTransaction().commit([
        {
          action: "assert",
          path: "owned.txt",
          mode: 0o600,
          expect: {
            sha256: sha256(Buffer.from("owned")),
            mode: observed.mode === 0o600 ? 0o644 : 0o600,
          },
        },
      ] as never),
    ).toThrow("owned file transaction destination changed before commit");
  });

  it("prevalidates action coherence and action-aware policy before effects", () => {
    const announcements: string[] = [];
    const tx = customTransaction({
      assertAction: (path: string, action: string) => {
        if (path === "assert-only.txt" && action !== "assert") {
          throw new Error("assert-only policy");
        }
      },
    });

    for (const invalid of [
      {
        action: "assert",
        path: "bad.txt",
        mode: 0o600,
        contents: Buffer.from("bad"),
        expect: { absent: true },
      },
      { action: "write", path: "bad.txt", mode: 0o600, expect: { absent: true } },
      {
        action: "remove",
        path: "bad.txt",
        mode: 0o600,
        contents: Buffer.from("bad"),
        expect: { absent: true },
      },
      { action: "rename", path: "bad.txt", mode: 0o600, expect: { absent: true } },
      {
        action: "assert",
        path: "bad.txt",
        mode: 0o600,
        expect: { sha256: "0".repeat(64), mode: undefined },
      },
    ]) {
      expect(() =>
        tx.commit([
          {
            path: "first.txt",
            mode: 0o600,
            contents: Buffer.from("first"),
            expect: { absent: true },
            announce: () => announcements.push("first"),
          },
          invalid,
        ] as never),
      ).toThrow("invalid owned file transaction steps");
    }

    expect(() =>
      tx.commit([
        {
          action: "write",
          path: "assert-only.txt",
          mode: 0o600,
          contents: Buffer.from("write"),
          expect: { absent: true },
        },
      ] as never),
    ).toThrow("assert-only policy");
    expect(announcements).toEqual([]);
    expect(existsSync(join(root, "first.txt"))).toBe(false);
    expect(existsSync(join(root, "assert-only.txt"))).toBe(false);

    const directActions: string[] = [];
    const direct = customTransaction({
      assertAction: (_path: string, action: string) => directActions.push(action),
    });
    expect(direct.inspect("direct.txt").state).toBe("absent");
    direct.writeAtomic("direct.txt", Buffer.from("direct"), 0o600);
    expect(direct.read("direct.txt")?.toString("utf8")).toBe("direct");
    direct.remove("direct.txt");
    expect(directActions).toEqual(["assert", "write", "assert", "remove"]);
  });

  it("snapshots commit guards and rolls back when afterEffects refuses", () => {
    let beforeCalls = 0;
    let afterCalls = 0;
    const tx = customTransaction(
      {},
      {
        beforeEffects: () => {
          beforeCalls += 1;
          expect(existsSync(join(root, "guarded.txt"))).toBe(false);
        },
        afterEffects: () => {
          afterCalls += 1;
          expect(readFileSync(join(root, "guarded.txt"), "utf8")).toBe("new");
          throw new Error("postcondition refused");
        },
      },
    );

    expect(() =>
      tx.commit([
        {
          action: "write",
          path: "guarded.txt",
          mode: 0o600,
          contents: Buffer.from("new"),
          expect: { absent: true },
        },
      ] as never),
    ).toThrow("postcondition refused");
    expect(beforeCalls).toBe(1);
    expect(afterCalls).toBe(1);
    expect(existsSync(join(root, "guarded.txt"))).toBe(false);

    let getterCalls = 0;
    const hostileDeps = {};
    Object.defineProperty(hostileDeps, "beforeEffects", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return () => undefined;
      },
    });
    expect(() => customTransaction({}, hostileDeps)).toThrow(
      "owned file transaction dependencies are invalid",
    );
    expect(getterCalls).toBe(0);

    let proxyTraps = 0;
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          proxyTraps += 1;
          return Object.prototype;
        },
        ownKeys: () => {
          proxyTraps += 1;
          return [];
        },
      },
    );
    expect(() => customTransaction({}, hostileProxy)).toThrow(
      "owned file transaction dependencies are invalid",
    );
    expect(proxyTraps).toBe(0);
  });

  it("rejects inherited action hooks without invoking them", () => {
    let hookCalls = 0;
    const inherited = Object.create({
      assertAction: () => {
        hookCalls += 1;
      },
    }) as OwnedFilePolicy;
    Object.assign(inherited, policy);

    expect(
      () => new OwnedFileTransaction(resolveOwnedFileRoot(root, policy.label), inherited),
    ).toThrow("invalid owned file transaction policy");
    expect(hookCalls).toBe(0);
    expect(existsSync(join(root, "blocked.txt"))).toBe(false);
  });

  it("preauthorizes assertion, forward, and inverse rollback actions before guards", () => {
    let beforeCalls = 0;
    let afterCalls = 0;
    const inverseRefused = customTransaction(
      {
        assertAction: (_path: string, action: string) => {
          if (action === "remove") throw new Error("remove refused");
        },
      },
      {
        beforeEffects: () => {
          beforeCalls += 1;
        },
        afterEffects: () => {
          afterCalls += 1;
          throw new Error("after refused");
        },
      },
    );
    expect(() =>
      inverseRefused.commit([
        {
          action: "write",
          path: "created.txt",
          mode: 0o600,
          contents: Buffer.from("created"),
          expect: { absent: true },
        },
      ] as never),
    ).toThrow("remove refused");
    expect(beforeCalls).toBe(0);
    expect(afterCalls).toBe(0);
    expect(existsSync(join(root, "created.txt"))).toBe(false);

    const assertionRefused = customTransaction(
      {
        assertAction: (_path: string, action: string) => {
          if (action === "assert") throw new Error("assert refused");
        },
      },
      {
        beforeEffects: () => {
          beforeCalls += 1;
        },
      },
    );
    expect(() =>
      assertionRefused.commit([
        {
          action: "write",
          path: "assertion.txt",
          mode: 0o600,
          contents: Buffer.from("created"),
          expect: { absent: true },
        },
      ] as never),
    ).toThrow("assert refused");
    expect(beforeCalls).toBe(0);
    expect(existsSync(join(root, "assertion.txt"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "preserves an operator mode change while rolling back later effects",
    () => {
      const generated = join(root, "generated.txt");
      expect(() =>
        customTransaction().commit([
          {
            action: "write",
            path: "generated.txt",
            mode: 0o644,
            contents: Buffer.from("generated"),
            expect: { absent: true },
          },
          {
            action: "write",
            path: "later.txt",
            mode: 0o600,
            contents: Buffer.from("later"),
            expect: { absent: true },
            announce: () => {
              chmodSync(generated, 0o600);
              throw new Error("later refused");
            },
          },
        ] as never),
      ).toThrow("rollback did not restore");
      expect(readFileSync(generated, "utf8")).toBe("generated");
      expect(lstatSync(generated).mode & 0o777).toBe(0o600);
      expect(existsSync(join(root, "later.txt"))).toBe(false);
    },
  );
});
