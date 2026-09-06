import { superpowersCatalogProviderV1 } from "../../../../src/org-policy/workbench/providers/superpowers.js";
import { providerContract } from "./contract-helper.js";

providerContract(superpowersCatalogProviderV1);

import { expect, it } from "vitest";
import { pinnedProviderFixtureV1 } from "../../../../src/org-policy/workbench/providers/pinned.js";

it("rejects a source snapshot from a different pin", () => {
  const input = pinnedProviderFixtureV1("superpowers");
  input.source.pinnedSha = "d".repeat(40);
  expect(() => superpowersCatalogProviderV1.compile(input)).toThrow(/source identity mismatch/);
});
