import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ECC_PROFILE_INSTALLATION_TRUST_V1 } from "../../src/framework-host/index.js";

const fixtureDirectory = join(import.meta.dirname, "../fixtures/ecc-profile");

describe("Core's append-only ECC profile installation trust record", () => {
  it("keeps the 0c1d7be9 version-1 and version-2 anchors unchanged", () => {
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
    ]);
  });

  it("cannot be widened at runtime", () => {
    expect(Object.isFrozen(ECC_PROFILE_INSTALLATION_TRUST_V1)).toBe(true);
    for (const anchor of ECC_PROFILE_INSTALLATION_TRUST_V1)
      expect(Object.isFrozen(anchor)).toBe(true);
    const widened = ECC_PROFILE_INSTALLATION_TRUST_V1 as unknown as unknown[];
    expect(() => widened.push({ commit: "b".repeat(40) })).toThrow(TypeError);
    expect(ECC_PROFILE_INSTALLATION_TRUST_V1).toHaveLength(2);
  });

  it("anchors the write semantics of every version-1 identity with a version-2 companion", () => {
    const recorded = JSON.parse(
      readFileSync(join(fixtureDirectory, "projection-receipt.json"), "utf8"),
    ) as {
      sourceCommit: string;
      projectionSha256: string;
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
      ).toHaveLength(1);
    }
    expect(trust).toContainEqual(
      expect.objectContaining({
        recoveryIdentityVersion: 2,
        commit: recorded.sourceCommit,
        projectionSha256: recorded.recoveryIdentityV2ProjectionSha256,
      }),
    );
    expect(trust).toContainEqual(
      expect.objectContaining({
        commit: recorded.sourceCommit,
        projectionSha256: recorded.projectionSha256,
      }),
    );
  });
});
