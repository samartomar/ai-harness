import { describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import { countPhysicalCores, LinuxAdapter, parseMemTotalKb } from "../../src/platform/linux.js";

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

  it("is marked unverified", () => {
    expect(
      new LinuxAdapter(
        fakeRunner(() => undefined),
        {},
      ).verified,
    ).toBe(false);
  });
});
