/**
 * The engine boundary (Policy Workbench UI delivery): the engine entry bundles
 * for the browser with no Node built-ins, transitively. Checked on the real
 * bundle graph, not on import text.
 */
import { createContext, runInContext } from "node:vm";
import { build, type Metafile } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { tinyStudioModel } from "../studio-test-fixture.js";

const ENGINE_ENTRY = "src/org-policy/workbench/engine/index.ts";

/** Node-bound modules that must never be reachable from the engine at run time. */
const NODE_BOUND_SOURCES = [
  "src/org-policy/schema.ts",
  "src/org-policy/ui-server.ts",
  "src/org-policy/studio-model.ts",
  "src/internals/fsxn.ts",
  "src/internals/plan.ts",
  "src/internals/proc.ts",
  "src/internals/prompt.ts",
];

let metafile: Metafile;
let bundleText = "";

beforeAll(async () => {
  const result = await build({
    entryPoints: [ENGINE_ENTRY],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  metafile = result.metafile;
  bundleText = result.outputFiles[0]?.text ?? "";
});

describe("engine entry browser bundle", () => {
  it("builds for the browser", () => {
    expect(bundleText.length).toBeGreaterThan(0);
    expect(Object.keys(metafile.inputs)).toContain(ENGINE_ENTRY);
  });

  it("imports no Node built-in and leaves nothing external, transitively", () => {
    const offenders = Object.entries(metafile.inputs).flatMap(([importer, input]) =>
      input.imports
        .filter((imported) => imported.external === true || imported.path.startsWith("node:"))
        .map((imported) => `${importer} -> ${imported.path}`),
    );
    expect(offenders).toEqual([]);
    expect(Object.keys(metafile.inputs).filter((path) => path.startsWith("node:"))).toEqual([]);
  });

  it("reaches no Node-bound module of the repository", () => {
    const inputs = new Set(Object.keys(metafile.inputs));
    expect(NODE_BOUND_SOURCES.filter((path) => inputs.has(path))).toEqual([]);
  });

  it("bundles only zod from node_modules", () => {
    const packages = new Set(
      Object.keys(metafile.inputs)
        .filter((path) => path.includes("node_modules/"))
        .map((path) => (path.split("node_modules/").at(-1) ?? "").split("/")[0]),
    );
    expect([...packages]).toEqual(["zod"]);
  });

  /**
   * The offline file runs under `script-src` without `unsafe-eval`. A caught
   * capability probe still raises a policy violation there, so the engine must
   * never construct code from a string at all.
   */
  it("never constructs code from a string, not even as a capability probe", async () => {
    const result = await build({
      entryPoints: [ENGINE_ENTRY],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "aihEngine",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    // The platform globals the engine declares, and nothing else.
    const context = createContext({
      model: tinyStudioModel(),
      structuredClone,
      TextEncoder,
      URL,
    });
    const constructed = runInContext(
      [
        "const constructed = [];",
        "globalThis.Function = new Proxy(Function, {",
        "  construct(target, args) { constructed.push(args.join(',')); return Reflect.construct(target, args); },",
        "  apply(target, self, args) { constructed.push(args.join(',')); return Reflect.apply(target, self, args); },",
        "});",
        result.outputFiles[0]?.text ?? "",
        "const created = aihEngine.createAdminEngine(model);",
        "if (!created.ok) throw new Error(created.errors.join('; '));",
        "created.value.check();",
        "constructed;",
      ].join("\n"),
      context,
    ) as string[];
    expect([...constructed]).toEqual([]);
  });
});
