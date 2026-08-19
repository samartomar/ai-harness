import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

/**
 * The mechanical Repair executor and verifier are internal AIH Core authority:
 * they may reach the filesystem under one plan-bound root and nothing else. This
 * suite walks their static import closure from source and refuses any route to a
 * process, shell, network, provider, scanner, signer, package/install,
 * publication, governance-decision, or command surface.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ENTRY_POINTS = [
  "src/governance-doctor/repair-claim-store-v1.ts",
  "src/governance-doctor/repair-claim-v1.ts",
  "src/governance-doctor/repair-content-v1.ts",
  "src/governance-doctor/repair-custody-v1.ts",
  "src/governance-doctor/repair-executor-v1.ts",
  "src/governance-doctor/repair-verifier-v1.ts",
] as const;

/**
 * Exactly the Node built-ins this authority is allowed to reach. `node:os` is here
 * for exactly one reason: the durable claim store resolves the machine-local home
 * it owns. It reaches nothing else there, and the pure claim record module reaches
 * none of these at all.
 */
const PERMITTED_BUILTINS = [
  "node:crypto",
  "node:fs",
  "node:os",
  "node:path",
  "node:util/types",
] as const;

/** The pure claim record module holds no filesystem or environment capability. */
const CLAIM_MODULE = "src/governance-doctor/repair-claim-v1.ts";
const PERMITTED_CLAIM_EXTERNALS = ["jsonc-parser", "node:crypto", "node:util/types"] as const;

/** Exactly the third-party packages the closure may reach (strict JSON parsing). */
const PERMITTED_PACKAGES = ["jsonc-parser"] as const;

/** Capability areas that must have no route into this authority at all. */
const PROHIBITED_AREAS = [
  "src/adopt/",
  "src/bootstrap/",
  "src/bundle/",
  "src/certs/",
  "src/cli.ts",
  "src/commands/",
  "src/doctor.ts",
  "src/ecc/",
  "src/governance-doctor/command-v1.ts",
  "src/governance-doctor/operational-v1.ts",
  "src/guardrails/",
  "src/index.ts",
  "src/internals/execute.ts",
  "src/internals/git.ts",
  "src/internals/proc.ts",
  "src/live/",
  "src/marketplace/",
  "src/mcp/",
  "src/org-policy/",
  "src/platform/",
  "src/plugins/",
  "src/program.ts",
  "src/release/",
  "src/sandbox/",
  "src/secrets/",
  "src/security/",
  "src/telemetry/",
  "src/tools/",
  "src/trust/",
  "src/workspace/",
] as const;

const IMPORT_PATTERN =
  /(?:^|[\s;}])(?:import|export)[^;]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']/g;

/**
 * Every dynamic invocation seam this authority must not contain. A specifier the
 * static closure cannot follow is the one route that would reintroduce a
 * capability the allowlists above already exclude, so each is refused by shape.
 */
const DYNAMIC_SEAMS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "eval", pattern: /\beval\s*\(/ },
  { label: "Function constructor", pattern: /new\s+Function\s*\(/ },
  { label: "require", pattern: /\brequire\s*\(/ },
  { label: "dynamic import", pattern: /(?:^|[^.\w])import\s*\(/m },
  { label: "process control", pattern: /\bprocess\s*\.\s*(?:exit|kill|binding|dlopen)\b/ },
];

/** The exact read-only custody surface the independent verifier may reach. */
const VERIFIER_CUSTODY_SURFACE = [
  "governanceDoctorRepairCustodyPlanSha256V1",
  "governanceDoctorRepairReadV1",
] as const;

/**
 * Every custody export that can change the tree. Minting a grant is on this list
 * on purpose: a module able to assemble mutation authority is a module able to
 * mutate, whether or not it also names the two operations that spend it.
 */
const CUSTODY_MUTATION_SURFACE = [
  "createGovernanceDoctorRepairMutationGrantV1",
  "governanceDoctorRepairCreateDirectoryV1",
  "governanceDoctorRepairWriteFileV1",
] as const;

/**
 * The bound root's absolute real path. It changes nothing, but it hands out a
 * filesystem location and it is the input to the durable claim scope, so it is
 * held to the same one-importer rule as the mutations themselves.
 */
const CUSTODY_SCOPE_SURFACE = ["governanceDoctorRepairCustodyRootRealPathV1"] as const;

/** Everything above, which together only the executor may reach. */
const CUSTODY_RESTRICTED_SURFACE: readonly string[] = [
  ...CUSTODY_MUTATION_SURFACE,
  ...CUSTODY_SCOPE_SURFACE,
].sort();

/** The one module in the repository allowed to reach that surface. */
const CUSTODY_MUTATION_IMPORTER = "src/governance-doctor/repair-executor-v1.ts";

/**
 * The durable claim store is the only thing in this closure that writes outside the
 * plan's own root, so its whole surface is held to the same rule: one importer, and
 * that importer is the executor.
 */
const CLAIM_STORE_MODULE = "src/governance-doctor/repair-claim-store-v1.ts";
const CLAIM_STORE_SPECIFIER_SUFFIX = "repair-claim-store-v1.js";
const CLAIM_STORE_ACQUIRE_SURFACE = ["acquireGovernanceDoctorRepairClaimV1"] as const;
const CLAIM_STORE_IMPORTER = "src/governance-doctor/repair-executor-v1.ts";

interface Closure {
  readonly files: readonly string[];
  readonly externals: readonly string[];
}

function repoRelative(absolute: string): string {
  return relative(repoRoot, absolute).split("\\").join("/");
}

function importSpecifiers(text: string): readonly string[] {
  const found: string[] = [];
  IMPORT_PATTERN.lastIndex = 0;
  let match = IMPORT_PATTERN.exec(text);
  while (match !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) found.push(specifier);
    match = IMPORT_PATTERN.exec(text);
  }
  return found;
}

function importClosure(entryPoints: readonly string[]): Closure {
  const files = new Set<string>();
  const externals = new Set<string>();
  const pending = entryPoints.map((entry) => resolve(repoRoot, entry));
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (files.has(current)) continue;
    files.add(current);
    const text = readFileSync(current, "utf8");
    for (const specifier of importSpecifiers(text)) {
      if (!specifier.startsWith(".")) {
        externals.add(specifier);
        continue;
      }
      const target = resolve(dirname(current), specifier.replace(/\.js$/, ".ts"));
      expect(existsSync(target), `${repoRelative(current)} -> ${specifier}`).toBe(true);
      pending.push(target);
    }
  }
  return { files: [...files].map(repoRelative).sort(), externals: [...externals].sort() };
}

const closure = importClosure(ENTRY_POINTS);

/** Every TypeScript source file in the repository's own `src` tree. */
function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(absolute));
    else if (entry.name.endsWith(".ts")) found.push(absolute);
  }
  return found;
}

const CUSTODY_MODULE = "src/governance-doctor/repair-custody-v1.ts";
const CUSTODY_SPECIFIER_SUFFIX = "repair-custody-v1.js";

interface ScannedToken {
  readonly kind: number;
  readonly text: string;
  readonly value: string;
}

/**
 * The tokens after which a `/` divides rather than opens a regular expression.
 * Everything else puts the scanner in expression position, where the slash has to
 * be re-scanned as a literal.
 */
const DIVIDES_AFTER: ReadonlySet<number> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.FalseKeyword,
  SyntaxKind.Identifier,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.StringLiteral,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TemplateTail,
  SyntaxKind.ThisKeyword,
  SyntaxKind.TrueKeyword,
]);

/**
 * The file's tokens as TypeScript itself reads them.
 *
 * This is the compiler's own scanner, so a specifier inside a comment or a string
 * literal, a declaration wrapped across lines, and an alias separated by arbitrary
 * trivia are all settled by the language rather than by a pattern that approximates
 * it. TypeScript 7 exposes no in-process parser -- its only tree comes from the
 * native program API, which needs a project on disk -- so the scanner is the
 * furthest this reader can go into that dependency, and the declaration grammar
 * below is small enough to be read against the language reference by eye.
 */
function scanTokens(text: string): readonly ScannedToken[] {
  const scanner = createScanner(true, LanguageVariant.Standard);
  scanner.setText(text);
  const tokens: ScannedToken[] = [];
  // Three pieces of context a scanner cannot supply itself, all of which a parser
  // would. A `}` that closes a template substitution has to be re-scanned as the
  // rest of the template. A `/` in expression position has to be re-scanned as a
  // regular expression. Miss either and the next backtick or quote pairs with the
  // wrong one and swallows the remainder of the file, taking every later
  // declaration with it -- which is a detector that has quietly stopped looking.
  // And an ambiguous character the scanner cannot advance past -- a lone `#` among
  // others -- has to be stepped over, or the walk never ends.
  const substitutions: number[] = [];
  let braces = 0;
  let position = 0;
  let previous = SyntaxKind.SemicolonToken;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.TemplateHead) substitutions.push(braces);
    else if (kind === SyntaxKind.OpenBraceToken) braces += 1;
    else if (kind === SyntaxKind.CloseBraceToken) {
      if (substitutions[substitutions.length - 1] === braces) {
        substitutions.pop();
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateMiddle) substitutions.push(braces);
      } else if (braces > 0) braces -= 1;
    } else if (
      (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
      !DIVIDES_AFTER.has(previous)
    )
      kind = scanner.reScanSlashToken();
    previous = kind;
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
    const end = scanner.getTokenEnd();
    if (end > position) position = end;
    else {
      position += 1;
      if (position >= text.length) break;
      scanner.resetTokenState(position);
    }
  }
  return tokens;
}

const NAME_TOKEN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isNameToken(token: ScannedToken | undefined): boolean {
  return token !== undefined && NAME_TOKEN.test(token.text);
}

interface ModuleReferenceV1 {
  /** Canonical imported or re-exported names, before any local rename. */
  readonly names: readonly string[];
  readonly specifier: string;
  /** A namespace binding or a star re-export reaches the module's whole surface. */
  readonly whole: boolean;
}

/**
 * Reads one import or export declaration starting at `start`, or reports nothing
 * when the tokens there are not a module reference at all.
 *
 * Every name is reduced to the one it reaches in the target module: `type X`,
 * `X as alias`, and `export { X as alias } from` all name `X`, and a default
 * binding names `default`. A namespace binding and a star re-export name nothing
 * individually and are reported as whole-surface reachability instead.
 */
function readModuleReference(
  tokens: readonly ScannedToken[],
  start: number,
): ModuleReferenceV1 | undefined {
  let index = tokens[start]?.text === "type" ? start + 1 : start;
  const first = tokens[index];
  if (first === undefined) return undefined;
  if (first.kind === SyntaxKind.StringLiteral)
    return { names: [], specifier: first.value, whole: false };
  if (
    first.kind !== SyntaxKind.AsteriskToken &&
    first.kind !== SyntaxKind.OpenBraceToken &&
    !isNameToken(first)
  )
    return undefined;

  const names: string[] = [];
  let whole = false;
  let inBraces = false;
  let expectImported = false;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index] as ScannedToken;
    if (token.kind === SyntaxKind.StringLiteral)
      return tokens[index - 1]?.kind === SyntaxKind.FromKeyword
        ? { names, specifier: token.value, whole }
        : undefined;
    if (token.kind === SyntaxKind.AsteriskToken) whole = true;
    else if (token.kind === SyntaxKind.OpenBraceToken) {
      inBraces = true;
      expectImported = true;
    } else if (token.kind === SyntaxKind.CloseBraceToken) inBraces = false;
    else if (token.kind === SyntaxKind.CommaToken) expectImported = inBraces;
    else if (token.kind === SyntaxKind.AsKeyword) expectImported = false;
    else if (token.kind === SyntaxKind.FromKeyword) continue;
    else if (token.kind === SyntaxKind.SemicolonToken) return undefined;
    else if (!isNameToken(token)) return undefined;
    else if (!inBraces) {
      // Outside braces only two bindings exist: the namespace name after a star,
      // which names nothing on its own, and the default import.
      if (!whole) names.push("default");
    } else if (expectImported && token.text !== "type") {
      names.push(token.value);
      expectImported = false;
    }
  }
  return undefined;
}

/** Every module reference one file makes, in source order. */
function moduleReferences(text: string): readonly ModuleReferenceV1[] {
  const tokens = scanTokens(text);
  const found: ModuleReferenceV1[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as ScannedToken;
    const isImport = token.kind === SyntaxKind.ImportKeyword;
    if (!isImport && token.kind !== SyntaxKind.ExportKeyword) continue;
    // `import(...)` and `import.meta` are not declarations; the dynamic-seam rules
    // above are what refuse the first of those outright.
    const next = tokens[index + 1];
    if (
      isImport &&
      (next?.kind === SyntaxKind.OpenParenToken || next?.kind === SyntaxKind.DotToken)
    )
      continue;
    const reference = readModuleReference(tokens, index + 1);
    if (reference !== undefined) found.push(reference);
  }
  return found;
}

/** Every name the custody module itself exports, read from its own source. */
function moduleExportedNames(text: string): readonly string[] {
  const tokens = scanTokens(text);
  const declarators = new Set([
    "abstract",
    "async",
    "class",
    "const",
    "declare",
    "enum",
    "function",
    "interface",
    "let",
    "type",
    "var",
  ]);
  const names = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    if ((tokens[index] as ScannedToken).kind !== SyntaxKind.ExportKeyword) continue;
    let cursor = index + 1;
    while (declarators.has(tokens[cursor]?.text ?? "")) cursor += 1;
    const declared = tokens[cursor];
    if (isNameToken(declared)) names.add((declared as ScannedToken).value);
  }
  return [...names].sort();
}

/** The complete exported surface of one module in this closure. */
function exportedSurface(module: string): readonly string[] {
  return moduleExportedNames(readFileSync(resolve(repoRoot, module), "utf8"));
}

function custodySurface(): readonly string[] {
  return exportedSurface(CUSTODY_MODULE);
}

/**
 * The custody names one file can reach, in canonical form, or nothing when it does
 * not name the module at all.
 *
 * A namespace import, a star re-export, and a namespaced re-export each answer with
 * the module's complete exported surface, because a binding for the module is a
 * binding for everything in it. A named or default form answers with exactly the
 * names it reaches. Either way the answer is what the allowlist below is entitled
 * to reason about: an alias, a second declaration, a default-and-named combination,
 * and a re-export are all just spellings, and none of them is a way past it.
 */
function namesReached(
  text: string,
  specifierSuffix: string,
  surface: () => readonly string[],
): readonly string[] | undefined {
  const references = moduleReferences(text).filter((reference) =>
    reference.specifier.endsWith(specifierSuffix),
  );
  if (references.length === 0) return undefined;
  const named = new Set<string>();
  for (const reference of references) {
    if (reference.whole) for (const name of surface()) named.add(name);
    for (const name of reference.names) named.add(name);
  }
  return [...named].sort();
}

function custodyImports(text: string): readonly string[] | undefined {
  return namesReached(text, CUSTODY_SPECIFIER_SUFFIX, custodySurface);
}

function claimStoreImports(text: string): readonly string[] | undefined {
  return namesReached(text, CLAIM_STORE_SPECIFIER_SUFFIX, () =>
    exportedSurface(CLAIM_STORE_MODULE),
  );
}

describe("governance doctor repair execution capability boundary", () => {
  it("recognizes side-effect-only static imports while building the closure", () => {
    expect(importSpecifiers('import "node:child_process";')).toEqual(["node:child_process"]);
  });

  it("reaches only the permitted Node built-ins", () => {
    for (const specifier of closure.externals) {
      if (!specifier.startsWith("node:")) continue;
      expect(PERMITTED_BUILTINS as readonly string[]).toContain(specifier);
    }
  });

  it("reaches no package beyond the strict JSON parser", () => {
    for (const specifier of closure.externals) {
      if (specifier.startsWith("node:")) continue;
      expect(PERMITTED_PACKAGES as readonly string[]).toContain(specifier);
    }
  });

  it("has no route into a process, network, provider, scanner, signer, or command area", () => {
    for (const file of closure.files)
      for (const area of PROHIBITED_AREAS)
        expect(file.startsWith(area), `${file} reaches ${area}`).toBe(false);
  });

  it("recognizes every dynamic seam it claims to exclude", () => {
    const seam = (label: string): RegExp =>
      (DYNAMIC_SEAMS.find((entry) => entry.label === label) as { pattern: RegExp }).pattern;

    expect(seam("eval").test("eval(payload)")).toBe(true);
    expect(seam("Function constructor").test("new Function(body)")).toBe(true);
    expect(seam("require").test("require('node:child_process')")).toBe(true);
    expect(seam("dynamic import").test("await import(specifier)")).toBe(true);
    // A specifier at the very start of a line is still a dynamic import.
    expect(seam("dynamic import").test("import(specifier)")).toBe(true);
    expect(seam("dynamic import").test("const x = a.import(y)")).toBe(false);
    expect(seam("process control").test("process.exit(1)")).toBe(true);
  });

  it("contains no dynamic invocation seam", () => {
    for (const file of closure.files) {
      const text = readFileSync(resolve(repoRoot, file), "utf8");
      for (const { label, pattern } of DYNAMIC_SEAMS)
        expect(pattern.test(text), `${file} reaches ${label}`).toBe(false);
    }
  });

  it("hands the independent verifier a read-only custody surface", () => {
    const named = custodyImports(
      readFileSync(resolve(repoRoot, "src/governance-doctor/repair-verifier-v1.ts"), "utf8"),
    );
    expect(named, "the verifier must name its custody surface explicitly").toBeDefined();
    expect(named).toEqual([...VERIFIER_CUSTODY_SURFACE]);
  });

  it("lets exactly one module reach the custody mutation and scope surface", () => {
    const importers = new Map<string, readonly string[]>();
    for (const absolute of sourceFiles(resolve(repoRoot, "src"))) {
      const named = custodyImports(readFileSync(absolute, "utf8"));
      if (named === undefined) continue;
      const restricted = named.filter((entry) => CUSTODY_RESTRICTED_SURFACE.includes(entry));
      if (restricted.length > 0) importers.set(repoRelative(absolute), restricted);
    }

    // One importer, named exactly -- a second one would be a second way to write.
    expect([...importers.keys()]).toEqual([CUSTODY_MUTATION_IMPORTER]);
    // And it reaches the whole surface, so the list above cannot silently rot as
    // an export it no longer names quietly becomes reachable from somewhere else.
    expect(importers.get(CUSTODY_MUTATION_IMPORTER)).toEqual(CUSTODY_RESTRICTED_SURFACE);
  });

  it("lets exactly one module reach the durable claim store", () => {
    const importers = new Map<string, readonly string[]>();
    for (const absolute of sourceFiles(resolve(repoRoot, "src"))) {
      const named = claimStoreImports(readFileSync(absolute, "utf8"));
      if (named !== undefined && named.length > 0) importers.set(repoRelative(absolute), named);
    }

    // The store is the one thing in this closure that writes outside the plan's own
    // root, so a second importer would be a second durable authority.
    expect([...importers.keys()]).toEqual([CLAIM_STORE_IMPORTER]);
    expect(importers.get(CLAIM_STORE_IMPORTER)).toEqual([...CLAIM_STORE_ACQUIRE_SURFACE]);
    // The store's whole reachable surface is the one operation plus its own frozen
    // limits, so nothing here can grow a read-back, a listing, or a removal unnoticed.
    expect(exportedSurface(CLAIM_STORE_MODULE)).toEqual([
      "GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS",
      "GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS",
      "acquireGovernanceDoctorRepairClaimV1",
    ]);
  });

  it("keeps the pure claim record module free of every capability", () => {
    // Canonical schema and digest parsing runs over records some other process
    // wrote. It must never be a route to a filesystem, a home, or a clock.
    const pure = importClosure([CLAIM_MODULE]);
    expect([...pure.externals].sort()).toEqual([...PERMITTED_CLAIM_EXTERNALS]);
    expect(pure.externals).not.toContain("node:fs");
    expect(pure.externals).not.toContain("node:os");

    for (const file of pure.files) {
      const text = readFileSync(resolve(repoRoot, file), "utf8");
      for (const forbidden of [/\bDate\s*\.\s*now\b/, /\bprocess\s*\.\s*env\b/, /\bhomedir\b/])
        expect(forbidden.test(text), `${file} reaches ${String(forbidden)}`).toBe(false);
    }
  });

  it("reads every source file to its end rather than losing declarations to a desync", () => {
    // A scanner driven without a parser can lose synchronisation and swallow the
    // rest of a file, which would make this whole suite quietly stop looking. Every
    // declaration that starts a line has to survive as a keyword token.
    for (const absolute of sourceFiles(resolve(repoRoot, "src"))) {
      const text = readFileSync(absolute, "utf8");
      const written = (text.match(/^(?:import|export) /gm) ?? []).length;
      const scanned = scanTokens(text).filter(
        (token) =>
          token.kind === SyntaxKind.ImportKeyword || token.kind === SyntaxKind.ExportKeyword,
      ).length;
      expect(scanned, repoRelative(absolute)).toBeGreaterThanOrEqual(written);
    }
  });

  it("reads a namespace import, a re-export, and a star re-export as the whole surface", () => {
    // A binding for the module itself reaches every name the module exports, so
    // the detector must answer with that surface rather than with no names at all.
    const surface = [...custodySurface()];
    expect(surface).toContain("governanceDoctorRepairWriteFileV1");
    for (const bypass of [
      'import * as custody from "./repair-custody-v1.js";',
      'export * from "./repair-custody-v1.js";',
      'export * as custody from "./repair-custody-v1.js";',
    ])
      expect(custodyImports(bypass), bypass).toEqual(surface);

    // A default binding alongside the namespace one adds its own name to that.
    expect(
      custodyImports('import custodyDefault, * as custody from "./repair-custody-v1.js";'),
    ).toEqual(["default", ...surface].sort());

    // A re-export hands the surface onward exactly as an import reaches it.
    expect(
      custodyImports('export { governanceDoctorRepairWriteFileV1 } from "./repair-custody-v1.js";'),
    ).toEqual(["governanceDoctorRepairWriteFileV1"]);
    expect(
      custodyImports(
        'export { governanceDoctorRepairWriteFileV1 as write } from "./repair-custody-v1.js";',
      ),
    ).toEqual(["governanceDoctorRepairWriteFileV1"]);
  });

  it("reads a default and named combination, and ignores look-alikes in comments and strings", () => {
    expect(
      custodyImports(
        'import fallback, { governanceDoctorRepairWriteFileV1 } from "./repair-custody-v1.js";',
      ),
    ).toEqual(["default", "governanceDoctorRepairWriteFileV1"]);

    // A specifier that only appears inside a comment or a string is not an import,
    // and a dynamic specifier is already refused by the seam rules above.
    expect(
      custodyImports(
        '// import { governanceDoctorRepairWriteFileV1 } from "./repair-custody-v1.js";',
      ),
    ).toBeUndefined();
    expect(
      custodyImports(
        "const note = 'import { governanceDoctorRepairWriteFileV1 } from \"./repair-custody-v1.js\"';",
      ),
    ).toBeUndefined();
    expect(custodyImports('export const specifier = "./repair-custody-v1.js";')).toBeUndefined();
  });

  it("recognizes a mutation importer it would have to refuse", () => {
    // The detector above is only a boundary if it sees a violation as one.
    const planted = 'import { governanceDoctorRepairWriteFileV1 } from "./repair-custody-v1.js";';
    expect(custodyImports(planted)).toEqual(["governanceDoctorRepairWriteFileV1"]);
    expect(custodyImports('import { readFileSync } from "node:fs";')).toBeUndefined();
    // A type-only name is still the name it imports.
    expect(
      custodyImports(
        'import { type GovernanceDoctorRepairCustodyV1 } from "./repair-custody-v1.js";',
      ),
    ).toEqual(["GovernanceDoctorRepairCustodyV1"]);

    // Every declaration counts, not just the first: a benign import must not be
    // able to stand in front of a second one and hide the surface it reaches.
    expect(
      custodyImports(
        [
          'import { governanceDoctorRepairReadV1 } from "./repair-custody-v1.js";',
          'import { governanceDoctorRepairWriteFileV1 } from "./repair-custody-v1.js";',
        ].join("\n"),
      ),
    ).toEqual(["governanceDoctorRepairReadV1", "governanceDoctorRepairWriteFileV1"]);

    // An alias renames the local binding, never the export it reaches, so the
    // name this detector reports is the imported one.
    expect(
      custodyImports(
        'import { governanceDoctorRepairWriteFileV1 as alias } from "./repair-custody-v1.js";',
      ),
    ).toEqual(["governanceDoctorRepairWriteFileV1"]);
    expect(
      custodyImports(
        'import { type GovernanceDoctorRepairCustodyV1 as Custody } from "./repair-custody-v1.js";',
      ),
    ).toEqual(["GovernanceDoctorRepairCustodyV1"]);
  });

  it("keeps the executor and verifier out of every public and command surface", () => {
    const surfaces = [
      "src/index.ts",
      "src/commands/index.ts",
      "src/governance-doctor/command-v1.ts",
    ];
    for (const surface of surfaces) {
      const text = readFileSync(resolve(repoRoot, surface), "utf8");
      for (const entry of ENTRY_POINTS) {
        const moduleName = entry.replace("src/governance-doctor/", "").replace(".ts", "");
        expect(text.includes(moduleName), `${surface} exposes ${moduleName}`).toBe(false);
      }
    }
  });
});
