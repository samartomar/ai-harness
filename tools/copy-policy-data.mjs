import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Copy retained Core policy/Catalog data after tsup cleans dist. No browser assets. */
export async function copyPolicyDataToDist(root = repositoryRoot) {
  const output = resolve(root, "dist");
  await mkdir(output, { recursive: true });
  for (const source of [
    "src/org-policy/workbench/default-catalog-preassembly.generated.cjs",
    "src/org-policy/workbench/core/packaged-source-data-data.json",
    "src/org-policy/workbench/core/catalog-qualification-data.json",
    "src/org-policy/packaged-collection-evidence-data.json",
  ]) {
    await copyFile(resolve(root, source), resolve(output, source.split("/").at(-1)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copyPolicyDataToDist();
}
