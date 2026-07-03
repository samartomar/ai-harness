# Product principles

What `aih` is and is not — the tests a proposal must pass before it becomes code,
so design churn does not reopen settled questions. The moat, competitive
posture, and the full rejected-proposal history are maintained privately; this
file carries the public, durable shape.

## The three tests

Every feature proposal must pass all three:

1. **Delegate, don't vendor.** `aih` runs an upstream's own installer and pins
   `owner/repo@SHA`; it never assembles, re-hosts, caches, or redistributes
   third-party content. `aih ecc` shells out to ECC's installer with `--profile`
   only.
2. **Not a runtime.** `aih` configures, constrains, evaluates, and observes AI
   CLIs. Reject anything that turns it into one: agent dispatch, workboards, an
   agent-memory backend, an LLM client, `aih`-as-MCP-server, or a registry field
   with no consumer.
3. **Tool-neutral across the supported CLIs.** A mechanism that only works for one
   CLI is a regression unless it degrades cleanly for the others.

## The default answer is curation, not surface

The answer to a design or scope problem is almost always **routing existing
capabilities into the right loading path** — not a new command, flag, or file
family. Reach for "which existing capability fails here, and why can't routing
fix it?" before proposing anything new. Canon generation follows the same
lean-context thesis: a compact contract, token-negative prose edits, point at a
source rather than re-spelling it. New configurable knobs follow the
`AIH_*` env-var → org-policy-field idiom.

## Enterprise seam is design-only

The public core builds only the seams: a pluggable command registry that probes
for the literal optional peer `@aihq/enterprise` (never an env-configurable
package name), with policy-in / evidence-out schemas. No enterprise code, license
gating, or policy-sync lives in the public repo.

## MCP catalog posture

- On-by-default is **secret-free-first** — prefer OAuth/remote servers over
  tokens-in-file.
- The three risk axes (egress, credentials, supply-chain) are serialized **into**
  `.mcp.json` as reviewer-visible data.
- Enterprise tightening happens only via the opt-in posture overlay; the default
  community output stays byte-identical.

## Report & dashboard honesty

For any `aih report` / dashboard / readiness work:

- **Live, preview, or omit — never demo data styled as real.** Every panel is
  LIVE (traces to a real digest), PREVIEW (visibly badged and desaturated), or
  EMPTY/omitted, in both the hydrated DOM and the static no-JS body.
  Omit-when-absent is a server decision: server-side digest templating is the
  source of truth; client JS consumes an injected view-model built from the same
  digests — never move rendering client-only.
- **No cost / forecast / ROI panels** — cost is unpredictable, so it is not a
  metric. Never present counterfactual "time/tokens saved"; cache efficiency is
  the one defensible savings number, labeled inline. Score labels say "wiring",
  never "quality".
- **The proven shipped report is the spec** (`docs/specs/local-report-v9/`). Diff
  any new prototype against it and warn about regressions instead of adopting the
  prototype. When the owner shares mockups to improve a UI, graft new panels into
  the existing layout additively — confirm before any structural reorganization;
  section titles in a mockup are suggestions. For data/behavior the spec wins; for
  look the reference wins — record which you followed.
- Every surfaced gap names the exact `aih <command>` that closes it, and that
  command must parse against `tests/contract/command-surface.json`. Rendered HTML
  must pass redaction (seeded token + home-path scrub) and re-render
  byte-identical. In-IDE preview panes routinely fail on heavy self-contained
  HTML — verify deterministically and flag visuals as unverified.
