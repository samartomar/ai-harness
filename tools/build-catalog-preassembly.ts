import { createRequire } from "node:module";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalStrictJsonSha256V1 } from "../src/contract/strict-json-v1.js";
import {
  admitDefaultCatalogPreassemblyV1,
  createDefaultCatalogPreassemblyV1,
} from "../src/org-policy/workbench/default-catalog-preassembly.js";
import { compilePackagedWorkbenchCatalogForBuildV1 } from "../src/org-policy/workbench/prepared-catalog.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const companionPath = "src/org-policy/workbench/default-catalog-preassembly.generated.cjs";
const nodeRequire = createRequire(import.meta.url);

function generatedModule(catalog: Readonly<{ bytes: string; sha256: string }>): string {
  return `module.exports = ${JSON.stringify({ catalog })};\n`;
}

function samePreparedOutput(
  left: ReturnType<typeof compilePackagedWorkbenchCatalogForBuildV1>,
  right: ReturnType<typeof compilePackagedWorkbenchCatalogForBuildV1>,
): boolean {
  return canonicalStrictJsonSha256V1(left) === canonicalStrictJsonSha256V1(right);
}

/** A provider edit cannot let stale companion bytes replace current compiler output. */
export async function buildCatalogPreassembly(root = repositoryRoot) {
  const fresh = compilePackagedWorkbenchCatalogForBuildV1();
  const catalog = createDefaultCatalogPreassemblyV1(fresh);
  const target = resolve(root, companionPath);
  const staging = `${target}.${process.pid}.staging.cjs`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(staging, generatedModule(catalog), "utf8");
    delete nodeRequire.cache[staging];
    const staged = nodeRequire(staging) as unknown;
    if (
      staged === null ||
      typeof staged !== "object" ||
      Array.isArray(staged) ||
      Object.keys(staged).length !== 1 ||
      !Object.hasOwn(staged, "catalog")
    )
      throw new TypeError("Default catalog preassembly staging companion is malformed");
    const candidate = staged as { catalog: typeof catalog };
    const admitted = admitDefaultCatalogPreassemblyV1(candidate.catalog);
    if (admitted === undefined || !samePreparedOutput(admitted, fresh))
      throw new TypeError("Default catalog preassembly staging output differs from current compiler");
    await rename(staging, target);
    return {
      bytes: Buffer.byteLength(catalog.bytes, "utf8"),
      digest: catalog.sha256,
      target: pathToFileURL(target).href,
    };
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildCatalogPreassembly();
  console.log(`Default catalog preassembly: ${String(result.bytes)} bytes ${result.digest}`);
}
