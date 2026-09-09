import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertAihScanMaterialEquivalenceV1,
  materializeAihScanSubjectsV1,
  removeMaterializedAihScanSubjectsV1,
} from "../baseline-evidence/aih-scan-material.js";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1 } from "../baseline-evidence/scanner-publication-policy.js";
import { policyAuthoringCatalog } from "../org-policy/catalog.js";
import { packagedScannerCollectionEvidenceV1 } from "../org-policy/packaged-collection-evidence-v1.js";
import { compileBuiltInCatalogV1 } from "../org-policy/workbench/compilers/built-in.js";
import { packagedCatalogQualificationBindingsV1 } from "../org-policy/workbench/core/catalog-qualification-package-v1.js";
import { packagedWorkbenchSourceDataRecordsV1 } from "../org-policy/workbench/core/packaged-source-data.js";
import { defaultPreparedWorkbenchCatalog } from "../org-policy/workbench/prepared-catalog.js";
import {
  acquireBoundedGithubSourceArchiveV1,
  forgetAcquiredGithubSourceArchiveV1,
} from "./bounded-github-source-archive.js";
import { hermeticGitEnv } from "./git-env.js";
import type { WorkbenchCollectionCatalogIdV1 } from "./prepare-workbench-collection-evidence.js";
import { verifyPackagedWorkbenchSourceDataV1 } from "./verify-packaged-workbench-source-data.js";
import { verifyWorkbenchPublicPublicationV1 } from "./verify-workbench-publication.js";

type MaterialTarget = {
  id: string;
  sourceId: string;
  repository: string;
  pin: string;
  collectionSource?: { repository: string; pin: string };
  publications: readonly string[];
};
const fileLimits = {
  SHA256SUMS: 8_192,
  "discovery.json": 8_192,
  "inspection.json": 1_048_576,
  "publication.json": 96 * 1024 * 1024,
};

/** Inert plan from package-owned identities, never from a user-supplied fetch manifest. */
export function workbenchPublicationMaterialTargetsV1(): readonly MaterialTarget[] {
  const bundle = defaultPreparedWorkbenchCatalog().bundle;
  const records = packagedScannerCollectionEvidenceV1();
  const packagedSources = new Map(
    packagedWorkbenchSourceDataRecordsV1().map((record) => {
      const ids = Object.keys(record.sourceBundle.sources);
      if (ids.length !== 1 || ids[0] === undefined)
        throw new Error("Release material has ambiguous packaged source identity.");
      return [ids[0], record] as const;
    }),
  );
  const needed = new Set(records.map((record) => record.catalog.source.id));
  for (const sourceId of packagedSources.keys()) needed.add(sourceId);
  for (const binding of packagedCatalogQualificationBindingsV1())
    needed.add(binding.asset.sourceId);
  return [...needed].sort().map((sourceId) => {
    const source = bundle.sources[sourceId];
    const record = records.find((candidate) => candidate.catalog.source.id === sourceId);
    const packaged = packagedSources.get(sourceId);
    const id = sourceId === "source:aih-core" ? "aih" : sourceId.replace(/^source:/, "");
    if (!source || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))
      throw new Error("Release material has no registered source.");
    const repository =
      packaged?.source.repository ??
      (record ? `${record.catalog.owner}/${record.catalog.repository}` : undefined) ??
      (source.upstreamOrigin.kind === "aih"
        ? "samartomar/ai-harness"
        : source.upstreamOrigin.locator.replace(/^https:\/\/github\.com\//, ""));
    const pin =
      packaged?.source.commit ??
      record?.catalog.pinnedCommit ??
      (source.upstreamOrigin.kind === "aih" ? undefined : source.revision.id);
    if (
      packaged &&
      (source.revision.id !== packaged.source.commit ||
        source.upstreamOrigin.kind !== "git" ||
        source.upstreamOrigin.locator.replace(/^https:\/\/github\.com\//, "") !==
          packaged.source.repository)
    )
      throw new Error("Release material packaged source does not match the displayed bundle.");
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !pin ||
      !/^[a-f0-9]{40}$/.test(pin)
    )
      throw new Error("Release material requires an exact registered GitHub source pin.");
    const publications = (record?.publications ?? []).map((publication) => {
      const publisher = SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1.find(
        (candidate) =>
          candidate.repository === publication.repository &&
          candidate.commit === publication.sourceCommit,
      );
      if (!publisher)
        throw new Error("Release material contains an unregistered immutable Scanner publisher.");
      const prefix = `https://github.com/${publisher.repository}/releases/download/baseline-v1-${publisher.commit}-${publication.requestSha256}`;
      const suffix = publication.publicationLocator.slice(prefix.length);
      if (
        !publication.publicationLocator.startsWith(prefix) ||
        !/^(?:-r[0-9]{8})?\/publication\.json$/.test(suffix)
      )
        throw new Error(
          "Release material contains an invalid immutable Scanner publication address.",
        );
      return publication.publicationLocator.slice(0, -"publication.json".length);
    });
    const collectionSource = record
      ? {
          repository: `${record.catalog.owner}/${record.catalog.repository}`,
          pin: record.catalog.pinnedCommit,
        }
      : undefined;
    if (
      collectionSource &&
      (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(collectionSource.repository) ||
        !/^[a-f0-9]{40}$/.test(collectionSource.pin))
    )
      throw new Error(
        "Release collection material requires an exact registered GitHub source pin.",
      );
    return { id, sourceId, repository, pin, publications, collectionSource };
  });
}

async function download(url: string, maximum: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Published Workbench material could not be downloaded.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      count += result.value.byteLength;
      if (count > maximum) throw new Error("Published Workbench material exceeds its byte bound.");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel();
  }
  if (count === 0) throw new Error("Published Workbench material is empty.");
  return Buffer.concat(chunks);
}

function moduleOwnedCoreCheckoutRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDirectory, "../.."), resolve(moduleDirectory, "..")];
  for (const root of candidates) {
    if (
      existsSync(join(root, "package.json")) &&
      existsSync(join(root, "src", "org-policy", "catalog.ts"))
    )
      return root;
  }
  throw new Error("Release Core checkout root is unavailable.");
}

function cleanCoreCheckout(): Readonly<{ root: string; commit: string }> {
  const root = moduleOwnedCoreCheckoutRoot();
  const options = { encoding: "utf8" as const, windowsHide: true };
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    ...options,
    env: hermeticGitEnv(),
  }).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Release Core checkout has no exact HEAD.");
  const status = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain=v1", "--untracked-files=no"],
    { ...options, env: hermeticGitEnv() },
  );
  if (status !== "") throw new Error("Release Core checkout must be clean.");
  return { root, commit };
}

function assertAihReleaseMaterialEquivalence(
  scannedRoot: string,
  scannedCommit: string,
  outputParent: string,
): void {
  const release = cleanCoreCheckout();
  const catalog = policyAuthoringCatalog();
  const compiled = compileBuiltInCatalogV1(catalog);
  const scanned = materializeAihScanSubjectsV1({
    packageRoot: scannedRoot,
    outputParent,
    coreRevision: { pinnedSha: scannedCommit },
    catalog,
    compiled,
  });
  let releaseMaterial: ReturnType<typeof materializeAihScanSubjectsV1> | undefined;
  try {
    releaseMaterial = materializeAihScanSubjectsV1({
      packageRoot: release.root,
      outputParent,
      coreRevision: { pinnedSha: release.commit },
      catalog,
      compiled,
    });
    assertAihScanMaterialEquivalenceV1(scanned, releaseMaterial);
  } finally {
    if (releaseMaterial !== undefined) removeMaterializedAihScanSubjectsV1(releaseMaterial);
    removeMaterializedAihScanSubjectsV1(scanned);
  }
}
/** Connected release gate only. Normal Studio generation never calls this operation. */
export async function verifyWorkbenchPublicPublicationWithMaterialsV1(): Promise<void> {
  await verifyPackagedWorkbenchSourceDataV1();
  const targets = workbenchPublicationMaterialTargetsV1();
  if (targets.length === 0) return verifyWorkbenchPublicPublicationV1();
  const root = mkdtempSync(join(tmpdir(), "aih-workbench-publications-"));
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
    throw new Error("Unsafe release material directory.");
  const qualificationRoots: { sourceRoot: string; providerId: string }[] = [];
  const packagedSourceQualification = [] as {
    sourceId: string;
    sourceRoot: string;
    record: ReturnType<typeof packagedWorkbenchSourceDataRecordsV1>[number];
  }[];
  const packagedSources = new Map(
    packagedWorkbenchSourceDataRecordsV1().map((record) => {
      const sourceId = Object.keys(record.sourceBundle.sources)[0];
      if (!sourceId) throw new Error("Release material has ambiguous packaged source identity.");
      return [sourceId, record] as const;
    }),
  );
  try {
    for (const target of targets) {
      const checkout = join(root, target.id, "checkout");
      await acquireBoundedGithubSourceArchiveV1({
        repository: target.repository,
        commit: target.pin,
        destination: checkout,
      });
      if (target.id === "aih") assertAihReleaseMaterialEquivalence(checkout, target.pin, root);
      // A retained report can cover an older pin than the current packaged source.
      // Replay that report against its original bytes, never the replacement checkout.
      if (
        target.collectionSource &&
        (target.collectionSource.repository !== target.repository ||
          target.collectionSource.pin !== target.pin)
      ) {
        await acquireBoundedGithubSourceArchiveV1({
          repository: target.collectionSource.repository,
          commit: target.collectionSource.pin,
          destination: join(root, target.id, "collection-checkout"),
        });
      }
      const packaged = packagedSources.get(target.sourceId);
      if (packaged) {
        packagedSourceQualification.push({
          sourceId: target.sourceId,
          sourceRoot: checkout,
          record: packaged,
        });
      } else if (target.id !== "aih")
        qualificationRoots.push({ sourceRoot: checkout, providerId: target.id });
      let remaining = 128 * 1024 * 1024;
      for (const [index, base] of target.publications.entries()) {
        const directory = join(
          root,
          target.id,
          "publications",
          `batch-${String(index + 1).padStart(3, "0")}`,
        );
        mkdirSync(directory, { recursive: true });
        for (const [name, maximum] of Object.entries(fileLimits)) {
          const bytes = await download(base + name, Math.min(maximum, remaining));
          remaining -= bytes.length;
          writeFileSync(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
        }
      }
    }
    await verifyWorkbenchPublicPublicationV1({
      catalogQualification: qualificationRoots,
      packagedSourceQualification,
      collectionMaterial: targets
        .filter((target) => target.publications.length > 0)
        .map((target) => ({
          sourceRoot: join(
            root,
            target.id,
            target.collectionSource &&
              (target.collectionSource.repository !== target.repository ||
                target.collectionSource.pin !== target.pin)
              ? "collection-checkout"
              : "checkout",
          ),
          catalogId: target.id as WorkbenchCollectionCatalogIdV1,
          publicationRoot: join(root, target.id, "publications"),
        })),
    });
  } finally {
    for (const target of targets) {
      forgetAcquiredGithubSourceArchiveV1(join(root, target.id, "checkout"));
      forgetAcquiredGithubSourceArchiveV1(join(root, target.id, "collection-checkout"));
    }
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2)
    throw new Error("This release gate accepts no artifact URLs or source overrides.");
  await verifyWorkbenchPublicPublicationWithMaterialsV1();
  console.log("Workbench publications reverified against their exact pinned source material.");
}
