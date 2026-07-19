import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as generationStoreModule from "../../src/methodology/generation-store.js";
import {
  ActivationRecordSchema,
  type CleanProjectionResult,
  canonicalRecordBytes,
  TransactionRecordSchema,
} from "../../src/methodology/generation-store-contract.js";
import {
  createOrOpenOwnedStore,
  inspectFixedStoreLayout,
} from "../../src/methodology/generation-store-fs.js";
import { acquireStoreLock, releaseStoreLock } from "../../src/methodology/generation-store-lock.js";
import {
  binaryPayloadFixture,
  binaryPlannedFixture,
  makeSiblingCanary,
  makeTemporaryProject,
  payloadFixture,
  plannedFixture,
  type TemporaryProject,
} from "./generation-store-fixtures.js";

type PlannedFixture = Extract<ReturnType<typeof plannedFixture>, { state: "planned" }>;
type CleanProjectionFunction = (value: unknown) => CleanProjectionResult;
type CleanFaultPoint =
  | "after-clean-journal-prepared"
  | "before-clean-quarantine"
  | "after-clean-quarantine"
  | "during-clean-delete"
  | "after-clean-delete";
type CleanRuntime = Readonly<{
  onFaultPoint: (point: CleanFaultPoint) => void;
  lockRuntime: Readonly<{
    pid: number;
    randomToken: () => string;
    pidState: (pid: number) => "alive" | "absent" | "unknown";
  }>;
}>;
type CleanProjectionWithRuntimeFunction = (
  value: unknown,
  runtime: CleanRuntime,
) => CleanProjectionResult;

const CLEAN_FAULT_POINTS = [
  "after-clean-journal-prepared",
  "before-clean-quarantine",
  "after-clean-quarantine",
  "during-clean-delete",
  "after-clean-delete",
] as const;
const LOCK_TOKEN = "a".repeat(64);

const roots: TemporaryProject[] = [];
const mutableFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const mutableCrypto = createRequire(import.meta.url)("node:crypto") as typeof import("node:crypto");
const originalCloseSync = mutableFs.closeSync;
const originalLstatSync = mutableFs.lstatSync;
const originalOpenSync = mutableFs.openSync;
const originalOpendirSync = mutableFs.opendirSync;
const originalReadFileSync = mutableFs.readFileSync;
const originalRealpathSync = mutableFs.realpathSync;
const originalUnlinkSync = mutableFs.unlinkSync;
const originalRandomBytes = mutableCrypto.randomBytes;

function restoreBuiltins(): void {
  mutableFs.closeSync = originalCloseSync;
  mutableFs.lstatSync = originalLstatSync;
  mutableFs.openSync = originalOpenSync;
  mutableFs.opendirSync = originalOpendirSync;
  mutableFs.readFileSync = originalReadFileSync;
  mutableFs.realpathSync = originalRealpathSync;
  mutableFs.unlinkSync = originalUnlinkSync;
  mutableCrypto.randomBytes = originalRandomBytes;
  syncBuiltinESMExports();
}

function injectLockReleaseFailure(store: ReturnType<typeof createOrOpenOwnedStore>): () => boolean {
  let injected = false;
  mutableFs.unlinkSync = ((...args: unknown[]) => {
    const target = String(args[0]);
    if (
      !injected &&
      basename(target) === "owner.json" &&
      dirname(target).startsWith(store.layout.lockCandidates)
    ) {
      injected = true;
      throw Object.assign(new Error("synthetic lock release failure"), { code: "EACCES" });
    }
    return Reflect.apply(originalUnlinkSync, mutableFs, args);
  }) as typeof originalUnlinkSync;
  syncBuiltinESMExports();
  return () => injected;
}

function temporaryProject(): TemporaryProject {
  const root = makeTemporaryProject();
  roots.push(root);
  return root;
}

function requirePlanned<T extends { state: string }>(value: T): Extract<T, { state: "planned" }> {
  if (value.state !== "planned") throw new Error("fixture must produce a planned projection");
  return value as Extract<T, { state: "planned" }>;
}

function cleanProjectionGeneration(value: unknown): CleanProjectionResult {
  const implementation = (
    generationStoreModule as unknown as {
      cleanProjectionGeneration?: CleanProjectionFunction;
    }
  ).cleanProjectionGeneration;
  if (implementation === undefined) {
    throw new Error("cleanProjectionGeneration is not implemented");
  }
  return implementation(value);
}

function cleanProjectionGenerationWithRuntime(
  value: unknown,
  runtime: CleanRuntime,
): CleanProjectionResult {
  const implementation = (
    generationStoreModule as unknown as {
      cleanProjectionGenerationWithRuntime?: CleanProjectionWithRuntimeFunction;
    }
  ).cleanProjectionGenerationWithRuntime;
  if (implementation === undefined) {
    throw new Error("cleanProjectionGenerationWithRuntime is not implemented");
  }
  return implementation(value, runtime);
}

function cleanFaultRuntime(point: CleanFaultPoint): CleanRuntime {
  return Object.freeze({
    onFaultPoint(candidate: CleanFaultPoint): void {
      if (candidate === point) throw new Error(`injected:${point}`);
    },
    lockRuntime: Object.freeze({
      pid: process.pid,
      randomToken: () => LOCK_TOKEN,
      pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
    }),
  });
}

function identityTreeSnapshot(root: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  const visit = (path: string, relativePath: string): void => {
    const stats = lstatSync(path, { bigint: true });
    const identity = [
      stats.dev,
      stats.ino,
      stats.mode,
      stats.nlink,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ]
      .map(String)
      .join(":");
    values[relativePath] = stats.isFile()
      ? `${identity}:${readFileSync(path).toString("hex")}`
      : identity;
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relativePath === "" ? name : `${relativePath}/${name}`);
    }
  };
  visit(root, "");
  return Object.freeze(values);
}

function materializeTwoGenerations(): Readonly<{
  root: TemporaryProject;
  oldPlan: PlannedFixture;
  newPlan: PlannedFixture;
  oldGenerationRoot: string;
  newGenerationRoot: string;
}> {
  const root = temporaryProject();
  const oldPlan = requirePlanned(plannedFixture());
  const first = generationStoreModule.applyProjection({
    mode: "apply",
    projectRoot: root.projectRoot,
    plan: oldPlan,
    payloads: payloadFixture(),
    expectedActiveDigest: null,
  });
  expect(first.state).toBe("applied");
  const newPlan = requirePlanned(binaryPlannedFixture());
  const second = generationStoreModule.applyProjection({
    mode: "apply",
    projectRoot: root.projectRoot,
    plan: newPlan,
    payloads: binaryPayloadFixture(),
    expectedActiveDigest: oldPlan.manifest.digest,
  });
  expect(second.state).toBe("applied");
  const store = createOrOpenOwnedStore(root.projectRoot);
  return Object.freeze({
    root,
    oldPlan,
    newPlan,
    oldGenerationRoot: join(store.layout.generations, oldPlan.manifest.digest),
    newGenerationRoot: join(store.layout.generations, newPlan.manifest.digest),
  });
}

function expectCleanBoundary(result: CleanProjectionResult): void {
  expect(result.boundary).toEqual({
    providerRead: false,
    providerExecution: false,
    hostExecution: false,
    network: false,
    packageManager: false,
    cli: false,
    writeCapability: "aih-owned-project-root",
  });
}

afterEach(() => {
  restoreBuiltins();
  for (const root of roots.splice(0)) {
    rmSync(root.sandboxRoot, { recursive: true, force: true });
  }
});

describe("generation store fail-closed clean", { timeout: 30_000 }, () => {
  it("returns a closed result when clean input reflection throws", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile clean input trap");
        },
      },
    );

    expect(() => cleanProjectionGeneration(hostile)).not.toThrow();
    expect(cleanProjectionGeneration(hostile)).toMatchObject({
      state: "blocked",
      generationDigest: null,
      findings: [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }],
    });
  });

  it("does not construct storage for invalid, empty, or unsafe public recovery and clean inputs", () => {
    const root = temporaryProject();
    const storeAncestor = join(root.projectRoot, ".aih");
    const digest = "f".repeat(64);

    expect(generationStoreModule.recoverProjectionStore(null)).toMatchObject({
      state: "failed-closed",
      activeDigest: null,
      findings: [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }],
    });
    expect(cleanProjectionGeneration(null)).toMatchObject({
      state: "blocked",
      generationDigest: null,
      findings: [{ code: "METHODOLOGY_STORE_INPUT_INVALID" }],
    });
    expect(
      generationStoreModule.recoverProjectionStore({ projectRoot: root.projectRoot }),
    ).toMatchObject({ state: "nothing-to-recover", activeDigest: null, findings: [] });
    expect(
      cleanProjectionGeneration({ projectRoot: root.projectRoot, generationDigest: digest }),
    ).toMatchObject({
      state: "retained",
      generationDigest: digest,
      findings: [{ code: "METHODOLOGY_STORE_CLEAN_RETAINED" }],
    });
    expect(existsSync(storeAncestor)).toBe(false);

    writeFileSync(storeAncestor, "not-a-directory\n", { mode: 0o600 });
    expect(
      generationStoreModule.recoverProjectionStore({ projectRoot: root.projectRoot }),
    ).toMatchObject({
      state: "failed-closed",
      activeDigest: null,
      findings: [{ code: "METHODOLOGY_STORE_PATH_UNSAFE" }],
    });
    expect(
      cleanProjectionGeneration({ projectRoot: root.projectRoot, generationDigest: digest }),
    ).toMatchObject({
      state: "failed-closed",
      generationDigest: digest,
      findings: [{ code: "METHODOLOGY_STORE_PATH_UNSAFE" }],
    });
    expect(readFileSync(storeAncestor, "utf8")).toBe("not-a-directory\n");
  });

  it("honors one live cooperative lock across apply, recovery, and clean entrypoints", () => {
    const fixture = materializeTwoGenerations();
    const store = createOrOpenOwnedStore(fixture.root.projectRoot);
    const oldBefore = identityTreeSnapshot(fixture.oldGenerationRoot);
    const activeBefore = identityTreeSnapshot(fixture.newGenerationRoot);
    const held = acquireStoreLock(store, "e".repeat(64));

    const results = (() => {
      try {
        return {
          apply: generationStoreModule.applyProjection({
            mode: "apply",
            projectRoot: fixture.root.projectRoot,
            plan: fixture.newPlan,
            payloads: binaryPayloadFixture(),
            expectedActiveDigest: fixture.newPlan.manifest.digest,
          }),
          recovery: generationStoreModule.recoverProjectionStore({
            projectRoot: fixture.root.projectRoot,
          }),
          clean: cleanProjectionGeneration({
            projectRoot: fixture.root.projectRoot,
            generationDigest: fixture.oldPlan.manifest.digest,
          }),
        };
      } finally {
        releaseStoreLock(store, held);
      }
    })();

    expect(results.apply).toMatchObject({
      state: "blocked",
      findings: [{ code: "METHODOLOGY_STORE_LOCK_HELD" }],
    });
    expect(results.recovery).toMatchObject({
      state: "blocked",
      findings: [{ code: "METHODOLOGY_STORE_LOCK_HELD" }],
    });
    expect(results.clean).toMatchObject({
      state: "blocked",
      findings: [{ code: "METHODOLOGY_STORE_LOCK_HELD" }],
    });
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(oldBefore);
    expect(identityTreeSnapshot(fixture.newGenerationRoot)).toEqual(activeBefore);
    expect(inspectFixedStoreLayout(store)).toMatchObject({
      transactions: [],
      staging: [],
      trash: [],
      lockPresent: false,
      lockCandidates: [],
    });
  });

  it("fails closed before lock acquisition when transaction entropy is unavailable", () => {
    const fixture = materializeTwoGenerations();
    const oldBefore = identityTreeSnapshot(fixture.oldGenerationRoot);
    const activeBefore = identityTreeSnapshot(fixture.newGenerationRoot);
    mutableCrypto.randomBytes = (() => {
      throw new Error("synthetic entropy failure");
    }) as typeof originalRandomBytes;
    syncBuiltinESMExports();

    const apply = generationStoreModule.applyProjection({
      mode: "apply",
      projectRoot: fixture.root.projectRoot,
      plan: fixture.newPlan,
      payloads: binaryPayloadFixture(),
      expectedActiveDigest: fixture.newPlan.manifest.digest,
    });
    const recovery = generationStoreModule.recoverProjectionStore({
      projectRoot: fixture.root.projectRoot,
    });
    const clean = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.oldPlan.manifest.digest,
    });
    restoreBuiltins();

    expect(apply).toMatchObject({
      state: "failed-closed",
      findings: [{ code: "METHODOLOGY_STORE_FILESYSTEM_FAILURE" }],
    });
    expect(recovery).toMatchObject({
      state: "failed-closed",
      findings: [{ code: "METHODOLOGY_STORE_FILESYSTEM_FAILURE" }],
    });
    expect(clean).toMatchObject({
      state: "failed-closed",
      findings: [{ code: "METHODOLOGY_STORE_FILESYSTEM_FAILURE" }],
    });
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(oldBefore);
    expect(identityTreeSnapshot(fixture.newGenerationRoot)).toEqual(activeBefore);
  });

  it.each([
    "apply",
    "recovery",
    "clean",
  ] as const)("reports a conservative %s result when exact lock release fails", (operation) => {
    const fixture = materializeTwoGenerations();
    const store = createOrOpenOwnedStore(fixture.root.projectRoot);
    const activeBefore = identityTreeSnapshot(fixture.newGenerationRoot);
    const wasInjected = injectLockReleaseFailure(store);
    const result =
      operation === "apply"
        ? generationStoreModule.applyProjection({
            mode: "apply",
            projectRoot: fixture.root.projectRoot,
            plan: fixture.newPlan,
            payloads: binaryPayloadFixture(),
            expectedActiveDigest: fixture.newPlan.manifest.digest,
          })
        : operation === "recovery"
          ? generationStoreModule.recoverProjectionStore({
              projectRoot: fixture.root.projectRoot,
            })
          : cleanProjectionGeneration({
              projectRoot: fixture.root.projectRoot,
              generationDigest: fixture.oldPlan.manifest.digest,
            });
    restoreBuiltins();

    expect(wasInjected()).toBe(true);
    expect(result.findings).toEqual([{ code: "METHODOLOGY_STORE_FILESYSTEM_FAILURE" }]);
    expect(result.state).toBe("failed-closed");
    expect(identityTreeSnapshot(fixture.newGenerationRoot)).toEqual(activeBefore);
    expect(existsSync(fixture.oldGenerationRoot)).toBe(operation !== "clean");
    expect(inspectFixedStoreLayout(store)).toMatchObject({
      transactions: [],
      staging: [],
      trash: [],
      lockPresent: false,
    });
  });

  it.each([
    "lstat",
    "realpath",
    "receipt-open",
    "opendir",
    "payload-open",
    "payload-read",
    "payload-close",
  ] as const)("fails closed when post-journal clean target %s verification is inaccessible", (operation) => {
    const fixture = materializeTwoGenerations();
    const store = createOrOpenOwnedStore(fixture.root.projectRoot);
    const receiptPath = join(fixture.oldGenerationRoot, "receipt.json");
    const payloadTarget = fixture.oldPlan.manifest.entries[0]?.target;
    if (payloadTarget === undefined) throw new Error("fixture payload target is absent");
    const payloadPath = join(fixture.oldGenerationRoot, "content", ...payloadTarget.split("/"));
    const oldBefore = identityTreeSnapshot(fixture.oldGenerationRoot);
    const activeBefore = identityTreeSnapshot(fixture.newGenerationRoot);
    let injected = false;
    const result = cleanProjectionGenerationWithRuntime(
      {
        projectRoot: fixture.root.projectRoot,
        generationDigest: fixture.oldPlan.manifest.digest,
      },
      Object.freeze({
        onFaultPoint(point: CleanFaultPoint): void {
          if (point !== "after-clean-journal-prepared") return;
          injected = true;
          const inaccessible = (code = "EACCES"): never => {
            throw Object.assign(new Error("synthetic clean target access failure"), {
              code,
            });
          };
          if (operation === "lstat") {
            mutableFs.lstatSync = ((...args: unknown[]) =>
              String(args[0]) === receiptPath
                ? inaccessible()
                : Reflect.apply(originalLstatSync, mutableFs, args)) as typeof originalLstatSync;
          } else if (operation === "realpath") {
            mutableFs.realpathSync = ((...args: unknown[]) =>
              String(args[0]) === receiptPath
                ? inaccessible()
                : Reflect.apply(
                    originalRealpathSync,
                    mutableFs,
                    args,
                  )) as typeof originalRealpathSync;
          } else if (operation === "receipt-open") {
            mutableFs.openSync = ((...args: unknown[]) =>
              String(args[0]) === receiptPath
                ? inaccessible()
                : Reflect.apply(originalOpenSync, mutableFs, args)) as typeof originalOpenSync;
          } else if (operation === "opendir") {
            mutableFs.opendirSync = ((...args: unknown[]) =>
              String(args[0]) === fixture.oldGenerationRoot
                ? inaccessible()
                : Reflect.apply(
                    originalOpendirSync,
                    mutableFs,
                    args,
                  )) as typeof originalOpendirSync;
          } else if (operation === "payload-open") {
            mutableFs.openSync = ((...args: unknown[]) =>
              String(args[0]) === payloadPath
                ? inaccessible()
                : Reflect.apply(originalOpenSync, mutableFs, args)) as typeof originalOpenSync;
          } else {
            let payloadDescriptor: number | undefined;
            mutableFs.openSync = ((...args: unknown[]) => {
              const descriptor = Reflect.apply(originalOpenSync, mutableFs, args) as number;
              if (String(args[0]) === payloadPath) payloadDescriptor = descriptor;
              return descriptor;
            }) as typeof originalOpenSync;
            if (operation === "payload-read") {
              mutableFs.readFileSync = ((...args: unknown[]) => {
                if (args[0] !== payloadDescriptor) {
                  return Reflect.apply(originalReadFileSync, mutableFs, args);
                }
                payloadDescriptor = undefined;
                return inaccessible("EIO");
              }) as typeof originalReadFileSync;
            } else {
              mutableFs.closeSync = ((descriptor: number) => {
                if (descriptor !== payloadDescriptor) {
                  return originalCloseSync(descriptor);
                }
                originalCloseSync(descriptor);
                payloadDescriptor = undefined;
                return inaccessible("EIO");
              }) as typeof originalCloseSync;
            }
          }
          syncBuiltinESMExports();
        },
        lockRuntime: Object.freeze({
          pid: process.pid,
          randomToken: () => LOCK_TOKEN,
          pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
        }),
      }),
    );
    restoreBuiltins();

    expect(result).toMatchObject({
      state: "failed-closed",
      generationDigest: fixture.oldPlan.manifest.digest,
      findings: [{ code: "METHODOLOGY_STORE_FILESYSTEM_FAILURE" }],
    });
    expect(injected).toBe(true);
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(oldBefore);
    expect(identityTreeSnapshot(fixture.newGenerationRoot)).toEqual(activeBefore);
    expect(inspectFixedStoreLayout(store)).toMatchObject({
      transactions: [expect.any(String)],
      staging: [],
      trash: [],
      lockPresent: false,
    });
  });

  it("cleans one exact inactive generation without changing the active generation", () => {
    const fixture = materializeTwoGenerations();
    const outside = makeSiblingCanary(fixture.root);
    const store = createOrOpenOwnedStore(fixture.root.projectRoot);
    const activeBefore = readFileSync(store.layout.active);
    const activeGenerationBefore = identityTreeSnapshot(fixture.newGenerationRoot);

    const result = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.oldPlan.manifest.digest,
    });

    expect(result).toMatchObject({
      state: "cleaned",
      generationDigest: fixture.oldPlan.manifest.digest,
      findings: [],
    });
    expectCleanBoundary(result);
    expect(existsSync(fixture.oldGenerationRoot)).toBe(false);
    expect(readFileSync(store.layout.active)).toEqual(activeBefore);
    expect(identityTreeSnapshot(fixture.newGenerationRoot)).toEqual(activeGenerationBefore);
    expect(inspectFixedStoreLayout(store)).toMatchObject({
      transactions: [],
      staging: [],
      trash: [],
      lockPresent: false,
    });
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("blocks cleaning the active generation and leaves every generation unchanged", () => {
    const fixture = materializeTwoGenerations();
    const store = createOrOpenOwnedStore(fixture.root.projectRoot);
    const activeBefore = readFileSync(store.layout.active);
    const oldBefore = identityTreeSnapshot(fixture.oldGenerationRoot);
    const newBefore = identityTreeSnapshot(fixture.newGenerationRoot);

    const result = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.newPlan.manifest.digest,
    });

    expect(result).toMatchObject({
      state: "blocked",
      generationDigest: fixture.newPlan.manifest.digest,
      findings: [{ code: "METHODOLOGY_STORE_CLEAN_ACTIVE" }],
    });
    expectCleanBoundary(result);
    expect(readFileSync(store.layout.active)).toEqual(activeBefore);
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(oldBefore);
    expect(identityTreeSnapshot(fixture.newGenerationRoot)).toEqual(newBefore);
  });

  it("retains inactive history when the selected generation is absent", () => {
    const fixture = materializeTwoGenerations();
    const oldBefore = identityTreeSnapshot(fixture.oldGenerationRoot);
    rmSync(fixture.newGenerationRoot, { recursive: true });

    const result = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.oldPlan.manifest.digest,
    });

    expect(result.state).not.toBe("cleaned");
    expect(existsSync(fixture.oldGenerationRoot)).toBe(true);
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(oldBefore);
  });

  it("retains inactive history when activation is not bound to its receipt", () => {
    const fixture = materializeTwoGenerations();
    const store = createOrOpenOwnedStore(fixture.root.projectRoot);
    const active = ActivationRecordSchema.parse(
      JSON.parse(readFileSync(store.layout.active, "utf8")),
    );
    writeFileSync(
      store.layout.active,
      canonicalRecordBytes("activation", {
        ...active,
        receiptDigest: "f".repeat(64),
      }),
    );
    const oldBefore = identityTreeSnapshot(fixture.oldGenerationRoot);

    const result = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.oldPlan.manifest.digest,
    });

    expect(result.state).not.toBe("cleaned");
    expect(existsSync(fixture.oldGenerationRoot)).toBe(true);
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(oldBefore);
  });

  it("retains an absent generation instead of claiming it was cleaned", () => {
    const fixture = materializeTwoGenerations();
    const digest = "f".repeat(64);

    const result = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: digest,
    });

    expect(result).toMatchObject({
      state: "retained",
      generationDigest: digest,
      findings: [{ code: "METHODOLOGY_STORE_CLEAN_RETAINED" }],
    });
    expectCleanBoundary(result);
  });

  it.each([
    "byte-drift",
    "missing",
    "extra",
  ] as const)("retains the target generation on %s", (kind) => {
    const fixture = materializeTwoGenerations();
    const outside = makeSiblingCanary(fixture.root);
    const target = fixture.oldPlan.manifest.entries[0]?.target;
    if (target === undefined) throw new Error("fixture target is absent");
    const targetPath = join(fixture.oldGenerationRoot, "content", ...target.split("/"));
    if (kind === "byte-drift") {
      writeFileSync(targetPath, "drift\n");
    } else if (kind === "missing") {
      rmSync(targetPath);
    } else {
      const extra = join(fixture.oldGenerationRoot, "content", "unexpected.txt");
      mkdirSync(dirname(extra), { recursive: true, mode: 0o700 });
      writeFileSync(extra, "unexpected\n", { mode: 0o600 });
    }
    const before = identityTreeSnapshot(fixture.oldGenerationRoot);

    const result = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.oldPlan.manifest.digest,
    });

    expect(result.state).toBe("retained");
    expect(result.generationDigest).toBe(fixture.oldPlan.manifest.digest);
    expect(result.findings).toHaveLength(1);
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("retains a hard-linked unexpected leaf and preserves its outside canary", () => {
    const fixture = materializeTwoGenerations();
    const outside = makeSiblingCanary(fixture.root);
    const linked = join(fixture.oldGenerationRoot, "content", "hard-linked-canary");
    linkSync(outside.canary, linked);
    const before = identityTreeSnapshot(fixture.oldGenerationRoot);

    const result = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.oldPlan.manifest.digest,
    });

    expect(result.state).toBe("retained");
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("retains a symbolic-link leaf and preserves its outside canary", ({ skip }) => {
    const fixture = materializeTwoGenerations();
    const outside = makeSiblingCanary(fixture.root);
    const linked = join(fixture.oldGenerationRoot, "content", "symbolic-canary");
    try {
      symlinkSync(outside.canary, linked, "file");
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? String(error.code)
          : "unknown";
      expect(["EACCES", "EINVAL", "ENOTSUP", "EPERM"]).toContain(code);
      skip(`symbolic-link fixture is unavailable on this runner: ${code}`);
      return;
    }
    const before = identityTreeSnapshot(fixture.oldGenerationRoot);

    const result = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.oldPlan.manifest.digest,
    });

    expect(result.state).toBe("retained");
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(before);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it("retains a malformed receipt without changing activation or target bytes", () => {
    const fixture = materializeTwoGenerations();
    const outside = makeSiblingCanary(fixture.root);
    const store = createOrOpenOwnedStore(fixture.root.projectRoot);
    writeFileSync(join(fixture.oldGenerationRoot, "receipt.json"), "{}\n", { mode: 0o600 });
    const targetBefore = identityTreeSnapshot(fixture.oldGenerationRoot);
    const activationBefore = readFileSync(store.layout.active);

    const result = cleanProjectionGeneration({
      projectRoot: fixture.root.projectRoot,
      generationDigest: fixture.oldPlan.manifest.digest,
    });

    expect(result.state).toBe("retained");
    expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(targetBefore);
    expect(readFileSync(store.layout.active)).toEqual(activationBefore);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on POSIX private-mode drift for content files and directories",
    () => {
      for (const kind of ["file", "directory"] as const) {
        const fixture = materializeTwoGenerations();
        const outside = makeSiblingCanary(fixture.root);
        const store = createOrOpenOwnedStore(fixture.root.projectRoot);
        const target = fixture.newPlan.manifest.entries[0]?.target;
        if (target === undefined) throw new Error("active target entry is absent");
        const changedPath =
          kind === "file"
            ? join(fixture.newGenerationRoot, "content", ...target.split("/"))
            : join(fixture.newGenerationRoot, "content");
        chmodSync(changedPath, 0o777);
        const activationBefore = readFileSync(store.layout.active);

        const result = generationStoreModule.inspectProjectionStore({
          projectRoot: fixture.root.projectRoot,
        });

        expect(result.state).toBe("failed-closed");
        expect(readFileSync(store.layout.active)).toEqual(activationBefore);
        expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
        chmodSync(changedPath, kind === "file" ? 0o600 : 0o700);
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "retains a Windows directory junction and preserves its outside canary",
    () => {
      const fixture = materializeTwoGenerations();
      const outsideDirectory = join(fixture.root.sandboxRoot, "junction-outside");
      const outsideCanary = join(outsideDirectory, "canary.txt");
      mkdirSync(outsideDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(outsideCanary, "junction-canary\n", { mode: 0o600 });
      const junction = join(fixture.oldGenerationRoot, "content", "junction-canary");
      symlinkSync(outsideDirectory, junction, "junction");
      const targetBefore = identityTreeSnapshot(fixture.oldGenerationRoot);

      const result = cleanProjectionGeneration({
        projectRoot: fixture.root.projectRoot,
        generationDigest: fixture.oldPlan.manifest.digest,
      });

      expect(result.state).toBe("retained");
      expect(identityTreeSnapshot(fixture.oldGenerationRoot)).toEqual(targetBefore);
      expect(readFileSync(outsideCanary, "utf8")).toBe("junction-canary\n");
    },
  );

  it("never adopts a clean next-phase temporary as partial-deletion authority", () => {
    const fixture = materializeTwoGenerations();
    const outside = makeSiblingCanary(fixture.root);
    const store = createOrOpenOwnedStore(fixture.root.projectRoot);
    const activationBefore = readFileSync(store.layout.active);
    const activeGenerationBefore = identityTreeSnapshot(fixture.newGenerationRoot);

    expect(() =>
      cleanProjectionGenerationWithRuntime(
        {
          projectRoot: fixture.root.projectRoot,
          generationDigest: fixture.oldPlan.manifest.digest,
        },
        cleanFaultRuntime("after-clean-quarantine"),
      ),
    ).toThrow("injected:after-clean-quarantine");
    const transactionId = inspectFixedStoreLayout(store).transactions[0];
    expect(transactionId).toBeDefined();
    if (transactionId === undefined) throw new Error("clean transaction id is absent");
    const journalPath = join(store.layout.transactions, `${transactionId}.json`);
    const durable = TransactionRecordSchema.parse(JSON.parse(readFileSync(journalPath, "utf8")));
    if (durable.operation !== "clean") throw new Error("clean journal changed operation");
    const quarantined = TransactionRecordSchema.parse({ ...durable, phase: "quarantined" });
    const deleting = TransactionRecordSchema.parse({ ...durable, phase: "deleting" });
    writeFileSync(journalPath, canonicalRecordBytes("transaction", quarantined), { mode: 0o600 });
    const temporaryPath = join(store.layout.transactions, `.${transactionId}.deleting.tmp`);
    writeFileSync(temporaryPath, canonicalRecordBytes("transaction", deleting), { mode: 0o600 });
    const trashRoot = join(store.layout.trash, transactionId);
    const target = fixture.oldPlan.manifest.entries[0]?.target;
    if (target === undefined) throw new Error("clean target entry is absent");
    rmSync(join(trashRoot, "content", ...target.split("/")));
    const journalBefore = readFileSync(journalPath);
    const temporaryBefore = readFileSync(temporaryPath);
    const trashBefore = identityTreeSnapshot(trashRoot);

    const result = generationStoreModule.recoverProjectionStore({
      projectRoot: fixture.root.projectRoot,
    });

    expect(result).toMatchObject({
      state: "failed-closed",
      activeDigest: fixture.newPlan.manifest.digest,
      findings: [{ code: "METHODOLOGY_STORE_TRANSACTION_INVALID" }],
    });
    expect(readFileSync(journalPath)).toEqual(journalBefore);
    expect(readFileSync(temporaryPath)).toEqual(temporaryBefore);
    expect(identityTreeSnapshot(trashRoot)).toEqual(trashBefore);
    expect(readFileSync(store.layout.active)).toEqual(activationBefore);
    expect(identityTreeSnapshot(fixture.newGenerationRoot)).toEqual(activeGenerationBefore);
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });

  it.each(
    CLEAN_FAULT_POINTS,
  )("recovers an interrupted exact clean at %s and never changes activation", (point) => {
    const fixture = materializeTwoGenerations();
    const outside = makeSiblingCanary(fixture.root);
    const store = createOrOpenOwnedStore(fixture.root.projectRoot);
    const activeBefore = readFileSync(store.layout.active);
    const activeGenerationBefore = identityTreeSnapshot(fixture.newGenerationRoot);

    expect(() =>
      cleanProjectionGenerationWithRuntime(
        {
          projectRoot: fixture.root.projectRoot,
          generationDigest: fixture.oldPlan.manifest.digest,
        },
        cleanFaultRuntime(point),
      ),
    ).toThrow(`injected:${point}`);
    expect(readFileSync(store.layout.active)).toEqual(activeBefore);

    const recovered = generationStoreModule.recoverProjectionStore({
      projectRoot: fixture.root.projectRoot,
    });

    expect(recovered).toMatchObject({
      state: "recovered",
      activeDigest: fixture.newPlan.manifest.digest,
      findings: [],
    });
    expect(existsSync(fixture.oldGenerationRoot)).toBe(false);
    expect(readFileSync(store.layout.active)).toEqual(activeBefore);
    expect(identityTreeSnapshot(fixture.newGenerationRoot)).toEqual(activeGenerationBefore);
    expect(inspectFixedStoreLayout(store)).toMatchObject({
      transactions: [],
      staging: [],
      trash: [],
      lockPresent: false,
    });
    expect(
      generationStoreModule.recoverProjectionStore({
        projectRoot: fixture.root.projectRoot,
      }),
    ).toMatchObject({
      state: "nothing-to-recover",
      activeDigest: fixture.newPlan.manifest.digest,
    });
    expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
  });
});
