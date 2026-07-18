import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
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
  watch,
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
const windowsBackendPath = fileURLToPath(
  new URL("../../native/methodology-fs/src/backend_windows.c", import.meta.url),
);
const darwinBackendPath = fileURLToPath(
  new URL("../../native/methodology-fs/src/backend_darwin.c", import.meta.url),
);
const addonBuildAncestor = fileURLToPath(
  new URL("../../native/methodology-fs/build", import.meta.url),
);
const addonBuildLinkPath = fileURLToPath(
  new URL(
    "../../native/methodology-fs/build/Release/obj.target/methodology_fs.node",
    import.meta.url,
  ),
);
const moduleUrl = new URL("../../src/methodology/native-fs-feasibility.ts", import.meta.url);
const tsxImportUrl = pathToFileURL(require.resolve("tsx")).href;
const NATIVE_CHILD_PROCESS_TIMEOUT_MS = 25_000;
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
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
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
const windowsDispositionReasons = [
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
] as const;
const rawWindowsReport = JSON.stringify({
  schemaVersion: 1,
  nativeProtocolVersion: "phase-4a-native-observations-v1",
  observations: primitiveOrder.map((primitive, index) => ({
    primitive,
    disposition: windowsDispositionReasons[index]?.[0],
    reason: windowsDispositionReasons[index]?.[1],
  })),
});
const darwinDispositionReasons = [
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
  ["blocked", "root-capability-unproven"],
] as const;
const rawDarwinReport = JSON.stringify({
  schemaVersion: 1,
  nativeProtocolVersion: "phase-4a-native-observations-v1",
  observations: primitiveOrder.map((primitive, index) => ({
    primitive,
    disposition: darwinDispositionReasons[index]?.[0],
    reason: darwinDispositionReasons[index]?.[1],
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
const expectedPlatformRawReport =
  process.platform === "linux"
    ? rawLinuxReport
    : process.platform === "win32"
      ? rawWindowsReport
      : process.platform === "darwin"
        ? rawDarwinReport
        : rawBlockedReport;
const expectedPlatformReasons =
  process.platform === "linux"
    ? linuxDispositionReasons.map(([, reason]) => reason)
    : process.platform === "win32"
      ? windowsDispositionReasons.map(([, reason]) => reason)
      : process.platform === "darwin"
        ? darwinDispositionReasons.map(([, reason]) => reason)
        : primitiveOrder.map(() => "native-backend-unimplemented");

function withCapability<T>(
  run: (root: string, capability: ReturnType<typeof createNativeFsProbeCapability>) => T,
): T {
  const capability = createNativeFsProbeCapability();
  try {
    return run(capability.root, capability);
  } finally {
    disposeCapabilityFixture(capability);
  }
}

function disposeCapabilityFixture(capability: { readonly root: string; dispose(): void }): void {
  const root = capability.root;
  capability.dispose();
  rmSync(root, { recursive: true, force: true });
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

function spawnNativeProbe(
  script: string,
  options?: Readonly<{ cwd?: string }>,
  timeout = NATIVE_CHILD_PROCESS_TIMEOUT_MS,
) {
  return spawnSync(
    process.execPath,
    ["--import", tsxImportUrl, "--input-type=module", "-e", script],
    { cwd: options?.cwd, encoding: "utf8", timeout },
  );
}

function syntheticBlockedRecord(os: "darwin" | "win32", scope: "filesystem" | "volume") {
  return NativeFsCapabilityRecordSchema.parse({
    schemaVersion: 1,
    probeVersion: "phase-4a-native-fs-v1",
    state: "blocked",
    platform: {
      os,
      architecture: process.arch,
      runtime: "node",
      runtimeVersion: process.versions.node,
      nodeApiVersion: process.versions.napi,
    },
    nativeComponentVersion: "phase-4a-native-fs-native-v1",
    nativeLoader: {
      identityBound: false,
      disposition: "blocked",
      reason: "native-loader-not-identity-bound",
    },
    nativeRootAuthority: {
      authenticated: false,
      disposition: "blocked",
      reason: "root-capability-unproven",
    },
    rootIdentity: { device: "1", file: "1" },
    filesystemIdentity: { scope, device: "1", type: "1" },
    observations: primitiveOrder.map((primitive) => ({
      primitive,
      primitiveVersion: "phase-4a-primitive-v1",
      disposition: "blocked",
      reason: "root-capability-unproven",
    })),
    boundary: {
      cli: false,
      executor: false,
      providerExecution: false,
      hostExecution: false,
      network: false,
      nonTemporaryWrites: false,
    },
  });
}

describe.sequential("native methodology filesystem feasibility", () => {
  it("bounds every native child-process probe", () => {
    const child = spawnNativeProbe(
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);",
      undefined,
      1_000,
    );

    expect((child.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
  });

  it.runIf(process.platform === "linux")(
    "blocks unauthenticated Linux roots deterministically and leaves them empty",
    () => {
      const addon = require(addonPath) as { probe(root: string): string };
      const expected = linuxDispositionReasons.map(
        ([disposition, reason]) => `${disposition}/${reason}`,
      );

      try {
        withCapability((root) => {
          const first = addon.probe(root);
          expect(readdirSync(root)).toEqual([]);
          const second = addon.probe(root);
          expect(readdirSync(root)).toEqual([]);
          expect(rawReasons(first)).toEqual(expected);
          expect(second).toBe(first);
        });
      } finally {
        delete require.cache[addonPath];
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "leaves a manually minted matching root and hard-linked canary byte-identical",
    () => {
      const addon = require(addonPath) as { probe(root: string): string };
      const root = mkdtempSync(join(realpathSync(tmpdir()), "aih-methodology-native-fs-"));
      const capture = mkdtempSync(join(realpathSync(tmpdir()), "aih-linux-hardlink-capture-"));
      const canary = join(root, "must-survive.txt");
      const escaped = join(capture, "must-survive.txt");
      writeFileSync(canary, "must-survive-byte-for-byte", { mode: 0o600 });
      linkSync(canary, escaped);
      const before = lstatSync(canary, { bigint: true });
      try {
        expect(rawReasons(addon.probe(root))).toEqual(
          primitiveOrder.map(() => "blocked/root-capability-unproven"),
        );
        const after = lstatSync(canary, { bigint: true });
        expect(readFileSync(canary, "utf8")).toBe("must-survive-byte-for-byte");
        expect(readFileSync(escaped, "utf8")).toBe("must-survive-byte-for-byte");
        expect({
          device: after.dev,
          file: after.ino,
          links: after.nlink,
          size: after.size,
          modified: after.mtimeNs,
          changed: after.ctimeNs,
        }).toEqual({
          device: before.dev,
          file: before.ino,
          links: before.nlink,
          size: before.size,
          modified: before.mtimeNs,
          changed: before.ctimeNs,
        });
      } finally {
        delete require.cache[addonPath];
        rmSync(root, { recursive: true, force: true });
        rmSync(capture, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "exposes no transient probe entry to a concurrent directory watcher",
    async () => {
      const addon = require(addonPath) as { probe(root: string): string };
      const capability = createNativeFsProbeCapability();
      const observed = new Set<string>();
      const watcher = watch(capability.root, (_event, filename) => {
        if (filename !== null) observed.add(filename);
      });
      try {
        for (let index = 0; index < 16; index += 1) {
          expect(rawReasons(addon.probe(capability.root))).toEqual(
            primitiveOrder.map(() => "blocked/root-capability-unproven"),
          );
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      } finally {
        watcher.close();
        disposeCapabilityFixture(capability);
        delete require.cache[addonPath];
      }
      expect([...observed]).toEqual([]);
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
          const before =
            candidate === "relative-root" ? undefined : lstatSync(candidate, { bigint: true });
          expect(rawReasons(addon.probe(candidate))).toEqual(
            primitiveOrder.map(() => "blocked/root-outside-temporary-directory"),
          );
          if (before !== undefined) {
            const after = lstatSync(candidate, { bigint: true });
            expect({
              device: after.dev,
              file: after.ino,
              links: after.nlink,
              mode: after.mode,
              size: after.size,
              modified: after.mtimeNs,
              changed: after.ctimeNs,
            }).toEqual({
              device: before.dev,
              file: before.ino,
              links: before.nlink,
              mode: before.mode,
              size: before.size,
              modified: before.mtimeNs,
              changed: before.ctimeNs,
            });
          }
        }
        expect(rawReasons(addon.probe(linkedRoot))).toEqual(
          primitiveOrder.map(() => "blocked/root-linked"),
        );
        expect(readdirSync(linkedTarget)).toEqual([]);
      } finally {
        delete require.cache[addonPath];
        rmSync(linkedRoot, { force: true });
        rmdirSync(linkedTarget);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps the Linux backend read-only behind an unauthenticated root boundary",
    () => {
      const source = readFileSync(linuxBackendPath, "utf8");
      expect(source).toContain("root-capability-unproven");
      expect(source).not.toContain("AIH_SUPPORTED");
      expect(source).not.toContain("AIH_UNSUPPORTED");
      expect(source).not.toMatch(
        /\/proc|\bsystem\s*\(|\bpopen\s*\(|\bexec[lvpe]*\s*\(|getenv\s*\(|\blinkat\s*\(|\brenameat2\s*\(|SYS_renameat2|\bunlinkat\s*\(|\bmkdirat\s*\(|\bsymlinkat\s*\(|O_TMPFILE|O_CREAT|O_EXCL|AT_REMOVEDIR|\bwrite\s*\(|\bfsync\s*\(/,
      );
    },
  );

  it("keeps the Windows backend mutation-free behind a fixed unauthenticated root boundary", () => {
    const source = readFileSync(windowsBackendPath, "utf8");
    expect(source).toContain("AIH_NATIVE_FS_OBSERVATION_COUNT");
    expect(source).toContain("(enum aih_native_fs_primitive)index");
    expect(source).toContain("AIH_BLOCKED");
    expect(source).toContain("root-capability-unproven");
    expect(source).not.toContain("native-backend-unimplemented");
    expect(source).not.toContain("AIH_SUPPORTED");
    expect(source).not.toContain("AIH_UNSUPPORTED");
    expect(source).not.toMatch(
      /\b(?:CreateFileW|SetFileInformationByHandle|WriteFile|FlushFileBuffers|MoveFileW|MoveFileExW|ReplaceFileW|DeleteFileW|RemoveDirectoryW|CreateDirectoryW|CreateHardLinkW|DeviceIoControl|CreateProcessW|WinExec|ShellExecuteW|LoadLibraryW|GetProcAddress|WinHttpOpen|InternetOpenW|WSAStartup)\s*\(|\b(?:system|popen|exec[lvpe]*|spawn[lvpe]*|fopen|freopen|open|rename|remove|unlink|mkdir|rmdir|write|fsync)\s*\(/,
    );

    const windowsRecord = syntheticBlockedRecord("win32", "volume");
    expect(windowsRecord.nativeRootAuthority).toEqual({
      authenticated: false,
      disposition: "blocked",
      reason: "root-capability-unproven",
    });
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...windowsRecord,
        nativeRootAuthority: {
          authenticated: true,
          disposition: "supported",
          reason: "primitive-qualified",
        },
      }).success,
    ).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "blocks plausible Windows roots without changing fixture or host paths",
    () => {
      const addon = require(addonPath) as { probe(root: string): string };
      const capability = createNativeFsProbeCapability();
      const manualRoot = mkdtempSync(join(realpathSync(tmpdir()), "aih-methodology-native-fs-"));
      const fixtureRoots = [capability.root, manualRoot];
      const hostPaths = [process.cwd(), homedir()];
      const candidates = [...fixtureRoots, ...hostPaths];
      const fixtureBefore = fixtureRoots.map((candidate) => lstatSync(candidate, { bigint: true }));
      const hostBefore = hostPaths.map((candidate) => {
        const stat = lstatSync(candidate, { bigint: true });
        return { device: stat.dev, file: stat.ino, mode: stat.mode };
      });
      try {
        for (const candidate of candidates) {
          expect(rawReasons(addon.probe(candidate))).toEqual(
            primitiveOrder.map(() => "blocked/root-capability-unproven"),
          );
        }
        const fixtureAfter = fixtureRoots.map((candidate) =>
          lstatSync(candidate, { bigint: true }),
        );
        expect(
          fixtureAfter.map((stat) => ({
            device: stat.dev,
            file: stat.ino,
            links: stat.nlink,
            mode: stat.mode,
            size: stat.size,
            modified: stat.mtimeNs,
            changed: stat.ctimeNs,
          })),
        ).toEqual(
          fixtureBefore.map((stat) => ({
            device: stat.dev,
            file: stat.ino,
            links: stat.nlink,
            mode: stat.mode,
            size: stat.size,
            modified: stat.mtimeNs,
            changed: stat.ctimeNs,
          })),
        );
        expect(
          hostPaths.map((candidate) => {
            const stat = lstatSync(candidate, { bigint: true });
            return { device: stat.dev, file: stat.ino, mode: stat.mode };
          }),
        ).toEqual(hostBefore);
        expect(readdirSync(capability.root)).toEqual([]);
        expect(readdirSync(manualRoot)).toEqual([]);
      } finally {
        disposeCapabilityFixture(capability);
        delete require.cache[addonPath];
        rmdirSync(manualRoot);
      }
    },
  );

  it("keeps the Darwin backend mutation-free behind a fixed unauthenticated root boundary", () => {
    const source = readFileSync(darwinBackendPath, "utf8");
    expect(source).toContain("AIH_NATIVE_FS_OBSERVATION_COUNT");
    expect(source).toContain("(enum aih_native_fs_primitive)index");
    expect(source).toContain("AIH_BLOCKED");
    expect(source).toContain("root-capability-unproven");
    expect(source).not.toContain("native-backend-unimplemented");
    expect(source).not.toContain("AIH_SUPPORTED");
    expect(source).not.toContain("AIH_UNSUPPORTED");
    expect(source).not.toMatch(
      /\b(?:fclonefileat|clonefile|renameatx_np|renamex_np|open|openat|creat|fopen|freopen|write|pwrite|fsync|fcntl|stat|lstat|fstat|statfs|fstatfs|getattrlist|setattrlist|unlink|unlinkat|remove|rename|renameat|mkdir|mkdirat|rmdir|link|linkat|symlink|symlinkat|mount|unmount|system|popen|exec[lvpe]*|posix_spawn|dlopen|dlsym|CFBundleLoadExecutable|NSURLSession|socket|connect)\s*\(/,
    );

    const darwinRecord = syntheticBlockedRecord("darwin", "filesystem");
    expect(darwinRecord.nativeRootAuthority).toEqual({
      authenticated: false,
      disposition: "blocked",
      reason: "root-capability-unproven",
    });
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...darwinRecord,
        nativeRootAuthority: {
          authenticated: true,
          disposition: "supported",
          reason: "primitive-qualified",
        },
      }).success,
    ).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "blocks plausible Darwin roots without changing fixture or host paths",
    () => {
      const addon = require(addonPath) as { probe(root: string): string };
      const capability = createNativeFsProbeCapability();
      const manualRoot = mkdtempSync(join(realpathSync(tmpdir()), "aih-methodology-native-fs-"));
      const fixtureRoots = [capability.root, manualRoot];
      const hostPaths = [process.cwd(), homedir()];
      const candidates = [...fixtureRoots, ...hostPaths];
      const fixtureBefore = fixtureRoots.map((candidate) => lstatSync(candidate, { bigint: true }));
      const hostBefore = hostPaths.map((candidate) => {
        const stat = lstatSync(candidate, { bigint: true });
        return { device: stat.dev, file: stat.ino, mode: stat.mode };
      });
      try {
        for (const candidate of candidates) {
          expect(rawReasons(addon.probe(candidate))).toEqual(
            primitiveOrder.map(() => "blocked/root-capability-unproven"),
          );
        }
        const fixtureAfter = fixtureRoots.map((candidate) =>
          lstatSync(candidate, { bigint: true }),
        );
        expect(
          fixtureAfter.map((stat) => ({
            device: stat.dev,
            file: stat.ino,
            links: stat.nlink,
            mode: stat.mode,
            size: stat.size,
            modified: stat.mtimeNs,
            changed: stat.ctimeNs,
          })),
        ).toEqual(
          fixtureBefore.map((stat) => ({
            device: stat.dev,
            file: stat.ino,
            links: stat.nlink,
            mode: stat.mode,
            size: stat.size,
            modified: stat.mtimeNs,
            changed: stat.ctimeNs,
          })),
        );
        expect(
          hostPaths.map((candidate) => {
            const stat = lstatSync(candidate, { bigint: true });
            return { device: stat.dev, file: stat.ino, mode: stat.mode };
          }),
        ).toEqual(hostBefore);
        expect(readdirSync(capability.root)).toEqual([]);
        expect(readdirSync(manualRoot)).toEqual([]);
        expect(syntheticBlockedRecord("darwin", "filesystem").nativeRootAuthority).toEqual({
          authenticated: false,
          disposition: "blocked",
          reason: "root-capability-unproven",
        });
      } finally {
        disposeCapabilityFixture(capability);
        delete require.cache[addonPath];
        rmdirSync(manualRoot);
      }
    },
  );

  it("rejects a preloaded unowned native addon cache entry", () => {
    const script = `
      const fs = await import("node:fs");
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const addon = require(${JSON.stringify(addonPath)});
      const module = await import(${JSON.stringify(moduleUrl.href)});
      const capability = module.createNativeFsProbeCapability();
      const errorName = (run) => {
        try { run(); return null; } catch (error) { return error?.name; }
      };
      try {
        const record = module.probeNativeFilesystem(capability);
        const descriptor = Object.getOwnPropertyDescriptor(addon, "probe");
        process.stdout.write(JSON.stringify({
          state: record.state,
          reasons: record.observations.map((item) => item.reason),
          keys: Object.keys(addon),
          probeType: typeof addon.probe,
          first: addon.probe(capability.root),
          second: addon.probe(capability.root),
          descriptor: {
            configurable: descriptor?.configurable,
            enumerable: descriptor?.enumerable,
            writable: descriptor?.writable,
          },
          errors: [
            errorName(() => addon.probe()),
            errorName(() => addon.probe(42)),
            errorName(() => addon.probe("contains\\0nul")),
            errorName(() => addon.probe("\\uD800")),
            errorName(() => addon.probe("\\uDC00")),
            errorName(() => addon.probe("\\uDC00\\uD800")),
            errorName(() => addon.probe("\\uD800x")),
            errorName(() => addon.probe("x".repeat(4_097))),
            errorName(() => addon.probe("\\u{1F600}".repeat(1_025))),
            errorName(() => addon.probe("root", "unexpected")),
          ],
          unicode: addon.probe("root-\\u{1F600}"),
        }));
      } finally {
        capability.dispose();
        fs.rmSync(capability.root, { recursive: true, force: true });
      }
    `;
    const child = spawnNativeProbe(script);
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as {
      state: string;
      reasons: string[];
      keys: string[];
      probeType: string;
      first: string;
      second: string;
      descriptor: { configurable: boolean; enumerable: boolean; writable: boolean };
      errors: Array<string | null>;
      unicode: string;
    };
    expect(result.state).toBe("blocked");
    expect(result.reasons).toEqual(primitiveOrder.map(() => "native-addon-abi-mismatch"));
    expect(result.keys).toEqual(["probe"]);
    expect(result.probeType).toBe("function");
    expect(result.first).toBe(expectedPlatformRawReport);
    expect(result.second).toBe(result.first);
    expect(result.descriptor).toEqual({ configurable: false, enumerable: true, writable: false });
    expect(result.errors).toEqual([
      "TypeError",
      "TypeError",
      "TypeError",
      "TypeError",
      "TypeError",
      "TypeError",
      "TypeError",
      "RangeError",
      "RangeError",
      "TypeError",
    ]);
    expect(result.unicode).toBe(
      process.platform === "linux"
        ? rawOutsideRootReport
        : process.platform === "win32"
          ? rawWindowsReport
          : process.platform === "darwin"
            ? rawDarwinReport
            : rawBlockedReport,
    );
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

  it("requires the C17 language standard in the Windows compiler configuration", () => {
    const binding = JSON.parse(readFileSync(bindingGypPath, "utf8")) as {
      targets?: Array<{
        win_delay_load_hook?: unknown;
        conditions?: Array<
          [
            string,
            {
              msvs_settings?: {
                VCCLCompilerTool?: { LanguageStandard_C?: unknown };
              };
            },
          ]
        >;
      }>;
    };
    const windows = binding.targets?.[0]?.conditions?.find(
      ([condition]) => condition === "OS=='win'",
    )?.[1];

    expect(binding.targets?.[0]?.win_delay_load_hook).toBe("false");
    expect(windows?.msvs_settings?.VCCLCompilerTool?.LanguageStandard_C).toBe("stdc17");
  });

  it("contains no Zod, production chmod, or pathname deletion capability", () => {
    const source = readFileSync(fileURLToPath(moduleUrl), "utf8");

    expect(source).not.toMatch(/\bchmodSync\b|\brmdirSync\b|(?:from\s+["']zod["'])/u);
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
        disposeCapabilityFixture(capability);
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
        disposeCapabilityFixture(capability);
      }
    } finally {
      vi.doUnmock("node:module");
      vi.resetModules();
    }
  });

  it("rejects native exports with missing or malformed owned-cache entries", async () => {
    const actualModule = await vi.importActual<typeof import("node:module")>("node:module");
    const cache = Object.create(null) as NodeJS.Dict<NodeModule>;
    let insertMalformedEntry = false;
    let nativeLoads = 0;
    vi.doMock("node:module", () => ({
      ...actualModule,
      createRequire() {
        const uncachedRequire = (() => {
          nativeLoads += 1;
          if (insertMalformedEntry) cache[addonPath] = null as unknown as NodeModule;
          return { probe() {} };
        }) as unknown as NodeRequire;
        uncachedRequire.cache = cache;
        return uncachedRequire;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "native-addon-abi-mismatch"),
        );
        insertMalformedEntry = true;
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "native-addon-abi-mismatch"),
        );
        expect(nativeLoads).toBe(2);
      } finally {
        disposeCapabilityFixture(capability);
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
        disposeCapabilityFixture(capability);
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
        disposeCapabilityFixture(capability);
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
        disposeCapabilityFixture(capability);
      }
      expect(reads).toBe(0);
      expect(nativeLoads).toBe(0);
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:module");
      vi.resetModules();
    }
  });

  it("revokes a descriptor-less capability without pathname removal", async () => {
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
      const root = capability.root;
      capability.dispose();
      expect(existsSync(root)).toBe(true);
      expect(() => isolated.probeNativeFilesystem(capability)).toThrow(/capability/i);
      rmSync(root, { recursive: true, force: true });
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
    expect(existsSync(root)).toBe(true);
    expect(() => probeNativeFilesystem(capability)).toThrow(/capability/i);
    rmSync(root, { recursive: true, force: true });
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
    expect(first.nativeRootAuthority).toEqual({
      authenticated: false,
      disposition: "blocked",
      reason: "root-capability-unproven",
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
    if (process.platform === "linux") {
      expect(first.observations.map(({ disposition }) => disposition)).toEqual(
        primitiveOrder.map(() => "blocked"),
      );
    }
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
      const fs = await import("node:fs");
      const module = await import(${JSON.stringify(pathToFileURL(fileURLToPath(moduleUrl)).href)});
      const capability = module.createNativeFsProbeCapability();
      try {
        const record = module.probeNativeFilesystem(capability);
        process.stdout.write(JSON.stringify(record.observations.map((item) => item.reason)));
      } finally {
        capability.dispose();
        fs.rmSync(capability.root, { recursive: true, force: true });
      }
    `;
    try {
      const child = spawnNativeProbe(script, { cwd: attackerRoot });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(expectedPlatformReasons);
    } finally {
      rmSync(attackerRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the owned module cache or exports identity is replaced", () => {
    const script = `
      const fs = await import("node:fs");
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const module = await import(${JSON.stringify(moduleUrl.href)});
      const capability = module.createNativeFsProbeCapability();
      let ownedModule;
      let originalExports;
      try {
        const first = module.probeNativeFilesystem(capability);
        ownedModule = require.cache[${JSON.stringify(addonPath)}];
        if (ownedModule === undefined) throw new Error("owned addon cache entry is missing");
        originalExports = ownedModule.exports;
        ownedModule.exports = { probe() { return "forged supported report"; } };
        const exportsMutation = module.probeNativeFilesystem(capability);
        ownedModule.exports = originalExports;
        require.cache[${JSON.stringify(addonPath)}] = { ...ownedModule, exports: originalExports };
        const cacheMutation = module.probeNativeFilesystem(capability);
        process.stdout.write(JSON.stringify({
          first: first.observations.map((item) => item.reason),
          exportsMutation: exportsMutation.observations.map((item) => item.reason),
          cacheMutation: cacheMutation.observations.map((item) => item.reason),
        }));
      } finally {
        if (ownedModule !== undefined && originalExports !== undefined) {
          ownedModule.exports = originalExports;
          require.cache[${JSON.stringify(addonPath)}] = ownedModule;
        }
        capability.dispose();
        fs.rmSync(capability.root, { recursive: true, force: true });
      }
    `;
    const child = spawnNativeProbe(script);
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as {
      first: string[];
      exportsMutation: string[];
      cacheMutation: string[];
    };
    expect(result.first).toEqual(expectedPlatformReasons);
    expect(result.exportsMutation).toEqual(primitiveOrder.map(() => "native-addon-abi-mismatch"));
    expect(result.cacheMutation).toEqual(primitiveOrder.map(() => "native-addon-abi-mismatch"));
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
              if (call === 10) {
                const report = rawReport();
                return JSON.stringify({
                  ...report,
                  observations: [
                    {
                      ...report.observations[0],
                      disposition: "supported",
                      reason: "native-backend-unimplemented",
                    },
                    ...report.observations.slice(1),
                  ],
                });
              }
              if (call === 11) throw new Error("native probe failure");
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
      for (let index = 0; index < 12; index += 1) {
        const capability = isolated.createNativeFsProbeCapability();
        try {
          reasons.push(isolated.probeNativeFilesystem(capability).observations[0]?.reason ?? "");
        } finally {
          disposeCapabilityFixture(capability);
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
    expect(NativeFsDispositionSchema.safeParse("supported").success).toBe(false);
    expect(NativeFsDispositionSchema.safeParse("unsupported").success).toBe(false);
    expect(NativeFsDispositionSchema.safeParse("active").success).toBe(false);
    expect(NativeFsReasonCodeSchema.safeParse("native-backend-unimplemented").success).toBe(true);
    expect(NativeFsReasonCodeSchema.safeParse("root-capability-unproven").success).toBe(true);
    expect(NativeFsReasonCodeSchema.safeParse("primitive-qualified").success).toBe(false);
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

  it("rejects unsupported primitive vocabulary at the Phase 4A boundary", () => {
    for (const primitive of primitiveOrder) {
      expect(
        NativeFsObservationSchema.safeParse({
          primitive,
          primitiveVersion: "phase-4a-primitive-v1",
          disposition: "unsupported",
          reason: "identity-bound-file-publication-unavailable",
        }).success,
      ).toBe(false);
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

  it("supports the complete closed-schema facade and rejects hostile array surfaces", async () => {
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

  it("does not assimilate an inherited then property from async schema output", () => {
    const script = `
      const fs = await import("node:fs");
      const module = await import(${JSON.stringify(moduleUrl.href)});
      const capability = module.createNativeFsProbeCapability();
      const record = module.probeNativeFilesystem(capability);
      const original = Object.getOwnPropertyDescriptor(Object.prototype, "then");
      let calls = 0;
      let rejected = false;
      Object.defineProperty(Object.prototype, "then", {
        configurable: true,
        get() {
          calls += 1;
          throw new Error("ambient then invoked");
        },
      });
      try {
        await module.NativeFsCapabilityRecordSchema.parseAsync(record);
      } catch {
        rejected = true;
      } finally {
        if (original === undefined) delete Object.prototype.then;
        else Object.defineProperty(Object.prototype, "then", original);
        capability.dispose();
        fs.rmSync(capability.root, { recursive: true, force: true });
      }
      process.stdout.write(JSON.stringify({ calls, rejected }));
    `;
    const child = spawnNativeProbe(script);

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ calls: 0, rejected: false });
  });

  it("returns one fixed deterministic closed-schema error", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const first = NativeFsCapabilityRecordSchema.safeParse(null);
    const second = NativeFsCapabilityRecordSchema.safeParse({ ...record, state: "supported" });

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    if (!first.success && !second.success) {
      expect({ name: first.error.name, message: first.error.message }).toEqual({
        name: "NativeFsClosedSchemaError",
        message: "native filesystem closed-schema validation failed",
      });
      expect({ name: second.error.name, message: second.error.message }).toEqual({
        name: "NativeFsClosedSchemaError",
        message: "native filesystem closed-schema validation failed",
      });
    }
  });

  it("rejects unavailable primitive dispositions while blocking state", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const unsupported = {
      ...record,
      state: "blocked",
      observations: record.observations.map((observation, index) => ({
        ...observation,
        disposition: "unsupported",
        reason:
          index === 0
            ? "identity-bound-file-publication-unavailable"
            : "native-backend-unimplemented",
      })),
    };
    expect(NativeFsCapabilityRecordSchema.safeParse(unsupported).success).toBe(false);
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

  it("rejects every non-blocked primitive observation while authority is unproven", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const observations = primitiveOrder.map((primitive) => ({
      primitive,
      primitiveVersion: "phase-4a-primitive-v1",
      disposition: "supported",
      reason: "primitive-qualified",
    }));
    expect(NativeFsObservationSchema.safeParse(observations[0]).success).toBe(false);
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...record,
        state: "blocked",
        observations,
      }).success,
    ).toBe(false);
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...record,
        state: "supported",
      }).success,
    ).toBe(false);
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...record,
        nativeRootAuthority: {
          authenticated: true,
          disposition: "supported",
          reason: "primitive-qualified",
        },
      }).success,
    ).toBe(false);
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...record,
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

  it("rejects cyclic, exotic, symbolic, and non-data schema surfaces", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const cyclic = { ...record } as Record<string, unknown>;
    cyclic.self = cyclic;
    const exotic = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(exotic, record);
    const symbolic = { ...record } as Record<PropertyKey, unknown>;
    symbolic[Symbol("hidden")] = true;
    const keyedObservations = [...record.observations] as unknown[] & { extra?: boolean };
    keyedObservations.extra = true;
    const nestedProxy = new Proxy(
      { ...record.observations[0] },
      {
        ownKeys() {
          throw new Error("nested proxy hook must not run");
        },
      },
    );

    for (const candidate of [
      cyclic,
      exotic,
      symbolic,
      { ...record, observations: keyedObservations },
      { ...record, observations: [nestedProxy, ...record.observations.slice(1)] },
    ]) {
      expect(NativeFsCapabilityRecordSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("accepts the runtime-version bound and rejects its first over-bound value", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
    const boundary = {
      ...record,
      platform: { ...record.platform, runtimeVersion: "1".repeat(4_096) },
    };
    const overBound = {
      ...record,
      platform: { ...record.platform, runtimeVersion: "1".repeat(4_097) },
    };

    expect(NativeFsCapabilityRecordSchema.safeParse(boundary).success).toBe(true);
    expect(NativeFsCapabilityRecordSchema.safeParse(overBound).success).toBe(false);
  });

  it("rejects an unavailable filesystem identity unless every observation binds that block", () => {
    const record = withCapability((_root, capability) => probeNativeFilesystem(capability));

    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...record,
        filesystemIdentity: { ...record.filesystemIdentity, type: "unavailable" },
      }).success,
    ).toBe(false);
    expect(
      NativeFsCapabilityRecordSchema.safeParse({
        ...record,
        filesystemIdentity: { ...record.filesystemIdentity, type: "unavailable" },
        observations: primitiveOrder.map((primitive) => ({
          primitive,
          primitiveVersion: "phase-4a-primitive-v1",
          disposition: "blocked",
          reason: "filesystem-identity-unavailable",
        })),
      }).success,
    ).toBe(true);
    expect(
      NativeFsObservationSchema.safeParse({
        primitive: primitiveOrder[0],
        primitiveVersion: "phase-4a-primitive-v1",
        disposition: "blocked",
        reason: "identity-bound-file-publication-unavailable",
      }).success,
    ).toBe(false);
  });

  it("detects owned addon ancestor, exports, and whole-cache-entry substitution", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const priorCacheEntry = require.cache[addonPath];
    delete require.cache[addonPath];
    let ancestorUnavailable = false;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0], options?: unknown) {
        if (ancestorUnavailable && path === addonBuildAncestor) {
          throw new Error("ancestor unavailable");
        }
        return actualFs.lstatSync(path, options as never);
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      const ownedModule = require.cache[addonPath];
      try {
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          expectedPlatformReasons,
        );
        const loadedModule = require.cache[addonPath];
        if (loadedModule === undefined) throw new Error("native addon cache entry was not created");
        const originalExports = loadedModule.exports;

        ancestorUnavailable = true;
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "native-addon-ancestor-invalid"),
        );
        ancestorUnavailable = false;

        loadedModule.exports = { probe() {} };
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "native-addon-abi-mismatch"),
        );
        loadedModule.exports = originalExports;

        require.cache[addonPath] = { ...loadedModule, exports: originalExports } as NodeModule;
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "native-addon-abi-mismatch"),
        );
        require.cache[addonPath] = loadedModule;
      } finally {
        disposeCapabilityFixture(capability);
        if (ownedModule !== undefined) require.cache[addonPath] = ownedModule;
      }
    } finally {
      delete require.cache[addonPath];
      if (priorCacheEntry !== undefined) require.cache[addonPath] = priorCacheEntry;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("fails closed when temporary-root filesystem identity cannot be observed", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      statfsSync() {
        throw new Error("filesystem identity unavailable");
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        const record = isolated.probeNativeFilesystem(capability);
        expect(record.filesystemIdentity.type).toBe("unavailable");
        expect(allBlockedReasons(record)).toEqual(
          primitiveOrder.map(() => "filesystem-identity-unavailable"),
        );
        expect(isolated.NativeFsCapabilityRecordSchema.safeParse(record).success).toBe(true);
      } finally {
        disposeCapabilityFixture(capability);
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("fails closed when filesystem identity changes after the native observation", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const priorCacheEntry = require.cache[addonPath];
    delete require.cache[addonPath];
    let filesystemReads = 0;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      statfsSync(path: Parameters<typeof actualFs.statfsSync>[0], options?: unknown) {
        const stat = actualFs.statfsSync(path, options as never);
        filesystemReads += 1;
        return filesystemReads >= 3 && typeof stat.type === "bigint"
          ? { ...stat, type: stat.type + 1n }
          : stat;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "filesystem-identity-drift"),
        );
      } finally {
        disposeCapabilityFixture(capability);
      }
    } finally {
      delete require.cache[addonPath];
      if (priorCacheEntry !== undefined) require.cache[addonPath] = priorCacheEntry;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("refuses to mint a capability when the created root is not a regular directory", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let mintedRoot: string | undefined;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      mkdtempSync(...args: Parameters<typeof actualFs.mkdtempSync>) {
        mintedRoot = actualFs.mkdtempSync(...args);
        return mintedRoot;
      },
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0], options?: unknown) {
        const stat = actualFs.lstatSync(path, options as never);
        return path === mintedRoot ? { ...stat, mode: 0n } : stat;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      expect(() => isolated.createNativeFsProbeCapability()).toThrow(/failed to mint/i);
      expect(mintedRoot).toBeDefined();
      expect(existsSync(mintedRoot as string)).toBe(true);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      if (mintedRoot !== undefined) rmSync(mintedRoot, { recursive: true, force: true });
    }
  });

  it("blocks a capability when its open directory descriptor identity drifts", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let injectDrift = false;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      fstatSync(descriptor: number, options?: unknown) {
        const stat = actualFs.fstatSync(descriptor, options as never);
        return injectDrift && typeof stat.ino === "bigint" ? { ...stat, ino: stat.ino + 1n } : stat;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      const root = capability.root;
      try {
        injectDrift = true;
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "root-identity-drift"),
        );
      } finally {
        injectDrift = false;
        capability.dispose();
      }
      expect(existsSync(root)).toBe(true);
      expect(() => isolated.probeNativeFilesystem(capability)).toThrow(/capability/i);
      rmSync(root, { recursive: true, force: true });
    } finally {
      injectDrift = false;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("blocks capabilities whose descriptor becomes non-directory or unreadable", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let failure: "non-directory" | "unreadable" | undefined;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      fstatSync(descriptor: number, options?: unknown) {
        if (failure === "unreadable") throw new Error("descriptor unreadable");
        const stat = actualFs.fstatSync(descriptor, options as never);
        return failure === "non-directory" && typeof stat.mode === "bigint"
          ? { ...stat, mode: 0n }
          : stat;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      for (const mode of ["non-directory", "unreadable"] as const) {
        const capability = isolated.createNativeFsProbeCapability();
        const root = capability.root;
        try {
          failure = mode;
          expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
            primitiveOrder.map(() => "root-identity-drift"),
          );
        } finally {
          failure = undefined;
          capability.dispose();
        }
        expect(existsSync(root)).toBe(true);
        expect(() => isolated.probeNativeFilesystem(capability)).toThrow(/capability/i);
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      failure = undefined;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects a native addon whose expected build hard link has a different identity", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let primaryStats = 0;
    let buildLinkStats = 0;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0], options?: unknown) {
        if (path === addonPath || path === addonBuildLinkPath) {
          const primary = actualFs.lstatSync(addonPath, options as never);
          if (typeof primary.ino === "bigint") {
            if (path === addonPath) primaryStats += 1;
            else buildLinkStats += 1;
            return path === addonPath
              ? { ...primary, nlink: 2n }
              : { ...primary, nlink: 2n, ino: primary.ino + 1n };
          }
          return primary;
        }
        return actualFs.lstatSync(path, options as never);
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "native-addon-load-failed"),
        );
        expect(primaryStats).toBe(1);
        expect(buildLinkStats).toBe(1);
      } finally {
        disposeCapabilityFixture(capability);
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("fails closed when the native addon bytes cannot be captured", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      readFileSync(path: Parameters<typeof actualFs.readFileSync>[0], options?: unknown) {
        if (path === addonPath) throw new Error("addon bytes unreadable");
        return actualFs.readFileSync(path, options as never);
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "native-addon-load-failed"),
        );
      } finally {
        disposeCapabilityFixture(capability);
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects a non-regular native addon artifact before loading it", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0], options?: unknown) {
        const stat = actualFs.lstatSync(path, options as never);
        return path === addonPath && typeof stat.mode === "bigint" ? { ...stat, mode: 0n } : stat;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "native-addon-load-failed"),
        );
      } finally {
        disposeCapabilityFixture(capability);
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects an addon ancestor identity change across native loading", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const priorCacheEntry = require.cache[addonPath];
    delete require.cache[addonPath];
    let buildAncestorReads = 0;
    vi.doMock("node:fs", () => ({
      ...actualFs,
      lstatSync(path: Parameters<typeof actualFs.lstatSync>[0], options?: unknown) {
        const stat = actualFs.lstatSync(path, options as never);
        if (path !== addonBuildAncestor || typeof stat.ino !== "bigint") return stat;
        buildAncestorReads += 1;
        return buildAncestorReads >= 2 ? { ...stat, ino: stat.ino + 1n } : stat;
      },
    }));
    vi.resetModules();
    try {
      const isolated = await import("../../src/methodology/native-fs-feasibility.js");
      const capability = isolated.createNativeFsProbeCapability();
      try {
        expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
          primitiveOrder.map(() => "native-addon-ancestor-invalid"),
        );
      } finally {
        disposeCapabilityFixture(capability);
      }
    } finally {
      delete require.cache[addonPath];
      if (priorCacheEntry !== undefined) require.cache[addonPath] = priorCacheEntry;
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("rejects forged, disposed, and identity-drifted capabilities", () => {
    expect(() => probeNativeFilesystem({ root: tmpdir(), dispose() {} })).toThrow(/capability/i);

    const disposed = createNativeFsProbeCapability();
    const disposedRoot = disposed.root;
    disposed.dispose();
    expect(() => probeNativeFilesystem(disposed)).toThrow(/capability/i);
    rmSync(disposedRoot, { recursive: true, force: true });

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
      disposeCapabilityFixture(capability);
    }
  });

  it("revokes after identity drift without removing authentic or substitute paths", () => {
    const capability = createNativeFsProbeCapability();
    const authenticRoot = `${capability.root}.authentic`;
    const substituteFile = join(capability.root, "must-survive.txt");
    renameSync(capability.root, authenticRoot);
    mkdirSync(capability.root, { mode: 0o700 });
    writeFileSync(substituteFile, "must survive", { mode: 0o600 });

    capability.dispose();
    expect(existsSync(authenticRoot)).toBe(true);
    expect(existsSync(substituteFile)).toBe(true);
    expect(() => probeNativeFilesystem(capability)).toThrow(/capability/i);
    rmSync(capability.root, { recursive: true, force: true });
    rmSync(authenticRoot, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")(
    "revokes a Darwin capability without relying on directory link count or pathname deletion",
    async () => {
      const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
      vi.doMock("node:fs", () => ({
        ...actualFs,
        fstatSync(descriptor: number, options?: unknown) {
          const stat = actualFs.fstatSync(descriptor, options as never);
          return typeof stat.nlink === "bigint" ? { ...stat, nlink: 2n } : stat;
        },
      }));
      vi.doMock("node:os", () => ({ ...actualOs, platform: () => "darwin" }));
      vi.resetModules();
      try {
        const isolated = await import("../../src/methodology/native-fs-feasibility.js");
        const capability = isolated.createNativeFsProbeCapability();
        const root = capability.root;
        capability.dispose();
        expect(existsSync(root)).toBe(true);
        expect(() => isolated.probeNativeFilesystem(capability)).toThrow(/capability/i);
        rmSync(root, { recursive: true, force: true });
      } finally {
        vi.doUnmock("node:fs");
        vi.doUnmock("node:os");
        vi.resetModules();
      }
    },
  );

  it("revokes a non-empty authentic root without removing its path or contents", () => {
    const capability = createNativeFsProbeCapability();
    const child = join(capability.root, "owned.txt");
    writeFileSync(child, "owned", { mode: 0o600 });
    capability.dispose();
    expect(existsSync(child)).toBe(true);
    expect(existsSync(capability.root)).toBe(true);
    expect(() => probeNativeFilesystem(capability)).toThrow(/capability/i);
    rmSync(capability.root, { recursive: true, force: true });
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
        disposeCapabilityFixture(capability);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "never repairs a same-UID mode substitution with production chmod",
    async () => {
      const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
      let productionChmods = 0;
      vi.doMock("node:fs", () => ({
        ...actualFs,
        chmodSync() {
          productionChmods += 1;
          throw new Error("production chmod is forbidden");
        },
      }));
      vi.resetModules();
      try {
        const isolated = await import("../../src/methodology/native-fs-feasibility.js");
        const capability = isolated.createNativeFsProbeCapability();
        const root = capability.root;
        actualFs.chmodSync(root, 0o755);
        try {
          expect(allBlockedReasons(isolated.probeNativeFilesystem(capability))).toEqual(
            primitiveOrder.map(() => "root-not-private"),
          );
          expect(productionChmods).toBe(0);
        } finally {
          capability.dispose();
          actualFs.rmSync(root, { recursive: true, force: true });
        }
      } finally {
        vi.doUnmock("node:fs");
        vi.resetModules();
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
        disposeCapabilityFixture(capability);
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

  it("blocks before path, filesystem, or native work when a guarded Array intrinsic drifts", () => {
    const script = `
      const fs = await import("node:fs");
      const module = await import(${JSON.stringify(moduleUrl.href)});
      const capability = module.createNativeFsProbeCapability();
      const root = capability.root;
      module.probeNativeFilesystem(capability);
      const keys = [
        "map",
        "sort",
        "filter",
        "forEach",
        "push",
        "slice",
        "some",
        "every",
        "reduce",
        Symbol.iterator,
      ];
      const results = new Array(keys.length);
      let calls = 0;
      let failure = null;
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const original = Array.prototype[key];
        Array.prototype[key] = function poisonedArrayIntrinsic() {
          calls += 1;
          throw new Error("ambient Array intrinsic invoked");
        };
        try {
          const record = module.probeNativeFilesystem(capability);
          let blocked = record.observations.length === 7;
          for (let observationIndex = 0; observationIndex < record.observations.length; observationIndex += 1) {
            const observation = record.observations[observationIndex];
            if (
              observation.disposition !== "blocked" ||
              observation.reason !== "native-operation-failed"
            ) {
              blocked = false;
            }
          }
          results[index] = blocked;
        } catch (error) {
          failure = error?.name ?? "unknown";
        } finally {
          Array.prototype[key] = original;
        }
      }
      capability.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ calls, failure, results }));
    `;
    const child = spawnNativeProbe(script);

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      calls: 0,
      failure: null,
      results: Array.from({ length: 10 }, () => true),
    });
  });

  it("does not consult post-import ambient hooks at the closed schema boundary", () => {
    const script = `
      const fs = await import("node:fs");
      const module = await import(${JSON.stringify(moduleUrl.href)});
      const capability = module.createNativeFsProbeCapability();
      const root = capability.root;
      const baseline = module.probeNativeFilesystem(capability);
      capability.dispose();
      fs.rmSync(root, { recursive: true, force: true });

      const originalRegExpTest = RegExp.prototype.test;
      const originalSetHas = Set.prototype.has;
      const originalSetAdd = Set.prototype.add;
      const originalObjectKeys = Object.keys;
      const originalFunction = globalThis.Function;
      const originalPromise = globalThis.Promise;
      const originalSet = globalThis.Set;
      const originalMathMin = Math.min;
      const originalObjectCreate = Object.create;
      const originalObjectDefineProperty = Object.defineProperty;
      const originalJsonStringify = JSON.stringify;
      const originalArrayJoin = Array.prototype.join;
      const originalStringRepeat = String.prototype.repeat;
      const originalStringSlice = String.prototype.slice;
      const originalStringSplit = String.prototype.split;
      const originalStringTrimStart = String.prototype.trimStart;
      let calls = 0;
      const poison = () => {
        calls += 1;
        throw new Error("ambient hook invoked");
      };
      let valid = false;
      let primitive = false;
      let asyncPrimitive = false;
      let invalid = true;
      let failure = null;
      try {
        RegExp.prototype.test = poison;
        Set.prototype.has = poison;
        Set.prototype.add = poison;
        Object.keys = poison;
        globalThis.Function = poison;
        globalThis.Promise = function poisonedPromise() {
          calls += 1;
          throw new Error("ambient Promise constructor invoked");
        };
        globalThis.Set = poison;
        Math.min = poison;
        Object.create = poison;
        Object.defineProperty = poison;
        JSON.stringify = poison;
        Array.prototype.join = poison;
        String.prototype.repeat = poison;
        String.prototype.slice = poison;
        String.prototype.split = poison;
        String.prototype.trimStart = poison;

        valid = module.NativeFsCapabilityRecordSchema.safeParse(baseline).success;
        primitive = module.NativeFsPrimitiveSchema.safeParse(
          "identity-bound-file-publication",
        ).success;
        asyncPrimitive = (
          await module.NativeFsPrimitiveSchema.safeParseAsync(
            "identity-bound-file-publication",
          )
        ).success;
        invalid = module.NativeFsCapabilityRecordSchema.safeParse({
          ...baseline,
          state: "supported",
        }).success;
      } catch (error) {
        failure = error?.name ?? "unknown";
      } finally {
        RegExp.prototype.test = originalRegExpTest;
        Object.keys = originalObjectKeys;
        globalThis.Function = originalFunction;
        globalThis.Promise = originalPromise;
        globalThis.Set = originalSet;
        Set.prototype.has = originalSetHas;
        Set.prototype.add = originalSetAdd;
        Math.min = originalMathMin;
        Object.create = originalObjectCreate;
        Object.defineProperty = originalObjectDefineProperty;
        JSON.stringify = originalJsonStringify;
        Array.prototype.join = originalArrayJoin;
        String.prototype.repeat = originalStringRepeat;
        String.prototype.slice = originalStringSlice;
        String.prototype.split = originalStringSplit;
        String.prototype.trimStart = originalStringTrimStart;
      }
      process.stdout.write(
        originalJsonStringify({ calls, failure, valid, primitive, asyncPrimitive, invalid }),
      );
    `;
    const child = spawnNativeProbe(script);

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      calls: 0,
      failure: null,
      valid: true,
      primitive: true,
      asyncPrimitive: true,
      invalid: false,
    });
  });
});
