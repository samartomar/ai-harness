/** Historical destination mapping used to authenticate shipped runtime descriptors. */
export function eccContentDestinationMapping(
  source: string,
  target: string | undefined,
): { scope: "project" | "home"; relative: string } | undefined {
  if (source === "AGENTS.md") return { scope: "project", relative: "AGENTS.md" };
  if (source === ".codex/AGENTS.md") {
    return { scope: "home", relative: ".codex/AGENTS.md" };
  }
  if (target === undefined) return undefined;
  const targetRoot = target === "kimi" ? ".kimi-code" : `.${target}`;
  const mappings: Array<[string, string]> = [
    [".agents/plugins/", ".agents/plugins/"],
    [".agents/skills/", ".agents/skills/"],
    ...(target === "claude"
      ? ([[".claude/commands/", ".claude/commands/"]] as Array<[string, string]>)
      : []),
    ...(target === "opencode"
      ? ([
          // OpenCode consumes the cross-tool `.agents/skills` convention. Prefer
          // an upstream `.agents/skills` copy when present; `skills/` is the
          // source fallback handled by the target adapter.
          ["skills/", ".agents/skills/"],
        ] as Array<[string, string]>)
      : ([
          ["agents/", `${targetRoot}/agents/`],
          ["skills/", `${targetRoot}/skills/`],
          ["commands/", `${targetRoot}/commands/`],
          ["rules/", `${targetRoot}/rules/`],
        ] as Array<[string, string]>)),
  ];
  for (const [sourcePrefix, targetPrefix] of mappings) {
    if (!source.startsWith(sourcePrefix)) continue;
    const suffix = source.slice(sourcePrefix.length);
    if (suffix.length === 0) return undefined;
    return { scope: "project", relative: `${targetPrefix}${suffix}` };
  }
  return undefined;
}
