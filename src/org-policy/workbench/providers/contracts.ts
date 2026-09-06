import { canonicalStrictJsonSha256V1 } from "../../../contract/strict-json-v1.js";
import type { CatalogCompilerAssemblyInputV1 } from "../compiler-input.js";
import { rejectTrustedCompilerEvidence } from "../compiler-input.js";

export interface CatalogProviderCompilationV1 {
  providerId: string;
  providerVersion: string;
  inputDigest: string;
  inputs: readonly CatalogCompilerAssemblyInputV1[];
}
export interface CatalogProviderV1<Input> {
  readonly providerId: string;
  readonly providerVersion: string;
  compile(input: Input): readonly CatalogCompilerAssemblyInputV1[];
  compileFixture(): CatalogProviderCompilationV1;
}
/** Provider identity describes build ownership, never compiler or Core authority. */
export function compileCatalogProviderV1<Input>(
  provider: CatalogProviderV1<Input>,
  input: Input,
): CatalogProviderCompilationV1 {
  const inputs = provider.compile(input);
  if (!Array.isArray(inputs) || inputs.length === 0)
    throw new TypeError("catalog provider produced no assembly input");
  for (const output of inputs) {
    const allowed = new Set([
      "sources",
      "declarations",
      "relations",
      "groups",
      "templates",
      "evidence",
      "detailBytes",
    ]);
    if (Object.keys(output).some((key) => !allowed.has(key)))
      throw new TypeError("catalog provider supplied unsupported assembly fields");
  }
  rejectTrustedCompilerEvidence(inputs);
  return {
    providerId: provider.providerId,
    providerVersion: provider.providerVersion,
    inputDigest: `sha256:${canonicalStrictJsonSha256V1(input)}`,
    inputs,
  };
}
export function defineCatalogProviderV1<Input>(definition: {
  providerId: string;
  providerVersion: string;
  compile(input: Input): readonly CatalogCompilerAssemblyInputV1[];
  fixture(): Input;
}): CatalogProviderV1<Input> {
  if (
    !/^[a-z][a-z0-9-]*$/.test(definition.providerId) ||
    !/^[0-9]+$/.test(definition.providerVersion)
  )
    throw new TypeError("invalid catalog provider identity");
  const provider: CatalogProviderV1<Input> = {
    providerId: definition.providerId,
    providerVersion: definition.providerVersion,
    compile: definition.compile,
    compileFixture: () => compileCatalogProviderV1(provider, definition.fixture()),
  };
  return Object.freeze(provider);
}
