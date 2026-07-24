import type { BigIntStats, PathLike, Stats } from "node:fs";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import { LinuxAdapter } from "../../src/platform/linux.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    fstatSync: vi.fn(actual.fstatSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    statSync: vi.fn(actual.statSync),
  };
});

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const FAKE_PEM = "-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n";

function adapter(anchorDirs: readonly string[] = [], bundlePaths: readonly string[] = []) {
  return new LinuxAdapter(
    fakeRunner(() => undefined),
    {},
    anchorDirs,
    bundlePaths,
  );
}

function realStat(path: PathLike, options?: { bigint?: boolean }): Stats | BigIntStats {
  return options?.bigint ? actualFs.statSync(path, { bigint: true }) : actualFs.statSync(path);
}

function changedMtime(stats: BigIntStats): BigIntStats {
  return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
    mtimeNs: stats.mtimeNs + 1n,
  });
}

beforeEach(() => {
  vi.mocked(closeSync).mockReset().mockImplementation(actualFs.closeSync);
  vi.mocked(fstatSync).mockReset().mockImplementation(actualFs.fstatSync);
  vi.mocked(openSync).mockReset().mockImplementation(actualFs.openSync);
  vi.mocked(readSync).mockReset().mockImplementation(actualFs.readSync);
  vi.mocked(statSync).mockReset().mockImplementation(actualFs.statSync);
});

describe("Linux root inventory fault handling", () => {
  it("returns no partial inventory when aggregate certificate entries overflow", async () => {
    const anchors = mkdtempSync(join(tmpdir(), "aih-root-entry-overflow-"));
    try {
      for (const name of ["a.crt", "b.crt", "c.crt"]) {
        writeFileSync(join(anchors, name), FAKE_PEM.repeat(400));
      }

      expect(await adapter([anchors]).trustStoreRoots()).toEqual([]);
    } finally {
      rmSync(anchors, { recursive: true, force: true });
    }
  });

  it("rejects inventory when the pathname resolves to a replacement after reading", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-root-path-replacement-"));
    try {
      const bundle = join(root, "bundle.crt");
      const replacement = join(root, "replacement.crt");
      writeFileSync(bundle, FAKE_PEM);
      writeFileSync(replacement, FAKE_PEM);
      let statCalls = 0;
      vi.mocked(statSync).mockImplementation(((path: PathLike, options?: { bigint?: boolean }) => {
        statCalls += 1;
        return statCalls === 2 ? realStat(replacement, options) : realStat(path, options);
      }) as typeof statSync);

      expect(await adapter([], [bundle]).trustStoreRoots()).toEqual([]);
      expect(statCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a nanosecond-only metadata mutation during reading", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-root-metadata-mutation-"));
    try {
      const bundle = join(root, "bundle.crt");
      writeFileSync(bundle, FAKE_PEM);
      let bigintCalls = 0;
      vi.mocked(fstatSync).mockImplementation(((fd: number, options?: { bigint?: boolean }) => {
        if (!options?.bigint) return actualFs.fstatSync(fd);
        bigintCalls += 1;
        const stats = actualFs.fstatSync(fd, { bigint: true });
        return bigintCalls === 2 ? changedMtime(stats) : stats;
      }) as typeof fstatSync);

      expect(await adapter([], [bundle]).trustStoreRoots()).toEqual([]);
      expect(bigintCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns no inventory after a short read", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-root-short-read-"));
    try {
      const bundle = join(root, "bundle.crt");
      writeFileSync(bundle, FAKE_PEM);
      vi.mocked(readSync).mockReturnValueOnce(0);

      expect(await adapter([], [bundle]).trustStoreRoots()).toEqual([]);
      expect(readSync).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns no inventory after a close failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-root-close-failure-"));
    try {
      const bundle = join(root, "bundle.crt");
      writeFileSync(bundle, FAKE_PEM);
      vi.mocked(closeSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("close failed"), { code: "EIO" });
      });

      expect(await adapter([], [bundle]).trustStoreRoots()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a blocking special file before attempting to open it", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-root-special-file-"));
    try {
      const bundle = join(root, "bundle.crt");
      writeFileSync(bundle, FAKE_PEM);
      const special = Object.assign(
        Object.create(Object.getPrototypeOf(actualFs.statSync(bundle))),
        actualFs.statSync(bundle),
        { isFile: () => false },
      ) as Stats;
      vi.mocked(statSync).mockReturnValueOnce(special);

      expect(await adapter([], [bundle]).trustStoreRoots()).toEqual([]);
      expect(openSync).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
