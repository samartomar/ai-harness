/**
 * Core's append-only record of the ECC profile installations a recovery
 * (repair, rollback, uninstall) may authenticate against. The ownership
 * receipt is operator-writable state, so its self-declared identity only
 * authorizes a write when it equals an entry here. Core ships the record and
 * `@aihq/framework-ecc` reads it through `@aihq/core/framework-host`: a plugin
 * release cannot add an anchor without Core changing.
 *
 * Append only: an entry is never edited or removed. Version 1 (unversioned)
 * binds destination, content and mode; version 2 also binds each file's merge
 * strategy. Every version-1 entry needs its version-2 companion at the same
 * pin.
 */

interface EccProfileInstallationPinV1 {
  readonly repository: "affaan-m/ECC";
  readonly commit: string;
  readonly sourceClosureId: string;
  readonly sourceClosureSha256: string;
  readonly projectionSha256: string;
}

/** One anchored recovery identity: version 1 (unversioned) or version 2. */
export type EccProfileInstallationTrustV1 =
  | EccProfileInstallationPinV1
  | (EccProfileInstallationPinV1 & { readonly recoveryIdentityVersion: 2 });

function anchors(
  entries: readonly EccProfileInstallationTrustV1[],
): readonly EccProfileInstallationTrustV1[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

export const ECC_PROFILE_INSTALLATION_TRUST_V1: readonly EccProfileInstallationTrustV1[] = anchors([
  {
    repository: "affaan-m/ECC",
    commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    sourceClosureId: "ecc-projected-source-closure-v1",
    sourceClosureSha256: "8dadd2c412511d690555243773f8bc4a0ed1e7ba43fc0804bc1d955b3b7bca37",
    projectionSha256: "8bfa1837b2f7d4239b69955540c20a76a795c4ef86dc3555390d5d18e30bc585",
  },
  // Version 2 of the same installation: also binds each file's merge strategy.
  {
    recoveryIdentityVersion: 2,
    repository: "affaan-m/ECC",
    commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    sourceClosureId: "ecc-projected-source-closure-v1",
    sourceClosureSha256: "8dadd2c412511d690555243773f8bc4a0ed1e7ba43fc0804bc1d955b3b7bca37",
    projectionSha256: "1d9367486f2075d4f90fea24d8d59ba5cb8b0ace087ec8a0382c53890ca7cbe2",
  },
]);
