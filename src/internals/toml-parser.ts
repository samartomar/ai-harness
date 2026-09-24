import { createRequire } from "node:module";

/**
 * The CommonJS entry of the TOML parser Core ships (smol-toml), resolved from
 * this Core installation. A child script that must judge TOML exactly as Core's
 * `parseToml` does loads it by this path; no input selects it.
 */
export function tomlParserModulePath(): string {
  return createRequire(import.meta.url).resolve("smol-toml");
}
