import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The framework plugins ship INSIDE @aihq/core (D71) and load only from their
 * built `dist` under Core's own package root
 * (src/framework-plugin/load-framework-plugin.ts, BUNDLED_FRAMEWORK_PLUGIN_DIRECTORIES).
 * A fresh checkout — CI or local — carries no plugin `dist` under packages/, and
 * the loader then refuses `framework-plugin-incompatible` on the ENOENT, which
 * skips the prune/uninstall grace path and reaches the hard throws (hosted CI
 * run 36167901002). Every entry point that runs the suite therefore builds the
 * bundled plugins first, with the same build the pack uses.
 *
 * The refusal gate itself is NOT relaxed here: a missing entry point in an
 * install stays `framework-plugin-incompatible`, pinned by
 * tests/framework-plugin/load-framework-plugin.test.ts.
 */

const root = process.cwd();
const workflowsDirectory = resolve(root, ".github", "workflows");
const PLUGIN_BUILD_SCRIPT = "build:framework-plugins";
const PLUGIN_BUILD_COMMAND = `npm run ${PLUGIN_BUILD_SCRIPT}`;
const PLUGIN_DIRECTORIES = ["packages/framework-ecc", "packages/framework-superpowers"] as const;

interface Step {
  name?: string;
  run?: string;
}

interface Job {
  steps?: Step[];
}

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** Scripts that run the suite: every `vitest run` script plus the selected-test runner. */
const SUITE_SCRIPTS = new Set<string>([
  ...Object.entries(pkg.scripts)
    .filter(([, command]) => /\bvitest run\b/u.test(command))
    .map(([name]) => name),
  // Spawns `node node_modules/vitest/vitest.mjs` from .github/scripts/run-selected-tests.mjs.
  "ci:run-selected",
]);

/** package.json scripts a workflow step invokes through npm. */
function npmScripts(run: string): string[] {
  return [...run.matchAll(/\bnpm run (?:--silent )?([A-Za-z0-9:_-]+)|\bnpm (test|start)\b/gu)].map(
    (match) => (match[1] ?? match[2]) as string,
  );
}

function runsSuite(run: string | undefined): boolean {
  if (run === undefined) return false;
  if (/\bvitest run\b/u.test(run)) return true;
  return npmScripts(run).some((name) => SUITE_SCRIPTS.has(name));
}

/** A step is covered when its job built the plugins earlier, or the script it runs has that prescript. */
function buildsPluginsFirst(step: Step, before: readonly Step[]): boolean {
  if (before.some((prior) => prior.run?.includes(PLUGIN_BUILD_COMMAND) === true)) return true;
  return npmScripts(step.run ?? "").some((name) =>
    (pkg.scripts[`pre${name}`] ?? "").includes(PLUGIN_BUILD_COMMAND),
  );
}

function workflowJobs(file: string): Record<string, Job> {
  const workflow = parse(readFileSync(resolve(workflowsDirectory, file), "utf8")) as {
    jobs?: Record<string, Job>;
  };
  return workflow.jobs ?? {};
}

describe("the bundled framework plugins are built before the suite runs", () => {
  it("keeps both plugin builds inside the build the pack uses", () => {
    for (const directory of PLUGIN_DIRECTORIES) {
      expect(pkg.scripts[PLUGIN_BUILD_SCRIPT], PLUGIN_BUILD_SCRIPT).toContain(
        `npm run build --prefix ${directory}`,
      );
      expect(pkg.scripts.build, "npm run build").toContain(`npm run build --prefix ${directory}`);
    }
  });

  it("builds the plugins from the local suite entry points, verify included", () => {
    for (const script of ["test", "test:cov"]) {
      expect(pkg.scripts[`pre${script}`], `pre${script}`).toContain(PLUGIN_BUILD_COMMAND);
    }
    // `npm run verify` reaches that build through the test:cov it already runs first.
    expect(pkg.scripts.verify).toContain("npm run test:cov");
  });

  it("builds the plugins before the first suite step of every ci.yml job that runs one", () => {
    const running = Object.entries(workflowJobs("ci.yml")).filter(([, job]) =>
      (job.steps ?? []).some((step) => runsSuite(step.run)),
    );
    expect(running.map(([name]) => name).sort()).toEqual([
      "full_verify",
      "quality",
      "selected_tests",
      "windows_full_tests",
    ]);
    for (const [name, job] of running) {
      const steps = job.steps ?? [];
      const builtAt = steps.findIndex((step) => step.run?.includes(PLUGIN_BUILD_COMMAND) === true);
      const suiteAt = steps.findIndex((step) => runsSuite(step.run));
      expect(builtAt, `${name} builds the bundled plugins`).toBeGreaterThanOrEqual(0);
      expect(
        builtAt,
        `${name} builds the bundled plugins before its first suite step`,
      ).toBeLessThan(suiteAt);
    }
  });

  it("builds the plugins before every suite step in every other workflow", () => {
    for (const file of readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/u.test(name))) {
      if (file === "ci.yml") continue;
      for (const [job, definition] of Object.entries(workflowJobs(file))) {
        const steps = definition.steps ?? [];
        steps.forEach((step, index) => {
          if (!runsSuite(step.run)) return;
          expect(buildsPluginsFirst(step, steps.slice(0, index)), `${file}#${job}`).toBe(true);
        });
      }
    }
  });
});
