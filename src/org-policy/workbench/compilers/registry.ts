import type {
  CompilerAssetDeclarationV1,
  CoreAuthoringCapabilityRegistryEntryV1,
} from "../contracts.js";

export type CompilerAuthoringActionV1 = CoreAuthoringCapabilityRegistryEntryV1["action"];

export interface CompilerFormatRegistrationV1 {
  readonly id: string;
  readonly version: string;
  readonly inputFormat: string;
  /** Reviewed format/kind policy; compiler input cannot nominate a projector. */
  readonly actions: Readonly<Record<string, CompilerAuthoringActionV1>>;
}

/**
 * The sole reviewed enrollment record for a build-time input format. Adding a
 * format here requires a fixture factory in index.ts through its derived type.
 */
export const compilerFormatRegistrationsV1 = [
  {
    id: "pinned-baseline",
    version: "1",
    inputFormat: "pinned-baseline/v1",
    actions: { "*": "record-selection" },
  },
  {
    id: "built-in",
    version: "1",
    inputFormat: "built-in/v1",
    actions: {
      mcp: "record-request",
      hook: "record-request",
      skill: "record-selection",
      agent: "record-selection",
    },
  },
  {
    id: "organization-manifest",
    version: "1",
    inputFormat: "organization-authoring-manifest/v1",
    actions: {
      mcp: "record-request",
      skill: "record-selection",
      agent: "record-selection",
    },
  },
] as const satisfies readonly CompilerFormatRegistrationV1[];

export type RegisteredCompilerInputFormatV1 =
  (typeof compilerFormatRegistrationsV1)[number]["inputFormat"];
export type RegisteredCompilerFormatRegistrationV1 = (typeof compilerFormatRegistrationsV1)[number];

export interface CompiledDeclarationV1 {
  declaration: CompilerAssetDeclarationV1;
  /** A registered format identity, never an action chosen by compiler input. */
  inputFormat: string;
}

export const registeredCompilerInputFormatsV1 = Object.freeze(
  compilerFormatRegistrationsV1.map((registration) => registration.inputFormat).sort(),
);

export function compilerRegistrationForInputFormatV1(
  inputFormat: string,
): Readonly<{ id: string; version: string }> {
  const registration = compilerFormatRegistrationsV1.find(
    (candidate) => candidate.inputFormat === inputFormat,
  );
  if (registration === undefined)
    throw new TypeError(`unregistered compiler input format ${inputFormat}`);
  return registration;
}

export function actionForCompilerDeclarationV1(
  inputFormat: string,
  kind: string,
): CompilerAuthoringActionV1 {
  const registration = compilerFormatRegistrationsV1.find(
    (candidate) => candidate.inputFormat === inputFormat,
  );
  const actions = registration?.actions as
    | Readonly<Record<string, CompilerAuthoringActionV1>>
    | undefined;
  const action = actions?.[kind] ?? actions?.["*"];
  if (action === undefined) {
    throw new TypeError(`unsupported compiler declaration kind ${kind} for ${inputFormat}`);
  }
  return action;
}

function identityKey(
  entry: Pick<
    CoreAuthoringCapabilityRegistryEntryV1,
    "assetId" | "sourceId" | "sourceRevisionId" | "contentDigest"
  >,
): string {
  return `${entry.assetId}\u0000${entry.sourceId}\u0000${entry.sourceRevisionId}\u0000${entry.contentDigest}`;
}

/** Core capability matches may elevate only exact first-party controls. */
export function assemblyRegistryForCompiledDeclarationsV1(
  declarations: readonly CompiledDeclarationV1[],
  coreCapabilities: readonly CoreAuthoringCapabilityRegistryEntryV1[],
): CoreAuthoringCapabilityRegistryEntryV1[] {
  const exactCapabilities = new Map<string, CoreAuthoringCapabilityRegistryEntryV1>();
  for (const capability of coreCapabilities) {
    const key = identityKey(capability);
    if (exactCapabilities.has(key)) throw new Error("ambiguous Core authoring capability");
    exactCapabilities.set(key, capability);
  }
  const seenDeclarations = new Set<string>();
  return declarations.map(({ declaration, inputFormat }) => {
    const key = identityKey({ ...declaration, assetId: declaration.id });
    if (seenDeclarations.has(key)) throw new Error("duplicate compiled authoring declaration");
    seenDeclarations.add(key);
    const core = exactCapabilities.get(key);
    if (core !== undefined) return core;
    return {
      assetId: declaration.id,
      sourceId: declaration.sourceId,
      sourceRevisionId: declaration.sourceRevisionId,
      contentDigest: declaration.contentDigest,
      action: actionForCompilerDeclarationV1(inputFormat, declaration.kind),
      supportedTargets: [],
    };
  });
}
