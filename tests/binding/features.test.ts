import { describe, expect, it } from "vitest";
import { assertKnownFeatureKeys, BindingFeatureKeyError } from "../../src/binding/features.js";

describe("assertKnownFeatureKeys — plan-time feature-key validation (W2 ruling)", () => {
  it("accepts an absent features object (no flags declared)", () => {
    expect(() => assertKnownFeatureKeys(undefined, ["codexReviews"], "gstack")).not.toThrow();
  });

  it("accepts declared keys the adapter knows", () => {
    expect(() =>
      assertKnownFeatureKeys(
        { codexReviews: true, browser: false },
        ["codexReviews", "browser"],
        "gstack",
      ),
    ).not.toThrow();
  });

  it("rejects an unknown key, naming it and the known set", () => {
    expect(() => assertKnownFeatureKeys({ turboMode: true }, ["codexReviews"], "gstack")).toThrow(
      BindingFeatureKeyError,
    );
    expect(() => assertKnownFeatureKeys({ turboMode: true }, ["codexReviews"], "gstack")).toThrow(
      /turboMode.*codexReviews/s,
    );
  });

  it("rejects every declared key when the framework accepts no feature flags", () => {
    expect(() => assertKnownFeatureKeys({ anything: true }, [], "superpowers")).toThrow(
      /unknown feature key.*anything.*\(none\)/s,
    );
  });

  it("lists all unknown keys, not just the first", () => {
    expect(() =>
      assertKnownFeatureKeys({ a: true, b: false, codexReviews: true }, ["codexReviews"], "ecc"),
    ).toThrow(/a, b/);
  });
});
