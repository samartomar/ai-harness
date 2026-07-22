import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashComponentTree } from "../../../src/baseline-evidence/hash.js";
import type { HostLoadFacts } from "../../../src/binding/closure/profile-closure.js";
import {
  CLOSURE_CLASSIFIER_VERSION,
  type ClosureSeed,
  type ClosureSpec,
} from "../../../src/binding/closure/profile-closure.js";
import {
  applyGstackNamePatch,
  GSTACK_PIN_COMMIT,
  GSTACK_REPOSITORY,
  GSTACK_SELECTED_PROFILE,
  type GstackInstaller,
  type GstackInstallInput,
} from "../../../src/binding/frameworks/gstack.js";
import {
  type ResolvedGitSource,
  runFastScanGate,
  type ScanDisposition,
  type ScannableSource,
  W2_DEFAULT_INSPECTORS,
} from "../../../src/binding/scan-gate.js";
import type { BindingDeclaration } from "../../../src/binding/schema.js";
import { fakeRunner, type Runner, type RunResult } from "../../../src/internals/proc.js";

/**
 * Shared gstack contract-test fixtures: a small bland-ASCII tree shaped like
 * the pinned checkout (setup script, bin hook, browse subtree, two top-level
 * skills), REAL dispositions minted by the actual W2 fast-scan gate under the
 * gstack selected-profile closure, and a configurable fixture installer that
 * mimics the measured install surface (whole-tree copy + name patch + wrapper
 * dirs + root alias) without executing any upstream code.
 */

/** The measured R4 host facts (evidence: evidence-w5-spike/2b-r4-nested-loader.json). */
export const GSTACK_HOST_FACTS: HostLoadFacts = {
  hostVersion: "claude-code@2.1.217",
  registersNestedSkillMd: false,
  readsNonSkillSkillFiles: false,
  probeEvidence: "evidence-w5-spike/2b-r4-nested-loader.json (fixture mirror)",
};

/** Bland-ASCII gstack-shaped fixture tree. Derived inventory: gstack-qa,
 * gstack-ship, gstack, gstack-connect-chrome (4 identities). */
export const GSTACK_FIXTURE_FILES: Record<string, string> = {
  setup: "#!/usr/bin/env bash\necho gstack setup\n",
  "bin/gstack-settings-hook": "#!/usr/bin/env bash\necho settings hook\n",
  "browse/src/index.ts": "export const browse = true;\n",
  "qa/SKILL.md":
    "---\nname: qa\ndescription: run the qa checks\n---\n\nRun the project QA checks.\n",
  "ship/SKILL.md":
    "---\nname: ship\ndescription: ship the change\n---\n\nShip the change safely.\n",
};

/** Identities the fixture tree derives (kept in one place for assertions). */
export const GSTACK_FIXTURE_IDENTITIES = [
  "gstack-qa",
  "gstack-ship",
  "gstack",
  "gstack-connect-chrome",
] as const;

export function writeFileEnsuring(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/** Materialize a fixture tree under `<cacheHome>/<name>` and return its path. */
export function fixtureTree(
  cacheHome: string,
  name: string,
  files: Record<string, string> = GSTACK_FIXTURE_FILES,
): string {
  const dir = join(cacheHome, name);
  for (const [rel, contents] of Object.entries(files)) {
    writeFileEnsuring(join(dir, ...rel.split("/")), contents);
  }
  return dir;
}

/** The selected-profile seed set for a fixture tree (spike seeding, miniature). */
function buildSeeds(files: readonly string[]): ClosureSeed[] {
  const seeds: ClosureSeed[] = [];
  for (const path of files) {
    const segments = path.split("/");
    if (path === "setup" || segments[0] === "bin") {
      seeds.push({ path, reachability: "control" });
    } else if (segments[0] === "browse") {
      seeds.push({ path, reachability: "build-input" });
    } else if (segments.length === 2 && segments[1] === "SKILL.md") {
      seeds.push({ path, reachability: "model-loaded" });
    }
  }
  return seeds;
}

/** The gstack ruled-profile closure spec over a fixture file list. */
export function gstackClosureSpec(files: readonly string[]): ClosureSpec {
  return {
    profile: GSTACK_SELECTED_PROFILE,
    classifierVersion: CLOSURE_CLASSIFIER_VERSION,
    mode: "seeded",
    seeds: buildSeeds(files),
  };
}

/**
 * A REAL, non-forged, brand-protected disposition minted by the actual W2
 * fast-scan gate over an on-disk fixture tree, classified under the gstack
 * selected-profile closure (so `closure.profile` carries the ruled profile).
 * Pass `closureSpec: null` for a legacy full-tree disposition (no closure), or
 * a custom spec for profile-mismatch scenarios.
 */
export function scannedGstackFixture(
  cacheHome: string,
  name: string,
  opts: {
    files?: Record<string, string>;
    closureSpec?: ClosureSpec | null;
  } = {},
): { resolved: ResolvedGitSource; disposition: ScanDisposition } {
  const dir = fixtureTree(cacheHome, name, opts.files ?? GSTACK_FIXTURE_FILES);
  const topLevel = readdirSync(dir)
    .filter((entry) => entry !== ".git")
    .sort();
  const hashed = hashComponentTree(dir, topLevel);
  const identityFiles = hashed.files.map((file) => file.path);
  const source: ScannableSource = {
    digest: hashed.treeSha256,
    treePath: dir,
    identityFiles,
  };
  const closureSpec =
    opts.closureSpec === null ? undefined : (opts.closureSpec ?? gstackClosureSpec(identityFiles));
  const disposition = runFastScanGate(
    source,
    {
      posture: "enterprise",
      ...(closureSpec === undefined ? {} : { closureSpec, hostFacts: GSTACK_HOST_FACTS }),
    },
    { cacheHome, inspectors: W2_DEFAULT_INSPECTORS },
  );
  return {
    resolved: {
      kind: "git",
      repository: GSTACK_REPOSITORY,
      commitSha: GSTACK_PIN_COMMIT,
      treeDigest: hashed.treeSha256,
      treePath: dir,
      files: identityFiles,
    },
    disposition,
  };
}

export function declarationFor(
  treeDigest: string,
  features?: Record<string, boolean>,
): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: {
      id: "gstack",
      host: "claude",
      ...(features === undefined ? {} : { features }),
    },
    source: {
      kind: "git",
      repository: GSTACK_REPOSITORY,
      commitSha: GSTACK_PIN_COMMIT,
      treeDigest,
    },
  };
}

/** A fake Runner that answers the readiness probes and records every argv. */
export function recordingRunner(script?: (argv: string[]) => Partial<RunResult> | undefined): {
  runner: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner = fakeRunner((argv) => {
    calls.push(argv);
    const scripted = script?.(argv);
    if (scripted !== undefined) return scripted;
    if (argv[0] === "bun") return { code: 0, stdout: "1.3.14\n" };
    if (argv[0] === "node") return { code: 0, stdout: "v24.18.0\n" };
    return undefined;
  });
  return { runner, calls };
}

function fixtureFrontmatterName(content: string): string {
  const match = /^name:[ \t]*([^\r\n]+)$/m.exec(content);
  if (match?.[1] === undefined) throw new Error("fixture SKILL.md has no frontmatter name");
  return match[1].trim();
}

export interface FixtureInstallerOptions {
  /** Create the conditional back-compat alias dir (default false — the measured
   * real-install default). */
  includeConditional?: boolean;
  /** Create one extra wrapper dir carrying this identity (reconciliation must refuse). */
  extraIdentity?: string;
  /** Skip creating this wrapper identity (a non-conditional gap must refuse). */
  omitIdentity?: string;
  /** Materialize install-surface junk (node_modules, build outputs, .git). */
  junk?: boolean;
  /** Mutate the install root after the faithful copy (D7 tamper scenarios). */
  tamperInstallRoot?: (installRootAbs: string) => void;
  /** Incorrectly name-patch the install-root whole-tree copy (real setup leaves
   * it RAW — patch-names runs on the source after the copy). Induces a genuine
   * D7 mismatch on the top-level SKILL.md files. */
  patchInstallRoot?: boolean;
}

/**
 * A fixture installer replicating the measured install surface: a verbatim
 * whole-tree copy into `~/.claude/skills/gstack` (RAW — the real setup copies
 * before patch-names runs on the source), one wrapper dir per top-level skill
 * (PATCHED SKILL.md), the `_gstack-command` root alias (frontmatter
 * `name: gstack`), and optional junk/aliases/deviations. Executes NO upstream
 * code.
 */
export function fixtureInstaller(opts: FixtureInstallerOptions = {}): {
  installer: GstackInstaller;
  calls: GstackInstallInput[];
} {
  const calls: GstackInstallInput[] = [];
  const installer: GstackInstaller = async (input) => {
    calls.push(input);
    const { resolved, home } = input;
    const skillsDir = join(home, ".claude", "skills");
    const installRoot = join(skillsDir, "gstack");
    for (const rel of resolved.files ?? []) {
      const raw = readFileSync(join(resolved.treePath, ...rel.split("/")), "utf8");
      const segments = rel.split("/");
      const eligible = segments.length === 2 && segments[1] === "SKILL.md";
      // The install-root whole-tree copy is RAW in reality (patch-names runs on
      // the source AFTER this copy). patchInstallRoot forces the WRONG,
      // mismatch-inducing behavior for the D7 negative test.
      const out = eligible && opts.patchInstallRoot === true ? applyGstackNamePatch(raw) : raw;
      writeFileEnsuring(join(installRoot, ...segments), out);
    }
    if (opts.junk === true) {
      writeFileEnsuring(
        join(installRoot, "node_modules", "left-pad", "index.js"),
        "module.exports = (s) => s;\n",
      );
      writeFileEnsuring(join(installRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileEnsuring(join(installRoot, "browse", "dist", "browse.js"), "// built output\n");
    }
    for (const rel of resolved.files ?? []) {
      const segments = rel.split("/");
      if (segments.length !== 2 || segments[1] !== "SKILL.md") continue;
      const patched = applyGstackNamePatch(
        readFileSync(join(resolved.treePath, ...segments), "utf8"),
      );
      const identity = fixtureFrontmatterName(patched);
      if (identity === opts.omitIdentity) continue;
      writeFileEnsuring(join(skillsDir, identity, "SKILL.md"), patched);
    }
    writeFileEnsuring(
      join(skillsDir, "_gstack-command", "SKILL.md"),
      "---\nname: gstack\ndescription: gstack root command\n---\n\ngstack root alias.\n",
    );
    if (opts.includeConditional === true) {
      writeFileEnsuring(
        join(skillsDir, "gstack-connect-chrome", "SKILL.md"),
        "---\nname: gstack-connect-chrome\ndescription: legacy chrome alias\n---\n\nLegacy alias.\n",
      );
    }
    if (opts.extraIdentity !== undefined) {
      writeFileEnsuring(
        join(skillsDir, opts.extraIdentity, "SKILL.md"),
        `---\nname: ${opts.extraIdentity}\ndescription: extra wrapper\n---\n\nExtra wrapper.\n`,
      );
    }
    opts.tamperInstallRoot?.(installRoot);
    return { exitCode: 0, stdout: "installed\n", stderr: "" };
  };
  return { installer, calls };
}
