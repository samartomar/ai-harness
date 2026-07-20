import { existsSync } from "node:fs";
import { join } from "node:path";
import { readAihConfigDiagnostic } from "../../../config/marker.js";
import { detectOne } from "../../../internals/cli-detect.js";
import type { PlanContext } from "../../../internals/plan.js";
import { defaultRunner, type Runner } from "../../../internals/proc.js";
import type { Platform } from "../../../platform/base.js";
import { makeHostAdapter, resolvePlatform } from "../../../platform/detect.js";
import {
  CLAUDE_BOOTLOADER_PATH,
  CLAUDE_MCP_PATH,
  CLAUDE_OWNED_FILE_ROOTS,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_SETTINGS_PATH,
} from "./surfaces.js";

/**
 * Host + project-root detection for the Claude project-scope adapter. Reuses the
 * shared CLI-detection seam (`detectOne`) for the install signal and the marker
 * readers for project-root surface presence. Detection is a READ; it never writes,
 * shells out beyond the injected runner's PATH probe, or invokes the `claude` CLI
 * (that is W3b's scope).
 *
 * `root` is passed explicitly (the repo convention resolves cwd/`--root`/`AIH_ROOT`
 * upstream in `loadSettings`); this reports on the given root and does NOT walk up
 * to discover one.
 */
export interface ClaudeHostDetectDeps {
  /** Process env — home-dir resolution + PATH probe. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Local command runner seam (PATH probe). Defaults to the real runner. */
  run?: Runner;
  /** Host platform (selects `where` vs `which`). Defaults to `resolvePlatform(env)`. */
  platform?: Platform;
}

export interface ClaudeHostReport {
  /** Claude install signal: a `~/.claude` config dir and/or the `claude` binary on PATH. */
  install: { present: boolean; via?: "config" | "binary"; detail?: string };
  /** Project-root surface presence at `root`. */
  surfaces: {
    /** `.aih-config.json` marker present, and whether it carries a binding declaration. */
    marker: { present: boolean; hasBinding: boolean };
    /** `.claude/` directory present at the project root. */
    claudeDir: boolean;
    /** `CLAUDE.md` bootloader present at the project root. */
    bootloader: boolean;
  };
  /** Resolved repo-relative host surface paths (D4.3). */
  paths: {
    settings: string;
    settingsLocal: string;
    mcp: string;
    bootloader: string;
    ownedFileRoots: readonly string[];
  };
}

export async function detectClaudeHost(
  root: string,
  deps: ClaudeHostDetectDeps = {},
): Promise<ClaudeHostReport> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRunner;
  const platform = deps.platform ?? resolvePlatform(env);
  const host = makeHostAdapter({ platform, run, env });
  // A minimal context just for the shared install probe (env/host/run only).
  const ctx: PlanContext = {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host,
    env,
    options: {},
  };
  const presence = await detectOne(ctx, "claude");
  const diagnostic = readAihConfigDiagnostic(root);
  const markerPresent = diagnostic.present;
  const hasBinding =
    diagnostic.present && !diagnostic.invalid && diagnostic.config.binding !== undefined;

  return {
    install: { present: presence.present, via: presence.via, detail: presence.detail },
    surfaces: {
      marker: { present: markerPresent, hasBinding },
      claudeDir: existsSync(join(root, ".claude")),
      bootloader: existsSync(join(root, CLAUDE_BOOTLOADER_PATH)),
    },
    paths: {
      settings: CLAUDE_SETTINGS_PATH,
      settingsLocal: CLAUDE_SETTINGS_LOCAL_PATH,
      mcp: CLAUDE_MCP_PATH,
      bootloader: CLAUDE_BOOTLOADER_PATH,
      ownedFileRoots: CLAUDE_OWNED_FILE_ROOTS,
    },
  };
}
