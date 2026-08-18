import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { command as governanceDoctorCommand } from "../../src/governance-doctor/command-v1.js";
import {
  assertGovernanceDoctorRepairEffectArgumentsV1,
  canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes,
  createGovernanceDoctorRepairBrokerRegistryV1,
  GOVERNANCE_DOCTOR_REPAIR_EFFECT_ARGUMENT_SCHEMAS_V1,
  GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1,
  governanceDoctorRepairRecipeV1,
  parseGovernanceDoctorRepairBrokerRegistryV1Json,
} from "../../src/governance-doctor/repair-broker-v1.js";
import {
  GOVERNANCE_DOCTOR_PROHIBITED_REPAIR_AUTHORITIES_V1,
  GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS,
} from "../../src/governance-doctor/repair-capability-v1.js";

const root = resolve(__dirname, "..", "..");

const REPAIR_SOURCES = [
  "src/governance-doctor/repair-broker-v1.ts",
  "src/governance-doctor/repair-capability-v1.ts",
  "src/governance-doctor/repair-consent-v1.ts",
  "src/governance-doctor/repair-outcome-v1.ts",
  "src/governance-doctor/repair-plan-v1.ts",
] as const;

const repairSource = Object.fromEntries(
  REPAIR_SOURCES.map((relative) => [relative, readFileSync(resolve(root, relative), "utf8")]),
) as Record<string, string>;

/**
 * Independent, test-owned JCS serializer and digest. Nothing here calls the
 * production canonicalizer, so a vector computed with it is real evidence rather
 * than a restatement of the function under test.
 */
const jcs = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`)
    .join(",")}}`;
};
const domainDigest = (domain: string, record: unknown): string =>
  createHash("sha256").update(jcs({ domain, record }), "utf8").digest("hex");

/** Fixtures are built from code points so this source stays pure ASCII. */
const cp = (...points: readonly number[]): string => String.fromCodePoint(...points);

const PATH_ARGUMENT = { name: "path", type: "managed-relative-path" } as const;
const CONTENT_ARGUMENT = { name: "contentSha256", type: "sha256" } as const;

function templates(): Record<string, unknown>[] {
  return [
    {
      argumentSchema: [{ ...PATH_ARGUMENT }],
      effectKind: "create-managed-directory",
      templateId: "ensure-canon-directory",
    },
    {
      argumentSchema: [{ ...CONTENT_ARGUMENT }, { ...PATH_ARGUMENT }],
      effectKind: "restore-managed-file-content",
      templateId: "restore-canon-router",
    },
  ];
}

function recipeInput(overrides: Record<string, unknown> = {}) {
  return {
    effectVersion: "1",
    effects: templates(),
    recipeId: "restore-repository-canon",
    schemaVersion: "1",
    ...overrides,
  };
}

function registryInput(overrides: Record<string, unknown> = {}) {
  return {
    brokerId: "aih:governance-doctor.mechanical",
    owner: "aih",
    recipes: [recipeInput()],
    ...overrides,
  };
}

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("GovernanceDoctor Repair V1 capability boundary (static)", () => {
  it("holds no filesystem, process, network, provider, scanner, or signer implementation", () => {
    for (const [relative, source] of Object.entries(repairSource)) {
      expect(source, relative).not.toMatch(
        /node:(?:fs|child_process|net|http|https|dgram|tls|worker_threads|vm|readline|crypto|os|path)/,
      );
      expect(source, relative).not.toMatch(
        /\b(?:fetch|execSync|execFileSync|spawnSync|spawn|exec|execFile|require|createSign|createVerify|createHash|webcrypto)\s*\(/,
      );
      expect(source, relative).not.toMatch(/\bprocess\.(?:env|argv|cwd|stdout|stderr)\b/);
      expect(source, relative).not.toMatch(/\bnew Function\b|\beval\s*\(/);
      expect(source, relative).not.toMatch(/\bimport\s*\(/);
    }
  });

  it("synthesizes no command, argv, shell, or executable seam and takes no caller callback", () => {
    // The frozen exclusion list is the one place these words may legitimately
    // appear, and only as data the foundation refuses; every other occurrence
    // would be a capability. Strip that declaration, then require absence.
    const EXCLUSION_LIST = /const GOVERNANCE_DOCTOR_PROHIBITED_REPAIR_AUTHORITIES_V1[\s\S]*?\]\);/;
    expect(repairSource["src/governance-doctor/repair-capability-v1.ts"]).toMatch(EXCLUSION_LIST);
    for (const [relative, source] of Object.entries(repairSource)) {
      const body = source.replace(EXCLUSION_LIST, "");
      for (const token of [
        "argv",
        "commandPath",
        "CommandSpec",
        "PlanContext",
        "shell",
        "stdin",
        "stdout",
        "--force",
        "--yes",
        "--apply",
      ])
        expect(body, `${relative}:${token}`).not.toContain(token);
      // No schema field may hold, type, or invoke a caller-supplied function.
      expect(source, relative).not.toMatch(/===\s*"function"/);
      expect(source, relative).not.toMatch(/\basync\b|\bawait\b|\bPromise\b/);
    }
  });

  it("orders exclusively by raw UTF-16 code units", () => {
    for (const [relative, source] of Object.entries(repairSource)) {
      expect(source, relative).not.toMatch(/localeCompare|\bIntl\b|Collator/);
      expect(source, relative).not.toMatch(/\.sort\(\s*\)/);
    }
  });

  it("reads no clock, random source, or ambient global state", () => {
    for (const [relative, source] of Object.entries(repairSource)) {
      expect(source, relative).not.toMatch(/\bDate\b|Math\.random|randomUUID|performance\./);
      expect(source, relative).not.toMatch(/\bglobalThis\b/);
    }
  });

  it("leaves index, command registration, Workbench, and public exports unchanged", () => {
    const index = readFileSync(resolve(root, "src/index.ts"), "utf8");
    expect(index).not.toMatch(/governance-doctor|GovernanceDoctor|repair-/);

    const commands = readFileSync(resolve(root, "src/commands/index.ts"), "utf8");
    expect(commands.match(/governance-doctor/g)).toEqual(["governance-doctor"]);
    expect(commands).not.toMatch(/repair-/);
    expect(governanceDoctorCommand.name).toBe("governance-doctor");
    expect(governanceDoctorCommand.readOnly).toBe(true);
    expect(governanceDoctorCommand.zeroWrite).toBe(true);
    expect(governanceDoctorCommand.options).toEqual([]);

    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      exports?: unknown;
      main?: string;
    };
    expect(JSON.stringify(packageJson.exports ?? packageJson.main ?? "")).not.toMatch(/repair/i);
  });

  // The foundation is no longer dormant: #775 adds the internal AIH Core local
  // mechanical executor, its independent verifier, and the durable single-use claim
  // the executor takes before any effect. The assertion keeps its original force --
  // an exact, enumerated importer set with no CLI, command, Workbench, or
  // public-export route -- and now names those internal modules too.
  it("keeps its importer set closed to the foundation and its internal executor", () => {
    const importers = sourceFilesUnder(resolve(root, "src"))
      .filter((file) =>
        // Every repair module is named here, the internal executor and verifier
        // included: a consumer that skipped the foundation and imported only the
        // operational modules would otherwise evade this reverse enumeration.
        /repair-(?:broker|capability|claim|claim-store|consent|content|custody|executor|outcome|plan|verifier)-v1\.js/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => file.replace(/\\/g, "/").split("/src/")[1] ?? "")
      .sort();
    expect(importers).toEqual([
      "governance-doctor/repair-broker-v1.ts",
      "governance-doctor/repair-claim-store-v1.ts",
      "governance-doctor/repair-claim-v1.ts",
      "governance-doctor/repair-consent-v1.ts",
      "governance-doctor/repair-content-v1.ts",
      "governance-doctor/repair-custody-v1.ts",
      "governance-doctor/repair-executor-v1.ts",
      "governance-doctor/repair-outcome-v1.ts",
      "governance-doctor/repair-plan-v1.ts",
      "governance-doctor/repair-verifier-v1.ts",
    ]);
  });

  it("adds no source-pack lifecycle evidence, card, lock, approval, or report", () => {
    const packAssets = readdirSync(resolve(root, "packs/governance-quality"), {
      recursive: true,
    }) as string[];
    expect(packAssets.map((entry) => entry.replace(/\\/g, "/")).sort()).toEqual([
      "governance-doctor-audit-guide",
      "governance-doctor-audit-guide/LICENSE",
      "governance-doctor-audit-guide/SKILL.md",
      "governance-doctor-audit-guide/profile.json",
    ]);
  });
});

describe("GovernanceDoctor Repair V1 mechanical effect allowlist", () => {
  it("closes the effect kinds to AIH-owned mechanical recipes only", () => {
    expect([...GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1]).toEqual([
      "create-managed-directory",
      "normalize-managed-line-endings",
      "restore-managed-file-content",
      "rewrite-managed-marker-block",
    ]);
    expect(Object.isFrozen(GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1)).toBe(true);
  });

  it("declares one exact, ordered, value-level argument schema per effect kind", () => {
    expect(
      Object.fromEntries(
        GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1.map((kind) => [
          kind,
          GOVERNANCE_DOCTOR_REPAIR_EFFECT_ARGUMENT_SCHEMAS_V1[kind].map(
            (argument) => `${argument.name}:${argument.type}`,
          ),
        ]),
      ),
    ).toEqual({
      "create-managed-directory": ["path:managed-relative-path"],
      "normalize-managed-line-endings": ["path:managed-relative-path"],
      "restore-managed-file-content": ["contentSha256:sha256", "path:managed-relative-path"],
      "rewrite-managed-marker-block": [
        "blockId:managed-token",
        "contentSha256:sha256",
        "path:managed-relative-path",
      ],
    });
    expect(Object.isFrozen(GOVERNANCE_DOCTOR_REPAIR_EFFECT_ARGUMENT_SCHEMAS_V1)).toBe(true);
    for (const kind of GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1)
      expect(Object.isFrozen(GOVERNANCE_DOCTOR_REPAIR_EFFECT_ARGUMENT_SCHEMAS_V1[kind])).toBe(true);
  });

  it("excludes every prohibited authority class from the mechanical allowlist", () => {
    expect([...GOVERNANCE_DOCTOR_PROHIBITED_REPAIR_AUTHORITIES_V1]).toEqual([
      "approval",
      "approve",
      "argv",
      "command",
      "decision",
      "destructive",
      "exec",
      "install",
      "network",
      "override",
      "package",
      "provider",
      "publish",
      "runtime",
      "scan",
      "select",
      "shell",
      "sign",
    ]);
    expect(Object.isFrozen(GOVERNANCE_DOCTOR_PROHIBITED_REPAIR_AUTHORITIES_V1)).toBe(true);
    for (const prohibited of GOVERNANCE_DOCTOR_PROHIBITED_REPAIR_AUTHORITIES_V1)
      for (const kind of GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1)
        expect(kind, `${kind}/${prohibited}`).not.toContain(prohibited);
  });

  it("refuses a recipe whose identity names a prohibited authority class", () => {
    for (const recipeId of [
      "approval-gate",
      "approve-catalog",
      "run-command",
      "governance-decision",
      "destructive-override",
      "publish-catalog",
      "install-package",
      "provider-callback",
      "scan-workspace",
      "sign-artifact",
      "select-intent",
      "shell-out",
      "network-fetch",
      "runtime-cutover",
      "argv-builder",
      "exec-plan",
    ])
      expect(
        () =>
          createGovernanceDoctorRepairBrokerRegistryV1(
            registryInput({ recipes: [recipeInput({ recipeId })] }),
          ),
        recipeId,
      ).toThrow(TypeError);
  });

  it("refuses a template whose identity names a prohibited authority class", () => {
    for (const templateId of ["approve-write", "exec-restore", "publish-canon"])
      expect(
        () =>
          createGovernanceDoctorRepairBrokerRegistryV1(
            registryInput({
              recipes: [recipeInput({ effects: [{ ...templates()[0], templateId }] })],
            }),
          ),
        templateId,
      ).toThrow(TypeError);
  });
});

describe("createGovernanceDoctorRepairBrokerRegistryV1", () => {
  it("parses only bounded canonical registry bytes under the exact trusted registry", () => {
    const built = createGovernanceDoctorRepairBrokerRegistryV1(registryInput());
    const bytes = canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(built);
    const parsed = parseGovernanceDoctorRepairBrokerRegistryV1Json({ bytes, registry: built });
    expect(parsed.registrySha256).toBe(built.registrySha256);
    expect(parsed).not.toBe(built);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(parsed).equals(bytes)).toBe(true);
    expect(() => parseGovernanceDoctorRepairBrokerRegistryV1Json(bytes)).toThrow(TypeError);
    const text = bytes.toString("utf8");
    for (const hostile of [
      Buffer.alloc(0),
      Buffer.from([0xff]),
      Buffer.from([0xef, 0xbb, 0xbf, ...bytes]),
      Buffer.from(` ${text}`),
      Buffer.from(`${text} `),
      Buffer.from(text.replace(/^\{/, '{"protocol":"GovernanceDoctorRepairBrokerRegistryV1",')),
      Buffer.alloc(GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxTransportBytes + 1, 0x20),
    ])
      expect(() =>
        parseGovernanceDoctorRepairBrokerRegistryV1Json({ bytes: hostile, registry: built }),
      ).toThrow(TypeError);
    for (const nonBuffer of [text, null, {}])
      expect(() =>
        parseGovernanceDoctorRepairBrokerRegistryV1Json({ bytes: nonBuffer, registry: built }),
      ).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorRepairBrokerRegistryV1Json({ bytes, registry: { ...built } }),
    ).toThrow(TypeError);
    let observed = false;
    const hostileRequest = new Proxy(
      { bytes, registry: built },
      {
        get(target, key, receiver) {
          observed = true;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => parseGovernanceDoctorRepairBrokerRegistryV1Json(hostileRequest)).toThrow(
      TypeError,
    );
    expect(observed).toBe(false);
  });
  it("mints a frozen, branded registry whose bytes and identity match an independent vector", () => {
    const registry = createGovernanceDoctorRepairBrokerRegistryV1(registryInput());
    const recipeBody = {
      effectVersion: "1",
      effects: templates(),
      recipeId: "restore-repository-canon",
      schemaVersion: "1",
    };
    const recipeSha256 = domainDigest("aih.governance-doctor-repair-recipe-v1", recipeBody);
    const registryBody = {
      brokerId: "aih:governance-doctor.mechanical",
      owner: "aih",
      protocol: "GovernanceDoctorRepairBrokerRegistryV1",
      recipes: [{ ...recipeBody, recipeSha256 }],
    };
    const registrySha256 = domainDigest(
      "aih.governance-doctor-repair-broker-registry-v1",
      registryBody,
    );

    expect(registry.registrySha256).toBe(registrySha256);
    expect(registry.recipes[0]?.recipeSha256).toBe(recipeSha256);
    expect(canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(registry).toString("utf8")).toBe(
      jcs({ ...registryBody, registrySha256 }),
    );

    // Fixed offline anchors, computed once with the independent serializer above.
    expect(recipeSha256).toBe("ab60bccf00e21bd7052b89d88aa5f7cb085b24193557cb5d166efce35d845599");
    expect(registrySha256).toBe("136c9cbd6b97ee16ec9adcb45c6ed20e1e0cbb0e965c21d658e494f9792ed7d5");
  });

  it("deep freezes the registry and returns defensive canonical bytes", () => {
    const registry = createGovernanceDoctorRepairBrokerRegistryV1(registryInput());
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.recipes)).toBe(true);
    expect(Object.isFrozen(registry.recipes[0])).toBe(true);
    expect(Object.isFrozen(registry.recipes[0]?.effects[0])).toBe(true);
    expect(Object.isFrozen(registry.recipes[0]?.effects[0]?.argumentSchema)).toBe(true);
    expect(Object.isFrozen(registry.recipes[0]?.effects[0]?.argumentSchema[0])).toBe(true);

    const first = canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(registry);
    first.fill(0);
    expect(canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(registry).equals(first)).toBe(
      false,
    );
  });

  it("deep copies its input so post-return mutation cannot reach the registry", () => {
    const input = registryInput();
    const registry = createGovernanceDoctorRepairBrokerRegistryV1(input);
    const before = canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(registry);
    (input.recipes[0] as Record<string, unknown>).recipeId = "mutated";
    expect(canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(registry).equals(before)).toBe(
      true,
    );
  });

  it("orders recipes and templates deterministically regardless of declaration order", () => {
    const second = recipeInput({
      effects: [templates()[1] as Record<string, unknown>],
      recipeId: "align-managed-endings",
    });
    const forward = createGovernanceDoctorRepairBrokerRegistryV1(
      registryInput({ recipes: [recipeInput(), second] }),
    );
    const reversed = createGovernanceDoctorRepairBrokerRegistryV1(
      registryInput({
        recipes: [second, recipeInput({ effects: [...templates()].reverse() })],
      }),
    );
    expect(
      canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(forward).equals(
        canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(reversed),
      ),
    ).toBe(true);
    expect(forward.recipes.map((recipe) => recipe.recipeId)).toEqual([
      "align-managed-endings",
      "restore-repository-canon",
    ]);
  });

  it("refuses a forged registry that was never validated by this module", () => {
    const registry = createGovernanceDoctorRepairBrokerRegistryV1(registryInput());
    const forged = JSON.parse(
      canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(registry).toString("utf8"),
    ) as unknown;
    expect(() => canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(forged)).toThrow(TypeError);
    expect(() => canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes({ ...registry })).toThrow(
      TypeError,
    );
    expect(() => governanceDoctorRepairRecipeV1(forged, "restore-repository-canon")).toThrow(
      TypeError,
    );
  });

  it("resolves only a registered recipe id", () => {
    const registry = createGovernanceDoctorRepairBrokerRegistryV1(registryInput());
    expect(governanceDoctorRepairRecipeV1(registry, "restore-repository-canon").recipeId).toBe(
      "restore-repository-canon",
    );
    for (const unknownId of ["absent", "", "RESTORE-REPOSITORY-CANON", "__proto__", "toString"])
      expect(() => governanceDoctorRepairRecipeV1(registry, unknownId), unknownId).toThrow(
        TypeError,
      );
  });

  it("refuses ownership outside AIH", () => {
    for (const owner of ["catalog-publisher", "operator", "org-policy", "", null, "AIH"])
      expect(
        () => createGovernanceDoctorRepairBrokerRegistryV1(registryInput({ owner })),
        String(owner),
      ).toThrow(TypeError);
    for (const brokerId of [
      "catalog:governance-doctor.mechanical",
      "operator:x",
      "aih",
      "aih:",
      "AIH:x",
      "aih:Governance",
    ])
      expect(
        () => createGovernanceDoctorRepairBrokerRegistryV1(registryInput({ brokerId })),
        brokerId,
      ).toThrow(TypeError);
  });

  it("refuses unknown effect kinds, unknown versions, and mismatched argument schemas", () => {
    for (const effectKind of [
      "delete-repository",
      "run-command",
      "create-managed-directory ",
      "",
      null,
    ])
      expect(
        () =>
          createGovernanceDoctorRepairBrokerRegistryV1(
            registryInput({
              recipes: [recipeInput({ effects: [{ ...templates()[0], effectKind }] })],
            }),
          ),
        String(effectKind),
      ).toThrow(TypeError);

    for (const field of ["effectVersion", "schemaVersion"] as const)
      for (const version of ["2", "1.1", "", "01", null])
        expect(
          () =>
            createGovernanceDoctorRepairBrokerRegistryV1(
              registryInput({ recipes: [recipeInput({ [field]: version })] }),
            ),
          `${field}=${String(version)}`,
        ).toThrow(TypeError);

    for (const argumentSchema of [
      [],
      [{ name: "path", type: "sha256" }],
      [{ name: "target", type: "managed-relative-path" }],
      [{ ...PATH_ARGUMENT }, { ...PATH_ARGUMENT }],
      [{ ...PATH_ARGUMENT }, { ...CONTENT_ARGUMENT }],
      [{ name: "path", type: "managed-relative-path", extra: 1 }],
    ])
      expect(
        () =>
          createGovernanceDoctorRepairBrokerRegistryV1(
            registryInput({
              recipes: [recipeInput({ effects: [{ ...templates()[0], argumentSchema }] })],
            }),
          ),
        JSON.stringify(argumentSchema),
      ).toThrow(TypeError);
  });

  it("refuses duplicate, empty, oversized, and unknown-field collections", () => {
    expect(() =>
      createGovernanceDoctorRepairBrokerRegistryV1(
        registryInput({ recipes: [recipeInput(), recipeInput()] }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairBrokerRegistryV1(
        registryInput({ recipes: [recipeInput({ effects: [templates()[0], templates()[0]] })] }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairBrokerRegistryV1(registryInput({ recipes: [] })),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairBrokerRegistryV1(
        registryInput({
          recipes: Array.from(
            { length: GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxRecipes + 1 },
            (_, index) => recipeInput({ recipeId: `recipe-${String(index).padStart(3, "0")}` }),
          ),
        }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairBrokerRegistryV1(registryInput({ extra: true })),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairBrokerRegistryV1(
        registryInput({ recipes: [{ ...recipeInput(), extra: true }] }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairBrokerRegistryV1(
        registryInput({ recipes: [{ ...recipeInput(), effects: [] }] }),
      ),
    ).toThrow(TypeError);
  });

  it("refuses proxied, accessor-backed, sparse, cyclic, and prototype-polluted input", () => {
    let observed = false;
    const proxied = new Proxy(registryInput(), {
      get(target, key, receiver) {
        observed = true;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createGovernanceDoctorRepairBrokerRegistryV1(proxied)).toThrow(TypeError);
    expect(observed).toBe(false);

    let read = false;
    const accessor = registryInput();
    Object.defineProperty(accessor, "recipes", {
      configurable: true,
      enumerable: true,
      get() {
        read = true;
        return [recipeInput()];
      },
    });
    expect(() => createGovernanceDoctorRepairBrokerRegistryV1(accessor)).toThrow(TypeError);
    expect(read).toBe(false);

    const sparse = registryInput();
    // A hole, not a missing key: the exact hostile array shape under test.
    delete (sparse.recipes as unknown[])[0];
    expect(() => createGovernanceDoctorRepairBrokerRegistryV1(sparse)).toThrow(TypeError);

    const cyclic = registryInput() as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => createGovernanceDoctorRepairBrokerRegistryV1(cyclic)).toThrow(TypeError);

    expect(() =>
      createGovernanceDoctorRepairBrokerRegistryV1(
        Object.assign(Object.create({ inherited: true }), registryInput()),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorRepairBrokerRegistryV1(
        Object.assign(registryInput(), { [Symbol("hidden")]: 1 }),
      ),
    ).toThrow(TypeError);
    for (const notARecord of [null, undefined, 0, "registry", [], true])
      expect(
        () => createGovernanceDoctorRepairBrokerRegistryV1(notARecord),
        String(notARecord),
      ).toThrow(TypeError);
  });
});

describe("assertGovernanceDoctorRepairEffectArgumentsV1", () => {
  it("accepts exactly the declared argument names, types, and order", () => {
    expect(
      assertGovernanceDoctorRepairEffectArgumentsV1(
        "restore-managed-file-content",
        { contentSha256: "a".repeat(64), path: "ai-coding/RULE_ROUTER.md" },
        "effect arguments",
      ),
    ).toEqual({ contentSha256: "a".repeat(64), path: "ai-coding/RULE_ROUTER.md" });
  });

  it("refuses missing, extra, misnamed, and mistyped arguments", () => {
    for (const value of [
      {},
      { path: "ai-coding/RULE_ROUTER.md" },
      { contentSha256: "a".repeat(64) },
      { contentSha256: "a".repeat(64), extra: 1, path: "ai-coding/RULE_ROUTER.md" },
      { contentSha256: "a".repeat(64), target: "ai-coding/RULE_ROUTER.md" },
      { contentSha256: "A".repeat(64), path: "ai-coding/RULE_ROUTER.md" },
      { contentSha256: "a".repeat(63), path: "ai-coding/RULE_ROUTER.md" },
      { contentSha256: 1, path: "ai-coding/RULE_ROUTER.md" },
      { contentSha256: "a".repeat(64), path: 1 },
    ])
      expect(
        () =>
          assertGovernanceDoctorRepairEffectArgumentsV1(
            "restore-managed-file-content",
            value,
            "effect arguments",
          ),
        JSON.stringify(value),
      ).toThrow(TypeError);
  });

  it("refuses unsafe, absolute, traversing, encoded, and non-NFC managed paths", () => {
    for (const path of [
      "/etc/passwd",
      "C:/Windows",
      "c:\\Windows",
      "../escape",
      "ai-coding/../..",
      "ai-coding/./router.md",
      "ai-coding//router.md",
      "ai-coding/router.md/",
      "ai-coding\\router.md",
      "ai-coding/%2e%2e/router.md",
      "ai-coding/router?.md",
      "ai-coding/router#.md",
      "ai-coding/router:.md",
      `ai-coding/${cp(0x0000)}router.md`,
      `ai-coding/${cp(0x000a)}router.md`,
      `ai-coding/router${cp(0x0301)}.md`,
      `ai-coding/${cp(0xfeff)}router.md`,
      "",
      "a".repeat(GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxManagedPathCodeUnits + 1),
    ])
      expect(
        () =>
          assertGovernanceDoctorRepairEffectArgumentsV1(
            "create-managed-directory",
            { path },
            "effect arguments",
          ),
        JSON.stringify(path),
      ).toThrow(TypeError);
  });

  it("refuses an unknown effect kind and hostile argument containers", () => {
    expect(() =>
      assertGovernanceDoctorRepairEffectArgumentsV1(
        "delete-everything",
        { path: "ai-coding" },
        "effect arguments",
      ),
    ).toThrow(TypeError);
    let observed = false;
    const proxied = new Proxy(
      { path: "ai-coding" },
      {
        get(target, key, receiver) {
          observed = true;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() =>
      assertGovernanceDoctorRepairEffectArgumentsV1(
        "create-managed-directory",
        proxied,
        "effect arguments",
      ),
    ).toThrow(TypeError);
    expect(observed).toBe(false);
  });

  it("bounds managed marker block tokens", () => {
    expect(
      assertGovernanceDoctorRepairEffectArgumentsV1(
        "rewrite-managed-marker-block",
        { blockId: "ai-canonical-shared", contentSha256: "b".repeat(64), path: "AGENTS.md" },
        "effect arguments",
      ).blockId,
    ).toBe("ai-canonical-shared");
    for (const blockId of [
      "",
      "-leading",
      "Upper",
      "with space",
      "a".repeat(GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxManagedTokenCodeUnits + 1),
      cp(0x200b),
    ])
      expect(
        () =>
          assertGovernanceDoctorRepairEffectArgumentsV1(
            "rewrite-managed-marker-block",
            { blockId, contentSha256: "b".repeat(64), path: "AGENTS.md" },
            "effect arguments",
          ),
        JSON.stringify(blockId),
      ).toThrow(TypeError);
  });
});
