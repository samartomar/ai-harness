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

  it.skipIf(process.platform === "win32")(
    "preserves an operator mode change while rolling back later effects",
    () => {
      const generated = join(root, "generated.txt");
      expect(() =>
        transaction().commit([
          {
            path: "generated.txt",
            mode: 0o644,
            contents: Buffer.from("generated"),
            expect: { absent: true },
          },
          {
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
