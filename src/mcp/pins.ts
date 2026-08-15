/**
 * Exact package-pin parsing for MCP package resolvers.
 *
 * A version-shaped argument alone is not evidence that a server will execute that
 * package. Keep the resolver grammar here so generated catalog metadata, runtime
 * verification, and incoming-config attestation agree about the launch operand.
 */

export interface ExactNpmPackagePin {
  packageName: string;
  version: string;
  spec: string;
}

const NPM_PACKAGE_SPEC =
  /^(@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const PYTHON_PACKAGE_SPEC =
  /^([A-Za-z0-9._-]+(?:\[[A-Za-z0-9._,-]+\])?)(?:@|==)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

const UVX_BOOLEAN_OPTIONS = new Set([
  "--isolated",
  "--no-cache",
  "--no-config",
  "--no-env-file",
  "--no-index",
  "--no-progress",
  "--no-python-downloads",
  "--no-sources",
  "--offline",
]);

const NPX_BOOLEAN_OPTIONS = new Set(["-y", "-q", "--no", "--quiet", "--yes"]);
export type McpPackageResolver = "npx" | "uvx";

export function mcpResolverLike(command: string): McpPackageResolver | undefined {
  const last = command.split(/[\\/]/).at(-1) ?? command;
  const normalized = last.replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
  return normalized === "npx" || normalized === "uvx" ? normalized : undefined;
}

export function mcpPackageResolver(command: string): McpPackageResolver | undefined {
  return command === "npx" || command === "uvx" ? command : undefined;
}

function exactNpmPackagePin(value: string): ExactNpmPackagePin | undefined {
  const spec = value.trim();
  const match = NPM_PACKAGE_SPEC.exec(spec);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { packageName: match[1], version: match[2], spec };
}

export function hasExactPackagePin(value: string): boolean {
  return exactNpmPackagePin(value) !== undefined || PYTHON_PACKAGE_SPEC.test(value.trim());
}

function hasExactPythonPackagePin(value: string): boolean {
  return PYTHON_PACKAGE_SPEC.test(value.trim());
}

function optionValue(arg: string, option: string): string | undefined {
  const prefix = `${option}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : undefined;
}

/**
 * Returns the npm packages that an `npx` launch explicitly resolves. An empty
 * result means the command has no exact package evidence and must be treated as
 * unpinned. Only npx's direct package operand is accepted: `--package` / `--call`
 * modes can execute a different or arbitrary command and need separate provenance.
 */
export function npxLaunchPins(args: readonly string[]): ExactNpmPackagePin[] {
  let primary: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      primary ??= args[index + 1];
      break;
    }
    if (NPX_BOOLEAN_OPTIONS.has(arg)) continue;
    if (arg.startsWith("-")) return [];
    primary ??= arg;
    break;
  }
  const selected = primary === undefined ? [] : [primary];
  if (selected.length === 0) return [];
  const pins = selected.map(exactNpmPackagePin);
  return pins.every((pin) => pin !== undefined) ? (pins as ExactNpmPackagePin[]) : [];
}

interface UvxLaunchOperands {
  primary?: string;
  withPackages: string[];
  /** A source-changing/unknown option was seen — no exact-pin evidence possible. */
  disqualified: boolean;
}

/**
 * Walk a `uvx` launch's args to its executable operands. The direct positional
 * package operand is the only supported executable form: `--from` can run an
 * arbitrary command and therefore needs package-bin provenance beyond this
 * syntax-only parse. Any source-changing option that requires an external file,
 * editable path, or alternative index disqualifies the launch until an artifact
 * provenance model can verify it.
 */
function uvxLaunchOperands(args: readonly string[]): UvxLaunchOperands {
  let primary: string | undefined;
  const withPackages: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      primary ??= args[index + 1];
      break;
    }

    if (arg === "--from" || optionValue(arg, "--from") !== undefined) {
      return { withPackages, disqualified: true };
    }

    const withValue = optionValue(arg, "--with");
    if (withValue !== undefined) {
      withPackages.push(withValue);
      continue;
    }
    if (arg === "--with" || arg === "-w") {
      const value = args[index + 1];
      if (value === undefined) return { withPackages, disqualified: true };
      withPackages.push(value);
      index += 1;
      continue;
    }
    if (
      arg === "--with-editable" ||
      optionValue(arg, "--with-editable") !== undefined ||
      arg === "--with-requirements" ||
      optionValue(arg, "--with-requirements") !== undefined
    ) {
      return { withPackages, disqualified: true };
    }
    if (UVX_BOOLEAN_OPTIONS.has(arg)) continue;
    if (arg.startsWith("-")) return { withPackages, disqualified: true };
    primary = arg;
    break;
  }
  return { primary, withPackages, disqualified: false };
}

/**
 * Checks whether `uvx` has exactly pinned its executable package and every
 * explicitly added package (see {@link uvxLaunchOperands} for the grammar).
 */
function hasPinnedUvxLaunch(args: readonly string[]): boolean {
  const operands = uvxLaunchOperands(args);
  return (
    !operands.disqualified &&
    operands.primary !== undefined &&
    hasExactPythonPackagePin(operands.primary) &&
    operands.withPackages.every(hasExactPythonPackagePin)
  );
}

export interface ExactUvxPackagePin {
  packageName: string;
  version: string;
  spec: string;
}

function exactUvxPackagePin(value: string): ExactUvxPackagePin | undefined {
  const spec = value.trim();
  const match = PYTHON_PACKAGE_SPEC.exec(spec);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { packageName: match[1], version: match[2], spec };
}

/**
 * The exact PRIMARY package pin behind a `uvx` launch — the distribution whose
 * running server self-reports `serverInfo.version` — returned only when the whole
 * launch is exactly pinned (primary AND every `--with`) with no source-changing
 * option. `undefined` means the launch carries no attestable exact-pin evidence.
 */
export function uvxPrimaryPin(args: readonly string[]): ExactUvxPackagePin | undefined {
  if (!hasPinnedUvxLaunch(args)) return undefined;
  const primary = uvxLaunchOperands(args).primary;
  return primary === undefined ? undefined : exactUvxPackagePin(primary);
}

function hasResolverEnvironmentOverride(
  env: Readonly<Record<string, unknown>> | undefined,
): boolean {
  // A launch-specific environment can replace the bare resolver executable
  // (`PATH`) or alter its loader, registry, interpreter, or config. Credential
  // provenance is a separate concern; exact package-pin evidence is intentionally
  // limited to catalog launchers with no config-provided environment.
  return Object.keys(env ?? {}).length > 0;
}

/**
 * `undefined` means this is not a package resolver. For npx/uvx, return a
 * fail-closed supply-chain classification based only on their actual launch
 * operands.
 */
export function mcpResolverPinState(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, unknown>>,
): "pinned" | "unpinned" | undefined {
  switch (mcpPackageResolver(command)) {
    case "npx":
      return !hasResolverEnvironmentOverride(env) && npxLaunchPins(args).length > 0
        ? "pinned"
        : "unpinned";
    case "uvx":
      return !hasResolverEnvironmentOverride(env) && hasPinnedUvxLaunch(args)
        ? "pinned"
        : "unpinned";
    default:
      return undefined;
  }
}

/**
 * Repo-local MCP configs whose servers carry pin evidence. Both `.mcp.json` (Claude/Kimi)
 * and `.kiro/settings/mcp.json` use the identical `mcpServers` → `{command,args,env}`
 * shape, so pin attestation and currency read both without normalization. Kiro was absent
 * here while `aih policy project` was writing governed servers into it — the two most
 * security-relevant doctor flags had no Kiro coverage at all.
 *
 * Deliberately NOT the full `MCP_CONFIG_FILES` set: `.vscode/mcp.json` and `opencode.json`
 * use different shapes and would need the normalization `baseline/attestation.ts` carries.
 */
export const MCP_PIN_CONFIG_FILES: readonly string[] = [".mcp.json", ".kiro/settings/mcp.json"];

/**
 * Qualify a server name with its config file so same-named servers across configs stay
 * distinguishable in reports. `.mcp.json` keeps the bare name, so existing Claude-only
 * output is unchanged.
 */
export function mcpLaunchLabel(server: string, configRel: string): string {
  return configRel === ".mcp.json" ? server : `${server} @ ${configRel}`;
}

/** Inverse of {@link mcpLaunchLabel}: the bare server name for catalog/name-keyed lookups. */
export function mcpLaunchServerName(label: string): string {
  const separator = label.indexOf(" @ ");
  return separator === -1 ? label : label.slice(0, separator);
}
