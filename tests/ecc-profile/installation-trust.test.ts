import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ECC_PROFILE_INSTALLATION_TRUST_V1 } from "../../src/framework-host/index.js";

const fixtureDirectory = join(import.meta.dirname, "../fixtures/ecc-profile");

describe("Core's append-only ECC profile installation trust record", () => {
  it("keeps the 0c1d7be9 anchors unchanged and appends the stub-only renders", () => {
    expect(ECC_PROFILE_INSTALLATION_TRUST_V1).toEqual([
      {
        repository: "affaan-m/ECC",
        commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
        sourceClosureId: "ecc-projected-source-closure-v1",
        sourceClosureSha256: "8dadd2c412511d690555243773f8bc4a0ed1e7ba43fc0804bc1d955b3b7bca37",
        projectionSha256: "8bfa1837b2f7d4239b69955540c20a76a795c4ef86dc3555390d5d18e30bc585",
      },
      {
        recoveryIdentityVersion: 2,
        repository: "affaan-m/ECC",
        commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
        sourceClosureId: "ecc-projected-source-closure-v1",
        sourceClosureSha256: "8dadd2c412511d690555243773f8bc4a0ed1e7ba43fc0804bc1d955b3b7bca37",
        projectionSha256: "1d9367486f2075d4f90fea24d8d59ba5cb8b0ace087ec8a0382c53890ca7cbe2",
      },
      {
        recoveryIdentityVersion: 2,
        repository: "affaan-m/ECC",
        commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
        sourceClosureId: "ecc-projected-source-closure-v1",
        sourceClosureSha256: "8dadd2c412511d690555243773f8bc4a0ed1e7ba43fc0804bc1d955b3b7bca37",
        projectionSha256: "2d721b76c1986a020ababdc8c1a5bd87095ed97a127eab2e5c36d5bada922dab",
      },
      {
        recoveryIdentityVersion: 2,
        repository: "affaan-m/ECC",
        commit: "5064474d4d762dc9640234a41617cccb79185cec",
        sourceClosureId: "ecc-projected-source-closure-v1",
        sourceClosureSha256: "17d2c510c63ce5566b48f96b3182e80f0e38b8262cdc191ae86e40dfa14f901b",
        projectionSha256: "09bc71543f5b374e1a97971c7bbb46e796eeef3fbff7d6cfee3e7b2464a9eb1d",
      },
    ]);
  });

  it("cannot be widened at runtime", () => {
    expect(Object.isFrozen(ECC_PROFILE_INSTALLATION_TRUST_V1)).toBe(true);
    for (const anchor of ECC_PROFILE_INSTALLATION_TRUST_V1)
      expect(Object.isFrozen(anchor)).toBe(true);
    const widened = ECC_PROFILE_INSTALLATION_TRUST_V1 as unknown as unknown[];
    expect(() => widened.push({ commit: "b".repeat(40) })).toThrow(TypeError);
    expect(ECC_PROFILE_INSTALLATION_TRUST_V1).toHaveLength(4);
  });

  it("anchors the write semantics of every version-1 identity with a version-2 companion", () => {
    const recorded = JSON.parse(
      readFileSync(join(fixtureDirectory, "projection-receipt.json"), "utf8"),
    ) as {
      sourceCommit: string;
      recoveryIdentityV2ProjectionSha256: string;
    };
    const trust = ECC_PROFILE_INSTALLATION_TRUST_V1 as unknown as readonly Record<
      string,
      unknown
    >[];
    const legacy = trust.filter((anchor) => !("recoveryIdentityVersion" in anchor));
    expect(legacy).not.toHaveLength(0);
    for (const anchor of legacy) {
      const { projectionSha256: _v1, ...pin } = anchor;
      expect(
        trust.filter((candidate) => {
          const { recoveryIdentityVersion, projectionSha256: _v2, ...candidatePin } = candidate;
          return (
            recoveryIdentityVersion === 2 && JSON.stringify(candidatePin) === JSON.stringify(pin)
          );
        }),
        String(anchor.commit),
      ).not.toHaveLength(0);
    }
    expect(trust).toContainEqual(
      expect.objectContaining({
        recoveryIdentityVersion: 2,
        commit: recorded.sourceCommit,
        projectionSha256: recorded.recoveryIdentityV2ProjectionSha256,
      }),
    );
  });
});
