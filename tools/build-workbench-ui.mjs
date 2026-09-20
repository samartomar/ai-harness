import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { transform } from "esbuild";
import { build } from "vite";

/**
 * The two production builds of the component UI (Policy Workbench UI
 * delivery, "Real hosts"): one static hosted site, and one self-contained
 * offline file the CLI host serves from the installed package.
 *
 * Nothing here fetches a network resource. Vite runs through its JS API
 * against local files only.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = resolve(repositoryRoot, "workbench-ui");
const hostedOutDir = resolve(uiRoot, "dist/hosted");
const componentPagePath = "src/org-policy/workbench/component-page.generated.cjs";

/**
 * FONT EMBEDDING IN THE OFFLINE FILE — the owner has not decided this yet.
 * The offline content-security policy the existing tests use has no
 * `font-src`, so a `data:` font would violate it. Until the owner decides,
 * the offline file ships without the three `@font-face` rules and carries no
 * font bytes. The hosted site always ships the fonts as separate assets.
 */
const EMBED_FONTS_IN_OFFLINE_FILE = false;

function viteConfig(hostFolder, extraBuild = {}) {
  return {
    configFile: false,
    root: resolve(uiRoot, "hosts", hostFolder),
    base: "./",
    plugins: [react()],
    // The component sources, the tokens and the fonts live outside the host root.
    css: { postcss: uiRoot },
    logLevel: "warn",
    build: { target: "es2022", ...extraBuild },
  };
}

function runPackageOnlyModel(root) {
  const source =
    "import { packageOnlyPolicyStudioModelV1 } from './src/org-policy/studio-model.ts';" +
    "process.stdout.write(JSON.stringify({" +
    "format: 'aih-workbench-input', version: 1, door: 'admin'," +
    "model: packageOnlyPolicyStudioModelV1()}));";
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectRun(new Error(`Package-only Workbench input failed: ${(stderr || stdout).trim()}`));
          return;
        }
        resolveRun(stdout);
      },
    );
    child.once("error", rejectRun);
  });
}

/** The static hosted site: hashed assets plus its input as one same-origin file. */
export async function buildHostedSite(root = repositoryRoot) {
  await rm(hostedOutDir, { recursive: true, force: true });
  await build(
    viteConfig("hosted", { outDir: hostedOutDir, emptyOutDir: true, assetsInlineLimit: 0 }),
  );
  const input = await runPackageOnlyModel(root);
  const inputPath = resolve(hostedOutDir, "workbench-input.json");
  await writeFile(inputPath, input);
  return { outDir: hostedOutDir, inputBytes: Buffer.byteLength(input) };
}

function assetText(output) {
  return typeof output.source === "string"
    ? output.source
    : Buffer.from(output.source).toString("utf8");
}

/** Strip the `@font-face{…}` blocks, and nothing else, from the offline CSS. */
function withoutFontFaces(css) {
  let result = "";
  let index = 0;
  for (;;) {
    const start = css.indexOf("@font-face", index);
    if (start === -1) {
      result += css.slice(index);
      return result;
    }
    const open = css.indexOf("{", start);
    if (open === -1) {
      result += css.slice(index);
      return result;
    }
    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    result += css.slice(index, start);
    index = cursor;
  }
}

/** The one self-contained file: no `<link>`, no `src=`, nothing to fetch. */
export async function buildOfflineFile(root = repositoryRoot) {
  const result = await build(
    viteConfig("cli", {
      write: false,
      cssCodeSplit: false,
      assetsInlineLimit: EMBED_FONTS_IN_OFFLINE_FILE ? 100_000_000 : 0,
      rollupOptions: { output: { inlineDynamicImports: true } },
    }),
  );
  const outputs = (Array.isArray(result) ? result[0] : result).output;
  const chunks = outputs.filter((output) => output.type === "chunk");
  if (chunks.length !== 1) {
    throw new Error(`The offline file needs exactly one script chunk, got ${chunks.length}`);
  }
  const page = outputs.find((output) => output.fileName === "index.html");
  if (page === undefined) throw new Error("The offline build produced no index.html");
  const styles = outputs
    .filter((output) => output.type === "asset" && output.fileName.endsWith(".css"))
    .map((output) => assetText(output))
    .join("\n");
  const css = EMBED_FONTS_IN_OFFLINE_FILE ? styles : withoutFontFaces(styles);
  const script = chunks[0].code.replaceAll("</script", "<\\/script");

  // The shell is the page without its two payloads, so these guards read the
  // markup the browser would fetch from, never the code or the styles.
  const shell = assetText(page)
    .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/u, "<!--script-->")
    .replace(/<link\b[^>]*\bstylesheet[^>]*>/u, "<!--style-->");
  if (/\b(?:src|href)\s*=\s*["'](?!#)/u.test(shell)) {
    throw new Error("The offline file still references a file it would have to fetch");
  }
  if (shell.includes("/assets/") || css.includes("/assets/")) {
    throw new Error("The offline file still references a built asset path");
  }
  if (!EMBED_FONTS_IN_OFFLINE_FILE && /data:font|woff2/u.test(css)) {
    throw new Error("The offline file carries font bytes while fonts are not embedded");
  }
  if (!shell.includes("__AIH_WORKBENCH_INPUT__")) {
    throw new Error("The offline file lost its input placeholder");
  }

  // Function replacements only: a string replacement expands `$&`, `` $` `` and
  // `$'`, which minified code contains, and would splice the page into itself.
  const scriptElement = `<script type="module">\n${script}\n</script>`;
  const styleElement = `<style>\n${css}\n</style>`;
  let html = shell.replace("<!--script-->", () => scriptElement);
  html = html.includes("<!--style-->")
    ? html.replace("<!--style-->", () => styleElement)
    : html.replace("</head>", () => `${styleElement}</head>`);

  // The assembled page must carry the bundle byte for byte, and that bundle
  // must parse, or the served page mounts nothing.
  const inlined = /<script type="module">\n([\s\S]*?)\n<\/script>/u.exec(html)?.[1];
  if (inlined !== script) {
    throw new Error("The offline file does not carry the built bundle byte for byte");
  }
  await transform(script, { loader: "js", format: "esm" });

  const generated = `module.exports = ${JSON.stringify(html)};\n`;
  const target = resolve(root, componentPagePath);
  await mkdir(dirname(target), { recursive: true });
  let previous;
  try {
    previous = await readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous !== generated) await writeFile(target, generated);
  return { bytes: Buffer.byteLength(html), scriptBytes: Buffer.byteLength(script) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hostedOnly = process.argv.includes("--hosted");
  const offlineOnly = process.argv.includes("--offline");
  if (!offlineOnly) {
    const hosted = await buildHostedSite();
    console.log(`Hosted Workbench site: ${hosted.outDir} (input ${hosted.inputBytes} bytes)`);
  }
  if (!hostedOnly) {
    const offline = await buildOfflineFile();
    console.log(`Offline Workbench page: ${offline.bytes} bytes`);
  }
}
