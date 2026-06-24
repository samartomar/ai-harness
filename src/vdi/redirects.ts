import type { EnvVar } from "../internals/envfile.js";

/**
 * Cache/SQLite locations that, on a VDI, must live on local scratch rather than
 * the roaming/synced profile. Each entry redirects a tool's cache or database
 * root into `${scratch}/<segment>` so heavy I/O never crosses the profile-sync
 * boundary (which is slow and, for SQLite, corruption-prone over SMB/roaming).
 *
 * The path segments under scratch are joined with forward slashes deliberately:
 * the value is written into a shell profile (PowerShell or sh) where `/` is a
 * valid separator on every host, and keeping it literal makes the generated
 * block byte-stable across platforms for golden tests.
 */
interface RedirectSpec {
  key: string;
  /** Path segments appended under the scratch root. */
  segments: string[];
}

const REDIRECTS: readonly RedirectSpec[] = [
  { key: "OLLAMA_MODELS", segments: ["ollama", "models"] },
  { key: "CLAUDE_CACHE_DIR", segments: ["claude", "cache"] },
  { key: "CRG_GLOBAL_DB_PATH", segments: ["crg", "global.db"] },
  { key: "NPX_CACHE", segments: ["npx"] },
  { key: "CARGO_HOME", segments: ["cargo"] },
  { key: "PIP_CACHE_DIR", segments: ["pip"] },
];

/**
 * Join `scratch` with `segments` using `/`. The whole value is normalized to
 * forward slashes (valid in both sh and PowerShell) so the generated block is
 * byte-identical regardless of the host separator and never needs shell quoting
 * for an embedded backslash.
 */
function under(scratch: string, segments: string[]): string {
  const root = scratch.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return [root, ...segments].join("/");
}

/**
 * Build the redirect env vars pointing every cache/DB root into `scratch`.
 * Order is fixed (matches {@link REDIRECTS}) so the managed block regenerates
 * byte-identically on re-run.
 */
export function redirectEnv(scratch: string): EnvVar[] {
  return REDIRECTS.map((r) => ({ key: r.key, value: under(scratch, r.segments) }));
}
