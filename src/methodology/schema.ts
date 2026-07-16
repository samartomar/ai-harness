import { createHash } from "node:crypto";
import { z } from "zod";

const ComponentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const CheckoutPathSchema = z
  .string()
  .regex(/^(?!\/)(?!.*\\\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._/-]+$/);

export const MethodologyProviderSchema = z.enum(["ecc", "gstack"]);
export const MethodologyHostSchema = z.enum(["claude-code", "codex", "cursor", "kiro", "opencode"]);
export const MethodologyOsSchema = z.enum(["win32", "darwin", "linux"]);
export const MethodologyArchitectureSchema = z.enum(["x64", "arm64"]);
export const MethodologyRuntimeSchema = z.enum(["node-26", "bun-1", "none"]);
export const MethodologyPolicyContextSchema = z.enum(["unmanaged", "managed", "disposable"]);

const ProviderAdapterIdSchema = z.enum(["ecc-static-v1", "gstack-static-v1"]);
const HostAdapterIdSchema = z.enum([
  "claude-code-static-v1",
  "codex-static-v1",
  "cursor-static-v1",
  "kiro-static-v1",
  "opencode-static-v1",
]);

export const MethodologySourceSchema = z
  .object({
    host: z.literal("github.com"),
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    checkout: CheckoutPathSchema,
  })
  .strict();

export const MethodologyCompatibilitySchema = z
  .object({
    host: MethodologyHostSchema,
    hostVersion: z.string().regex(/^\d+(?:\.\d+){1,3}$/),
    executableSha256: z.string().regex(/^[0-9a-f]{64}$/),
    os: MethodologyOsSchema,
    architecture: MethodologyArchitectureSchema,
    runtime: MethodologyRuntimeSchema,
    policyContext: MethodologyPolicyContextSchema,
  })
  .strict();

const MethodologySelectionSchema = z
  .object({
    provider: MethodologyProviderSchema,
    source: MethodologySourceSchema,
    components: z.array(z.object({ id: ComponentIdSchema }).strict()).min(1),
    providerAdapter: ProviderAdapterIdSchema,
    hostAdapter: HostAdapterIdSchema,
    compatibility: MethodologyCompatibilitySchema,
  })
  .strict()
  .superRefine((selection, ctx) => {
    const expectedSource =
      selection.provider === "ecc"
        ? { owner: "affaan-m", repo: "ECC", adapter: "ecc-static-v1" }
        : { owner: "garrytan", repo: "gstack", adapter: "gstack-static-v1" };
    if (
      selection.source.owner !== expectedSource.owner ||
      selection.source.repo !== expectedSource.repo
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "provider must name its exact declared GitHub source",
      });
    }
    if (selection.providerAdapter !== expectedSource.adapter) {
      ctx.addIssue({
        code: "custom",
        path: ["providerAdapter"],
        message: "provider adapter must match the selected provider",
      });
    }
    if (selection.hostAdapter !== `${selection.compatibility.host}-static-v1`) {
      ctx.addIssue({
        code: "custom",
        path: ["hostAdapter"],
        message: "host adapter must match the compatibility host",
      });
    }
    const ids = new Set<string>();
    for (const [index, component] of selection.components.entries()) {
      if (ids.has(component.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "id"],
          message: "component ids must be unique",
        });
      }
      ids.add(component.id);
    }
  });

export const MethodologyIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    selection: MethodologySelectionSchema,
  })
  .strict();

export interface ProviderAdapter {
  readonly schemaVersion: 1;
  readonly id: z.infer<typeof ProviderAdapterIdSchema>;
  readonly provider: z.infer<typeof MethodologyProviderSchema>;
  readonly sourceLayout: "unproven";
  readonly componentSemantics: "unproven";
  readonly execution: "forbidden";
}

export interface HostAdapter {
  readonly schemaVersion: 1;
  readonly id: z.infer<typeof HostAdapterIdSchema>;
  readonly host: z.infer<typeof MethodologyHostSchema>;
  readonly discovery: "unproven";
  readonly isolation: "unproven";
  readonly execution: "forbidden";
}

export const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = Object.freeze([
  {
    schemaVersion: 1,
    id: "ecc-static-v1",
    provider: "ecc",
    sourceLayout: "unproven",
    componentSemantics: "unproven",
    execution: "forbidden",
  },
  {
    schemaVersion: 1,
    id: "gstack-static-v1",
    provider: "gstack",
    sourceLayout: "unproven",
    componentSemantics: "unproven",
    execution: "forbidden",
  },
]);

export const HOST_ADAPTERS: readonly HostAdapter[] = Object.freeze(
  ["claude-code", "codex", "cursor", "kiro", "opencode"].map((host) => ({
    schemaVersion: 1 as const,
    id: `${host}-static-v1` as z.infer<typeof HostAdapterIdSchema>,
    host: host as z.infer<typeof MethodologyHostSchema>,
    discovery: "unproven" as const,
    isolation: "unproven" as const,
    execution: "forbidden" as const,
  })),
);

export const MethodologyFindingCodeSchema = z.enum([
  "METHODOLOGY_HOST_ADVISORY",
  "METHODOLOGY_INTENT_MALFORMED",
  "METHODOLOGY_INTENT_PATH_INVALID",
  "METHODOLOGY_INTENT_UNREADABLE",
  "METHODOLOGY_PHASE_ONE_NO_PROJECTION",
]);

export const MethodologyFindingSchema = z
  .object({
    code: MethodologyFindingCodeSchema,
    disposition: z.enum(["advisory", "blocked", "fail-closed"]),
    detail: z.string(),
  })
  .strict();

export const MethodologyIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: MethodologyProviderSchema,
    repository: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    components: z.array(ComponentIdSchema),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const MethodologyClaimsSchema = z
  .object({
    installed: z.literal(false),
    active: z.literal(false),
    isolated: z.literal(false),
    switchable: z.literal(false),
    concurrent: z.literal(false),
    conflictFree: z.literal(false),
  })
  .strict();

export const MethodologyStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["selected", "advisory", "blocked", "fail-closed"]),
    identity: MethodologyIdentitySchema,
    compatibility: MethodologyCompatibilitySchema,
    adapters: z
      .object({
        provider: z
          .object({
            schemaVersion: z.literal(1),
            id: ProviderAdapterIdSchema,
            provider: MethodologyProviderSchema,
            sourceLayout: z.literal("unproven"),
            componentSemantics: z.literal("unproven"),
            execution: z.literal("forbidden"),
          })
          .strict(),
        host: z
          .object({
            schemaVersion: z.literal(1),
            id: HostAdapterIdSchema,
            host: MethodologyHostSchema,
            discovery: z.literal("unproven"),
            isolation: z.literal("unproven"),
            execution: z.literal("forbidden"),
          })
          .strict(),
      })
      .strict(),
    claims: MethodologyClaimsSchema,
    findings: z.array(MethodologyFindingSchema),
  })
  .strict();

export type MethodologyIntent = z.infer<typeof MethodologyIntentSchema>;
export type MethodologyFinding = z.infer<typeof MethodologyFindingSchema>;
export type MethodologyIdentity = z.infer<typeof MethodologyIdentitySchema>;
export type MethodologyStatus = z.infer<typeof MethodologyStatusSchema>;

/** Sort every list that participates in the Phase 1 identity before serialization. */
export function canonicalizeMethodologyIntent(intent: MethodologyIntent): MethodologyIntent {
  return {
    schemaVersion: 1,
    selection: {
      ...intent.selection,
      components: [...intent.selection.components].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    },
  };
}

/** Exact-source identity is declared only; Phase 1 never reads or runs the checkout. */
export function exactSourceIdentity(intent: MethodologyIntent): MethodologyIdentity {
  const canonical = canonicalizeMethodologyIntent(intent);
  const { provider, source, components } = canonical.selection;
  const identity = {
    schemaVersion: 1 as const,
    provider,
    repository: `${source.host}/${source.owner}/${source.repo}`,
    commit: source.commit,
    components: components.map((component) => component.id),
  };
  return {
    ...identity,
    sha256: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  };
}

export function providerAdapterFor(intent: MethodologyIntent): ProviderAdapter {
  const adapter = PROVIDER_ADAPTERS.find(
    (candidate) => candidate.id === intent.selection.providerAdapter,
  );
  if (adapter === undefined || adapter.provider !== intent.selection.provider) {
    throw new Error("validated intent named an unavailable provider adapter");
  }
  return adapter;
}

export function hostAdapterFor(intent: MethodologyIntent): HostAdapter {
  const adapter = HOST_ADAPTERS.find((candidate) => candidate.id === intent.selection.hostAdapter);
  if (adapter === undefined || adapter.host !== intent.selection.compatibility.host) {
    throw new Error("validated intent named an unavailable host adapter");
  }
  return adapter;
}
