# FastMCP 3 vs official mcp for skills-over-MCP

> Status: design note / verified comparison. This preserves the framework
> decision context for #276; it does not add a shipped server, command, or
> runtime behavior.

## Decision

Keep the #274 implementation direction: use pinned **Python FastMCP 3.x** for
the first locked-skills MCP server, with the official Python `mcp` SDK as the
fallback if dependency review rejects FastMCP's larger surface.

That choice is about implementation ergonomics only. The framework choice is
orthogonal to the skills-over-MCP governance gap: neither FastMCP 3.x nor the
official `mcp` SDK replaces `aih` policy for server package pins, approved skill
cards, lockfile-derived roots, `_manifest` SHA-256 evidence, hot-reload drift,
egress classification, or enterprise source approval.

## Verified comparison

| Topic | FastMCP 3.x (`fastmcp`) | Official Python `mcp` SDK | `aih` implication |
| --- | --- | --- | --- |
| Skills serving shape | Provides skills providers that expose `SKILL.md`, supporting files, and synthetic `_manifest` resources under `skill://...` URIs. | Provides MCP Resources, Tools, Prompts, stdio transport, and low-level server primitives. The returned docs do not show a native `SkillProvider` or `SkillsDirectoryProvider`. | FastMCP reduces custom filesystem/resource mapping code for the first locked server. |
| Directory provider | `SkillsDirectoryProvider` can scan a configured root and create providers for skill subdirectories. | A comparable provider would need to be written on top of Resources. | FastMCP is the shorter path as long as roots come only from `aih-skills.lock.json` and approved cards. |
| Supporting files | Supporting files can be exposed as templates or visible resources. | Supporting file behavior would be custom resource handlers. | Use `supporting_files="template"` so files are addressable without broad upfront enumeration. |
| Reload behavior | Provider reload exists for some provider classes; locked-server posture keeps reload disabled. | Any reload/watch behavior would be custom code. | Reload or hot reload remains a supply-chain drift signal and is denied by the trust gate. |
| Dependency surface | Larger third-party dependency surface but less bespoke loader code. | Smaller official-SDK dependency surface but more bespoke skill-serving code. | Dependency review can still force the fallback; the governance controls stay the same either way. |

## SEP-2640 context

As verified on July 7, 2026, the Skills Over MCP Working Group records SEP-2640
as the current Resources-based direction and lists the Skills Extension work as
in review. The experimental repo also marks itself as incubation, not a final
specification.

The draft SEP describes skills as ordinary MCP Resources:

- `SKILL.md` and supporting files are exposed through `skill://...` resource
  URIs.
- A `skill://index.json` resource can enumerate skills, but enumeration is not
  required.
- Skill files are read through the existing `resources/read` method.
- The extension adds no new protocol methods or capabilities.
- The skill payload format is delegated to the Agent Skills specification.
- Skill content remains untrusted model input and must not trigger implicit
  local execution.

The draft index omits the Agent Skills `digest` field because it treats
integrity as the transport's concern over an authenticated MCP connection. That
means the draft does not standardize artifact signing, server package pinning,
hot-reload policy, or an `aih` approval model. Those remain local governance
requirements, implemented through the #275 trust gate rather than through the
framework selection.

## Consequence

The persisted decision is:

- choose pinned Python FastMCP 3.x for the first locked-skills server because it
  already has skills-provider ergonomics;
- keep the official Python `mcp` SDK as the fallback if FastMCP's dependency
  surface is not acceptable;
- treat SEP-2640 as draft/in-review input, not as a completed governance layer;
- keep the trust gate as the authority for pins, approved sources,
  `_manifest` SHA-256 evidence, reload denial, and egress classification.

Revisit this note if SEP-2640 reaches final status or an official SDK release
ships a reviewed skills-provider abstraction with signing, versioning, or
pinning semantics that overlap `aih` policy.

## Source links

- MCP Skills Over MCP Working Group charter:
  <https://modelcontextprotocol.io/community/working-groups/skills-over-mcp>
- Experimental Skills Over MCP repository:
  <https://github.com/modelcontextprotocol/experimental-ext-skills>
- SEP-2640 draft copy:
  <https://github.com/modelcontextprotocol/experimental-ext-skills/blob/main/docs/sep-draft-skills-extension.md>
- FastMCP skills provider docs:
  <https://github.com/prefecthq/fastmcp/blob/v3.2.4/docs/python-sdk/fastmcp-server-providers-skills-skill_provider.mdx>
- FastMCP skills package docs:
  <https://github.com/prefecthq/fastmcp/blob/v3.2.4/docs/python-sdk/fastmcp-server-providers-skills-__init__.mdx>
- Official Python MCP SDK:
  <https://github.com/modelcontextprotocol/python-sdk/blob/v1.12.4/README.md>
