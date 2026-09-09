import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { reverifyPackagedAihScannerEvidenceRecordV1 } from "../baseline-evidence/aih-scan-preparation.js";
import { reverifyPackagedScannerCollectionEvidenceRecordV1 } from "../baseline-evidence/scanner-collection-preparation.js";
import { vendorBaselineLockBytes } from "../baseline-evidence/vendor.js";
import { buildVendorBaselineEvidenceArtifactV1 } from "../baseline-evidence/vendor-artifact-v1.js";
import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import { findOnPath } from "../live/runner.js";
import { parseGithubBaselineEvidenceAttestationV1 } from "../org-policy/admin-baseline-evidence-operations-v1.js";
import { policyAuthoringCatalog } from "../org-policy/catalog.js";
import {
  encodePackagedScannerCollectionEvidenceRecordV1,
  packagedScannerCollectionEvidenceV1,
} from "../org-policy/packaged-collection-evidence-v1.js";
import { packagedPublicBaselineEvidenceV1 } from "../org-policy/packaged-public-baseline-v1.js";
import { compileBuiltInCatalogV1 } from "../org-policy/workbench/compilers/built-in.js";
import { CatalogQualificationSummariesV1Schema } from "../org-policy/workbench/contracts.js";
import {
  packagedCatalogQualificationProjectionsV1,
  packagedCatalogQualificationRecordsV1,
} from "../org-policy/workbench/core/catalog-qualification-package-v1.js";
import {
  type CompilerQualificationBindingV1,
  catalogQualificationPackagedProjectionV1,
  prepareAihFirstPartyCompilerQualificationsV1,
  prepareRegisteredCompilerQualificationBindingsV1,
  verifyCatalogQualificationForPackagingV1,
} from "../org-policy/workbench/core/catalog-qualification-v1.js";
import { defaultPreparedWorkbenchCatalog } from "../org-policy/workbench/prepared-catalog.js";
import {
  derivePackagedSourceQualificationBindingsV1,
  type PackagedSourceQualificationMaterialV1,
} from "./derive-packaged-source-qualification.js";
import {
  readWorkbenchCollectionPublicationMaterialV1,
  type WorkbenchCollectionCatalogIdV1,
} from "./prepare-workbench-collection-evidence.js";
import { defaultRunner, type Runner } from "./proc.js";

function mergeQualificationBindings(
  target: Record<string, CompilerQualificationBindingV1>,
  incoming: Readonly<Record<string, CompilerQualificationBindingV1>>,
): void {
  for (const [assetId, binding] of Object.entries(incoming)) {
    if (target[assetId] !== undefined)
      throw new Error("Release qualification source material overlaps an asset binding.");
    target[assetId] = binding;
  }
}

/** Release-only read gate. No result of this function can mint a custody witness. */
export async function verifyWorkbenchPublicPublicationV1(
  options: {
    now?: string;
    run?: Runner;
    gh?: string;
    catalogQualification?: readonly { sourceRoot: string; providerId: string }[];
    packagedSourceQualification?: readonly PackagedSourceQualificationMaterialV1[];
    collectionMaterial?: readonly {
      sourceRoot: string;
      catalogId: WorkbenchCollectionCatalogIdV1;
      publicationRoot: string;
    }[];
  } = {},
): Promise<void> {
  const collectionRecords = packagedScannerCollectionEvidenceV1();
  const proof = packagedPublicBaselineEvidenceV1();
  if (!proof && collectionRecords.length === 0)
    throw new Error("Release requires prepared public or collection evidence.");
  const now = options.now ?? `${new Date().toISOString().slice(0, 19)}Z`;
  if (!Number.isFinite(Date.parse(now))) throw new Error("Release verification time is invalid.");
  if (proof) {
    const clock = Date.parse(now);
    if (clock < Date.parse(proof.verifiedAt) || clock >= Date.parse(proof.validUntil))
      throw new Error("Release evidence is outside its original verification interval.");
    const artifact = buildVendorBaselineEvidenceArtifactV1({
      lockBytes: vendorBaselineLockBytes(),
      publisher: {
        repository: proof.publisher.repository,
        environment: proof.publisher.environment,
      },
    });
    if (proof.artifactSubjectDigest !== `sha256:${artifact.subject.sha256}`)
      throw new Error("Release evidence names a different artifact subject.");
    const gh =
      options.gh ?? findOnPath("gh", process.env, process.platform, { windowsExeOnly: true });
    if (!gh) throw new Error("Release evidence verification requires GitHub CLI.");
    const root = mkdtempSync(join(tmpdir(), "aih-release-evidence-"));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error("Unsafe evidence staging directory.");
    try {
      const subject = join(root, "SHA256SUMS");
      writeFileSync(subject, artifact.subject.bytes, { flag: "wx", mode: 0o600 });
      const publisher = proof.publisher;
      const result = await (options.run ?? defaultRunner)(
        [
          gh,
          "attestation",
          "verify",
          subject,
          "--format",
          "json",
          "--repo",
          publisher.repository,
          "--predicate-type",
          "https://slsa.dev/provenance/v1",
          "--cert-identity",
          `https://github.com/${publisher.workflow}@${publisher.ref}`,
          "--cert-oidc-issuer",
          publisher.issuer,
          "--source-ref",
          publisher.ref,
          "--deny-self-hosted-runners",
        ],
        { timeoutMs: 30000, maxBufferBytes: 256 * 1024 },
      );
      if (result.code !== 0 || result.spawnError || result.truncated)
        throw new Error("Release evidence publication attestation verification failed.");
      const verified = parseGithubBaselineEvidenceAttestationV1(
        Buffer.from(result.stdout, "utf8"),
        {
          expectedEnvironment: publisher.environment,
          expectedIssuer: publisher.issuer,
          expectedRef: publisher.ref,
          expectedRepository: publisher.repository,
          expectedWorkflow: publisher.workflow,
          subjectSha256: artifact.subject.sha256,
          now,
        },
      );
      if (verified.signedAt !== proof.signedAt)
        throw new Error("Release evidence signing time does not match the verified publication.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  let preparedAihPublications:
    | Awaited<ReturnType<typeof reverifyPackagedAihScannerEvidenceRecordV1>>
    | undefined;
  if (collectionRecords.length !== 0) {
    if (!options.collectionMaterial || options.collectionMaterial.length === 0)
      throw new Error(
        "Release collection records require their bounded source and publication material.",
      );
    const material = new Map(options.collectionMaterial.map((item) => [item.catalogId, item]));
    if (material.size !== options.collectionMaterial.length)
      throw new Error("Release collection material has duplicate catalog inputs.");
    for (const record of collectionRecords) {
      const input = material.get(record.catalog.id);
      const sealed = encodePackagedScannerCollectionEvidenceRecordV1(record);
      if (!input || !sealed)
        throw new Error("Release collection material is missing its sealed catalog record.");
      const materialized = readWorkbenchCollectionPublicationMaterialV1(
        input.sourceRoot,
        record.catalog.id,
        input.publicationRoot,
      );
      if (record.catalog.id === "aih") {
        if (preparedAihPublications !== undefined)
          throw new Error("Release collection material has duplicate AIH records.");
        preparedAihPublications = await reverifyPackagedAihScannerEvidenceRecordV1({
          packageRoot: input.sourceRoot,
          coreRevision: { pinnedSha: record.catalog.pinnedCommit },
          catalog: policyAuthoringCatalog(),
          compiled: compileBuiltInCatalogV1(policyAuthoringCatalog()),
          batches: materialized.batches,
          now,
          sealed,
        });
      } else {
        await reverifyPackagedScannerCollectionEvidenceRecordV1({
          sourceRoot: input.sourceRoot,
          catalogId: record.catalog.id,
          batches: materialized.batches,
          now,
          sealed,
        });
      }
    }
  }

  const qualificationRecords = packagedCatalogQualificationRecordsV1();
  if (qualificationRecords.length === 0) return;
  const preparedCatalog = defaultPreparedWorkbenchCatalog();
  const bindings: Record<string, CompilerQualificationBindingV1> = {};
  if (preparedAihPublications !== undefined) {
    const firstParty = prepareAihFirstPartyCompilerQualificationsV1(
      preparedCatalog.bundle,
      preparedAihPublications,
    );
    if (firstParty === undefined)
      throw new Error(
        "Release AIH qualification bindings could not be derived from verified material.",
      );
    mergeQualificationBindings(bindings, firstParty.bindings);
  }
  mergeQualificationBindings(
    bindings,
    derivePackagedSourceQualificationBindingsV1(
      preparedCatalog.bundle,
      options.packagedSourceQualification ?? [],
    ),
  );
  for (const source of options.catalogQualification ?? []) {
    const derived = prepareRegisteredCompilerQualificationBindingsV1(
      preparedCatalog.bundle,
      source.sourceRoot,
      source.providerId,
    );
    if (derived === undefined)
      throw new Error(
        "Release qualification bindings could not be recomputed from registered material.",
      );
    mergeQualificationBindings(bindings, derived);
  }
  const packagedProjections = packagedCatalogQualificationProjectionsV1();
  if (packagedProjections.length !== 1)
    throw new Error("Release Catalog qualification requires one prepared projection.");
  const expected = CatalogQualificationSummariesV1Schema.safeParse(packagedProjections[0]?.summary);
  if (!expected.success || Object.keys(expected.data).length === 0)
    throw new Error("Release Catalog qualification projection is malformed.");
  const verifiedTimes: Record<string, string> = {};
  for (const summary of Object.values(expected.data)) {
    const previous = verifiedTimes[summary.receiptDigest];
    if (previous !== undefined && previous !== summary.verifiedAt)
      throw new Error("Release Catalog receipt has conflicting verification times.");
    verifiedTimes[summary.receiptDigest] = summary.verifiedAt;
  }
  const preparedQualification = await verifyCatalogQualificationForPackagingV1(
    preparedCatalog.bundle,
    bindings,
    now,
    verifiedTimes,
  );
  const actualProjection = catalogQualificationPackagedProjectionV1(preparedQualification);
  if (
    actualProjection === undefined ||
    !Buffer.from(canonicalStrictJsonBytesV1(actualProjection)).equals(
      canonicalStrictJsonBytesV1(packagedProjections[0]),
    )
  )
    throw new Error(
      "Release Catalog qualification projection differs from live authenticated artifacts.",
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (
    args.length % 2 !== 0 ||
    args.some(
      (value, index) =>
        index % 2 === 0 &&
        value !== "--catalog-material-root" &&
        value !== "--collection-material-root",
    ) ||
    args.some((value, index) => index % 2 === 1 && (!value || value.startsWith("--"))) ||
    new Set(args.filter((_, index) => index % 2 === 0)).size !== args.length / 2
  )
    throw new TypeError(
      "Usage: check-workbench-publication [--catalog-material-root <directory-with-mattpocock-ponytail-ecc-superpowers-subroots>] [--collection-material-root <directory-with-provider-checkout-and-publications-subroots>]",
    );
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : (args[index + 1] as string);
  };
  const catalogRoot = flag("--catalog-material-root");
  const collectionRoot = flag("--collection-material-root");
  const catalogQualification =
    catalogRoot === undefined
      ? undefined
      : (["mattpocock", "ponytail", "ecc", "superpowers"] as const).flatMap((providerId) => {
          const sourceRoot = resolve(catalogRoot, providerId);
          return existsSync(sourceRoot) &&
            lstatSync(sourceRoot).isDirectory() &&
            !lstatSync(sourceRoot).isSymbolicLink()
            ? [{ providerId, sourceRoot }]
            : [];
        });
  const collectionMaterial =
    collectionRoot === undefined
      ? undefined
      : (["aih", "mattpocock", "ponytail", "ecc", "superpowers"] as const).flatMap((catalogId) => {
          const sourceRoot = resolve(collectionRoot, catalogId, "checkout");
          const publicationRoot = resolve(collectionRoot, catalogId, "publications");
          return existsSync(sourceRoot) && existsSync(publicationRoot)
            ? [{ catalogId, sourceRoot, publicationRoot }]
            : [];
        });
  await verifyWorkbenchPublicPublicationV1({ catalogQualification, collectionMaterial });
  console.log("Packaged public evidence matches the actual protected publication attestation.");
}
