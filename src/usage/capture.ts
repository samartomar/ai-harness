import { lines } from "../internals/render.js";

/**
 * Generated capture artifacts for the usage layer. These are TOOLS the hooks run
 * at event time — they are not executed at generation time, and they are
 * best-effort (a failure never blocks a commit or an agent turn).
 */

/**
 * `.aih/usage-record.mjs` — a tiny, dependency-free Node recorder. Hooks invoke it
 * as `node .aih/usage-record.mjs <tool> <kind> [name] [source|server]` and it
 * appends ONE JSON event to `.aih/usage.jsonl`. For `commit` it derives LOC from
 * `git show --numstat HEAD` itself, so the git hook stays a one-liner.
 */
export function usageRecorderScript(): string {
  return lines(
    "#!/usr/bin/env node",
    "// aih-managed usage recorder. Appends one event to .aih/usage.jsonl. Best-effort:",
    "// it must never throw into a hook, so every step is guarded.",
    'import { appendFileSync, mkdirSync } from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    "",
    'const [tool = "unknown", kind = "tool", name, extra] = process.argv.slice(2);',
    "const ev = { ts: new Date().toISOString(), tool, kind };",
    "if (name) ev.name = name;",
    'if (kind === "mcp" && extra) ev.server = extra;',
    "else if (extra) ev.source = extra;",
    "",
    'if (kind === "commit") {',
    "  try {",
    '    const out = execFileSync("git", ["show", "--numstat", "--format=", "HEAD"], { encoding: "utf8" });',
    "    let added = 0, removed = 0, files = 0;",
    '    for (const line of out.split("\\n")) {',
    '      const [a, r] = line.split("\\t");',
    "      if (a !== undefined && r !== undefined && line.trim()) {",
    "        added += Number.parseInt(a, 10) || 0;",
    "        removed += Number.parseInt(r, 10) || 0;",
    "        files += 1;",
    "      }",
    "    }",
    "    ev.added = added; ev.removed = removed; ev.files = files;",
    '    ev.sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();',
    "  } catch {}",
    "}",
    "",
    "try {",
    '  mkdirSync(".aih", { recursive: true });',
    '  appendFileSync(".aih/usage.jsonl", JSON.stringify(ev) + "\\n");',
    "} catch {}",
  );
}

/**
 * `.git/hooks/post-commit` — the UNIVERSAL floor. Works for every AI tool (and
 * hand-written code) because it keys off the commit, not the agent. Records commit
 * activity (LOC/files) with no tool attribution. Never blocks the commit.
 */
export function gitPostCommitHook(): string {
  return lines(
    "#!/bin/sh",
    "# aih-managed: record commit activity for `aih report` usage analytics.",
    "# Universal (any tool), best-effort — exits 0 so it can never block a commit.",
    'root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0',
    'if [ -f "$root/.aih/usage-record.mjs" ]; then',
    '  node "$root/.aih/usage-record.mjs" git commit >/dev/null 2>&1 || true',
    "fi",
    "exit 0",
  );
}

/**
 * A CHAINABLE capture block to append to an EXISTING `post-commit` hook (aih never
 * overwrites a user's hook). Namespaced var, no `exit`, `|| true` everywhere — so it
 * slots into the middle of someone else's hook without short-circuiting or failing it.
 */
export function gitPostCommitChainSnippet(): string {
  return lines(
    "# --- aih usage capture (best-effort; never blocks the commit) ---",
    'aih_root="$(git rev-parse --show-toplevel 2>/dev/null)"',
    'if [ -n "$aih_root" ] && [ -f "$aih_root/.aih/usage-record.mjs" ]; then',
    '  node "$aih_root/.aih/usage-record.mjs" git commit >/dev/null 2>&1 || true',
    "fi",
    "# --- end aih usage capture ---",
  );
}
