import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeNativeDetectorDigest,
  discoverNativeDetectorSourceFiles,
  NATIVE_DETECTOR_DIGEST,
  NATIVE_DETECTOR_SOURCES,
  nativeAnalyzerIdentity,
} from "../baseline-evidence/native-identity.js";

export interface NativeIdentityDriftReport {
  ok: boolean;
  addedSources: string[];
  removedSources: string[];
  digestDrift: boolean;
  currentDigest: string;
}

/**
 * Recompute the declared native-detector closure and digest from `root` (default:
 * the live repository tree) and compare against the committed
 * `NATIVE_DETECTOR_SOURCES` / `NATIVE_DETECTOR_DIGEST` constants. A new file under
 * a declared glob root, a removed one, or any content change inside the closure
 * fails this gate until `--write` regenerates the constants and the diff is
 * reviewed — this is what makes the aih-native identity trustworthy evidence
 * instead of a constant nobody re-derives.
 */
export function checkNativeIdentityDrift(root?: string): NativeIdentityDriftReport {
  const discovered = discoverNativeDetectorSourceFiles(root);
  const discoveredSet = new Set(discovered);
  const committedSet = new Set(NATIVE_DETECTOR_SOURCES);
  const addedSources = discovered.filter((file) => !committedSet.has(file));
  const removedSources = NATIVE_DETECTOR_SOURCES.filter((file) => !discoveredSet.has(file));
  const currentDigest = computeNativeDetectorDigest(root);
  const digestDrift = currentDigest !== NATIVE_DETECTOR_DIGEST;
  return {
    ok: addedSources.length === 0 && removedSources.length === 0 && !digestDrift,
    addedSources,
    removedSources,
    digestDrift,
    currentDigest,
  };
}

function nativeIdentityDataPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../baseline-evidence/native-identity-data.json",
  );
}

function writeNativeIdentityData(): void {
  const sources = discoverNativeDetectorSourceFiles();
  const digest = computeNativeDetectorDigest();
  const path = nativeIdentityDataPath();
  writeFileSync(path, `${JSON.stringify({ sources, digest }, null, 2)}\n`, "utf8");
  process.stdout.write(
    `wrote ${path} (native.${digest}, ${sources.length} declared source files)\n`,
  );
}

function main(): void {
  if (process.argv.includes("--write")) {
    writeNativeIdentityData();
    return;
  }
  const report = checkNativeIdentityDrift();
  if (!report.ok) {
    if (report.addedSources.length > 0) {
      process.stderr.write(
        `added to declared native-detector closure: ${report.addedSources.join(", ")}\n`,
      );
    }
    if (report.removedSources.length > 0) {
      process.stderr.write(
        `removed from declared native-detector closure: ${report.removedSources.join(", ")}\n`,
      );
    }
    if (report.digestDrift) {
      process.stderr.write(
        `native-detector digest drift: committed ${NATIVE_DETECTOR_DIGEST}, computed ${report.currentDigest}\n`,
      );
    }
    process.stderr.write("regenerate with: npm run baseline:native-identity -- --write\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`native-detector identity is current (${nativeAnalyzerIdentity()})\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main();
}
