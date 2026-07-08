import { basename, posix, resolve } from "node:path";
import { AIH_CONFIG_FILE, aihConfigJson, readAihConfig } from "../config/marker.js";
import { SettingsError } from "../errors.js";
import {
  type Action,
  type CommandSpec,
  digest,
  type PlanContext,
  plan,
  probe,
  writeJson,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { gitCommittedSet } from "../internals/scan-allowlist.js";
import type { Check } from "../internals/verify.js";
import { adoptApplyActions } from "./apply.js";
import {
  type BootloaderState,
  type CanonClassification,
  classifyCanon,
  isAdoptable,
} from "./classify.js";
import { type CliArtifact, type CliFootprint, cliFootprint } from "./cli-footprint.js";
import { migrateCliActions, migrateSkips } from "./migrate-cli.js";

/** Per-bootloader op label for the migration preview (Phase 1: analysis only). */
function bootloaderLine(b: BootloaderState): string {
  if (b.hasMarker && b.bodyMatches) {
    return `  [keep]   ${b.path} — managed block already current`;
  }
  if (b.hasMarker) {
    const ext =
      b.preservedLines > 0
        ? `~${b.preservedLines} project line(s) preserved → rules/project-canon-extension.md`
        : "no project lines to preserve";
    return `  [adopt]  ${b.path} — managed block diverges; ${ext}`;
  }
  return `  [insert] ${b.path} — no managed block; aih block will be inserted (hand-edits preserved)`;
}

/**
 * Human-readable migration preview built purely from the read-only
 * classification. Phase 1 reports intent (`[adopt]`/`[keep]`/`[insert]`/`[retire]`)
 * — it never writes. The `[adopt]`/carve mechanics land in Phase 2.
 */
function migrationReport(cls: CanonClassification, repo: string, contextDir: string): string {
  if (cls.kind === "greenfield") {
    return lines(
      `Adopt analysis for ${repo} — class: greenfield.`,
      "",
      `No adoptable canon under \`${contextDir}\`. Run \`aih init\` (or \`aih bootstrap-ai\`)`,
      "to create the managed canon from scratch.",
    );
  }
  if (cls.kind === "already-adopted") {
    return lines(
      `Adopt analysis for ${repo} — class: already-adopted.`,
      "",
      "Canon is already on aih's managed model — nothing to adopt.",
      "`aih bootstrap-ai --verify` is the ongoing drift gate.",
    );
  }

  const carve =
    cls.kind === "marker-divergent"
      ? "carves your project-specific lines into `rules/project-canon-extension.md` (preserved, never regenerated), then regenerates the aih-owned canon and the clean managed block"
      : "inserts the managed canonical block into each bootloader (your existing content is kept as the preamble) and writes the aih-owned canon";
  const body: string[] = [
    `Adopt analysis for ${repo} — class: ${cls.kind}.`,
    "",
    `Existing canon detected. \`aih adopt --apply\` converges it onto aih's managed`,
    `model WITHOUT overwriting your work: it ${carve}, backing every changed file up`,
    "to `*.aih.bak`. The file-level plan is below; nothing is written without `--apply`.",
    "",
    "Bootloaders:",
    ...cls.bootloaders.map(bootloaderLine),
  ];
  body.push(
    "",
    "Canon:",
    `  ${cls.routerPresent ? "[converge]" : "[create]"} ${contextDir}/RULE_ROUTER.md — ${cls.routerPresent ? "present; regenerated, project extension re-referenced" : "missing; will be created"}`,
  );
  if (cls.legacyArtifacts.length > 0) {
    body.push(
      "",
      "Legacy you can retire once converged (aih leaves these untouched — remove when ready):",
      ...cls.legacyArtifacts.map((p) => `  [legacy] ${p} — superseded by the managed canon`),
    );
  }
  body.push(
    "",
    "After `--apply`, `aih bootstrap-ai --verify` must report every bootloader in sync.",
  );
  return lines(...body);
}

/** Disposition → panel tag (§13.6). Only `[import]` is a candidate. */
const DISPOSITION_TAG: Record<CliArtifact["disposition"], string> = {
  wired: "[wired]",
  personal: "[personal]",
  kept: "[kept]",
  import: "[import]",
  runtime: "[runtime]",
};

/** One CLI-native artifact line for the footprint panel. */
function footprintLine(a: CliArtifact): string {
  return `  ${DISPOSITION_TAG[a.disposition]} ${a.path} — ${a.detail}`;
}

/**
 * The CLI-native footprint panel (§13). Read-only: aih reports what each tool
 * keeps at its own location and will NOT modify any of it. The team-pollution
 * guard (§13.6) means only committed, un-acknowledged tool-owned content counts as
 * an import candidate — `[personal]` (uncommitted) and `[kept]` (acknowledged) are
 * shown but never nagged, so re-runs don't loop.
 */
function footprintReport(fp: CliFootprint): string {
  if (fp.artifacts.length === 0) {
    return lines("CLI-native footprint:", "  none detected.");
  }
  const personal = fp.artifacts.filter((a) => a.disposition === "personal").length;
  const kept = fp.artifacts.filter((a) => a.disposition === "kept").length;
  const body = [
    "CLI-native footprint (aih will NOT modify these):",
    ...fp.artifacts.map(footprintLine),
  ];
  if (fp.importCandidates > 0) {
    body.push(
      "",
      `${fp.importCandidates} import candidate(s) — committed, shared, not yet in the canon.`,
      "Full migration is OPT-IN (`--migrate-cli`, content-verified) and agent-guided via",
      "`SETUP-TASKS.md`; until then these files are left exactly as they are.",
    );
  } else {
    body.push("", "No import candidates — nothing committed+shared awaits the canon.");
  }
  if (personal > 0 || kept > 0) {
    const notes: string[] = [];
    if (personal > 0)
      notes.push(`${personal} personal (uncommitted — a developer's own, left silent)`);
    if (kept > 0) notes.push(`${kept} kept (team-acknowledged as intentionally tool-native)`);
    body.push(`Not counted: ${notes.join("; ")}.`);
  }
  return lines(...body);
}

/**
 * Verify/JSON/support routing for the CLI-native scan: tool-owned content not yet
 * folded into the canon surfaces as a `skip` carrying `canon.cli-native-unmigrated`
 * (advisory — never a hard fail), so the user is told it exists without aih touching it.
 */
function cliNativeProbe(fp: CliFootprint): Check {
  const name = "cli-native-footprint";
  if (fp.importCandidates > 0) {
    return {
      name,
      verdict: "skip",
      detail: `${fp.importCandidates} tool-native artifact(s) hold content not in the canon — aih won't modify them; run \`aih adopt\` for the migration map`,
      code: "canon.cli-native-unmigrated",
    };
  }
  return { name, verdict: "pass", detail: "no un-migrated CLI-native content" };
}

/**
 * Verify/JSON/support routing for the analysis: a brownfield canon not yet on the
 * managed model surfaces as a `skip` carrying `canon.adoptable` (advisory — never a
 * hard fail), so `--json`/`--support-out` can route it like every other finding.
 */
function adoptableProbe(cls: CanonClassification): Check {
  const name = "adoptable-canon";
  if (isAdoptable(cls.kind) && !cls.configPresent) {
    return {
      name,
      verdict: "skip",
      detail: `existing AI canon detected (${cls.kind}) — run \`aih adopt\` to converge it onto the managed model`,
      code: "canon.adoptable",
    };
  }
  if (cls.kind === "already-adopted") {
    return { name, verdict: "pass", detail: "canon already on the managed model" };
  }
  return { name, verdict: "pass", detail: "no foreign canon to adopt" };
}

function normalizeAckPath(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/");
  if (value.length === 0) throw new SettingsError("--ack path must not be empty");
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new SettingsError("--ack path must be a single safe path");
  if (/^[A-Za-z]:($|\/)/.test(value)) throw new SettingsError("--ack path must be repo-relative");
  const normalized = posix.normalize(value).replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new SettingsError("--ack path must be a repo-relative CLI-native artifact path");
  }
  return normalized;
}

/** Parse a comma/space-separated option value into normalized, unique paths. */
function parseAckList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const out: string[] = [];
  for (const part of value.split(/[,\s]+/)) {
    if (part.trim().length === 0) continue;
    const normalized = normalizeAckPath(part);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function normalizeStoredAckPaths(paths: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const path of paths) {
    try {
      const normalized = normalizeAckPath(path);
      if (!out.includes(normalized)) out.push(normalized);
    } catch {
      // Ignore legacy malformed config values; new --ack input is validated below.
    }
  }
  return out;
}

function validateAckPaths(paths: readonly string[], fp: CliFootprint): void {
  if (paths.length === 0) return;
  const known = new Set(fp.artifacts.map((a) => a.path));
  const unknown = paths.filter((p) => !known.has(p));
  if (unknown.length === 0) return;
  const expected = [...known].sort();
  const suffix = expected.length > 0 ? ` Expected one of: ${expected.join(", ")}.` : "";
  throw new SettingsError(
    `--ack path is not a detected CLI-native artifact: ${unknown.join(", ")}.${suffix}`,
  );
}

/** Digest note for `--migrate-cli`: what folds into the canon, what is left. */
function migrateReport(fp: CliFootprint, contextDir: string): string {
  const skipped = new Set(migrateSkips(fp));
  const importing = fp.artifacts
    .filter((a) => a.disposition === "import" && !skipped.has(a.path))
    .map((a) => a.path);
  if (importing.length === 0 && skipped.size === 0) {
    return lines("--migrate-cli: no import candidates to migrate.");
  }
  const body =
    importing.length > 0
      ? [
          "--migrate-cli (opt-in): folding committed tool-native content INTO the canon —",
          "rule files become thin pointers (backed up to *.aih.bak); content dirs are copied",
          "and the originals left for you to retire. Run with `--apply` to perform it.",
          ...importing.map((p) => `  [migrate] ${p} → ${contextDir}/`),
        ]
      : ["--migrate-cli: no migratable import candidates to migrate."];
  if (skipped.size > 0) {
    body.push(
      `Left untouched (review manually): ${[...skipped].join(", ")} — memory stays yours; tool config isn't canon.`,
    );
  }
  return lines(...body);
}

/**
 * `aih adopt` — converge a repo's EXISTING AI canon onto aih's managed model
 * instead of bulldozing it (the brownfield path `init`/`bootstrap-ai` lack).
 *
 * It classifies the canon ({@link classifyCanon}) + inventories the CLI-native
 * footprint ({@link cliFootprint}), prints the migration as a digest, and — for a
 * brownfield canon — emits the convergence writes ({@link adoptApplyActions}):
 * carve the human extension out of a divergent bootloader into a preserved
 * user-owned file, regenerate the aih-owned canon, merge the clean block, persist
 * the marker. Dry-run by default; the writes execute only under `--apply` (with
 * `.aih.bak` backups). Greenfield → `init`; already-adopted → no-op.
 */
async function adoptPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  // The committed marker is authoritative for which context dir to inspect — same
  // precedence `doctor` uses, so adopt and doctor never disagree on the dir.
  const cfg = readAihConfig(ctx.root);
  const contextDir = cfg?.contextDir ?? ctx.contextDir;
  // Resolve before basename so a `.`/relative root still names the repo dir.
  const repo = basename(resolve(ctx.root)) || "this repo";
  const cls = classifyCanon(ctx.root, contextDir);
  // Team-pollution guard (§13.6): committed = the "shared" signal; acknowledged =
  // the team's committed decisions. Both read-only — uncommitted/personal and
  // acknowledged content is shown but never counted, so re-runs don't nag-loop.
  const committed = await gitCommittedSet(ctx);
  // `--ack <paths>` adds to the committed acknowledge list (§13.6). Fold the new
  // paths into the set used for THIS run's footprint too, so the digest immediately
  // shows them as `[kept]` rather than `[import]`.
  const ackPaths = parseAckList(ctx.options.ack);
  const storedAckPaths = normalizeStoredAckPaths(cfg?.adopt?.acknowledged ?? []);
  const acknowledged = new Set([...storedAckPaths, ...ackPaths]);
  const fp = cliFootprint(ctx.root, contextDir, { committed, acknowledged });
  validateAckPaths(ackPaths, fp);

  const migrateCli = ctx.options.migrateCli === true;
  let text = `${migrationReport(cls, repo, contextDir)}\n\n${footprintReport(fp)}`;
  if (migrateCli) text += `\n\n${migrateReport(fp, contextDir)}`;
  if (ackPaths.length > 0)
    text += `\n\nAcknowledged (now [kept], not flagged): ${ackPaths.join(", ")}.`;

  const actions: Action[] = [
    digest("adopt: canon migration analysis", text, { canon: cls, cliFootprint: fp }),
    probe("adoptable canon", () => adoptableProbe(cls)),
    probe("cli-native footprint", () => cliNativeProbe(fp)),
  ];

  // Phase 2: a brownfield canon gets the real convergence writes (carve + regenerate
  // + marker), shown in the plan and executed only under `--apply`. Greenfield and
  // already-adopted stay write-free — `init` owns greenfield; a converged repo is a no-op.
  if (cls.kind === "marker-divergent" || cls.kind === "foreign-scheme") {
    actions.push(...(await adoptApplyActions(ctx, cls, contextDir)));
  }

  // §13.6 opt-in: fold committed CLI-native content INTO the canon (additive copy +
  // pointer-convert single rule files; dirs/memory left). Tool-native writes happen
  // ONLY here, only under this explicit flag.
  if (migrateCli) actions.push(...migrateCliActions(ctx.root, fp, contextDir));

  // `--ack` records the team decision in the committed marker (merge-write unions
  // the acknowledged array), so future runs stop flagging those paths.
  if (ackPaths.length > 0) {
    actions.push(
      writeJson(
        AIH_CONFIG_FILE,
        { ...aihConfigJson(contextDir, cfg?.targets ?? []), adopt: { acknowledged: ackPaths } },
        `acknowledge ${ackPaths.length} CLI-native path(s) as intentionally tool-native`,
        { merge: true },
      ),
    );
  }

  return plan("adopt", ...actions);
}

export const command: CommandSpec = {
  name: "adopt",
  summary:
    "Converge an existing AI canon onto aih's managed model without overwriting your work (brownfield migration)",
  options: [
    {
      flags: "--migrate-cli",
      description:
        "opt-in: fold committed CLI-native content into the canon (copy + pointer-convert rule files; content-verified, backed up)",
    },
    {
      flags: "--ack <paths>",
      description:
        "mark CLI-native path(s) (comma-separated) as intentionally tool-native so adopt stops flagging them",
    },
  ],
  plan: adoptPlan,
};
