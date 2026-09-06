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
  return { id: registration.id, version: registration.version };
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
