# Product principles

> Load when: proposing a feature or flag, or doing report / dashboard work.

What `aih` is and is not — the tests a proposal passes before it becomes code, so
design churn doesn't reopen settled questions.

## The three tests

1. **Delegate, don't vendor.** `aih` runs an upstream's own installer and pins
   `owner/repo@SHA`; it never assembles, re-hosts, caches, or redistributes
   third-party content.
2. **Not a runtime.** `aih` configures, constrains, evaluates, and observes AI
   CLIs. Reject anything that turns it into one: agent dispatch, workboards, an
   agent-memory backend, an LLM client, `aih`-as-MCP-server.
3. **Tool-neutral.** A mechanism that only works for one CLI is a regression
   unless it degrades cleanly for the rest.

## Default to curation, not surface

The answer to a design problem is almost always routing existing capabilities
into the right loading path — not a new command, flag, or file family. Ask "which
existing capability falls short, and why can't routing fix it?" before proposing
anything new. New knobs follow the `AIH_*` env-var → org-policy-field idiom.

## MCP catalog

Secret-free-first (prefer OAuth/remote over tokens-in-file); the risk axes
(egress, credentials, supply-chain) are serialized into `.mcp.json` as
reviewer-visible data; enterprise tightening is an opt-in overlay that leaves the
default output byte-identical.

## Report honesty

- **Live, preview, or omit — never demo data styled as real**, in both the
  hydrated DOM and the static body. Omit-when-absent is a server decision.
- **No cost / forecast / ROI panels** — cost is unpredictable, so it isn't a
  metric. Score labels say "wiring", not "quality".
- **The shipped report is the spec** (`docs/specs/local-report-v9/`) — diff a
  prototype against it and warn on regressions rather than adopting it. Adopt
  design ideas additively; confirm before any structural reorganization.
- Every surfaced gap names the exact `aih <command>` that closes it, and that
  command must be runnable.
