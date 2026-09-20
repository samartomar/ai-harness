// @vitest-environment node
import { build, type Metafile, type Plugin } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const UI_ENTRY = "workbench-ui/src/App.tsx";
const HOST_ENTRIES = ["workbench-ui/hosts/cli/main.tsx", "workbench-ui/hosts/hosted/main.tsx"];
const ENGINE_ENTRY = "src/org-policy/workbench/engine/index.ts";
const ALLOWED_PACKAGES = new Set(["react", "react-dom", "@radix-ui/react-dialog"]);

/**
 * The style graph is local CSS and local font files, checked by the
 * source-level boundary test; this build stubs it so the module graph under
 * test is the JavaScript one.
 */
const stubStyles: Plugin = {
  name: "stub-styles",
  setup(builder) {
    builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "wb-css" }));
    builder.onLoad({ filter: /.*/, namespace: "wb-css" }, () => ({ contents: "" }));
  },
};

let metafile: Metafile;

beforeAll(async () => {
  const result = await build({
    entryPoints: [UI_ENTRY, ...HOST_ENTRIES],
    plugins: [stubStyles],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    outdir: "out",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  metafile = result.metafile;
});

function packageOf(path: string): string {
  const inside = path.split("node_modules/").at(-1) ?? "";
  const [first = "", second = ""] = inside.split("/");
  return first.startsWith("@") ? `${first}/${second}` : first;
}

/**
 * The bundle half of the boundary, scoped by importer: on the real module
 * graph, a file under workbench-ui/ imports only the UI itself, an
 * allow-listed package, or the engine entry. What the engine imports behind
 * its entry is the engine's business and is checked by its own boundary test.
 */
describe("workbench-ui bundle boundary", () => {
  it("bundles the UI and both host bootstraps, and reaches the engine entry", () => {
    const inputs = Object.keys(metafile.inputs);
    expect(inputs).toContain(UI_ENTRY);
    for (const entry of HOST_ENTRIES) expect(inputs).toContain(entry);
    expect(inputs).toContain(ENGINE_ENTRY);
  });

  it("lets UI files import only the UI, allow-listed packages and the engine entry", () => {
    const offenders = Object.entries(metafile.inputs)
      .filter(([importer]) => importer.startsWith("workbench-ui/"))
      .flatMap(([importer, input]) =>
        input.imports
          .filter((imported) => {
            if (imported.path.startsWith("workbench-ui/")) return false;
            if (imported.path.startsWith("wb-css:")) return false;
            if (imported.path.includes("node_modules/"))
              return !ALLOWED_PACKAGES.has(packageOf(imported.path));
            return imported.path !== ENGINE_ENTRY;
          })
          .map((imported) => `${importer} -> ${imported.path}`),
      );
    expect(offenders).toEqual([]);
  });

  it("imports no Node built-in anywhere in the page bundle", () => {
    const offenders = Object.entries(metafile.inputs).flatMap(([importer, input]) =>
      input.imports
        .filter((imported) => imported.external === true || imported.path.startsWith("node:"))
        .map((imported) => `${importer} -> ${imported.path}`),
    );
    expect(offenders).toEqual([]);
  });
});
