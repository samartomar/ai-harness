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

/**
 * Checks whether `uvx` has exactly pinned its executable package and every
 * explicitly added package. The direct positional package operand is the only
 * supported executable form: `--from` can run an arbitrary command and therefore
 * needs package-bin provenance beyond this syntax-only check. Any source-changing
 * option that requires an external file, editable path, or alternative index is
 * unpinned until an artifact provenance model can verify it.
 */
function hasPinnedUvxLaunch(args: readonly string[]): boolean {
  let primary: string | undefined;
  const withPackages: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      primary ??= args[index + 1];
      break;
    }

    if (arg === "--from" || optionValue(arg, "--from") !== undefined) return false;

    const withValue = optionValue(arg, "--with");
    if (withValue !== undefined) {
      withPackages.push(withValue);
      continue;
    }
    if (arg === "--with" || arg === "-w") {
      const value = args[index + 1];
      if (value === undefined) return false;
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
      return false;
    }
    if (UVX_BOOLEAN_OPTIONS.has(arg)) continue;
    if (arg.startsWith("-")) return false;
    primary = arg;
    break;
  }
  return (
    primary !== undefined &&
    hasExactPythonPackagePin(primary) &&
    withPackages.every(hasExactPythonPackagePin)
  );
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
