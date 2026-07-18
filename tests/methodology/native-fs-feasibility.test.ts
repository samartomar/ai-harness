import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
const addonPath = join(
  process.cwd(),
  "native",
  "methodology-fs",
  "build",
  "Release",
  "methodology_fs.node",
);
const primitiveOrder = [
  "identity-bound-file-publication",
  "no-replace-directory-publication",
  "identity-bound-file-detachment",
  "identity-bound-directory-detachment",
  "parent-directory-durability",
  "link-and-volume-containment",
  "substitution-resistance",
] as const;

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

describe.sequential("native methodology filesystem feasibility", () => {
  it("fails closed when the exact expected addon is missing", () => {
    const heldPath = `${addonPath}.task-2-held`;
    renameSync(addonPath, heldPath);
    try {
      const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
      expect(record.state).toBe("blocked");
      expect(allBlockedReasons(record)).toEqual(
        primitiveOrder.map(() => "native-addon-unavailable"),
      );
    } finally {
      renameSync(heldPath, addonPath);
    }
  });

  it("fails closed when the exact expected addon cannot be loaded", () => {
    const heldPath = `${addonPath}.task-2-held`;
    const original = readFileSync(addonPath);
    renameSync(addonPath, heldPath);
    try {
      writeFileSync(addonPath, "not a native addon", { mode: 0o600 });
      const record = withCapability((_root, capability) => probeNativeFilesystem(capability));
      expect(record.state).toBe("blocked");
      expect(allBlockedReasons(record)).toEqual(
        primitiveOrder.map(() => "native-addon-load-failed"),
      );
    } finally {
      rmSync(addonPath, { force: true });
      renameSync(heldPath, addonPath);
      expect(readFileSync(addonPath)).toEqual(original);
    }
  });

  it("loads the local addon with one synchronous probe export", () => {
    const addon = require(addonPath) as { probe?: unknown };

    expect(Object.keys(addon)).toEqual(["probe"]);
    expect(typeof addon.probe).toBe("function");
    if (typeof addon.probe !== "function") {
      throw new TypeError("expected native probe export");
    }

    expect(addon.probe()).toBe(
      '{"schemaVersion":1,"probeVersion":"phase-4a-native-fs-v1","state":"blocked","reason":"native-backend-unimplemented"}',
    );
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

  it("turns the placeholder backend into a complete ordered blocked record", () => {
    const { first, second } = withCapability((_root, capability) => ({
      first: probeNativeFilesystem(capability),
      second: probeNativeFilesystem(capability, { addonPath }),
    }));

    expect(first.schemaVersion).toBe(1);
    expect(first.probeVersion).toBe("phase-4a-native-fs-v1");
    expect(first.state).toBe("blocked");
    expect(first.platform).toEqual({
      os: process.platform,
      architecture: process.arch,
      runtime: "node",
      runtimeVersion: process.versions.node,
      nodeApiVersion: process.versions.napi,
    });
    expect(first.observations.map(({ primitive }) => primitive)).toEqual(primitiveOrder);
    expect(allBlockedReasons(first)).toEqual(
      primitiveOrder.map(() => "native-backend-unimplemented"),
    );
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
    } finally {
      Array.prototype.sort = originalSort;
      Array.prototype.map = originalMap;
    }
    expect(record?.state).toBe("blocked");
    expect(calls).toBe(0);
  });
});
