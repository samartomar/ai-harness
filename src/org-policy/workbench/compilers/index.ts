import type { CatalogCompilerAssemblyInputV1 } from "../compiler-input.js";
import { registeredCatalogProvidersV1 } from "../providers/registry.js";
import {
  compilerFormatRegistrationsV1,
  type RegisteredCompilerFormatRegistrationV1,
  type RegisteredCompilerInputFormatV1,
} from "./registry.js";
export type RegisteredCatalogCompilerV1 = RegisteredCompilerFormatRegistrationV1 & {
  compileFixture(): readonly CatalogCompilerAssemblyInputV1[];
};
function fixturesForFormat(
  format: RegisteredCompilerInputFormatV1,
): readonly CatalogCompilerAssemblyInputV1[] {
  const inputs = registeredCatalogProvidersV1
    .flatMap((provider) => provider.compileFixture().inputs)
    .filter((input) =>
      Object.values(input.sources).every((source) => source.inputFormat === format),
    );
  if (!inputs.length)
    throw new Error(`registered compiler format has no provider fixture: ${format}`);
  return inputs;
}
const compilerFixtureFactoriesV1: {
  readonly [format in RegisteredCompilerInputFormatV1]: () => readonly CatalogCompilerAssemblyInputV1[];
} = {
  "pinned-baseline/v1": () => fixturesForFormat("pinned-baseline/v1"),
  "built-in/v1": () => fixturesForFormat("built-in/v1"),
  "pinned-skill-collection/v1": () => fixturesForFormat("pinned-skill-collection/v1"),
  "pinned-component-collection/v1": () => fixturesForFormat("pinned-component-collection/v1"),
  "organization-authoring-manifest/v1": () =>
    fixturesForFormat("organization-authoring-manifest/v1"),
};
export const registeredCatalogCompilersV1: readonly RegisteredCatalogCompilerV1[] = Object.freeze(
  compilerFormatRegistrationsV1.map((registration) => ({
    ...registration,
    compileFixture: compilerFixtureFactoriesV1[registration.inputFormat],
  })),
);
