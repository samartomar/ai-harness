import { certStep } from "./cert-verify.js";
import { HEAL_SCOPES, type HealScope, type HealStep } from "./common.js";
import { mcpStep } from "./mcp-probe.js";
import { npmStep } from "./npm-heal.js";
import { pathStep } from "./path-heal.js";

/**
 * The fixed heal order is the dependency chain: certs → npm → path → mcp. TLS
 * trust gates npm; npm gates a usable PATH of tools; MCP pre-flight depends on
 * npm/npx. `--scope` selects a subset; the order is always preserved.
 */
export const HEAL_STEPS: readonly HealStep[] = [certStep, npmStep, pathStep, mcpStep];

/**
 * Parse `--scope` (e.g. "certs,npm" or "all"). Unknown tokens are ignored; an
 * empty/absent/"all" value (or all-garbage input) selects every step. Returns the
 * scopes in canonical {@link HEAL_SCOPES} order.
 */
export function parseScope(raw: unknown): HealScope[] {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (text === "" || text === "all") return [...HEAL_SCOPES];
  const wanted = new Set(
    text
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is HealScope => (HEAL_SCOPES as readonly string[]).includes(s)),
  );
  return wanted.size > 0 ? HEAL_SCOPES.filter((s) => wanted.has(s)) : [...HEAL_SCOPES];
}
