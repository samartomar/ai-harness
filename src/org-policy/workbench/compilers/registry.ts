import type { CoreAuthoringCapabilityRegistryEntryV1 } from "../contracts.js";
import { actionForCompilerDeclarationV1, type CompiledDeclarationV1 } from "./formats.js";

export type {
  CompiledDeclarationV1,
  CompilerAuthoringActionV1,
  CompilerFormatRegistrationV1,
  RegisteredCompilerFormatRegistrationV1,
  RegisteredCompilerInputFormatV1,
} from "./formats.js";
export {
  actionForCompilerDeclarationV1,
  compilerFormatRegistrationsV1,
  compilerRegistrationForInputFormatV1,
  registeredCompilerInputFormatsV1,
} from "./formats.js";

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
