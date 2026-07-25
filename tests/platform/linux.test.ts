import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import { countPhysicalCores, LinuxAdapter, parseMemTotalKb } from "../../src/platform/linux.js";

const FAKE_PEM = "-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n";

describe("Linux parsers", () => {
  it("counts unique (physical id, core id) pairs", () => {
    const cpuinfo = [
      "processor\t: 0\nphysical id\t: 0\ncore id\t: 0",
      "processor\t: 1\nphysical id\t: 0\ncore id\t: 1",
      "processor\t: 2\nphysical id\t: 0\ncore id\t: 0",
    ].join("\n\n");
    expect(countPhysicalCores(cpuinfo)).toBe(2);
  });

  it("falls back to processor count without topology info", () => {
    expect(countPhysicalCores("processor\t: 0\n\nprocessor\t: 1\n")).toBe(2);
  });

  it("parses MemTotal in kB", () => {
    expect(parseMemTotalKb("MemTotal:   32768000 kB\n")).toBe(32768000);
  });
});

describe("LinuxAdapter", () => {
  it("detects VDI from remote-desktop env markers", () => {
    const a = new LinuxAdapter(
      fakeRunner(() => undefined),
      { XRDP_SESSION: "1" },
    );
    expect(a.detectVdi().isVdi).toBe(true);
  });

  it("honors an explicit AIH_VDI_KIND declaration (wires the workspaces kind)", () => {
    const a = new LinuxAdapter(
      fakeRunner(() => undefined),
      { AIH_VDI_KIND: "workspaces" },
    );
    expect(a.detectVdi()).toMatchObject({ isVdi: true, kind: "workspaces" });
  });

  it("is marked verified (smoke-tested on real Linux metal)", () => {
    expect(
      new LinuxAdapter(
        fakeRunner(() => undefined),
        {},
      ).verified,
    ).toBe(true);
  });

  it("matches a corporate CA by SUBJECT when the filename lacks the pattern (openssl)", async () => {
    const anchors = mkdtempSync(join(tmpdir(), "aih-anchors-"));
    try {
      // filename 'corp-root.crt' does NOT contain 'acme', but the cert subject does.
      writeFileSync(join(anchors, "corp-root.crt"), FAKE_PEM);
      const run = fakeRunner((argv) =>
        argv[0] === "openssl" ? { code: 0, stdout: "subject=CN = Acme Corp Root\n" } : undefined,
      );
      const a = new LinuxAdapter(run, {}, [anchors]);
      const certs = await a.trustStoreCerts("Acme");
      expect(certs).toHaveLength(1);
      expect(certs[0]?.pem).toContain("BEGIN CERTIFICATE");
    } finally {
      rmSync(anchors, { recursive: true, force: true });
    }
  });

  it("does not match when neither filename nor subject contains the pattern", async () => {
    const anchors = mkdtempSync(join(tmpdir(), "aih-anchors-"));
    try {
      writeFileSync(join(anchors, "public-root.crt"), FAKE_PEM);
      const run = fakeRunner((argv) =>
        argv[0] === "openssl" ? { code: 0, stdout: "subject=CN = Public Root\n" } : undefined,
      );
      const a = new LinuxAdapter(run, {}, [anchors]);
      expect(await a.trustStoreCerts("Acme")).toHaveLength(0);
    } finally {
      rmSync(anchors, { recursive: true, force: true });
    }
  });

  it("still matches by filename when openssl is absent (no hard dependency)", async () => {
    const anchors = mkdtempSync(join(tmpdir(), "aih-anchors-"));
    try {
      writeFileSync(join(anchors, "acme-root.crt"), FAKE_PEM);
      // openssl missing → spawnError; the filename contains 'acme', so it still matches.
      const run = fakeRunner((argv) =>
        argv[0] === "openssl" ? { spawnError: true, code: 127 } : undefined,
      );
      const a = new LinuxAdapter(run, {}, [anchors]);
      expect(await a.trustStoreCerts("acme")).toHaveLength(1);
    } finally {
      rmSync(anchors, { recursive: true, force: true });
    }
  });

  it("prefers a consolidated root bundle and deduplicates identical PEM blocks", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-root-bundle-"));
    try {
      const bundle = join(root, "ca-certificates.crt");
      writeFileSync(bundle, `${FAKE_PEM}${FAKE_PEM}`);
      const a = new LinuxAdapter(
        fakeRunner(() => undefined),
        {},
        [],
        [bundle],
      );

      const certs = await a.trustStoreRoots();

      expect(certs).toHaveLength(1);
      expect(certs[0]?.pem).toBe(FAKE_PEM);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes OpenSSL hashed certificate filenames in a fallback directory", async () => {
    const anchors = mkdtempSync(join(tmpdir(), "aih-hashed-anchors-"));
    try {
      writeFileSync(join(anchors, "d34db33f.0"), FAKE_PEM);
      const a = new LinuxAdapter(
        fakeRunner(() => undefined),
        {},
        [anchors],
        [],
      );

      const certs = await a.trustStoreRoots();

      expect(certs).toHaveLength(1);
      expect(certs[0]?.pem).toBe(FAKE_PEM);
    } finally {
      rmSync(anchors, { recursive: true, force: true });
    }
  });

  it("rejects an oversized consolidated bundle before materializing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-oversized-bundle-"));
    try {
      const bundle = join(root, "ca-certificates.crt");
      writeFileSync(bundle, `${FAKE_PEM}${"X".repeat(2 * 1024 * 1024)}`);
      const a = new LinuxAdapter(
        fakeRunner(() => undefined),
        {},
        [],
        [bundle],
      );

      expect(await a.trustStoreRoots()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a consolidated bundle with too many certificate entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-oversized-bundle-entries-"));
    try {
      const bundle = join(root, "ca-certificates.crt");
      writeFileSync(bundle, FAKE_PEM.repeat(1025));
      const a = new LinuxAdapter(
        fakeRunner(() => undefined),
        {},
        [],
        [bundle],
      );

      expect(await a.trustStoreRoots()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns no partial fallback inventory when one file exceeds its byte bound", async () => {
    const anchors = mkdtempSync(join(tmpdir(), "aih-oversized-anchor-file-"));
    try {
      writeFileSync(join(anchors, "a-valid.crt"), FAKE_PEM);
      writeFileSync(join(anchors, "b-oversized.crt"), `${FAKE_PEM}${"X".repeat(2 * 1024 * 1024)}`);
      const a = new LinuxAdapter(
        fakeRunner(() => undefined),
        {},
        [anchors],
        [],
      );

      expect(await a.trustStoreRoots()).toEqual([]);
    } finally {
      rmSync(anchors, { recursive: true, force: true });
    }
  });

  it("returns no partial fallback inventory when total bytes exceed the bound", async () => {
    const anchors = mkdtempSync(join(tmpdir(), "aih-oversized-anchor-total-"));
    try {
      for (const name of ["a.crt", "b.crt", "c.crt"]) {
        writeFileSync(join(anchors, name), `${FAKE_PEM}${"X".repeat(1536 * 1024)}`);
      }
      const a = new LinuxAdapter(
        fakeRunner(() => undefined),
        {},
        [anchors],
        [],
      );

      expect(await a.trustStoreRoots()).toEqual([]);
    } finally {
      rmSync(anchors, { recursive: true, force: true });
    }
  });

  it("rejects an oversized directory inventory without returning partial roots", async () => {
    const anchors = mkdtempSync(join(tmpdir(), "aih-oversized-anchor-dir-"));
    try {
      writeFileSync(join(anchors, "trusted.crt"), FAKE_PEM);
      for (let index = 0; index < 1025; index += 1) {
        writeFileSync(join(anchors, `ignored-${index}.txt`), "");
      }
      const a = new LinuxAdapter(
        fakeRunner(() => undefined),
        {},
        [anchors],
        [],
      );

      expect(await a.trustStoreRoots()).toEqual([]);
    } finally {
      rmSync(anchors, { recursive: true, force: true });
    }
  });
});
