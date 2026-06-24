import { z } from "zod";
import { SettingsError } from "../errors.js";

/** Resolved runtime settings (env defaults overlaid with CLI flags). */
export interface Settings {
  apply: boolean;
  verify: boolean;
  json: boolean;
  contextDir: string;
  root: string;
  caPattern: string;
}

function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const s = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off", ""].includes(s)) return false;
  throw new SettingsError(`expected a boolean value, got ${JSON.stringify(raw)}`);
}

const ContextDir = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._\-/]+$/, "context dir must be a simple relative path")
  .refine((s) => !s.split(/[/\\]/).includes(".."), "context dir must not traverse parents");

/**
 * Resolve settings fail-closed: env provides defaults (`AIH_*`), `overrides`
 * (CLI flags) win, and any malformed value throws {@link SettingsError} before a
 * command runs. Dry-run (`apply=false`) is the safe default.
 */
export function loadSettings(env: NodeJS.ProcessEnv, overrides: Partial<Settings> = {}): Settings {
  try {
    const apply = overrides.apply ?? envBool(env.AIH_APPLY, false);
    const verify = overrides.verify ?? envBool(env.AIH_VERIFY, false);
    const json = overrides.json ?? envBool(env.AIH_JSON, false);
    const contextDir = ContextDir.parse(
      overrides.contextDir ?? env.AIH_CONTEXT_DIR ?? ".ai-context",
    );
    const root = overrides.root ?? env.AIH_ROOT ?? process.cwd();
    const caPattern = (overrides.caPattern ?? env.AIH_CA_PATTERN ?? "Zscaler").trim();
    if (caPattern.length === 0) {
      throw new SettingsError("caPattern must not be empty");
    }
    return { apply, verify, json, contextDir, root, caPattern };
  } catch (err) {
    if (err instanceof SettingsError) throw err;
    if (err instanceof z.ZodError) {
      throw new SettingsError(err.issues.map((i) => i.message).join("; "));
    }
    throw new SettingsError((err as Error).message);
  }
}
