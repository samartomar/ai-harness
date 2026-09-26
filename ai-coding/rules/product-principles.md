# Product principles

> Load when: proposing a feature or flag, or doing report / dashboard work.

What `aih` is and is not — the tests a proposal passes before it becomes code, so
design churn doesn't reopen settled questions.

## The three tests

1. **Bounded third-party delivery.** `aih` records `owner/repo@SHA` as provenance. It may optionally deliver and remove approved, self-contained third-party skills and agents for verified CLI pairs, using complete file digests and receipts that prove which files it wrote. It does not run a third-party installer or remove unowned files. External framework installs remain the developer’s responsibility; a pin alone does not prove their installed bytes. Third-party inventory stays selectable, and scan findings inform rather than block selection or delivery.
2. **Not a runtime.** `aih` configures, constrains, evaluates, and observes AI
   CLIs. Reject anything that turns it into one: agent dispatch, workboards, an
   agent-memory backend, an LLM client, `aih`-as-MCP-server.
3. **Tool-neutral mechanism, explicit coverage.** Shared delivery and reporting use per-CLI adapters. Offer aih-owned delivery only for tested item × CLI pairs; show guidance for every other pair.

## Default to curation, not surface

The answer to a design problem is almost always routing existing capabilities
into the right loading path — not a new command, flag, or file family. Ask "which
existing capability falls short, and why can't routing fix it?" before proposing
anything new. New knobs follow the `AIH_*` env-var → org-policy-field idiom.

## Availability

AIH is completely free to use. No capability, organization-administration
surface, evidence collection, or report may require payment or an entitlement.
The `vibe` and `enterprise` postures change governance strictness only; they are
not availability tiers. Optional package seams may modularize implementation but
must never introduce an upgrade boundary. Third-party tools and services retain
their own licenses and charges; AIH does not charge for their integration.

## MCP catalog

Secret-free-first (prefer OAuth/remote over tokens-in-file); the risk axes
(egress, credentials, supply-chain) are serialized into `.mcp.json` as
reviewer-visible data; enterprise tightening is an opt-in overlay that leaves the
default output byte-identical.

## Report honesty

- **Live, preview, or omit — never demo data styled as real**, in both the
  hydrated DOM and the static body. Omit-when-absent is a server decision.
- **No cost / forecast / ROI panels** — cost is unpredictable. Score labels say
  "wiring", not "quality".
- **The shipped report is the spec** (`docs/specs/local-report-v9/`) — diff a
  prototype against it and warn on regressions rather than adopting it. Adopt
  design ideas additively; confirm before any structural reorganization.
- Every surfaced gap names the exact `aih <command>` that closes it, and that
  command must be runnable.
