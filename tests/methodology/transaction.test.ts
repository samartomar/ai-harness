import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApplyFaultPoint,
  ApplySyntheticTransactionRequestSchema,
  applySyntheticTransaction,
  type CleanFaultPoint,
  CleanSyntheticTransactionRequestSchema,
  cleanSyntheticTransaction,
  createSyntheticTransactionCapability,
  type SyntheticTransactionCapability,
  SyntheticTransactionReceiptSchema,
  SyntheticTransactionResultSchema,
} from "../../src/methodology/transaction.js";

const roots: string[] = [];
const capabilities: SyntheticTransactionCapability[] = [];

function capability(): SyntheticTransactionCapability {
  const value = createSyntheticTransactionCapability();
  roots.push(value.root);
  capabilities.push(value);
  return value;
}

function requestFor(value: SyntheticTransactionCapability): unknown {
  return {
    schemaVersion: 1,
    capability: value,
    plannerInput: {},
    payloads: [],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function artifact(
  id: string,
  content: string,
  dependencies: string[] = [],
): Record<string, unknown> {
  return {
    id,
    sourceLocator: `synthetic:${id}`,
    contentDigest: sha256(content),
    contentDisposition: "inert",
    linkDisposition: "none",
    licenseDisposition: "permissive",
    evidenceDigest: sha256(`evidence:${id}`),
    dependencies,
  };
}

function evidence(candidate: Record<string, unknown>): Record<string, unknown> {
  return {
    artifactId: candidate.id,
    sourceLocator: candidate.sourceLocator,
    contentDigest: candidate.contentDigest,
    licenseDisposition: candidate.licenseDisposition,
    evidenceDigest: candidate.evidenceDigest,
  };
}

const ROOT_CONTENT = "# Root methodology\n";
const DEPENDENCY_CONTENT = "# Dependency methodology\n";

function plannerInput(): Record<string, unknown> {
  const root = artifact("root", ROOT_CONTENT, ["dependency"]);
  const dependency = artifact("dependency", DEPENDENCY_CONTENT);
  return {
    schemaVersion: 1,
    decisionVersion: "phase-3-decision-v1",
    classifierVersion: "phase-2-classifier-v1",
    policyVersion: "phase-3-policy-v1",
    manifestVersion: 1,
    owner: "aih-methodology",
    classifierInput: {
      schemaVersion: 1,
      requested: ["root"],
      declaredClosure: ["root", "dependency"],
      artifacts: [root, dependency],
      evidence: [evidence(root), evidence(dependency)],
    },
    mappings: [
      { artifactId: "root", target: "rules/root.md" },
      { artifactId: "dependency", target: "rules/dependency.md" },
    ],
  };
}

function applyRequest(value: SyntheticTransactionCapability): Record<string, unknown> {
  return {
    schemaVersion: 1,
    capability: value,
    plannerInput: plannerInput(),
    payloads: [
      { artifactId: "root", target: "rules/root.md", content: ROOT_CONTENT },
      {
        artifactId: "dependency",
        target: "rules/dependency.md",
        content: DEPENDENCY_CONTENT,
      },
    ],
  };
}

afterEach(() => {
  for (const value of capabilities.splice(0)) value.dispose();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("methodology synthetic transaction authority", () => {
  it("mints a frozen live capability beneath the canonical OS temporary root", () => {
    const value = capability();
    const child = relative(realpathSync(tmpdir()), value.root);

    expect(child).not.toBe("");
    expect(child.startsWith("..")).toBe(false);
    expect(Object.keys(value)).toEqual(["root", "dispose"]);
    expect(Object.isFrozen(value)).toBe(true);
    expect(lstatSync(value.root).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(lstatSync(value.root).mode & 0o777).toBe(0o700);
    }
    expect(ApplySyntheticTransactionRequestSchema.safeParse(requestFor(value)).success).toBe(true);
  });

  it("rejects forged and disposed capabilities without deleting their root", () => {
    const value = capability();
    const forged = Object.freeze({ root: value.root, dispose: value.dispose });

    expect(
      ApplySyntheticTransactionRequestSchema.safeParse(requestFor(forged as never)).success,
    ).toBe(false);
    value.dispose();
    expect(ApplySyntheticTransactionRequestSchema.safeParse(requestFor(value)).success).toBe(false);
    expect(lstatSync(value.root).isDirectory()).toBe(true);
  });

  it("rejects proxies, accessors, custom prototypes, unknown keys, and sparse arrays", () => {
    const value = capability();
    let getterCalls = 0;
    let proxyCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "schemaVersion", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    Object.defineProperty(accessor, "capability", { enumerable: true, value });
    Object.defineProperty(accessor, "plannerInput", { enumerable: true, value: {} });
    Object.defineProperty(accessor, "payloads", { enumerable: true, value: [] });
    const proxy = new Proxy(requestFor(value) as object, {
      ownKeys() {
        proxyCalls += 1;
        return [];
      },
    });
    const custom = Object.assign(Object.create({ inherited: true }), requestFor(value));
    const unknown = { ...(requestFor(value) as object), extra: true };
    const sparse: unknown[] = [];
    sparse.length = 1;

    expect(ApplySyntheticTransactionRequestSchema.safeParse(accessor).success).toBe(false);
    expect(ApplySyntheticTransactionRequestSchema.safeParse(proxy).success).toBe(false);
    expect(ApplySyntheticTransactionRequestSchema.safeParse(custom).success).toBe(false);
    expect(ApplySyntheticTransactionRequestSchema.safeParse(unknown).success).toBe(false);
    expect(
      ApplySyntheticTransactionRequestSchema.safeParse({
        ...(requestFor(value) as Record<string, unknown>),
        payloads: sparse,
      }).success,
    ).toBe(false);
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
  });
});

describe("methodology synthetic transaction apply", () => {
  it("writes exact planned bytes and publishes a deterministic receipt last", () => {
    const value = capability();
    const request = applyRequest(value);
    const result = applySyntheticTransaction(request);

    expect(result).toMatchObject({
      schemaVersion: 1,
      state: "applied",
      boundary: {
        temporaryRootOnly: true,
        cli: false,
        executor: false,
        providerExecution: false,
        hostExecution: false,
        network: false,
      },
    });
    if (result.state !== "applied") throw new Error("expected applied result");
    expect(SyntheticTransactionReceiptSchema.safeParse(result.receipt).success).toBe(true);
    expect(SyntheticTransactionResultSchema.safeParse(result).success).toBe(true);
    expect(result.receipt.claims).toEqual({
      installed: false,
      active: false,
      isolated: false,
      switchable: false,
      concurrent: false,
      conflictFree: false,
      secureErasure: false,
    });
    expect(readFileSync(`${value.root}/.aih-methodology-projection/rules/root.md`, "utf8")).toBe(
      ROOT_CONTENT,
    );
    expect(
      readFileSync(`${value.root}/.aih-methodology-projection/rules/dependency.md`, "utf8"),
    ).toBe(DEPENDENCY_CONTENT);
    expect(
      existsSync(`${value.root}/.aih-methodology-projection/.aih-methodology-receipt.json`),
    ).toBe(true);
    expect(applySyntheticTransaction(request)).toEqual(result);
    expect(readdirSync(value.root)).toEqual([".aih-methodology-projection"]);
  });

  it("canonicalizes payload and planner collection order for idempotent replay", () => {
    const value = capability();
    const request = applyRequest(value);
    const first = applySyntheticTransaction(request);
    const input = request.plannerInput as Record<string, unknown>;
    const classifier = input.classifierInput as Record<string, unknown>;
    const reordered = {
      ...request,
      plannerInput: {
        ...input,
        classifierInput: {
          ...classifier,
          artifacts: [...(classifier.artifacts as unknown[])].reverse(),
          evidence: [...(classifier.evidence as unknown[])].reverse(),
          declaredClosure: [...(classifier.declaredClosure as unknown[])].reverse(),
        },
        mappings: [...(input.mappings as unknown[])].reverse(),
      },
      payloads: [...(request.payloads as unknown[])].reverse(),
    };

    expect(applySyntheticTransaction(reordered)).toEqual(first);
  });

  it("blocks invalid payload binding and leaves the capability root unchanged", () => {
    const cases = [
      (request: Record<string, unknown>) => ({ ...request, payloads: [] }),
      (request: Record<string, unknown>) => ({
        ...request,
        payloads: [...(request.payloads as unknown[]), (request.payloads as unknown[])[0]],
      }),
      (request: Record<string, unknown>) => ({
        ...request,
        payloads: (request.payloads as Array<Record<string, unknown>>).map((payload, index) =>
          index === 0 ? { ...payload, content: "drifted" } : payload,
        ),
      }),
      (request: Record<string, unknown>) => ({
        ...request,
        payloads: (request.payloads as Array<Record<string, unknown>>).map((payload, index) =>
          index === 0 ? { ...payload, target: "rules/other.md" } : payload,
        ),
      }),
    ];

    for (const mutate of cases) {
      const value = capability();
      expect(applySyntheticTransaction(mutate(applyRequest(value))).state).toBe("blocked");
      expect(readdirSync(value.root)).toEqual([]);
    }
  });

  it("blocks an unexpected root entry or linked path without touching it", () => {
    const unexpected = capability();
    writeFileSync(`${unexpected.root}/operator.txt`, "keep");
    expect(applySyntheticTransaction(applyRequest(unexpected)).state).toBe("blocked");
    expect(readFileSync(`${unexpected.root}/operator.txt`, "utf8")).toBe("keep");

    const linked = capability();
    const outside = capability();
    writeFileSync(`${outside.root}/outside.txt`, "outside");
    symlinkSync(`${outside.root}/outside.txt`, `${linked.root}/linked.txt`);
    expect(applySyntheticTransaction(applyRequest(linked)).state).toBe("blocked");
    expect(readFileSync(`${outside.root}/outside.txt`, "utf8")).toBe("outside");
  });

  it("blocks a substituted capability root without writing either identity", () => {
    const value = capability();
    const authentic = `${value.root}-authentic`;
    renameSync(value.root, authentic);
    roots.push(authentic);
    const replacement = capability();
    renameSync(replacement.root, value.root);

    expect(applySyntheticTransaction(applyRequest(value)).state).toBe("blocked");
    expect(readdirSync(authentic)).toEqual([]);
    expect(readdirSync(value.root)).toEqual([]);
  });
});

describe("methodology synthetic transaction apply recovery", () => {
  it.each([
    "after-root-validation",
    "after-lock",
    "after-projection-create",
    "after-entry-write",
    "after-metadata-validation",
    "before-commit",
    "after-commit",
  ] satisfies ApplyFaultPoint[])("recovers deterministically after %s", (faultAt) => {
    const value = capability();
    const request = applyRequest(value);
    const interrupted = applySyntheticTransaction(request, { faultAt });

    expect(["blocked", "recovery-required"]).toContain(interrupted.state);
    expect(SyntheticTransactionResultSchema.safeParse(interrupted).success).toBe(true);
    expect(applySyntheticTransaction(request).state).toBe("applied");
    expect(readdirSync(value.root)).toEqual([".aih-methodology-projection"]);
  });

  it("retains authenticated recovery evidence when rollback is interrupted", () => {
    const value = capability();
    const request = applyRequest(value);

    expect(applySyntheticTransaction(request, { faultAt: "during-rollback" }).state).toBe(
      "recovery-required",
    );
    expect(existsSync(`${value.root}/.aih-methodology-recovery.json`)).toBe(true);
    expect(applySyntheticTransaction(request, { faultAt: "during-recovery" }).state).toBe(
      "recovery-required",
    );
    expect(applySyntheticTransaction(request).state).toBe("applied");
    expect(readdirSync(value.root)).toEqual([".aih-methodology-projection"]);
  });

  it("refuses a linked substitution in an interrupted projection", () => {
    const value = capability();
    const outside = capability();
    const request = applyRequest(value);
    expect(applySyntheticTransaction(request, { faultAt: "during-rollback" }).state).toBe(
      "recovery-required",
    );
    const partial = `${value.root}/.aih-methodology-projection/rules/dependency.md`;
    writeFileSync(`${outside.root}/outside.md`, "outside");
    unlinkSync(partial);
    symlinkSync(`${outside.root}/outside.md`, partial);

    expect(applySyntheticTransaction(request).state).toBe("recovery-required");
    expect(readFileSync(`${outside.root}/outside.md`, "utf8")).toBe("outside");
    expect(lstatSync(partial).isSymbolicLink()).toBe(true);
  });

  it("rejects unknown or accessor-backed fault options without executing getters", () => {
    const value = capability();
    let calls = 0;
    const options = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(options, "faultAt", {
      enumerable: true,
      get() {
        calls += 1;
        return "after-lock";
      },
    });

    expect(applySyntheticTransaction(applyRequest(value), options as never).state).toBe("blocked");
    expect(
      applySyntheticTransaction(applyRequest(value), { faultAt: "unknown" } as never).state,
    ).toBe("blocked");
    expect(calls).toBe(0);
    expect(readdirSync(value.root)).toEqual([]);
  });
});

function appliedReceipt(value: SyntheticTransactionCapability) {
  const result = applySyntheticTransaction(applyRequest(value));
  if (result.state !== "applied") throw new Error("expected applied fixture");
  return result.receipt;
}

describe("methodology synthetic transaction clean", () => {
  it("removes only the receipt-bound projection and is idempotent", () => {
    const value = capability();
    const receipt = appliedReceipt(value);
    const request = { schemaVersion: 1, capability: value, receipt };

    expect(CleanSyntheticTransactionRequestSchema.safeParse(request).success).toBe(true);
    const result = cleanSyntheticTransaction(request);
    expect(result).toMatchObject({
      schemaVersion: 1,
      state: "cleaned",
      manifestDigest: receipt.manifestDigest,
      boundary: { temporaryRootOnly: true, nativeComponent: false },
    });
    expect(SyntheticTransactionResultSchema.safeParse(result).success).toBe(true);
    expect(readdirSync(value.root)).toEqual([]);
    expect(cleanSyntheticTransaction(request)).toEqual(result);
  });

  it("rejects forged or stale receipts without changing the projection", () => {
    const value = capability();
    const receipt = appliedReceipt(value);
    const projection = `${value.root}/.aih-methodology-projection`;
    const forged = {
      ...receipt,
      authTag: "f".repeat(64),
    };

    expect(
      cleanSyntheticTransaction({ schemaVersion: 1, capability: value, receipt: forged }).state,
    ).toBe("blocked");
    expect(readFileSync(`${projection}/rules/root.md`, "utf8")).toBe(ROOT_CONTENT);
    const other = capability();
    const otherReceipt = appliedReceipt(other);
    expect(
      cleanSyntheticTransaction({ schemaVersion: 1, capability: value, receipt: otherReceipt })
        .state,
    ).toBe("blocked");
    expect(readFileSync(`${projection}/rules/root.md`, "utf8")).toBe(ROOT_CONTENT);
  });

  it("refuses content drift and unexpected entries without partial cleanup", () => {
    const drifted = capability();
    const driftedReceipt = appliedReceipt(drifted);
    const driftedTarget = `${drifted.root}/.aih-methodology-projection/rules/root.md`;
    writeFileSync(driftedTarget, "operator edit");
    expect(
      cleanSyntheticTransaction({
        schemaVersion: 1,
        capability: drifted,
        receipt: driftedReceipt,
      }).state,
    ).toBe("blocked");
    expect(readFileSync(driftedTarget, "utf8")).toBe("operator edit");

    const unexpected = capability();
    const unexpectedReceipt = appliedReceipt(unexpected);
    const extra = `${unexpected.root}/.aih-methodology-projection/operator.txt`;
    writeFileSync(extra, "keep");
    expect(
      cleanSyntheticTransaction({
        schemaVersion: 1,
        capability: unexpected,
        receipt: unexpectedReceipt,
      }).state,
    ).toBe("blocked");
    expect(readFileSync(extra, "utf8")).toBe("keep");
  });

  it("refuses linked managed files and preserves the external identity", () => {
    const symbolic = capability();
    const symbolicReceipt = appliedReceipt(symbolic);
    const outside = capability();
    const symbolicTarget = `${symbolic.root}/.aih-methodology-projection/rules/root.md`;
    writeFileSync(`${outside.root}/outside.md`, "outside");
    unlinkSync(symbolicTarget);
    symlinkSync(`${outside.root}/outside.md`, symbolicTarget);
    expect(
      cleanSyntheticTransaction({
        schemaVersion: 1,
        capability: symbolic,
        receipt: symbolicReceipt,
      }).state,
    ).toBe("blocked");
    expect(readFileSync(`${outside.root}/outside.md`, "utf8")).toBe("outside");

    const hard = capability();
    const hardReceipt = appliedReceipt(hard);
    const hardTarget = `${hard.root}/.aih-methodology-projection/rules/root.md`;
    linkSync(hardTarget, `${outside.root}/hard.md`);
    expect(
      cleanSyntheticTransaction({ schemaVersion: 1, capability: hard, receipt: hardReceipt }).state,
    ).toBe("blocked");
    expect(readFileSync(`${outside.root}/hard.md`, "utf8")).toBe(ROOT_CONTENT);
  });

  it.each([
    "after-root-validation",
    "after-lock",
    "after-recovery-record",
    "after-receipt-revoke",
    "during-entry-remove",
    "during-directory-remove",
    "before-recovery-remove",
  ] satisfies CleanFaultPoint[])("recovers deterministically after clean fault %s", (faultAt) => {
    const value = capability();
    const receipt = appliedReceipt(value);
    const request = { schemaVersion: 1, capability: value, receipt };

    expect(["blocked", "recovery-required"]).toContain(
      cleanSyntheticTransaction(request, { faultAt }).state,
    );
    expect(cleanSyntheticTransaction(request).state).toBe("cleaned");
    expect(readdirSync(value.root)).toEqual([]);
  });

  it("keeps clean recovery evidence when recovery itself is interrupted", () => {
    const value = capability();
    const receipt = appliedReceipt(value);
    const request = { schemaVersion: 1, capability: value, receipt };
    expect(cleanSyntheticTransaction(request, { faultAt: "after-receipt-revoke" }).state).toBe(
      "recovery-required",
    );
    expect(existsSync(`${value.root}/.aih-methodology-recovery.json`)).toBe(true);
    expect(cleanSyntheticTransaction(request, { faultAt: "during-recovery" }).state).toBe(
      "recovery-required",
    );
    expect(cleanSyntheticTransaction(request).state).toBe("cleaned");
  });
});

describe("methodology synthetic transaction boundaries", () => {
  it("pins a three-OS Phase 4 workflow and runs transaction tests before native build", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/methodology-phase-4-transactions.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toMatch(/ubuntu-latest/);
    expect(workflow).toMatch(/windows-latest/);
    expect(workflow).toMatch(/macos-latest/);
    expect(workflow).toMatch(/feature\/methodology-projection-phase-4-final/);
    expect(workflow).toMatch(/npm ci --ignore-scripts/);
    expect(workflow).toMatch(/npm test -- tests\/methodology\/transaction\.test\.ts/);
    expect(workflow.indexOf("transaction.test.ts")).toBeLessThan(
      workflow.indexOf("build:native-methodology"),
    );
    expect(workflow).toMatch(/npm run verify/);
    expect(workflow).toMatch(/git diff --check/);
    expect(workflow).not.toMatch(/upload-artifact|download-artifact|pull_request_target/);
    for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
      expect(match[1]).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });

  it("has no native, CLI, executor, process, network, provider, or host capability", () => {
    const source = readFileSync(
      new URL("../../src/methodology/transaction.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/native-fs-feasibility|node:child_process|node:net|node:http/);
    expect(source).not.toMatch(
      /from\s+["'][^"']*(?:src\/cli|internals\/execute|provider|host-profiles|package-manager)/,
    );
    expect(source).not.toMatch(/spawn|execFile|fork|Worker|fetch\s*\(|require\s*\(/);
    expect(source).not.toMatch(
      /\b(?:writeFileSync|rmSync|cpSync|renameSync|symlinkSync|linkSync)\b/,
    );
    expect(source).not.toMatch(/\b(?:readFileSync|readdirSync)\b/);
  });

  it("mutates only the live capability root", () => {
    const target = capability();
    const sibling = capability();
    const sentinel = `${sibling.root}/sentinel.txt`;
    writeFileSync(sentinel, "unchanged");
    const before = readFileSync(sentinel, "utf8");
    const receipt = appliedReceipt(target);

    expect(readFileSync(sentinel, "utf8")).toBe(before);
    expect(cleanSyntheticTransaction({ schemaVersion: 1, capability: target, receipt }).state).toBe(
      "cleaned",
    );
    expect(readFileSync(sentinel, "utf8")).toBe(before);
    expect(readdirSync(sibling.root)).toEqual(["sentinel.txt"]);
  });

  it("does not execute ambient Array, String, RegExp, or thenable hooks", () => {
    const value = capability();
    const request = applyRequest(value);
    const arrayPush = Array.prototype.push;
    const arraySplice = Array.prototype.splice;
    const stringEndsWith = String.prototype.endsWith;
    const stringSplit = String.prototype.split;
    const stringStartsWith = String.prototype.startsWith;
    const regexpTest = RegExp.prototype.test;
    const calls = {
      push: 0,
      splice: 0,
      endsWith: 0,
      split: 0,
      startsWith: 0,
      regexp: 0,
      thenable: 0,
    };
    let result: ReturnType<typeof applySyntheticTransaction> | undefined;
    Object.defineProperty(Array.prototype, "push", {
      configurable: true,
      value(...args: unknown[]) {
        calls.push += 1;
        return Reflect.apply(arrayPush, this, args);
      },
      writable: true,
    });
    Object.defineProperty(Array.prototype, "splice", {
      configurable: true,
      value(...args: unknown[]) {
        calls.splice += 1;
        return Reflect.apply(arraySplice, this, args);
      },
      writable: true,
    });
    Object.defineProperty(String.prototype, "split", {
      configurable: true,
      value(...args: unknown[]) {
        calls.split += 1;
        return Reflect.apply(stringSplit, this, args);
      },
      writable: true,
    });
    Object.defineProperty(String.prototype, "endsWith", {
      configurable: true,
      value(...args: unknown[]) {
        calls.endsWith += 1;
        return Reflect.apply(stringEndsWith, this, args);
      },
      writable: true,
    });
    Object.defineProperty(String.prototype, "startsWith", {
      configurable: true,
      value(...args: unknown[]) {
        calls.startsWith += 1;
        return Reflect.apply(stringStartsWith, this, args);
      },
      writable: true,
    });
    Object.defineProperty(RegExp.prototype, "test", {
      configurable: true,
      value(...args: unknown[]) {
        calls.regexp += 1;
        return Reflect.apply(regexpTest, this, args);
      },
      writable: true,
    });
    // biome-ignore lint/suspicious/noThenProperty: hostile thenable assimilation is the boundary under test.
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      get() {
        calls.thenable += 1;
        return undefined;
      },
    });
    try {
      result = applySyntheticTransaction(request);
    } finally {
      Object.defineProperty(Array.prototype, "push", {
        configurable: true,
        value: arrayPush,
        writable: true,
      });
      Object.defineProperty(Array.prototype, "splice", {
        configurable: true,
        value: arraySplice,
        writable: true,
      });
      Object.defineProperty(String.prototype, "split", {
        configurable: true,
        value: stringSplit,
        writable: true,
      });
      Object.defineProperty(String.prototype, "endsWith", {
        configurable: true,
        value: stringEndsWith,
        writable: true,
      });
      Object.defineProperty(String.prototype, "startsWith", {
        configurable: true,
        value: stringStartsWith,
        writable: true,
      });
      Object.defineProperty(RegExp.prototype, "test", {
        configurable: true,
        value: regexpTest,
        writable: true,
      });
      delete (Object.prototype as { then?: unknown }).then;
    }
    expect(calls).toEqual({
      push: 0,
      splice: 0,
      endsWith: 0,
      split: 0,
      startsWith: 0,
      regexp: 0,
      thenable: 0,
    });
    expect(result?.state).toBe("blocked");
  });

  it("enforces payload resource bounds before mutation", () => {
    const oversized = capability();
    const oversizedRequest = applyRequest(oversized);
    oversizedRequest.payloads = (oversizedRequest.payloads as Array<Record<string, unknown>>).map(
      (payload, index) =>
        index === 0 ? { ...payload, content: "x".repeat(64 * 1024 + 1) } : payload,
    );
    expect(applySyntheticTransaction(oversizedRequest).state).toBe("blocked");
    expect(readdirSync(oversized.root)).toEqual([]);

    const tooMany = capability();
    expect(
      ApplySyntheticTransactionRequestSchema.safeParse({
        ...applyRequest(tooMany),
        payloads: Array.from({ length: 65 }, () => ({
          artifactId: "a",
          target: "a",
          content: "a",
        })),
      }).success,
    ).toBe(false);
    expect(readdirSync(tooMany.root)).toEqual([]);

    const crowded = capability();
    for (let index = 0; index < 257; index += 1) {
      writeFileSync(`${crowded.root}/entry-${index.toString().padStart(3, "0")}`, "x");
    }
    expect(applySyntheticTransaction(applyRequest(crowded)).state).toBe("blocked");
  });

  it.each([
    "rules\\root.md",
    "CON",
    "rules/root.",
    "rules/root ",
    "/absolute/root.md",
    "../escape.md",
  ])("inherits fail-closed cross-platform target policy for %s", (target) => {
    const value = capability();
    const request = applyRequest(value);
    const input = request.plannerInput as Record<string, unknown>;
    const mappings = input.mappings as Array<Record<string, unknown>>;
    mappings[0] = { ...mappings[0], target };

    expect(applySyntheticTransaction(request).state).toBe("blocked");
    expect(readdirSync(value.root)).toEqual([]);
  });

  it("blocks a case-folded target collision before mutation", () => {
    const value = capability();
    const request = applyRequest(value);
    const input = request.plannerInput as Record<string, unknown>;
    input.mappings = [
      { artifactId: "root", target: "rules/ROOT.md" },
      { artifactId: "dependency", target: "rules/root.md" },
    ];

    expect(applySyntheticTransaction(request).state).toBe("blocked");
    expect(readdirSync(value.root)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("blocks POSIX root permission drift", () => {
    const value = capability();
    chmodSync(value.root, 0o755);

    expect(applySyntheticTransaction(applyRequest(value)).state).toBe("blocked");
    expect(readdirSync(value.root)).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")(
    "blocks a Windows junction entry without traversal",
    () => {
      const value = capability();
      const outside = capability();
      writeFileSync(`${outside.root}/sentinel.txt`, "outside");
      symlinkSync(outside.root, `${value.root}/junction`, "junction");

      expect(applySyntheticTransaction(applyRequest(value)).state).toBe("blocked");
      expect(readFileSync(`${outside.root}/sentinel.txt`, "utf8")).toBe("outside");
    },
  );

  it("rejects unknown findings and contradictory result records", () => {
    const invalidFinding = {
      schemaVersion: 1,
      state: "blocked",
      boundary: {
        temporaryRootOnly: true,
        cli: false,
        executor: false,
        providerExecution: false,
        hostExecution: false,
        network: false,
        nativeComponent: false,
      },
      findings: [{ code: "METHODOLOGY_TRANSACTION_FAKE" }],
    };
    const contradictory = {
      ...invalidFinding,
      state: "applied",
      receipt: {},
    };

    expect(SyntheticTransactionResultSchema.safeParse(invalidFinding).success).toBe(false);
    expect(SyntheticTransactionResultSchema.safeParse(contradictory).success).toBe(false);
  });

  it("bounds every receipt-controlled string", () => {
    const value = capability();
    const receipt = appliedReceipt(value);
    const entry = receipt.entries[0];
    if (entry === undefined) throw new Error("expected receipt entry");

    expect(
      SyntheticTransactionReceiptSchema.safeParse({ ...receipt, owner: "o".repeat(65) }).success,
    ).toBe(false);
    expect(
      SyntheticTransactionReceiptSchema.safeParse({
        ...receipt,
        entries: [{ ...entry, artifactId: "a".repeat(65) }, ...receipt.entries.slice(1)],
      }).success,
    ).toBe(false);
    expect(
      SyntheticTransactionReceiptSchema.safeParse({
        ...receipt,
        entries: [{ ...entry, target: "t".repeat(241) }, ...receipt.entries.slice(1)],
      }).success,
    ).toBe(false);
    expect(
      SyntheticTransactionReceiptSchema.safeParse({
        ...receipt,
        entries: [{ ...entry, target: "../outside.md" }, ...receipt.entries.slice(1)],
      }).success,
    ).toBe(false);
    expect(
      SyntheticTransactionReceiptSchema.safeParse({
        ...receipt,
        entries: [entry, entry],
      }).success,
    ).toBe(false);
    expect(
      SyntheticTransactionReceiptSchema.safeParse({
        ...receipt,
        entries: Array.from({ length: 9 }, (_, index) => ({
          ...entry,
          artifactId: `artifact-${index}`,
          target: `rules/artifact-${index}.md`,
          bytes: 64 * 1024,
        })),
      }).success,
    ).toBe(false);
  });
});
