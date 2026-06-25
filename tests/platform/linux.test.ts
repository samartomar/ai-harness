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
});
