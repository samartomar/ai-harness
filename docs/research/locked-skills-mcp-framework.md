# Locked-skills MCP server framework decision

> Status: design decision / deferred implementation record. This chooses the
> framework for the future locked-skills MCP server; it does not add a shipped
> server or change current `aih` command behavior.

## Decision

Build the first locked-skills MCP server in **Python with FastMCP 3.x**, pinned
to an exact reviewed release such as `fastmcp==3.2.4` and locked with hashes.

The server should expose approved skill content through FastMCP's native skill
providers:

```python
from fastmcp.server.providers.skills import SkillsDirectoryProvider

provider = SkillsDirectoryProvider(
    roots=approved_skill_roots,
    reload=False,
    supporting_files="template",
)
```

`reload=False` is part of the runtime contract. A process serves the approved
snapshot it was started with; approval changes require an explicit restart after
the lockfile and skill-card checks pass again.

The default transport is stdio-only. Do not ship the FastMCP dev UI, browser
preview, HTTP transport, or auto-reload path as part of the locked server.

## Why FastMCP 3.x

The locked server's core job is narrow: expose approved `SKILL.md` content and
its supporting files as MCP resources, not execute arbitrary skill code.
FastMCP 3.x already has `SkillProvider` and `SkillsDirectoryProvider` for that
domain, so the server can rely on a reviewed provider instead of maintaining a
custom skill-directory scanner, manifest builder, and resource URI mapper.

That dependency is a larger security surface than the low-level official SDK,
so the choice only holds with these constraints:

- pin the exact FastMCP release and transitive dependency lock;
- load roots derived from `aih-skills.lock.json` and committed skill cards, not
  arbitrary user-provided paths;
- reject traversal, absolute-path escapes, duplicate names, missing cards,
  missing lock entries, pin mismatches, and unsupported symlinks before server
  startup;
- use `supporting_files="template"` so supporting files are addressable without
  full upfront enumeration;
- expose resources and optional read-only metadata only; do not expose tools
  that install, approve, vet, fetch, modify, or delete skills;
- do not perform network fetches or package installs from the server process;
- log only skill names, stable source ids, verdicts, and rejected-path codes.

## Alternatives

### Official Python MCP SDK

The official Python SDK remains the fallback if security review rejects the
FastMCP dependency surface. It exposes both high-level `FastMCP` decorators and
low-level server primitives, which is enough to build a minimal stdio resource
server.

Rejected for the first slice because it does not provide the skill-provider
abstraction the locked-skills server needs. Using it first would move the risk
from dependency surface to bespoke filesystem and resource-mapping code.

### Official TypeScript MCP SDK

The official TypeScript SDK is a good fit for ordinary Node-hosted MCP servers:
it has `McpServer`, stdio transport, Zod schemas, and low-level request
handlers. It is not the first choice here because the TypeScript SDK has no
native `SkillProvider` or `SkillsDirectoryProvider` equivalent. A TypeScript
implementation would need to recreate the locked skill loader and resource
provider behavior.

TypeScript can be reconsidered if the repo needs a single-language package or
if a later official SDK release adds a reviewed skills provider.

### FastMCP dev server or reload mode

The dev server, browser UI, HTTP transport, and reload mode are rejected for the
locked server. They are useful for local development, but the production shape
should be a stable stdio process over already-approved local bytes.

## Implementation guardrails

- The server root set is derived from the committed approval authority, not from
  ambient environment variables or a client-supplied path.
- Startup is fail-closed: no valid lockfile, no server.
- Resource names are stable and scoped by approved skill name.
- The server is read-only. Runtime mutation stays in existing `aih skill`,
  `aih pack`, and `aih workspace` commands behind their current dry-run/apply
  gates.
- The server must not make remote calls, start background watchers, or run a
  package manager after launch.
- Tests should cover lockfile filtering, duplicate-name behavior, traversal and
  symlink refusal, and the no-reload snapshot boundary.

## Source links

- FastMCP skills provider docs:
  <https://github.com/prefecthq/fastmcp/blob/v3.2.4/docs/servers/providers/skills.mdx>
- FastMCP `SkillsDirectoryProvider` docs:
  <https://gofastmcp.com/python-sdk/fastmcp-server-providers-skills-directory_provider>
- Official Python MCP SDK:
  <https://github.com/modelcontextprotocol/python-sdk/blob/v1.12.4/README.md>
- Official TypeScript MCP SDK:
  <https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/server.md>
