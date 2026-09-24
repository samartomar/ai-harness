/** ECC's npm installer package and the bins aih invokes from it; no imports, so repository checks can load it. */
export const ECC_NPM_PACKAGE = "ecc-universal";
export const ECC_NPM_BIN = "ecc-install";
export const ECC_NPM_CLI_BIN = "ecc";
export const ECC_NPM_BINS = [ECC_NPM_BIN, ECC_NPM_CLI_BIN] as const;
