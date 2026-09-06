import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedPath = "src/org-policy/workbench/bundle.generated.cjs";

/** Explicit UI/package build step; importing a Vitest config never invokes it. */
export async function buildWorkbench(root = repositoryRoot) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/org-policy/workbench/ui/main.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    write: false,
    metafile: true,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("Workbench browser build produced no output");
  const browserScript = ("/* aih-workbench-ui/v1 */\n" + output.text).replaceAll("</script", "<\\/script");
  const generated = "module.exports = " + JSON.stringify(browserScript) + ";\n";
  const target = resolve(root, generatedPath);
  await mkdir(dirname(target), { recursive: true });
  let previous;
  try {
    previous = await readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous !== generated) await writeFile(target, generated);
  return { bytes: Buffer.byteLength(browserScript), inputs: Object.keys(result.metafile.inputs).sort() };
}

/** tsup cleans dist, so the exact generated companion is copied after its build. */
export async function copyWorkbenchToDist(root = repositoryRoot) {
  const target = resolve(root, "dist/bundle.generated.cjs");
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, generatedPath), target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--copy-to-dist")) {
    await copyWorkbenchToDist();
  } else {
    const result = await buildWorkbench();
    console.log("Workbench browser bundle: " + result.bytes + " bytes");
  }
}
