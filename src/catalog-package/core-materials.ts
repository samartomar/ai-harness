import { createHash } from "node:crypto";
import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import {
  type CatalogPackageAccessV1,
  CatalogPackageRefusalError,
  type CatalogPackageSubpathV1,
  candidateCatalogActiveV1,
  loadCatalogPackageFileV1,
} from "./load-catalog-package.js";

const MATERIALS = {
  qualification: {
    format: "aih-catalog-core-qualification",
    subpath: "./catalog-core-qualification.json",
    sha256: "9b03b38f75c4ee7fbf462a491894aa4020c1aeaa5625a91e24f5e11ca2807913",
  },
  scanner: {
    format: "aih-catalog-scanner-evidence",
    subpath: "./catalog-scanner-evidence.json",
    sha256: "bad4ce1e961225be117a3c64abccf1babb63974471c14eb94fcda2fbc0129ddd",
  },
  scannerProviders: {
    format: "aih-catalog-scanner-providers",
    subpath: "./catalog-scanner-providers.json",
    sha256: "19a05fd8c86652aa3b01f27109ad182a11b07697fcdd45ac684af3d217e5f32f",
  },
  publicBaseline: {
    format: "aih-catalog-public-baseline",
    subpath: "./catalog-public-baseline.json",
    sha256: "d19c92e619ac9db23b7a316c827477eb20e12e676a6ba2a27835f25224407892",
  },
} as const satisfies Record<
  string,
  { format: string; subpath: CatalogPackageSubpathV1; sha256: string }
>;

function incompatible(kind: keyof typeof MATERIALS, detail: string): never {
  throw new CatalogPackageRefusalError({
    reason: "catalog-package-incompatible",
    detail: `the installed @aihq/catalog ${kind} material ${detail}`,
  });
}

export function loadCatalogCoreMaterialV1<K extends keyof typeof MATERIALS>(
  kind: K,
  access?: CatalogPackageAccessV1,
): Record<string, unknown> {
  const expected = MATERIALS[kind];
  const loaded = loadCatalogPackageFileV1(expected.subpath, access);
  if (!loaded.ok) throw new CatalogPackageRefusalError(loaded.refusal);
  const sha256 = createHash("sha256").update(loaded.file.bytes).digest("hex");
  // An activated candidate's named digest stands in for Core's (internal preparation only).
  const candidate = access === undefined && candidateCatalogActiveV1();
  if (!candidate && sha256 !== expected.sha256) {
    return incompatible(kind, `has unaccepted authority sha256 ${sha256}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(loaded.file.bytes).toString("utf8"));
  } catch {
    return incompatible(kind, "is not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return incompatible(kind, "is not an object");
  }
  const document = value as Record<string, unknown>;
  const canonical = Buffer.concat([canonicalStrictJsonBytesV1(document), Buffer.from("\n")]);
  if (!canonical.equals(Buffer.from(loaded.file.bytes)))
    return incompatible(kind, "is not canonical");
  if (document.format !== expected.format || document.version !== 1) {
    return incompatible(kind, "has an unsupported identity");
  }
  return structuredClone(document);
}
