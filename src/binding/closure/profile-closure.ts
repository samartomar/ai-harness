import { posix } from "node:path";
import { canonicalJson, sha256Hex } from "../hosts/claude/surfaces.js";

/**
 * Selected-profile closure classifier (W5 a2). The fast-scan gate scans the WHOLE
 * hashed source tree; this module computes, orthogonally, the transitive set of
 * files a SELECTED install/runtime profile actually executes, sources, imports,
 * builds, or model-loads — so a finding in a file the profile never runs can be
 * reported without gating (the "materialized but proven inert" bucket), while a
 * finding in the executed/loaded closure (or one whose reachability we cannot
 * prove) still blocks.
 *
 * The classifier is PURE and host-fact-injected: it takes a flat file list + a
 * text reader (so the gate can back it with a scan inventory and tests can back
 * it with an in-memory map) and a {@link ClosureSpec} naming the profile's entry
 * points. It never reads the disk itself and never executes upstream code.
 *
 * Fail-closed by construction: an unresolved reference (dynamic path, non-literal
 * import) becomes an `unknown` node (blocking); an ABSENT host fact makes every
 * still-inert file `unknown` (blocking), because we cannot then prove the host
 * ignores the repo-shaped skills copy.
 */

// -- Reachability lattice ----------------------------------------------------

/**
 * How a profile reaches a file. `control` (executed/sourced/hooked),
 * `build-input` (compiled/bundled into a runtime artifact), and `model-loaded`
 * (a skill body/section the host reads into the model) are the three BLOCKING
 * "in-closure" kinds. `unknown` is blocking too — a reference we could not prove
 * inert. `materialized` is on disk but reached by none of the above → inert.
 */
export type Reachability = "control" | "build-input" | "model-loaded" | "materialized" | "unknown";

/** The three blocking kinds a seed or a resolved edge can carry. */
export type BlockingReachability = "control" | "build-input" | "model-loaded";

/**
 * The classification the gate acts on. `closure` = blocking (control/build-input/
 * model-loaded/unknown roll up here); `materialized-inert` = reported, non-blocking;
 * `non-materialized` = the profile does not even place the file on disk (report-only).
 */
export type FindingClassification = "closure" | "materialized-inert" | "non-materialized";

/** Blocking-vs-inert ordering used when two edges reach one file (higher wins). */
const RANK: Record<Reachability, number> = {
  control: 4,
  "build-input": 3,
  "model-loaded": 2,
  unknown: 1,
  materialized: 0,
};

/** A reachability is blocking iff it outranks plain `materialized`. */
function isBlocking(reachability: Reachability): boolean {
  return RANK[reachability] >= RANK.unknown;
}

// -- Host load facts (the injected model-load axis) --------------------------

/**
 * Measured facts about the HOST's skill loader that the tree alone cannot reveal.
 *
 * These bind to a specific host: `hostVersion` is folded into the closure's
 * `hostFactsDigest`, so a disposition classified under one host tuple is NOT
 * valid for another — re-probe on a host change.
 *
 * Adjacency semantics (orchestrator-pinned): `readsNonSkillSkillFiles` refers
 * ONLY to files adjacent to REGISTERED wrapper skills (their `sections/` and the
 * paths a SKILL.md body references) — which the profile's seeds already classify
 * `model-loaded` via reference extraction regardless of this flag. It NEVER
 * refers to the repo-shaped skills copy as a whole. Consequently, when
 * `registersNestedSkillMd` is false, a false/unmeasured `readsNonSkillSkillFiles`
 * does NOT expand nested repo-copy files to `unknown`: the model-read channel
 * into the copy is covered by extraction from model-loaded surfaces instead.
 * Only an ENTIRELY absent host fact (undefined) makes nested files `unknown`.
 */
export interface HostLoadFacts {
  /** The host tuple these facts were probed on, e.g. "claude-code@2.1.214". */
  hostVersion: string;
  /** Does the host register a SKILL.md nested inside a skills subtree (the repo-shaped copy)? */
  registersNestedSkillMd: boolean;
  /** Does the host read non-SKILL files ADJACENT to a registered wrapper skill (see doc note)? */
  readsNonSkillSkillFiles: boolean;
  /** Provenance: the probe evidence establishing the fact (audit only). */
  probeEvidence: string;
}

// -- Closure spec + input ----------------------------------------------------

/** One entry-point seed: a present file the profile reaches directly. */
export interface ClosureSeed {
  path: string;
  reachability: BlockingReachability;
}

/**
 * The profile's closure model. `mode: "full-tree"` classifies EVERY materialized
 * file as `control` (the W4 back-compat model: full-tree closure ⇒ the gate
 * reduces to "any ≥high blocks", exactly the pre-a2 behavior). `mode: "seeded"`
 * runs the transitive fixpoint from `seeds`.
 */
export interface ClosureSpec {
  /** Stable profile id, e.g. "claude:prefix:quiet:no-plan-tune-hooks". Part of closure identity. */
  profile: string;
  /** Extraction ruleset version; bump on any rule change (participates in the closure digest). */
  classifierVersion: number;
  mode: "full-tree" | "seeded";
  /** Entry points for `mode: "seeded"`; ignored for `mode: "full-tree"`. */
  seeds?: readonly ClosureSeed[];
  /**
   * Whether the profile materializes a given file (default: all present files).
   * A present file the profile does NOT materialize classifies `non-materialized`
   * (report-only) — nearly empty for whole-checkout-copy profiles.
   */
  materializes?: (path: string) => boolean;
}

/** The file universe + a text reader; injected so the classifier stays pure. */
export interface ClosureInput {
  /** All present file paths (source-relative POSIX), typically the scan inventory. */
  files: readonly string[];
  /** Read a file's UTF-8 text, or undefined if unreadable. */
  readText: (path: string) => string | undefined;
}

/** The current classifier ruleset version. Bump on any extraction-rule change. */
export const CLOSURE_CLASSIFIER_VERSION = 1;

/** The reserved profile id for the W4 full-tree closure. */
export const FULL_TREE_PROFILE = "full-tree";

/** The W4 back-compat spec: every materialized file is `control` (no fixpoint). */
export function fullTreeClosureSpec(): ClosureSpec {
  return {
    profile: FULL_TREE_PROFILE,
    classifierVersion: CLOSURE_CLASSIFIER_VERSION,
    mode: "full-tree",
  };
}

// -- Closure output ----------------------------------------------------------

/** One classified file. `reachedBy` records the seed/edge provenance (audit). */
export interface ClosureNode {
  path: string;
  reachability: Reachability;
  materialized: boolean;
  reachedBy: readonly string[];
}

export interface ProfileClosure {
  spec: ClosureSpec;
  /** Exactly one node per present file. */
  nodes: ReadonlyMap<string, ClosureNode>;
  /** Bare/out-of-tree references (e.g. node_modules specifiers) — recorded, non-blocking. */
  danglingRefs: readonly string[];
  /** Fully-dynamic references that widened nothing — disclosed, non-gating on their own. */
  unresolvedRefs: readonly string[];
  /** sha256 of (profile + classifierVersion + mode + hostVersion + sorted node classification). */
  closureDigest: string;
  /** sha256 of the host facts, or "absent". Binds a disposition to its host tuple. */
  hostFactsDigest: string;
}

// -- Mutable working node ----------------------------------------------------

interface MutableNode {
  path: string;
  reachability: Reachability;
  materialized: boolean;
  reachedBy: string[];
}

// -- Reference extraction ----------------------------------------------------

interface Ref {
  /** A resolved present-file target (inherits the referrer's blocking reachability). */
  target?: string;
  /** A directory prefix to conservatively widen to `unknown` (from `<dir>/$dynamic`). */
  dirPrefix?: string;
  /** The raw unresolved expression, for disclosure. */
  unresolvedRaw?: string;
  /** A bare/out-of-tree specifier (node_modules) — dangling, non-blocking. */
  dangling?: string;
}

type FileClass = "bash" | "tsjs" | "skill" | "markdown" | "packagejson" | "other";

function fileClassOf(path: string, firstLine: string): FileClass {
  const base = path.split("/").at(-1) ?? "";
  if (base === "package.json") return "packagejson";
  if (base === "SKILL.md") return "skill";
  const lower = base.toLowerCase();
  if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(lower)) return "tsjs";
  if (/\.sh$/.test(lower)) return "bash";
  if (/\.md$/.test(lower)) return "markdown";
  if (!base.includes(".") && /^#!.*\b(?:bash|sh|zsh)\b/.test(firstLine)) return "bash";
  return "other";
}

function stripQuotes(token: string): string {
  return token.replace(/^["'`]+/, "").replace(/["'`;|&)]+$/, "");
}

/** For a `$`-bearing token, the literal directory prefix before the first `$`, if any. */
function dynamicDirPrefix(token: string): string | undefined {
  const dollar = token.indexOf("$");
  if (dollar < 0) return undefined;
  const literal = token.slice(0, dollar);
  const lastSlash = literal.lastIndexOf("/");
  return lastSlash >= 0 ? literal.slice(0, lastSlash + 1) : undefined;
}

/** Resolve a shell/markdown path token to a present file, trying repo-relative and referrer-relative. */
function resolvePathToken(
  referrerDir: string,
  token: string,
  present: ReadonlySet<string>,
): string | undefined {
  const rel = token.startsWith("./") || token.startsWith("../");
  const candidates = rel
    ? [posix.normalize(posix.join(referrerDir, token))]
    : [posix.normalize(token), posix.normalize(posix.join(referrerDir, token))];
  return candidates.find((candidate) => present.has(candidate));
}

/** Resolve a TS/JS module specifier to a present file, trying extension + index candidates. */
function resolveModuleSpecifier(
  referrerDir: string,
  specifier: string,
  present: ReadonlySet<string>,
): string | undefined {
  const base = specifier.startsWith(".")
    ? posix.normalize(posix.join(referrerDir, specifier))
    : posix.normalize(specifier);
  const candidates = [base];
  for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]) {
    candidates.push(`${base}${ext}`);
  }
  // A `.js` import in TS source commonly resolves to a `.ts` sibling.
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.mts`);
  for (const index of ["/index.ts", "/index.js", "/index.mts"]) candidates.push(`${base}${index}`);
  return candidates.find((candidate) => present.has(candidate));
}

function analyzeToken(
  referrerDir: string,
  rawToken: string,
  present: ReadonlySet<string>,
): Ref | undefined {
  const token = stripQuotes(rawToken);
  if (token.length === 0) return undefined;
  if (token.includes("$")) {
    const dirPrefix = dynamicDirPrefix(token);
    return dirPrefix !== undefined ? { dirPrefix, unresolvedRaw: token } : { unresolvedRaw: token };
  }
  const resolved = resolvePathToken(referrerDir, token, present);
  if (resolved !== undefined) return { target: resolved };
  // A repo-relative-looking miss is dangling; a bare command word is ignored.
  return token.includes("/") ? { dangling: token } : undefined;
}

const BASH_INCLUDE = /^[ \t]*(?:source|\.)[ \t]+(\S+)/gm;
const BASH_EXEC = /\bexec[ \t]+(\S+)/g;
const BASH_PATH_LITERAL =
  /(?:^|[\s"'`(=:])((?:\.{1,2}\/|(?:bin|lib|hosts|browse|scripts|plugins|sections|agents)\/)[^\s"'`);|&]+)/g;

function extractBash(referrerDir: string, text: string, present: ReadonlySet<string>): Ref[] {
  const refs: Ref[] = [];
  for (const pattern of [BASH_INCLUDE, BASH_EXEC, BASH_PATH_LITERAL]) {
    for (const match of text.matchAll(pattern)) {
      const token = match[1];
      if (token === undefined) continue;
      const ref = analyzeToken(referrerDir, token, present);
      if (ref !== undefined) refs.push(ref);
    }
  }
  return refs;
}

const JS_IMPORT_FROM = /\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g;
const JS_EXPORT_FROM = /\bexport\s+[\w*{}\s,]+\s+from\s+["']([^"']+)["']/g;
const JS_REQUIRE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const JS_DYNAMIC_IMPORT = /\bimport\(\s*([^)]*)\)/g;

function extractTsJs(referrerDir: string, text: string, present: ReadonlySet<string>): Ref[] {
  const refs: Ref[] = [];
  for (const pattern of [JS_IMPORT_FROM, JS_EXPORT_FROM, JS_REQUIRE]) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        refs.push({ dangling: specifier });
        continue;
      }
      const resolved = resolveModuleSpecifier(referrerDir, specifier, present);
      refs.push(resolved !== undefined ? { target: resolved } : { dangling: specifier });
    }
  }
  for (const match of text.matchAll(JS_DYNAMIC_IMPORT)) {
    const arg = (match[1] ?? "").trim();
    if (arg.length > 0 && !/^["'][^"']*["']$/.test(arg))
      refs.push({ unresolvedRaw: `import(${arg})` });
  }
  return refs;
}

const MD_BACKTICK = /`([^`]+)`/g;
const MD_LINK = /\]\(([^)\s]+)\)/g;
const MD_PATH_MENTION =
  /(?:^|[\s(])((?:\.{1,2}\/|(?:sections|scripts|bin|hosts|agents)\/)[A-Za-z0-9._/-]+)/g;

function extractSkill(referrerDir: string, text: string, present: ReadonlySet<string>): Ref[] {
  const refs: Ref[] = [];
  const consider = (raw: string): void => {
    const token = stripQuotes(raw.trim().split(/\s+/)[0] ?? "");
    if (!token.includes("/")) return; // bare word (a slash-command or system binary) is not a path ref
    const ref = analyzeToken(referrerDir, token, present);
    if (ref !== undefined) refs.push(ref);
  };
  for (const pattern of [MD_BACKTICK, MD_LINK, MD_PATH_MENTION]) {
    for (const match of text.matchAll(pattern)) {
      const captured = match[1];
      if (captured !== undefined) consider(captured);
    }
  }
  return refs;
}

function extractPackageJson(
  referrerDir: string,
  text: string,
  present: ReadonlySet<string>,
): Ref[] {
  const refs: Ref[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refs;
  }
  if (typeof parsed !== "object" || parsed === null) return refs;
  const record = parsed as Record<string, unknown>;
  const scripts = record.scripts;
  if (typeof scripts === "object" && scripts !== null) {
    for (const value of Object.values(scripts as Record<string, unknown>)) {
      if (typeof value === "string") refs.push(...extractBash(referrerDir, value, present));
    }
  }
  for (const key of ["main", "module", "types"]) {
    const value = record[key];
    if (typeof value === "string") {
      const resolved = resolvePathToken(referrerDir, value, present);
      if (resolved !== undefined) refs.push({ target: resolved });
    }
  }
  const bin = record.bin;
  if (typeof bin === "string") {
    const resolved = resolvePathToken(referrerDir, bin, present);
    if (resolved !== undefined) refs.push({ target: resolved });
  } else if (typeof bin === "object" && bin !== null) {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === "string") {
        const resolved = resolvePathToken(referrerDir, value, present);
        if (resolved !== undefined) refs.push({ target: resolved });
      }
    }
  }
  return refs;
}

function extractRefs(path: string, text: string, present: ReadonlySet<string>): Ref[] {
  const referrerDir = posix.dirname(path);
  const firstLine = text.split("\n", 1)[0] ?? "";
  switch (fileClassOf(path, firstLine)) {
    case "bash":
      return extractBash(referrerDir, text, present);
    case "tsjs":
      return extractTsJs(referrerDir, text, present);
    case "skill":
    case "markdown":
      return extractSkill(referrerDir, text, present);
    case "packagejson":
      return extractPackageJson(referrerDir, text, present);
    default:
      return [];
  }
}

// -- Classifier --------------------------------------------------------------

/**
 * Classify every file in `input` against `spec` (and the injected `hostFacts`).
 * Deterministic: identical (input, spec, hostFacts) yields an identical
 * `closureDigest`. `hostFacts === undefined` fails closed (every inert file →
 * `unknown`).
 */
export function classifyClosure(
  input: ClosureInput,
  spec: ClosureSpec,
  hostFacts?: HostLoadFacts,
): ProfileClosure {
  const present = new Set(input.files);
  const materializes = spec.materializes ?? (() => true);
  const nodes = new Map<string, MutableNode>();
  for (const path of input.files) {
    nodes.set(path, {
      path,
      reachability: "materialized",
      materialized: materializes(path),
      reachedBy: [],
    });
  }
  const danglingRefs = new Set<string>();
  const unresolvedRefs = new Set<string>();

  if (spec.mode === "full-tree") {
    for (const node of nodes.values()) {
      node.reachability = "control";
      node.materialized = true;
      node.reachedBy = ["full-tree"];
    }
    return finalize(spec, nodes, danglingRefs, unresolvedRefs, hostFacts);
  }

  const work: string[] = [];
  const extracted = new Set<string>();

  const raise = (path: string, reachability: Reachability, by: string): void => {
    const node = nodes.get(path);
    if (node === undefined) return;
    if (RANK[reachability] > RANK[node.reachability]) {
      node.reachability = reachability;
      if (isBlocking(reachability)) node.materialized = true;
    }
    if (!node.reachedBy.includes(by)) node.reachedBy.push(by);
    // Only files reached as control/build-input/model-loaded are walked; unknown
    // nodes are terminal (we cannot trust content-derived refs from a file we
    // could not prove we run).
    if (RANK[reachability] >= RANK["model-loaded"] && !extracted.has(path)) work.push(path);
  };

  const applyRef = (node: MutableNode, ref: Ref): void => {
    if (ref.dangling !== undefined) {
      danglingRefs.add(ref.dangling);
      return;
    }
    if (ref.unresolvedRaw !== undefined) unresolvedRefs.add(ref.unresolvedRaw);
    if (ref.dirPrefix !== undefined) {
      for (const [candidate, other] of nodes) {
        if (candidate.startsWith(ref.dirPrefix) && other.reachability === "materialized") {
          raise(candidate, "unknown", `unresolved:${ref.dirPrefix}`);
        }
      }
      return;
    }
    if (ref.target !== undefined) {
      // A resolved edge inherits the referrer's blocking reachability (a control
      // script's include is control; a build input's import is build-input; a
      // model-loaded body's reference is model-loaded).
      const inherit: Reachability = isBlocking(node.reachability) ? node.reachability : "control";
      raise(ref.target, inherit, node.path);
    }
  };

  for (const seed of spec.seeds ?? []) {
    if (!present.has(seed.path)) {
      danglingRefs.add(seed.path);
      continue;
    }
    raise(seed.path, seed.reachability, "seed");
  }

  while (work.length > 0) {
    const path = work.pop();
    if (path === undefined) break;
    if (extracted.has(path)) continue;
    extracted.add(path);
    const node = nodes.get(path);
    if (node === undefined || !isBlocking(node.reachability) || node.reachability === "unknown")
      continue;
    const text = input.readText(path);
    if (text === undefined) continue;
    for (const ref of extractRefs(path, text, present)) applyRef(node, ref);
  }

  applyHostFacts(nodes, hostFacts, input, present, raise, work, extracted, applyRef);
  return finalize(spec, nodes, danglingRefs, unresolvedRefs, hostFacts);
}

/**
 * Host-fact post-pass. ABSENT facts fail closed (inert → unknown). A host that
 * registers nested SKILL.md raises those bodies to `model-loaded` (and walks
 * their refs only when it also reads non-SKILL adjacent files). A host that does
 * NOT register nested SKILL.md (the measured claude-code@2.1.214 case) adds
 * nothing here — nested adjacency is already covered by seed extraction.
 */
function applyHostFacts(
  nodes: Map<string, MutableNode>,
  hostFacts: HostLoadFacts | undefined,
  input: ClosureInput,
  present: ReadonlySet<string>,
  raise: (path: string, reachability: Reachability, by: string) => void,
  work: string[],
  extracted: Set<string>,
  applyRef: (node: MutableNode, ref: Ref) => void,
): void {
  if (hostFacts === undefined) {
    for (const node of nodes.values()) {
      if (node.reachability === "materialized") {
        node.reachability = "unknown";
        node.materialized = true;
        if (!node.reachedBy.includes("host-facts-absent")) node.reachedBy.push("host-facts-absent");
      }
    }
    return;
  }
  if (!hostFacts.registersNestedSkillMd) return;
  for (const [path, node] of nodes) {
    if (
      node.reachability === "materialized" &&
      (path === "SKILL.md" || path.endsWith("/SKILL.md"))
    ) {
      raise(path, "model-loaded", "host-registers-nested-skill");
    }
  }
  if (hostFacts.readsNonSkillSkillFiles) {
    while (work.length > 0) {
      const path = work.pop();
      if (path === undefined) break;
      if (extracted.has(path)) continue;
      extracted.add(path);
      const node = nodes.get(path);
      if (node === undefined || !isBlocking(node.reachability) || node.reachability === "unknown")
        continue;
      const text = input.readText(path);
      if (text === undefined) continue;
      for (const ref of extractRefs(path, text, present)) applyRef(node, ref);
    }
  } else {
    work.length = 0;
  }
}

function finalize(
  spec: ClosureSpec,
  nodes: Map<string, MutableNode>,
  danglingRefs: Set<string>,
  unresolvedRefs: Set<string>,
  hostFacts: HostLoadFacts | undefined,
): ProfileClosure {
  const frozen = new Map<string, ClosureNode>();
  for (const [path, node] of nodes) {
    frozen.set(path, {
      path: node.path,
      reachability: node.reachability,
      materialized: node.materialized,
      reachedBy: [...node.reachedBy],
    });
  }
  const hostFactsDigest =
    hostFacts === undefined
      ? "absent"
      : sha256Hex(
          canonicalJson({
            hostVersion: hostFacts.hostVersion,
            registersNestedSkillMd: hostFacts.registersNestedSkillMd,
            readsNonSkillSkillFiles: hostFacts.readsNonSkillSkillFiles,
            probeEvidence: hostFacts.probeEvidence,
          }),
        );
  const sortedClassification = [...frozen.values()]
    .map((node) => [node.path, node.reachability] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const closureDigest = sha256Hex(
    canonicalJson({
      profile: spec.profile,
      classifierVersion: spec.classifierVersion,
      mode: spec.mode,
      hostVersion: hostFacts?.hostVersion ?? "absent",
      nodes: sortedClassification,
    }),
  );
  return {
    spec,
    nodes: frozen,
    danglingRefs: [...danglingRefs].sort(),
    unresolvedRefs: [...unresolvedRefs].sort(),
    closureDigest,
    hostFactsDigest,
  };
}

// -- Finding classification --------------------------------------------------

/**
 * Classify a finding's file against the closure. A file absent from the closure
 * (never in the inventory) fails closed to blocking `unknown` — a finding can
 * never be silently declared inert for a file the closure did not see.
 */
export function classificationOf(
  closure: ProfileClosure,
  path: string,
): { classification: FindingClassification; reachability: Reachability | "non-materialized" } {
  const node = closure.nodes.get(path);
  if (node === undefined) return { classification: "closure", reachability: "unknown" };
  if (isBlocking(node.reachability)) {
    return { classification: "closure", reachability: node.reachability };
  }
  if (!node.materialized)
    return { classification: "non-materialized", reachability: "non-materialized" };
  return { classification: "materialized-inert", reachability: "materialized" };
}
