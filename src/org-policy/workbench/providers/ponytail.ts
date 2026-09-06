import {
  assertStrictJsonValueV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
} from "../../../contract/strict-json-v1.js";
import type { CatalogCompilerAssemblyInputV1 } from "../compiler-input.js";
import { compilerRegistrationForInputFormatV1 } from "../compilers/formats.js";
import {
  compilePinnedComponentCollectionV1,
  type PinnedComponentCollectionInputV1,
} from "../compilers/pinned-component-collection.js";
import {
  type CatalogProviderCompilationV1,
  compileCatalogProviderV1,
  defineCatalogProviderV1,
} from "./contracts.js";
import snapshot from "./ponytail.snapshot.json";

const PONYTAIL_FIXTURE: PinnedComponentCollectionInputV1 = {
  version: "pinned-component-collection/v1",
  source: {
    id: "ponytail",
    repository: "https://fixture.invalid/ponytail",
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    version: "0.0.0",
    licenseFileRef: "skills/main/SKILL.md",
  },
  files: [
    {
      path: "skills/main/SKILL.md",
      bytesBase64: "eA==",
      sha256: "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
      size: 1,
    },
  ],
  components: [
    {
      id: "skill:main",
      kind: "skill",
      label: "Fixture main skill",
      description: "Tiny synthetic component-collection fixture.",
      primaryPath: "skills/main/SKILL.md",
      fileRefs: ["skills/main/SKILL.md"],
    },
  ],
  profile: {
    id: "profile:methodology",
    label: "Fixture methodology profile",
    methodologyKey: "fixture",
    requires: "skill:main",
    originalPath: "skills/main/SKILL.md",
  },
  template: {
    id: "template:fixture/methodology",
    label: "Fixture methodology",
    profileRef: "profile:methodology",
  },
};
const REVIEWED_DIGEST = "ca06d43e8a2818ad277ca870113b0b98470080c3a0cf0aee49614f82485622cf";
const FIXTURE_DIGEST = "f781af36c963c9d824b1b0e6a8bfc1ee8c1cde56ec8475ff4c1660c75a5afef5";
let packagedSnapshot: PinnedComponentCollectionInputV1 | undefined;
let packagedBaselineCompilation: CatalogProviderCompilationV1 | undefined;

function assertReviewedPonytailInput(
  value: unknown,
): asserts value is PinnedComponentCollectionInputV1 {
  assertStrictJsonValueV1(value, "Ponytail component input");
  const valueDigest = canonicalStrictJsonSha256V1(value);
  if (valueDigest !== REVIEWED_DIGEST && valueDigest !== FIXTURE_DIGEST)
    throw new TypeError(
      "Ponytail input does not match a reviewed pinned inventory or synthetic fixture",
    );
}

/** Lazily seals the static JSON only when a packaged source path is requested. */
function packagedPonytailComponentCollectionV1(): PinnedComponentCollectionInputV1 {
  if (packagedSnapshot === undefined) {
    assertReviewedPonytailInput(snapshot);
    const candidate = structuredClone(snapshot);
    packagedSnapshot = deepFreezeStrictJsonV1(candidate) as PinnedComponentCollectionInputV1;
  }
  return packagedSnapshot;
}

/** Returns a detached copy of the packaged, reviewed source snapshot. */
export function ponytailPinnedComponentCollectionV1(): PinnedComponentCollectionInputV1 {
  return structuredClone(packagedPonytailComponentCollectionV1());
}

/** Tiny synthetic contract input; it is separate from the packaged Ponytail source inventory. */
export function ponytailComponentCollectionFixtureV1(): PinnedComponentCollectionInputV1 {
  return structuredClone(PONYTAIL_FIXTURE);
}

export function compilePonytailComponentCollectionV1(
  input: PinnedComponentCollectionInputV1,
): CatalogCompilerAssemblyInputV1 {
  assertReviewedPonytailInput(input);
  const result = compilePinnedComponentCollectionV1(input);
  return {
    sources: {
      [result.source.id]: {
        id: result.source.id,
        distributor: { kind: "aih", locator: "@aihq/core" },
        upstreamOrigin: { kind: "git", locator: result.source.repository },
        inputFormat: result.source.inputFormat,
        revision: { id: result.source.revisionId, contentDigest: result.source.contentDigest },
        compiler: compilerRegistrationForInputFormatV1(result.source.inputFormat),
      },
    },
    declarations: result.declarations,
    relations: result.relations,
    groups: result.groups,
    templates: result.templates,
    detailBytes: result.detailBytes,
  };
}

export const ponytailCatalogProviderV1 = defineCatalogProviderV1({
  providerId: "ponytail",
  providerVersion: "1",
  fixture: ponytailComponentCollectionFixtureV1,
  compile: (input: PinnedComponentCollectionInputV1) => [
    compilePonytailComponentCollectionV1(input),
  ],
});

/** Reuses only the sealed packaged baseline and always returns a detached provider compilation. */
export function preparePonytailCatalogProviderV1(): CatalogProviderCompilationV1 {
  if (packagedBaselineCompilation === undefined) {
    packagedBaselineCompilation = deepFreezeStrictJsonV1(
      compileCatalogProviderV1(ponytailCatalogProviderV1, packagedPonytailComponentCollectionV1()),
    ) as CatalogProviderCompilationV1;
  }
  return structuredClone(packagedBaselineCompilation);
}
