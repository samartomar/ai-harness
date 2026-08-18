import { canonicalStrictJsonBytesV1, deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
import {
  assertArrayV1,
  assertEnumV1,
  assertExactKeysV1,
  assertRecordV1,
  assertSha256V1,
  assertTokenV1,
  assertUniqueV1,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  governanceDoctorSha256V1,
  sortByCodeUnitsV1,
} from "./capability-v1.js";
import {
  assertManagedRelativePathV1,
  assertManagedTokenV1,
  assertNoProhibitedRepairAuthorityV1,
  boundedRepairTransportV1,
  brandedRepairValueV1,
  failGovernanceDoctorRepairV1,
  GOVERNANCE_DOCTOR_AIH_BROKER_ID_PATTERN,
  GOVERNANCE_DOCTOR_REPAIR_ARGUMENT_NAME_PATTERN,
  GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1,
  GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS,
} from "./repair-capability-v1.js";

/**
 * The Governance Doctor mechanical Repair broker registry.
 *
 * A broker entry is data: an AIH-owned recipe naming an ordered list of
 * mechanical effect templates, each pinned to one closed effect kind and to that
 * kind's exact, code-owned, value-level argument schema. No field is able to hold
 * an invocation, a location resolved at run time, a callback, an interpreter, or
 * a credential, so a mutation-class authority has no representation to occupy.
 *
 * The four effect kinds are deliberately narrow. Each one names a location
 * relative to the run's own root and, where content is involved, names that
 * content only by digest -- the registry and the Plan never carry file bytes, so
 * nothing downstream can be tricked into treating recorded data as trusted text.
 *
 * A registry entry cannot widen the boundary. Its declared argument schema must
 * match this module's frozen schema for the kind exactly, its versions must be
 * the supported ones rather than opaque tokens, and its identities are refused
 * outright when they name an excluded authority class.
 */
export type GovernanceDoctorRepairEffectKindV1 =
  | "create-managed-directory"
  | "normalize-managed-line-endings"
  | "restore-managed-file-content"
  | "rewrite-managed-marker-block";

export type GovernanceDoctorRepairArgumentTypeV1 =
  | "managed-relative-path"
  | "managed-token"
  | "sha256";

export interface GovernanceDoctorRepairArgumentSchemaV1 {
  readonly name: string;
  readonly type: GovernanceDoctorRepairArgumentTypeV1;
}

export interface GovernanceDoctorRepairEffectTemplateV1 {
  readonly argumentSchema: readonly GovernanceDoctorRepairArgumentSchemaV1[];
  readonly effectKind: GovernanceDoctorRepairEffectKindV1;
  readonly templateId: string;
}

export interface GovernanceDoctorRepairRecipeV1 {
  readonly effectVersion: "1";
  readonly effects: readonly GovernanceDoctorRepairEffectTemplateV1[];
  readonly recipeId: string;
  readonly recipeSha256: string;
  readonly schemaVersion: "1";
}

export interface GovernanceDoctorRepairBrokerRegistryV1 {
  readonly brokerId: string;
  readonly owner: "aih";
  readonly protocol: "GovernanceDoctorRepairBrokerRegistryV1";
  readonly recipes: readonly GovernanceDoctorRepairRecipeV1[];
  readonly registrySha256: string;
}

/** The closed mechanical allowlist. Widening it is a reviewed edit to this list. */
export const GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1: readonly GovernanceDoctorRepairEffectKindV1[] =
  Object.freeze([
    "create-managed-directory",
    "normalize-managed-line-endings",
    "restore-managed-file-content",
    "rewrite-managed-marker-block",
  ] as const);

export const GOVERNANCE_DOCTOR_REPAIR_ARGUMENT_TYPES_V1: readonly GovernanceDoctorRepairArgumentTypeV1[] =
  Object.freeze(["managed-relative-path", "managed-token", "sha256"] as const);

const MANAGED_PATH = Object.freeze({ name: "path", type: "managed-relative-path" } as const);
const CONTENT_DIGEST = Object.freeze({ name: "contentSha256", type: "sha256" } as const);
const BLOCK_TOKEN = Object.freeze({ name: "blockId", type: "managed-token" } as const);

/**
 * One exact, ordered, value-level argument schema per effect kind. Argument order
 * is canonical (by name), so a template's declaration and a plan's values have
 * exactly one accepted shape.
 */
export const GOVERNANCE_DOCTOR_REPAIR_EFFECT_ARGUMENT_SCHEMAS_V1: Readonly<
  Record<GovernanceDoctorRepairEffectKindV1, readonly GovernanceDoctorRepairArgumentSchemaV1[]>
> = Object.freeze({
  "create-managed-directory": Object.freeze([MANAGED_PATH]),
  "normalize-managed-line-endings": Object.freeze([MANAGED_PATH]),
  "restore-managed-file-content": Object.freeze([CONTENT_DIGEST, MANAGED_PATH]),
  "rewrite-managed-marker-block": Object.freeze([BLOCK_TOKEN, CONTENT_DIGEST, MANAGED_PATH]),
});

const SUPPORTED_SCHEMA_VERSION = "1";
const SUPPORTED_EFFECT_VERSION = "1";
const PROTOCOL = "GovernanceDoctorRepairBrokerRegistryV1";

// Load-time guard: the allowlist itself must satisfy the exclusion it enforces.
for (const kind of GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1)
  assertNoProhibitedRepairAuthorityV1(kind, "repair effect kind");

type Json = Record<string, unknown>;

/** Anti-forgery brand: a structurally identical plain object is not a registry. */
const registryBytes = new WeakMap<object, Buffer>();
const registryRecipes = new WeakMap<object, ReadonlyMap<string, GovernanceDoctorRepairRecipeV1>>();

function argumentValue(
  value: unknown,
  type: GovernanceDoctorRepairArgumentTypeV1,
  label: string,
): string {
  if (type === "managed-relative-path") return assertManagedRelativePathV1(value, label);
  if (type === "managed-token") return assertManagedTokenV1(value, label);
  return assertSha256V1(value, label);
}

/**
 * Validates one effect's argument values against its kind's frozen schema. The
 * key set must match exactly, and every value is re-derived rather than copied,
 * so a caller cannot smuggle an extra, misnamed, or mistyped argument through.
 */
export function assertGovernanceDoctorRepairEffectArgumentsV1(
  kind: unknown,
  value: unknown,
  label: string,
): Record<string, string> {
  const effectKind = assertEnumV1(
    kind,
    GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1,
    `${label} effect kind`,
  );
  const record = assertRecordV1(value, label);
  const schema = GOVERNANCE_DOCTOR_REPAIR_EFFECT_ARGUMENT_SCHEMAS_V1[effectKind];
  assertExactKeysV1(
    record,
    schema.map((argument) => argument.name),
    label,
  );
  const built: Record<string, string> = {};
  for (const argument of schema)
    built[argument.name] = argumentValue(
      record[argument.name],
      argument.type,
      `${label} ${argument.name}`,
    );
  return built;
}

function declaredArgumentSchema(
  value: unknown,
  effectKind: GovernanceDoctorRepairEffectKindV1,
): readonly GovernanceDoctorRepairArgumentSchemaV1[] {
  const expected = GOVERNANCE_DOCTOR_REPAIR_EFFECT_ARGUMENT_SCHEMAS_V1[effectKind];
  const declared = assertArrayV1(
    value,
    1,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEffectArguments,
    "repair effect argument schema",
  ).map((item) => {
    const argument = assertRecordV1(item, "repair effect argument");
    assertExactKeysV1(argument, ["name", "type"], "repair effect argument");
    return {
      name: assertTokenV1(
        argument.name,
        GOVERNANCE_DOCTOR_REPAIR_ARGUMENT_NAME_PATTERN,
        GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxManagedTokenCodeUnits,
        "repair effect argument name",
      ),
      type: assertEnumV1(
        argument.type,
        GOVERNANCE_DOCTOR_REPAIR_ARGUMENT_TYPES_V1,
        "repair effect argument type",
      ),
    };
  });
  if (
    declared.length !== expected.length ||
    declared.some(
      (argument, index) =>
        argument.name !== expected[index]?.name || argument.type !== expected[index]?.type,
    )
  )
    failGovernanceDoctorRepairV1(
      "repair effect template must declare its exact code-owned argument schema",
    );
  return expected.map((argument) => ({ name: argument.name, type: argument.type }));
}

function effectTemplate(value: unknown): GovernanceDoctorRepairEffectTemplateV1 {
  const record = assertRecordV1(value, "repair effect template");
  assertExactKeysV1(
    record,
    ["argumentSchema", "effectKind", "templateId"],
    "repair effect template",
  );
  const effectKind = assertEnumV1(
    record.effectKind,
    GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1,
    "repair effect kind",
  );
  const templateId = assertNoProhibitedRepairAuthorityV1(
    assertManagedTokenV1(record.templateId, "repair effect template ID"),
    "repair effect template ID",
  );
  return {
    argumentSchema: declaredArgumentSchema(record.argumentSchema, effectKind),
    effectKind,
    templateId,
  };
}

function recipe(value: unknown): GovernanceDoctorRepairRecipeV1 {
  const record = assertRecordV1(value, "repair recipe");
  assertExactKeysV1(
    record,
    ["effectVersion", "effects", "recipeId", "schemaVersion"],
    "repair recipe",
  );
  if (
    record.schemaVersion !== SUPPORTED_SCHEMA_VERSION ||
    record.effectVersion !== SUPPORTED_EFFECT_VERSION
  )
    failGovernanceDoctorRepairV1("repair recipe declares an unsupported schema or effect version");
  const recipeId = assertNoProhibitedRepairAuthorityV1(
    assertManagedTokenV1(record.recipeId, "repair recipe ID"),
    "repair recipe ID",
  );
  const templates = assertArrayV1(
    record.effects,
    1,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxRecipeEffects,
    "repair recipe effects",
  ).map(effectTemplate);
  assertUniqueV1(
    templates.map((template) => template.templateId),
    "repair recipe effects",
  );
  const body = {
    effectVersion: SUPPORTED_EFFECT_VERSION,
    effects: sortByCodeUnitsV1(templates, (template) => template.templateId),
    recipeId,
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
  } as const;
  return {
    ...body,
    recipeSha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.recipe, body),
  };
}

/**
 * Validates untrusted broker data and mints a branded, frozen, identified
 * registry. Every value is rebuilt into a fresh object, so a caller that mutates
 * its input afterwards cannot reach into the minted registry.
 */
export function createGovernanceDoctorRepairBrokerRegistryV1(
  input: unknown,
): GovernanceDoctorRepairBrokerRegistryV1 {
  const record = assertRecordV1(input, "repair broker registry");
  assertExactKeysV1(record, ["brokerId", "owner", "recipes"], "repair broker registry");
  const brokerId = assertNoProhibitedRepairAuthorityV1(
    assertTokenV1(
      record.brokerId,
      GOVERNANCE_DOCTOR_AIH_BROKER_ID_PATTERN,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
      "repair broker ID",
    ),
    "repair broker ID",
  );
  const owner = assertEnumV1(record.owner, ["aih"] as const, "repair broker owner");
  const recipes = assertArrayV1(
    record.recipes,
    1,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxRecipes,
    "repair recipes",
  ).map(recipe);
  assertUniqueV1(
    recipes.map((entry) => entry.recipeId),
    "repair recipes",
  );
  const body: Json = {
    brokerId,
    owner,
    protocol: PROTOCOL,
    recipes: sortByCodeUnitsV1(recipes, (entry) => entry.recipeId),
  };
  const registry = deepFreezeStrictJsonV1({
    ...body,
    registrySha256: governanceDoctorSha256V1(
      GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.brokerRegistry,
      body,
    ),
  }) as GovernanceDoctorRepairBrokerRegistryV1;
  registryBytes.set(registry, canonicalStrictJsonBytesV1(registry));
  registryRecipes.set(registry, new Map(registry.recipes.map((entry) => [entry.recipeId, entry])));
  return registry;
}

/** Resolves one registered recipe from a branded registry, or fails closed. */
export function governanceDoctorRepairRecipeV1(
  registry: unknown,
  recipeId: unknown,
): GovernanceDoctorRepairRecipeV1 {
  const recipes = brandedRepairValueV1(registryRecipes, registry, "repair broker registry");
  const entry = typeof recipeId === "string" ? recipes.get(recipeId) : undefined;
  if (entry === undefined) failGovernanceDoctorRepairV1("repair recipe is not registered");
  return entry;
}

/** The exact canonical JCS UTF-8 bytes of a minted registry, as a defensive copy. */
export function canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(value: unknown): Buffer {
  return Buffer.from(brandedRepairValueV1(registryBytes, value, "repair broker registry"));
}

/**
 * Validates canonical registry transport against a pre-existing trusted registry.
 * Broker bytes alone never mint authority for a plan.
 */
export function parseGovernanceDoctorRepairBrokerRegistryV1Json(
  input: unknown,
): GovernanceDoctorRepairBrokerRegistryV1 {
  const request = assertRecordV1(input, "repair broker registry transport request");
  assertExactKeysV1(request, ["bytes", "registry"], "repair broker registry transport request");
  const trustedBytes = canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(request.registry);
  const [bytes, record] = boundedRepairTransportV1(request.bytes, "repair broker registry");
  assertExactKeysV1(
    record,
    ["brokerId", "owner", "protocol", "recipes", "registrySha256"],
    "repair broker registry transport",
  );
  if (record.protocol !== PROTOCOL || !trustedBytes.equals(bytes))
    failGovernanceDoctorRepairV1(
      "repair broker registry transport does not match trusted registry",
    );
  const parsed = createGovernanceDoctorRepairBrokerRegistryV1({
    brokerId: record.brokerId,
    owner: record.owner,
    recipes: assertArrayV1(
      record.recipes,
      1,
      GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxRecipes,
      "repair broker registry transport recipes",
    ).map((item) => {
      const recipeRecord = assertRecordV1(item, "repair broker registry transport recipe");
      assertExactKeysV1(
        recipeRecord,
        ["effectVersion", "effects", "recipeId", "recipeSha256", "schemaVersion"],
        "repair broker registry transport recipe",
      );
      return {
        effectVersion: recipeRecord.effectVersion,
        effects: recipeRecord.effects,
        recipeId: recipeRecord.recipeId,
        schemaVersion: recipeRecord.schemaVersion,
      };
    }),
  });
  if (!canonicalGovernanceDoctorRepairBrokerRegistryV1Bytes(parsed).equals(bytes))
    failGovernanceDoctorRepairV1("repair broker registry transport identity is invalid");
  return parsed;
}
