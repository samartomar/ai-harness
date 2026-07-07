# Deferred analytics Tiers 2 and 3

> Status: design note / deferred decision record. Tier 1 is shipped through
> `aih report`, `aih usage`, and the operator-run analytics fetcher. This note
> scopes what would have to be true before a shared collector or hosted service
> becomes product work.

## Decision

Tier 2 is an **operator-owned shared collector** for aggregate team analytics.
It may combine local `.aih/usage.jsonl` events, Claude telemetry routed through
the generated OpenTelemetry collector, and already-fetched Admin API exports.
It does not change the local CLI contract: `aih report` still reads local files
or saved exports, and `aih` itself does not call remote analytics systems.

Tier 3 is a **hosted analytics SaaS** decision, not a current implementation
commitment. It remains deferred until the trigger conditions below are met.
If built later, it must be a visible product boundary with explicit enrollment,
not a hidden default destination for local commands.

## Invariants

- **D2 is preserved:** `aih report` reads local JSON/artifacts only. It never
  fetches analytics, starts a daemon, opens a localhost service, or posts to a
  hosted backend.
- `aih telemetry` may write collector/fetcher files and operator docs, but it
  does not schedule cron, run the fetcher, or call the Admin API.
- `.aih/usage.jsonl` remains local, gitignored, append-only, and opt-in through
  `aih usage --apply` or explicit imports.
- Raw prompts, tool I/O, secrets, command args, and source file contents are not
  Tier 2 inputs. Any future collector must stay aggregate-first.
- Empty or missing data renders as empty/PREVIEW state, never demo data or
  zeros presented as measured activity.

## Tier 2 shared collector scope

Tier 2 exists to answer questions Tier 1 deliberately avoids because they need
an org-owned data plane rather than one developer's local files:

- per-skill and per-agent cost/counter rollups by team, repo, CLI, and time
  window;
- skill adoption and dormancy across many repos without requiring operators to
  run `aih usage --rollup <dir...>` manually;
- cache/token efficiency trends where the collector receives token/cache
  counters from multiple machines;
- aggregate MCP/tool usage and failure rates for platform governance.

Allowed inputs:

- `.aih/usage.jsonl` event rows after local hook installation;
- OpenTelemetry records that pass through the generated redacting collector;
- `fetch-analytics.mjs --run` output saved by an operator or scheduled outside
  `aih`;
- repo metadata that is already present in local report artifacts, reduced to
  repo id/name, branch, commit, and configured CLI surface.

Privacy and data-shape constraints:

- Aggregate before leaving the workstation or project-controlled collector
  whenever possible.
- Use stable hashed identities for users and machines unless an organization
  explicitly configures named reporting.
- Keep skill names, tool names, MCP server names, model names, token/cache
  counters, verdict counts, and timestamps at bucket granularity.
- Drop or redact prompts, tool arguments, tool results, file contents, secret
  values, absolute home paths, and arbitrary environment variables.
- Retain source rows only for the shortest configured diagnostic window; long
  term storage should use rolled-up buckets.
- Treat pricing as a derived aggregate. Do not write per-prompt or per-session
  dollar rows into the local sink.

Tier 2 remains operator-owned: `aih` can generate config, schemas, and docs, but
starting or hosting the collector is an explicit platform step.

## Tier 3 hosted SaaS trigger conditions

Hosted analytics stays deferred until all of these are true:

- Tier 2's aggregate schema has stabilized across at least two release cycles.
- A privacy review approves the exact collected fields, retention defaults,
  redaction rules, and opt-in enrollment path.
- Customers need cross-org dashboards, SSO/RBAC, audit logs, retention policy,
  data residency, or managed alerting that self-hosted Tier 2 cannot satisfy.
- The hosted path has a documented export/delete story and a local-only fallback
  that preserves the shipped OSS behavior.
- The CLI contract stays explicit: no default remote endpoint, no background
  upload from `aih report`, `aih usage`, or `aih telemetry`, and no silent SaaS
  enrollment through config discovery.

Non-triggers:

- A prettier dashboard alone.
- Desire to centralize data before the aggregate schema and privacy contract
  are stable.
- Convenience for the project maintainers at the cost of the local-only D2
  invariant.

## Relationship to shipped commands

- `aih report --org <export.json>` remains the Tier 1 enterprise digest over a
  saved Admin API export.
- `aih usage --rollup <dir...>` remains the scan-on-demand local/cross-project
  rollup.
- `aih telemetry` remains a generator for operator-run collector/fetcher assets.
- A future Tier 2 command may validate collector config or emit aggregate schema
  examples, but it must not start collection or send data under default dry-run
  behavior.
