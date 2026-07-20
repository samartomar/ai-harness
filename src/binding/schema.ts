import { join } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";

// Kept in sync with AIH_CONFIG_FILE in ../config/marker.ts by hand: marker.ts
// imports this schema to add its optional `binding` field, so importing the
// constant back from marker.ts here would form a schema<->marker module cycle.
const MARKER_FILE = ".aih-config.json";

/**
 * Project Framework Binding — the committed declaration schema (D7/D8).
 *
 * The declaration is the AUTHORITY (D7): it lives as one additive optional
 * `binding` field on the committed `.aih-config.json` marker. Machine caches
 * (checkouts, scan results, the lock) are DERIVED from it. Exactly ONE
 * methodology framework binds per project (D8): the shape is a single object
 * with a single framework id — there is no representation for co-enablement, and
 * every object in this subtree is `.strict()` so a smuggled second framework
 * (extra key, nested array, aliased ref) is REJECTED, never silently stripped.
 *
 * Identity is exact (D7): git records repository + an exact 40-char lowercase
 * commit SHA + a sha256 tree digest; npm records package + an exact version +
 * an SRI integrity. Refs, tags, and branch names are resolution inputs only and
 * can never appear as recorded identity.
 */

export const BINDING_SCHEMA_VERSION = 1 as const;

/** The four methodology frameworks W1 enumerates. Unknown ids are rejected. */
export const FRAMEWORK_IDS = ["ecc", "superpowers", "gstack", "gsd-core"] as const;
export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

/** Only `ecc` carries a lean/full mode; every other framework must omit it. */
const MODE_FRAMEWORK: FrameworkId = "ecc";

/** W2 hosts exactly one CLI host; the enum keeps room for later hosts. */
export const BINDING_HOSTS = ["claude"] as const;

const LOWER_SHA40 = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// npm SRI for sha512 is base64 of 64 bytes: 86 base64 chars + "==" padding.
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
// Exact semver only — a range operator, wildcard, or dist-tag ("latest") fails.
const EXACT_SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) return true;
  }
  return false;
}

/**
 * A plausible git repository identity: an https URL, an scp-like `git@host:path`,
 * or a bare `owner/repo`. A `#` fragment (a ref/tag smuggle like `owner/repo#main`),
 * any whitespace/control character, and a leading `-` on the whole value or on
 * either `owner/repo` segment (a git option-injection shape) are rejected so a ref
 * or a flag can never ride inside the repository identity field.
 */
function isPlausibleGitRepository(value: string): boolean {
  if (value.length === 0 || hasControlOrSpace(value)) return false;
  if (value.includes("#") || value.startsWith("-")) return false;
  if (/^https:\/\/\S+$/.test(value)) return true;
  if (/^git@[^\s:]+:\S+$/.test(value)) return true;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (match === null) return false;
  return !(match[1] ?? "").startsWith("-") && !(match[2] ?? "").startsWith("-");
}

export const BindingFrameworkSchema = z
  .object({
    id: z.enum(FRAMEWORK_IDS),
    mode: z.enum(["lean", "full"]).optional(),
    host: z.enum(BINDING_HOSTS),
    features: z.record(z.string().min(1), z.boolean()).optional(),
  })
  .strict()
  .superRefine((framework, ctx) => {
    if (framework.mode !== undefined && framework.id !== MODE_FRAMEWORK) {
      ctx.addIssue({
        code: "custom",
        path: ["mode"],
        message: `mode is only valid for the ${MODE_FRAMEWORK} framework (got ${framework.id})`,
      });
    }
  });

export const BindingGitSourceSchema = z
  .object({
    kind: z.literal("git"),
    repository: z.string().min(1).max(2048).refine(isPlausibleGitRepository, {
      message: "repository must be an https URL, scp-like, or owner/repo with no ref fragment",
    }),
    commitSha: z
      .string()
      .regex(
        LOWER_SHA40,
        "commitSha must be an exact lowercase 40-character git commit SHA (refs, tags, branches, and short or uppercase SHAs are rejected)",
      ),
    treeDigest: z.string().regex(SHA256_HEX, "treeDigest must be a sha256 hex digest"),
  })
  .strict();

export const BindingNpmSourceSchema = z
  .object({
    kind: z.literal("npm"),
    package: z
      .string()
      .min(1)
      .max(214)
      .regex(NPM_PACKAGE, "package must be a valid npm package name"),
    exactVersion: z
      .string()
      .regex(
        EXACT_SEMVER,
        "exactVersion must be an exact semver (ranges, wildcards, and dist-tags are rejected)",
      ),
    integrity: z.string().regex(SRI_SHA512, "integrity must be an SRI sha512-<base64> digest"),
  })
  .strict();

export const BindingSourceSchema = z.discriminatedUnion("kind", [
  BindingGitSourceSchema,
  BindingNpmSourceSchema,
]);

export const BindingDeclarationSchema = z
  .object({
    schemaVersion: z.literal(BINDING_SCHEMA_VERSION),
    framework: BindingFrameworkSchema,
    source: BindingSourceSchema,
  })
  .strict();

export type BindingFramework = z.infer<typeof BindingFrameworkSchema>;
export type BindingGitSource = z.infer<typeof BindingGitSourceSchema>;
export type BindingNpmSource = z.infer<typeof BindingNpmSourceSchema>;
export type BindingSource = z.infer<typeof BindingSourceSchema>;
export type BindingDeclaration = z.infer<typeof BindingDeclarationSchema>;

/** Present-but-invalid committed declaration — a governance value that fails closed. */
export class BindingDeclarationError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_DECLARATION");
  }
}

/** D8 violation: a project already bound to a different methodology framework. */
export class BindingFrameworkConflictError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_CONFLICT");
  }
}

export function parseBindingDeclaration(value: unknown): BindingDeclaration {
  return BindingDeclarationSchema.parse(value);
}

export function safeParseBindingDeclaration(
  value: unknown,
): z.ZodSafeParseResult<BindingDeclaration> {
  return BindingDeclarationSchema.safeParse(value);
}

/**
 * The single D8 guard shared by every enforcement layer (schema is structural;
 * plan and provision each call this independently). Re-binding the SAME framework
 * is allowed; binding a DIFFERENT one over an existing binding fails closed.
 */
export function assertSingleMethodologyFramework(
  incoming: FrameworkId,
  existing: FrameworkId | undefined,
): void {
  if (existing !== undefined && existing !== incoming) {
    throw new BindingFrameworkConflictError(
      `project is already bound to methodology framework "${existing}"; refusing to co-enable "${incoming}" (exactly one framework per project)`,
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the committed binding declaration from `.aih-config.json`. The declaration
 * is the authority, so a present-but-invalid `binding` fails closed with a clear
 * {@link BindingDeclarationError} (mirrors the fail-closed baseline reader).
 * Absent marker / absent field / unparseable marker JSON => `undefined` (the
 * marker's own reader surfaces whole-file invalidity).
 */
export function readBindingDeclaration(root: string): BindingDeclaration | undefined {
  const raw = readIfExists(join(root, MARKER_FILE));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || !("binding" in parsed)) return undefined;
  const binding = parsed.binding;
  if (binding === undefined) return undefined;
  const result = BindingDeclarationSchema.safeParse(binding);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where =
    issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}: ${issue.message}`;
  throw new BindingDeclarationError(`invalid binding declaration in ${MARKER_FILE}${where}`);
}
