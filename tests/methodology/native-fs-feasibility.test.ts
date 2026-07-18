import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createNativeFsProbeCapability,
  NativeFsCapabilityRecordSchema,
  NativeFsDispositionSchema,
  NativeFsObservationSchema,
  NativeFsPrimitiveSchema,
  NativeFsReasonCodeSchema,
  probeNativeFilesystem,
} from "../../src/methodology/native-fs-feasibility.js";

const require = createRequire(import.meta.url);
const addonPath = fileURLToPath(
  new URL("../../native/methodology-fs/build/Release/methodology_fs.node", import.meta.url),
);
const bindingGypPath = fileURLToPath(
  new URL("../../native/methodology-fs/binding.gyp", import.meta.url),
);
const linuxBackendPath = fileURLToPath(
  new URL("../../native/methodology-fs/src/backend_linux.c", import.meta.url),
);
const addonBuildAncestor = fileURLToPath(
  new URL("../../native/methodology-fs/build", import.meta.url),
);
const moduleUrl = new URL("../../src/methodology/native-fs-feasibility.ts", import.meta.url);
const primitiveOrder = [
  "identity-bound-file-publication",
  "no-replace-directory-publication",
  "identity-bound-file-detachment",
  "identity-bound-directory-detachment",
  "parent-directory-durability",
  "link-and-volume-containment",
  "substitution-resistance",
] as const;
const rawBlockedReport = JSON.stringify({
  schemaVersion: 1,
  nativeProtocolVersion: "phase-4a-native-observations-v1",
  observations: primitiveOrder.map((primitive) => ({
    primitive,
    disposition: "blocked",
    reason: "native-backend-unimplemented",
  })),
});
const linuxDispositionReasons = [
  ["supported", "primitive-qualified"],
  ["supported", "primitive-qualified"],
  ["unsupported", "identity-bound-file-detachment-unavailable"],
  ["unsupported", "identity-bound-directory-detachment-unavailable"],
  ["supported", "primitive-qualified"],
  ["supported", "primitive-qualified"],
  ["unsupported", "substitution-resistance-unavailable"],
] as const;
const rawLinuxReport = JSON.stringify({
  schemaVersion: 1,
  nativeProtocolVersion: "phase-4a-native-observations-v1",
  observations: primitiveOrder.map((primitive, index) => ({
    primitive,
    disposition: linuxDispositionReasons[index]?.[0],
    reason: linuxDispositionReasons[index]?.[1],
  })),
});
const rawOutsideRootReport = JSON.stringify({
  schemaVersion: 1,
  nativeProtocolVersion: "phase-4a-native-observations-v1",
  observations: primitiveOrder.map((primitive) => ({
    primitive,
    disposition: "blocked",
    reason: "root-outside-temporary-directory",
  })),
});
const expectedPlatformRawReport = process.platform === "linux" ? rawLinuxReport : rawBlockedReport;
const expectedPlatformReasons =
  process.platform === "linux"
    ? linuxDispositionReasons.map(([, reason]) => reason)
    : primitiveOrder.map(() => "native-backend-unimplemented");

function withCapability<T>(
  run: (root: string, capability: ReturnType<typeof createNativeFsProbeCapability>) => T,
): T {
  const capability = createNativeFsProbeCapability();
  try {
    return run(capability.root, capability);
  } finally {
    capability.dispose();
  }
}

function allBlockedReasons(record: ReturnType<typeof probeNativeFilesystem>): string[] {
  return record.observations.map((observation) => observation.reason);
}

function rawReasons(raw: string): string[] {
  const parsed = JSON.parse(raw) as {
    observations: Array<{ disposition: string; reason: string }>;
  };
  return parsed.observations.map(({ disposition, reason }) => `${disposition}/${reason}`);
}

describe.sequential("native methodology filesystem feasibility", () => {
  it.runIf(process.platform === "linux")(
    "probes Linux primitives deterministically and leaves the qualified root empty",
    () => {
      const addon = require(addonPath) as { probe(root: string): string };
      const expected = linuxDispositionReasons.map(
        ([disposition, reason]) => `${disposition}/${reason}`,
      );

      withCapability((root) => {
        const first = addon.probe(root);
        expect(readdirSync(root)).toEqual([]);
        const second = addon.probe(root);
        expect(readdirSync(root)).toEqual([]);
        expect(rawReasons(first)).toEqual(expected);
        expect(second).toBe(first);
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "blocks direct outside-temp and linked roots before making any change",
    () => {
      const addon = require(addonPath) as { probe(root: string): string };
      const linkedTarget = mkdtempSync(join(realpathSync(tmpdir()), "aih-linux-linked-target-"));
      const linkedRoot = mkdtempSync(join(realpathSync(tmpdir()), "aih-methodology-native-fs-"));
      const outside = [process.cwd(), homedir(), "/", "relative-root"];
      try {
        rmdirSync(linkedRoot);
        symlinkSync(linkedTarget, linkedRoot, "dir");
        for (const candidate of outside) {
          expect(rawReasons(addon.probe(candidate))).toEqual(
            primitiveOrder.map(() => "blocked/root-outside-temporary-directory"),
          );
        }
        expect(rawReasons(addon.probe(linkedRoot))).toEqual(
          primitiveOrder.map(() => "blocked/root-linked"),
        );
        expect(readdirSync(linkedTarget)).toEqual([]);
      } finally {
        rmSync(linkedRoot, { force: true });
        rmdirSync(linkedTarget);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps the Linux backend bounded and maps missing primitives without a fallback",
    () => {
      const source = readFileSync(linuxBackendPath, "utf8");
      expect(source).toContain("SYS_openat2");
      expect(source).toContain("RESOLVE_BENEATH");
      expect(source).toContain("RESOLVE_NO_SYMLINKS");
      expect(source).toContain("RESOLVE_NO_MAGICLINKS");
      expect(source).toContain("AT_EMPTY_PATH");
      expect(source).toContain("O_TMPFILE");
      expect(source).toContain("SYS_renameat2");
      expect(source).toContain("RENAME_NOREPLACE");
      expect(source).toContain("SYS_statx");
      expect(source).toContain("STATX_MNT_ID");
      expect(source).toMatch(/ENOSYS[\s\S]+AIH_UNSUPPORTED/);
      expect(source).toMatch(/EOPNOTSUPP|ENOTSUP/);
      expect(source).not.toMatch(
        /\/proc|\bsystem\s*\(|\bpopen\s*\(|\bexec[lvpe]*\s*\(|getenv\s*\(/,
      );
    },
  );

  it("rejects a preloaded unowned native addon cache entry", () => {
    const addon = require(addonPath) as { probe?: unknown };
    try {
      const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
      expect(record.state).toBe("blocked");
      expect(allBlockedReasons(record)).toEqual(
        primitiveOrder.map(() => "native-addon-abi-mismatch"),
      );
    } finally {
      delete require.cache[addonPath];
    }
    expect(Object.keys(addon)).toEqual(["probe"]);
    expect(typeof addon.probe).toBe("function");
    if (typeof addon.probe !== "function") {
      throw new TypeError("expected native probe export");
    }
    const probe = addon.probe;

    expect(withCapability((root) => probe(root))).toBe(expectedPlatformRawReport);
    expect(Object.getOwnPropertyDescriptor(addon, "probe")).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false,
    });
    expect(() => probe()).toThrow(TypeError);
    expect(() => probe(42)).toThrow(TypeError);
    expect(() => probe("contains\0nul")).toThrow(TypeError);
    for (const malformed of ["\uD800", "\uDC00", "\uDC00\uD800", "\uD800x"]) {
      expect(() => probe(malformed)).toThrow(TypeError);
    }
    expect(() => probe("x".repeat(4_097))).toThrow(RangeError);
    expect(() => probe("\u{1F600}".repeat(1_025))).toThrow(RangeError);
    expect(() => probe("root", "unexpected")).toThrow(TypeError);
    expect(probe("root-\u{1F600}")).toBe(rawOutsideRootReport);
    expect(withCapability((root) => probe(root))).toBe(expectedPlatformRawReport);
  });

  it("selects exactly one planned platform backend at build time", () => {
    const binding = JSON.parse(readFileSync(bindingGypPath, "utf8")) as {
      targets?: Array<{
        conditions?: Array<
          [string, { defines?: string[]; sources?: string[]; xcode_settings?: unknown }]
        >;
      }>;
    };
    const selections = (binding.targets?.[0]?.conditions ?? [])
      .filter(([condition]) => ["OS=='linux'", "OS=='win'", "OS=='mac'"].includes(condition))
      .map(([condition, configuration]) => ({
        condition,
        defines: configuration.defines,
        sources: configuration.sources,
      }));

    expect(selections).toEqual([
      {
        condition: "OS=='linux'",
        defines: ["AIH_NATIVE_FS_BACKEND_LINUX=1"],
        sources: ["src/backend_linux.c"],
      },
      {
        condition: "OS=='win'",
        defines: ["AIH_NATIVE_FS_BACKEND_WINDOWS=1"],
        sources: ["src/backend_windows.c"],
      },
      {
        condition: "OS=='mac'",
        defines: ["AIH_NATIVE_FS_BACKEND_DARWIN=1"],
        sources: ["src/backend_darwin.c"],
      },
    ]);
    const selectedSources = selections.flatMap(({ sources }) => sources ?? []);
    expect(new Set(selectedSources).size).toBe(3);
    for (const source of selectedSources) {
      expect(existsSync(resolve(bindingGypPath, "..", source))).toBe(true);
    }
  });

  it("fails closed for a mocked missing addon without mutating the checkout", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0], options?: unknown) {
        if (path === addonPath) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return actualFs.lstatSync(path, options as never);
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        const record = isolated.probeNativeFilesystem(capability);
        expect(allBlockedReasons(record)).toEqual(
          primitiveOrder.map(() => "native-addon-unavailable"),
        );
      } finally {
        capability.dispose();
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("fails closed for a mocked native load failure without mutating the checkout", async () => {
    const actualModule = await vi.importActual<typeof import("node:module")>("node:module");
    vi.doMock("node:module", () => ({
      ...actualModule,
      createRequire() {
        const failingRequire = (() => {
          throw new Error("mocked native load failure");
        }) as unknown as NodeRequire;
        failingRequire.cache = Object.create(null) as NodeJS.Dict<NodeModule>;
        return failingRequire;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        const record = isolated.probeNativeFilesystem(capability);
        expect(allBlockedReasons(record)).toEqual(
          primitiveOrder.map(() => "native-addon-load-failed"),
        );
      } finally {
        capability.dispose();
      }
    } finally {
      vi.doUnmock("node:module");
      vi.resetModules();
    }
  });

  it("fails closed when mocked addon identity changes across native loading", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let addonStats = 0;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0], options?: unknown) {
        const stat = actualFs.lstatSync(path, options as never);
        if (path !== addonPath) return stat;
        addonStats += 1;
        return addonStats >= 3
          ? {
              ...stat,
              ino: (stat as unknown as import("node:fs").BigIntStats).ino + 1n,
            }
          : stat;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        const record = isolated.probeNativeFilesystem(capability);
        expect(allBlockedReasons(record)).toEqual(
          primitiveOrder.map(() => "native-addon-abi-mismatch"),
        );
      } finally {
        capability.dispose();
      }
    } finally {
      delete require.cache[addonPath];
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects an external ancestor symlink before native loading or cache insertion", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const actualModule = await vi.importActual<typeof import("node:module")>("node:module");
    const externalRoot = mkdtempSync(join(realpathSync(tmpdir()), "aih-native-ancestor-"));
    const externalTarget = join(externalRoot, "external-target");
    const externalLink = join(externalRoot, "ancestor-link");
    mkdirSync(externalTarget, { mode: 0o700 });
    writeFileSync(join(externalTarget, "methodology_fs.node"), "must not load", { mode: 0o600 });
    symlinkSync(externalTarget, externalLink, process.platform === "win32" ? "junction" : "dir");
    let nativeLoads = 0;
    const cache = Object.create(null) as NodeJS.Dict<NodeModule>;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0], options?: unknown) {
        return actualFs.lstatSync(
          path === addonBuildAncestor ? externalLink : path,
          options as never,
        );
      },
    }));
    vi.doMock("node:module", () => ({
      ...actualModule,
      createRequire() {
        const fakeRequire = (() => {
          nativeLoads += 1;
          throw new Error("native loader must not run");
        }) as unknown as NodeRequire;
        fakeRequire.cache = cache;
        return fakeRequire;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        const record = isolated.probeNativeFilesystem(capability);
        expect(allBlockedReasons(record)).toEqual(
          primitiveOrder.map(() => "native-addon-ancestor-invalid"),
        );
        expect(record.nativeLoader).toEqual({
          identityBound: false,
          disposition: "blocked",
          reason: "native-loader-not-identity-bound",
        });
      } finally {
        capability.dispose();
      }
      expect(nativeLoads).toBe(0);
      expect(Object.keys(cache)).toEqual([]);
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:module");
      vi.resetModules();
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("blocks an oversized addon before reading bytes or invoking the native loader", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const actualModule = await vi.importActual<typeof import("node:module")>("node:module");
    let reads = 0;
    let nativeLoads = 0;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0], options?: unknown) {
        const stat = actualFs.lstatSync(path, options as never);
        return path === addonPath ? { ...stat, size: 1_000_000_000n } : stat;
      },
      readFileSync(...args: Parameters<typeof actualFs.readFileSync>) {
        reads += 1;
        return actualFs.readFileSync(...args);
      },
    }));
    vi.doMock("node:module", () => ({
      ...actualModule,
      createRequire() {
        const fakeRequire = (() => {
          nativeLoads += 1;
          throw new Error("oversized addon must not load");
        }) as unknown as NodeRequire;
        fakeRequire.cache = Object.create(null) as NodeJS.Dict<NodeModule>;
        return fakeRequire;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        const record = isolated.probeNativeFilesystem(capability);
        expect(allBlockedReasons(record)).toEqual(
          primitiveOrder.map(() => "native-addon-oversized"),
        );
      } finally {
        capability.dispose();
      }
      expect(reads).toBe(0);
      expect(nativeLoads).toBe(0);
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:module");
      vi.resetModules();
    }
  });

  it("keeps a descriptor-less capability live without pathname removal or revocation", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync() {
        throw new Error("descriptor unavailable");
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      const authenticRoot = `${capability.root}.authentic`;
      renameSync(capability.root, authenticRoot);
      mkdirSync(capability.root, { mode: 0o700 });
      capability.dispose();
      expect(existsSync(capability.root)).toBe(true);
      expect(existsSync(authenticRoot)).toBe(true);
      expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
        primitiveOrder.map(() => "root-identity-drift"),
      );
      rmdirSync(capability.root);
      renameSync(authenticRoot, capability.root);
      capability.dispose();
      expect(existsSync(capability.root)).toBe(true);
      expect(() => isolated.probeNativeFilesystem(capability)).not.toThrow();
      rmdirSync(capability.root);
      delete require.cache[addonPath];
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("mints an opaque private capability under the actual operating-system temporary root", () => {
    const capability = createNativeFsProbeCapability();
    const root = capability.root;
    const tempRoot = resolve(realpathSync(tmpdir()));
    try {
      const pathFromTemp = relative(tempRoot, root);
      expect(pathFromTemp).not.toBe("");
      expect(pathFromTemp.startsWith("..")).toBe(false);
      const stat = lstatSync(root);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
      }
      expect(Object.isFrozen(capability)).toBe(true);
    } finally {
      capability.dispose();
    }
    expect(existsSync(root)).toBe(false);
  });

  it("turns the platform backend into a complete ordered blocked aggregate record", () => {
    const { first, second } = withCapability((_root, capability) => ({
      first: probeNativeFilesystem(capability),
      second: probeNativeFilesystem(capability, { addonPath }),
    }));

    expect(first.schemaVersion).toBe(1);
    expect(first.probeVersion).toBe("phase-4a-native-fs-v1");
    expect(first.state).toBe("blocked");
    expect(first.nativeLoader).toEqual({
      identityBound: false,
      disposition: "blocked",
      reason: "native-loader-not-identity-bound",
    });
    expect(first.platform).toEqual({
      os: process.platform,
      architecture: process.arch,
      runtime: "node",
      runtimeVersion: process.versions.node,
      nodeApiVersion: process.versions.napi,
    });
    expect(first.observations.map(({ primitive }) => primitive)).toEqual(primitiveOrder);
    expect(allBlockedReasons(first)).toEqual(expectedPlatformReasons);
    expect(first.boundary).toEqual({
      cli: false,
      executor: false,
      providerExecution: false,
      hostExecution: false,
      network: false,
      nonTemporaryWrites: false,
    });
    expect(NativeFsCapabilityRecordSchema.safeParse(first).success).toBe(true);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const addon = require(addonPath) as { probe?: unknown };
    expect(Object.isFrozen(addon)).toBe(true);
    expect(() =>
      Object.defineProperty(addon, "probe", {
        value() {
          return "forged";
        },
      }),
    ).toThrow();
  });

  it("does not resolve the native addon from an attacker-controlled working directory", () => {
    const attackerRoot = mkdtempSync(join(realpathSync(tmpdir()), "aih-native-cwd-attacker-"));
    const attackerAddon = join(
      attackerRoot,
      "native",
      "methodology-fs",
      "build",
      "Release",
      "methodology_fs.node",
    );
    mkdirSync(resolve(attackerAddon, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(attackerAddon, "attacker-controlled native bytes", { mode: 0o600 });
    const script = `
      const module = await import(${JSON.stringify(pathToFileURL(fileURLToPath(moduleUrl)).href)});
      const capability = module.createNativeFsProbeCapability();
      try {
        const record = module.probeNativeFilesystem(capability);
        process.stdout.write(JSON.stringify(record.observations.map((item) => item.reason)));
      } finally {
        capability.dispose();
      }
    `;
    try {
      const child = spawnSync(
        process.execPath,
        ["--import", require.resolve("tsx"), "--input-type=module", "-e", script],
        {
          cwd: attackerRoot,
          encoding: "utf8",
        },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(expectedPlatformReasons);
    } finally {
      rmSync(attackerRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the owned module cache or exports identity is replaced", () => {
    const first = withCapability((_root, capability) => probeNativeFilesystem(capability));
    expect(allBlockedReasons(first)).toEqual(expectedPlatformReasons);
    const ownedModule = require.cache[addonPath];
    if (ownedModule === undefined) throw new Error("owned addon cache entry is missing");
    const originalExports = ownedModule.exports;
    ownedModule.exports = {
      probe() {
        return "forged supported report";
      },
    };
    try {
      const blocked = withCapability((_root, capability) => probeNativeFilesystem(capability));
      expect(allBlockedReasons(blocked)).toEqual(
        primitiveOrder.map(() => "native-addon-abi-mismatch"),
      );
    } finally {
      ownedModule.exports = originalExports;
    }

    const forgedModule = { ...ownedModule, exports: originalExports } as NodeModule;
    require.cache[addonPath] = forgedModule;
    try {
      const blocked = withCapability((_root, capability) => probeNativeFilesystem(capability));
      expect(allBlockedReasons(blocked)).toEqual(
        primitiveOrder.map(() => "native-addon-abi-mismatch"),
      );
    } finally {
      require.cache[addonPath] = ownedModule;
    }
  });

  it("fails closed for malformed native reports and accepts only a fully bound report", async () => {
    const actualModule = await vi.importActual<typeof import("node:module")>("node:module");
    let call = 0;
    const rawReport = () => ({
      schemaVersion: 1,
      nativeProtocolVersion: "phase-4a-native-observations-v1",
      observations: primitiveOrder.map((primitive) => ({
        primitive,
        disposition: "blocked",
        reason: "native-backend-unimplemented",
      })),
    });
    vi.doMock("node:module", () => ({
      ...actualModule,
      createRequire() {
        const cache = Object.create(null) as NodeJS.Dict<NodeModule>;
        const fakeRequire = ((path: string) => {
          const exports = {
            probe(_root: string): unknown {
              call += 1;
              if (call === 1) return 7;
              if (call === 2) return "x".repeat(65_537);
              if (call === 3) return "{";
              if (call === 4) {
                return JSON.stringify({
                  ...rawReport(),
                  observations: rawReport().observations.slice(0, 6),
                });
              }
              if (call === 5) {
                const report = rawReport();
                return JSON.stringify({
                  ...report,
                  observations: [...report.observations.slice(0, 6), report.observations[0]],
                });
              }
              if (call === 6) {
                const report = rawReport();
                return JSON.stringify({
                  ...report,
                  observations: [...report.observations].reverse(),
                });
              }
              if (call === 7) {
                const report = rawReport();
                return JSON.stringify({
                  ...report,
                  observations: [
                    { ...report.observations[0], reason: "unknown-reason" },
                    ...report.observations.slice(1),
                  ],
                });
              }
              if (call === 8) {
                const report = rawReport();
                return JSON.stringify({
                  ...report,
                  observations: [
                    { ...report.observations[0], primitive: "unknown-primitive" },
                    ...report.observations.slice(1),
                  ],
                });
              }
              if (call === 9) return JSON.stringify({ ...rawReport(), extra: true });
              if (call === 10) throw new Error("native probe failure");
              return JSON.stringify(rawReport());
            },
          };
          cache[path] = { exports } as NodeModule;
          return exports;
        }) as unknown as NodeRequire;
        fakeRequire.cache = cache;
        return fakeRequire;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const reasons: string[] = [];
      for (let index = 0; index < 11; index += 1) {
        const capability = isolated.createNativeFsProbeCapability();
        try {
          reasons.push(isolated.probeNativeFilesystem(capability).observations[0]?.reason ?? "");
        } finally {
          capability.dispose();
        }
      }
      expect(reasons).toEqual([
        "native-report-invalid",
        "native-report-oversized",
        "native-report-invalid",
        "native-report-invalid",
        "native-report-invalid",
        "native-report-invalid",
        "native-report-invalid",
        "native-report-invalid",
        "native-report-invalid",
        "native-operation-failed",
        "native-backend-unimplemented",
      ]);
    } finally {
      vi.doUnmock("node:module");
      vi.resetModules();
    }
  });

  it("exports closed scalar and observation schemas", () => {
    expect(NativeFsPrimitiveSchema.safeParse(primitiveOrder[0]).success).toBe(true);
    expect(NativeFsPrimitiveSchema.safeParse("other").success).toBe(false);
    expect(NativeFsDispositionSchema.safeParse("blocked").success).toBe(true);
    expect(NativeFsDispositionSchema.safeParse("active").success).toBe(false);
    expect(NativeFsReasonCodeSchema.safeParse("native-backend-unimplemented").success).toBe(true);
    expect(NativeFsReasonCodeSchema.safeParse("unknown-reason").success).toBe(false);
    expect(
      NativeFsObservationSchema.safeParse({
        primitive: primitiveOrder[0],
        primitiveVersion: "phase-4a-primitive-v1",
        disposition: "blocked",
        reason: "native-backend-unimplemented",
      }).success,
    ).toBe(true);
    expect(
      NativeFsObservationSchema.safeParse({
        primitive: primitiveOrder[0],
        primitiveVersion: "phase-4a-primitive-v1",
        disposition: "blocked",
        reason: "native-backend-unimplemented",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      NativeFsObservationSchema.safeParse({
        primitive: primitiveOrder[0],
        primitiveVersion: "phase-4a-primitive-v1",
        disposition: "supported",
        reason: "native-backend-unimplemented",
      }).success,
    ).toBe(false);
    expect(
      NativeFsObservationSchema.safeParse({
        primitive: primitiveOrder[0],
        primitiveVersion: "phase-4a-primitive-v1",
        disposition: "unsupported",
        reason: "native-operation-failed",
      }).success,
    ).toBe(false);
  });

  it("binds each unsupported reason to exactly one primitive", () => {
    const unsupportedReasons = [
      "identity-bound-file-publication-unavailable",
      "no-replace-directory-publication-unavailable",
      "identity-bound-file-detachment-unavailable",
      "identity-bound-directory-detachment-unavailable",
      "parent-directory-durability-unavailable",
      "link-and-volume-containment-unavailable",
      "substitution-resistance-unavailable",
    ] as const;
    for (let primitiveIndex = 0; primitiveIndex < primitiveOrder.length; primitiveIndex += 1) {
      for (let reasonIndex = 0; reasonIndex < unsupportedReasons.length; reasonIndex += 1) {
        const parsed = NativeFsObservationSchema.safeParse({
          primitive: primitiveOrder[primitiveIndex],
          primitiveVersion: "phase-4a-primitive-v1",
          disposition: "unsupported",
          reason: unsupportedReasons[reasonIndex],
        });
        expect(parsed.success).toBe(primitiveIndex === reasonIndex);
      }
    }
  });

  it("rejects duplicate, missing, reordered, unknown, and oversized records", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const invalid = [
      { ...record, extra: true },
      { ...record, observations: record.observations.slice(0, 6) },
      { ...record, observations: [...record.observations, record.observations[0]] },
      { ...record, observations: [...record.observations].reverse() },
      {
        ...record,
        observations: [
          { ...record.observations[0], reason: "unknown-reason" },
          ...record.observations.slice(1),
        ],
      },
      { ...record, nativeComponentVersion: "x".repeat(4_097) },
    ];
    for (const candidate of invalid) {
      expect(NativeFsCapabilityRecordSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("canonicalizes reverse key insertion order to byte-identical schema output", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const reversed = Object.fromEntries(Object.entries(record).reverse());
    const parsed = NativeFsCapabilityRecordSchema.parse(reversed);

    expect(JSON.stringify(parsed)).toBe(JSON.stringify(record));
  });

  it("supports the complete safe Zod facade and rejects hostile array surfaces", async () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    expect((await NativeFsCapabilityRecordSchema.parseAsync(record)).schemaVersion).toBe(1);
    expect((await NativeFsCapabilityRecordSchema.decodeAsync(record)).schemaVersion).toBe(1);
    expect((await NativeFsCapabilityRecordSchema.safeParseAsync(record)).success).toBe(true);
    expect((await NativeFsCapabilityRecordSchema.safeDecodeAsync(record)).success).toBe(true);
    expect((await NativeFsCapabilityRecordSchema.spa(record)).success).toBe(true);
    await expect(NativeFsCapabilityRecordSchema.parseAsync(null)).rejects.toBeDefined();

    const oversized = new Array(17).fill(record.observations[0]);
    expect(
      NativeFsCapabilityRecordSchema.safeParse({ ...record, observations: oversized }).success,
    ).toBe(false);
    const accessorObservations = [...record.observations];
    Object.defineProperty(accessorObservations, "0", {
      enumerable: true,
      get() {
        throw new Error("array accessor must not run");
      },
    });
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...record,
        observations: accessorObservations,
      }).success,
    ).toBe(false);
  });

  it("preserves unsupported observations while blocking state and rejects mismatches", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const unsupportedReasons = [
      "identity-bound-file-publication-unavailable",
      "no-replace-directory-publication-unavailable",
      "identity-bound-file-detachment-unavailable",
      "identity-bound-directory-detachment-unavailable",
      "parent-directory-durability-unavailable",
      "link-and-volume-containment-unavailable",
      "substitution-resistance-unavailable",
    ] as const;
    const unsupported = {
      ...record,
      state: "blocked",
      observations: record.observations.map((observation, index) => ({
        ...observation,
        disposition: "unsupported",
        reason: unsupportedReasons[index],
      })),
    };
    expect(NativeFsCapabilityRecordSchema.safeParse(unsupported).success).toBe(true);
    expect(
      NativeFsCapabilityRecordSchema.safeParse({ ...unsupported, state: "unsupported" }).success,
    ).toBe(false);
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...record,
        filesystemIdentity: {
          ...record.filesystemIdentity,
          scope: record.filesystemIdentity.scope === "volume" ? "filesystem" : "volume",
        },
      }).success,
    ).toBe(false);
  });

  it("blocks every primitive when filesystem identity is unavailable", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const forgedSupported = {
      ...record,
      state: "supported",
      filesystemIdentity: { ...record.filesystemIdentity, type: "unavailable" },
      observations: primitiveOrder.map((primitive) => ({
        primitive,
        primitiveVersion: "phase-4a-primitive-v1",
        disposition: "supported",
        reason: "primitive-qualified",
      })),
    };
    expect(NativeFsCapabilityRecordSchema.safeParse(forgedSupported).success).toBe(false);
  });

  it("keeps all backend observations visible but blocks state while the loader is unbound", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const observations = primitiveOrder.map((primitive) => ({
      primitive,
      primitiveVersion: "phase-4a-primitive-v1",
      disposition: "supported",
      reason: "primitive-qualified",
    }));
    const blocked = NativeFsCapabilityRecordSchema.parse({
      ...record,
      state: "blocked",
      observations,
    });
    expect(blocked.state).toBe("blocked");
    expect(blocked.observations.map((observation) => observation.disposition)).toEqual(
      primitiveOrder.map(() => "supported"),
    );
    expect(blocked.nativeLoader).toEqual({
      identityBound: false,
      disposition: "blocked",
      reason: "native-loader-not-identity-bound",
    });
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...blocked,
        state: "supported",
      }).success,
    ).toBe(false);
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...blocked,
        nativeLoader: {
          identityBound: true,
          disposition: "supported",
          reason: "primitive-qualified",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects proxies and accessors without invoking user code", () => {
    let calls = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          calls += 1;
          throw new Error("proxy hook was invoked");
        },
      },
    );
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "schemaVersion", {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("accessor was invoked");
      },
    });

    expect(NativeFsCapabilityRecordSchema.safeParse(proxy).success).toBe(false);
    expect(NativeFsCapabilityRecordSchema.safeParse(accessor).success).toBe(false);
    expect(calls).toBe(0);
  });

  it("rejects forged, disposed, and identity-drifted capabilities", () => {
    expect(() => probeNativeFilesystem({ root: tmpdir(), dispose() {} })).toThrow(/capability/i);

    const disposed = createNativeFsProbeCapability();
    disposed.dispose();
    expect(() => probeNativeFilesystem(disposed)).toThrow(/capability/i);

    const capability = createNativeFsProbeCapability();
    const originalRoot = `${capability.root}.original`;
    renameSync(capability.root, originalRoot);
    mkdirSync(capability.root, { mode: 0o700 });
    try {
      const record = probeNativeFilesystem(capability);
      expect(record.state).toBe("blocked");
      expect(allBlockedReasons(record)).toEqual(primitiveOrder.map(() => "root-identity-drift"));
    } finally {
      rmSync(capability.root, { recursive: true, force: true });
      renameSync(originalRoot, capability.root);
      capability.dispose();
    }
  });

  it("keeps disposal live after substitution and never recursively removes substitute content", () => {
    const capability = createNativeFsProbeCapability();
    const authenticRoot = `${capability.root}.authentic`;
    const substituteFile = join(capability.root, "must-survive.txt");
    renameSync(capability.root, authenticRoot);
    mkdirSync(capability.root, { mode: 0o700 });
    writeFileSync(substituteFile, "must survive", { mode: 0o600 });

    capability.dispose();
    expect(existsSync(authenticRoot)).toBe(true);
    expect(existsSync(substituteFile)).toBe(true);
    const stillLive = probeNativeFilesystem(capability);
    expect(allBlockedReasons(stillLive)).toEqual(primitiveOrder.map(() => "root-identity-drift"));

    rmSync(capability.root, { recursive: true, force: true });
    renameSync(authenticRoot, capability.root);
    capability.dispose();
    expect(existsSync(capability.root)).toBe(false);
    expect(() => probeNativeFilesystem(capability)).toThrow(/capability/i);
  });

  it("keeps a non-empty authentic root live until empty-root removal succeeds", () => {
    const capability = createNativeFsProbeCapability();
    const child = join(capability.root, "owned.txt");
    writeFileSync(child, "owned", { mode: 0o600 });
    capability.dispose();
    expect(existsSync(child)).toBe(true);
    expect(() => probeNativeFilesystem(capability)).not.toThrow();
    rmSync(child);
    capability.dispose();
    expect(existsSync(capability.root)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a capability root that is no longer private",
    () => {
      const capability = createNativeFsProbeCapability();
      chmodSync(capability.root, 0o755);
      try {
        const record = probeNativeFilesystem(capability);
        expect(record.state).toBe("blocked");
        expect(allBlockedReasons(record)).toEqual(primitiveOrder.map(() => "root-not-private"));
      } finally {
        chmodSync(capability.root, 0o700);
        capability.dispose();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symbolic-link substitution without following it",
    () => {
      const capability = createNativeFsProbeCapability();
      const originalRoot = `${capability.root}.original`;
      renameSync(capability.root, originalRoot);
      symlinkSync(originalRoot, capability.root, "dir");
      try {
        const record = probeNativeFilesystem(capability);
        expect(record.state).toBe("blocked");
        expect(allBlockedReasons(record)).toEqual(primitiveOrder.map(() => "root-identity-drift"));
      } finally {
        rmSync(capability.root, { force: true });
        renameSync(originalRoot, capability.root);
        capability.dispose();
      }
    },
  );

  it("rejects every non-canonical addon path before native loading", () => {
    const candidates = [
      join(process.cwd(), "package.json"),
      `${addonPath}.other`,
      resolve(addonPath, ".."),
    ];
    for (const candidate of candidates) {
      expect(() =>
        withCapability((_root, capability) =>
          probeNativeFilesystem(capability, { addonPath: candidate }),
        ),
      ).toThrow(/addon path/i);
    }
    expect(() =>
      withCapability((_root, capability) =>
        probeNativeFilesystem(
          capability,
          Object.create({ addonPath }) as Readonly<{ addonPath?: string }>,
        ),
      ),
    ).toThrow(/options/i);
    expect(() =>
      withCapability((_root, capability) =>
        probeNativeFilesystem(capability, { unexpected: addonPath } as never),
      ),
    ).toThrow(/options/i);
  });

  it("rejects accessor and proxy options without invoking hooks", () => {
    let calls = 0;
    const accessor = {} as { addonPath?: string };
    Object.defineProperty(accessor, "addonPath", {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("option accessor was invoked");
      },
    });
    const proxy = new Proxy(
      {},
      {
        get() {
          calls += 1;
          throw new Error("option proxy was invoked");
        },
      },
    );

    expect(() =>
      withCapability((_root, capability) => probeNativeFilesystem(capability, accessor)),
    ).toThrow(/options/i);
    expect(() =>
      withCapability((_root, capability) => probeNativeFilesystem(capability, proxy)),
    ).toThrow(/options/i);
    expect(calls).toBe(0);
  });

  it("does not invoke ambient Array prototype hooks", () => {
    const originalSort = Array.prototype.sort;
    const originalMap = Array.prototype.map;
    let calls = 0;
    let record: ReturnType<typeof probeNativeFilesystem> | undefined;
    let schemaSuccess: boolean | undefined;
    const baseline = withCapability((_root, capability) => probeNativeFilesystem(capability));
    Array.prototype.sort = function poisonedSort(): never {
      calls += 1;
      throw new Error("ambient sort invoked");
    };
    Array.prototype.map = function poisonedMap(): never {
      calls += 1;
      throw new Error("ambient map invoked");
    };
    try {
      record = withCapability((_root, capability) => probeNativeFilesystem(capability));
      schemaSuccess = NativeFsCapabilityRecordSchema.safeParse(baseline).success;
    } finally {
      Array.prototype.sort = originalSort;
      Array.prototype.map = originalMap;
    }
    expect(record?.state).toBe("blocked");
    expect(schemaSuccess).toBe(false);
    expect(calls).toBe(0);
  });
});
