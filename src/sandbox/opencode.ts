import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import {
  type Action,
  exec,
  type FileAssertion,
  type PlanContext,
  writeJson,
  writeText,
} from "../internals/plan.js";

export const OPENCODE_SANDBOX_PROFILE = ".aih/sandbox/opencode.json";
export const OPENCODE_SANDBOX_HOME = ".aih/sandbox/opencode-home";
const OPENCODE_PROJECT_CONFIG = "opencode.json";
const AIH_PROJECT_CONFIG = ".aih-config.json";

const EnvironmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const OPENCODE_BOOLEAN_BINDINGS = new Set([
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
]);
const BOOLEAN_BINDING_VALUES = new Set(["0", "1", "false", "true"]);
const FORBIDDEN_ENV = new Set([
  "AIH_ORG_POLICY",
  "HOME",
  "XDG_CONFIG_HOME",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PYTHONPATH",
  "PYTHONHOME",
]);
const EnvironmentSchema = z.record(EnvironmentName, z.string()).superRefine((environment, ctx) => {
  for (const name of Object.keys(environment)) {
    if (
      FORBIDDEN_ENV.has(name) ||
      (name !== "PATH" && !name.startsWith("AIH_") && !OPENCODE_BOOLEAN_BINDINGS.has(name))
    ) {
      ctx.addIssue({
        code: "custom",
        message: `unsafe persisted environment name ${name}`,
      });
    }
    if (
      OPENCODE_BOOLEAN_BINDINGS.has(name) &&
      !BOOLEAN_BINDING_VALUES.has(environment[name] ?? "")
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${name} requires 0, 1, false, or true`,
      });
    }
  }
});
const PathIdentitySchema = z
  .object({
    kind: z.enum(["file", "directory"]),
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
  })
  .strict();
const ProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    client: z.literal("opencode"),
    root: z.string(),
    policy: z.string(),
    policySha256: z.string().regex(/^[a-f0-9]{64}$/),
    bwrapExecutable: z.string(),
    bwrapSha256: z.string().regex(/^[a-f0-9]{64}$/),
    opencodeExecutable: z.string(),
    opencodeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    seccompExecutable: z.string(),
    seccompSha256: z.string().regex(/^[a-f0-9]{64}$/),
    environment: EnvironmentSchema,
    hiddenPaths: z.array(z.string()),
    readOnlyPaths: z.array(z.string()),
    pathIdentities: z.record(z.string(), PathIdentitySchema),
    clientArgs: z.array(z.string()),
  })
  .strict();
export type OpenCodeSandboxProfile = z.infer<typeof ProfileSchema>;

const O_NOFOLLOW = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;

function readStableRegularFile(path: string, unsafeMessage: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) throw new Error("unsafe file");
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      realpathSync(path) !== path
    ) {
      throw new Error("file changed while reading");
    }
    return bytes;
  } catch {
    throw new AihError(unsafeMessage, "AIH_CONFIG");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function values(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new AihError("sandbox option must be supplied as text", "AIH_CONFIG");
}

function absolutePaths(root: string, value: unknown, option: string): string[] {
  return values(value).map((path) => {
    if (!isAbsolute(path) || path.includes("\0") || path.includes("\r") || path.includes("\n")) {
      throw new AihError(`${option} requires an absolute path`, "AIH_CONFIG");
    }
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("symlink");
    } catch {
      throw new AihError(`${option} path is missing or symlinked: ${path}`, "AIH_CONFIG");
    }
    const resolved = realpathSync(path);
    if (resolved === root) {
      throw new AihError(`${option} cannot name the sandbox root`, "AIH_CONFIG");
    }
    return resolved;
  });
}

function pathIdentity(path: string): z.infer<typeof PathIdentitySchema> {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error("unsafe path");
    const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
    if (kind === undefined) throw new Error("unsupported path type");
    return { kind, dev: String(stat.dev), ino: String(stat.ino) };
  } catch {
    throw new AihError(
      `OpenCode sandbox path identity is unavailable or unsafe: ${path}`,
      "AIH_CONFIG",
    );
  }
}

function assertPathIdentities(profile: OpenCodeSandboxProfile): void {
  const configured = [...profile.hiddenPaths, ...profile.readOnlyPaths];
  if (
    Object.keys(profile.pathIdentities).length !== configured.length ||
    configured.some((path) => !Object.hasOwn(profile.pathIdentities, path))
  ) {
    throw new AihError(
      "OpenCode sandbox path identities do not match configured paths",
      "AIH_CONFIG",
    );
  }
  for (const path of configured) {
    const expected = profile.pathIdentities[path];
    const current = pathIdentity(path);
    if (
      expected === undefined ||
      expected.kind !== current.kind ||
      expected.dev !== current.dev ||
      expected.ino !== current.ino
    ) {
      throw new AihError(`OpenCode sandbox path changed after setup: ${path}`, "AIH_CONFIG");
    }
  }
}

function externalExecutable(
  root: string,
  value: unknown,
  option: string,
  expectedSha256?: string,
): { path: string; sha256: string } {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new AihError(`${option} requires an absolute executable path`, "AIH_CONFIG");
  }
  const path = resolve(value);
  if (containsPath(root, path)) {
    throw new AihError(`${option} must be outside the project root`, "AIH_CONFIG");
  }
  const bytes = readStableRegularFile(
    path,
    `${option} executable does not exist or is unsafe: ${path}`,
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw new AihError(`${option} executable changed after sandbox setup: ${path}`, "AIH_CONFIG");
  }
  return { path, sha256 };
}

function bindings(value: unknown): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const binding of values(value)) {
    const separator = binding.indexOf("=");
    const name = separator < 0 ? "" : binding.slice(0, separator);
    const value = separator < 0 ? "" : binding.slice(separator + 1);
    if (!EnvironmentName.safeParse(name).success || value.length === 0 || value.includes("\0")) {
      throw new AihError("--binding requires NAME=non-secret-value", "AIH_CONFIG");
    }
    if (!EnvironmentSchema.safeParse({ [name]: value }).success) {
      throw new AihError(`--binding refuses unsafe environment name ${name}`, "AIH_CONFIG");
    }
    if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY)/i.test(name)) {
      throw new AihError(`--binding refuses secret-bearing name ${name}`, "AIH_CONFIG");
    }
    environment[name] = value;
  }
  return environment;
}

function selectedOpenCode(value: unknown): boolean {
  return (
    value === "opencode" || (Array.isArray(value) && value.length === 1 && value[0] === "opencode")
  );
}

function readProfile(root: string): OpenCodeSandboxProfile {
  const raw = readIfExists(join(root, OPENCODE_SANDBOX_PROFILE));
  if (raw === undefined) {
    throw new AihError(
      "OpenCode sandbox is not configured for this root; apply sandbox setup first",
      "AIH_CONFIG",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AihError(
      "OpenCode sandbox profile is malformed; apply sandbox setup again",
      "AIH_CONFIG",
    );
  }
  const profile = ProfileSchema.safeParse(parsed);
  if (!profile.success || resolve(profile.data.root) !== root) {
    throw new AihError("OpenCode sandbox profile does not belong to this root", "AIH_CONFIG");
  }
  return profile.data;
}

/** Restore the root-bound authority selection before shared posture/governance resolution. */
export function openCodeSandboxPolicyBinding(root: string): string {
  const resolvedRoot = resolve(root);
  const profile = readProfile(resolvedRoot);
  return externalPolicy(resolvedRoot, profile.policy, profile.policySha256).path;
}

function externalFileAssertion(path: string, sha256: string, describe: string): FileAssertion {
  const file = lstatSync(path);
  const volumeRoot = parse(path).root;
  const parent = dirname(path);
  const rel = relative(volumeRoot, parent);
  const parents: Array<{ path: string; dev: string; ino: string }> = [];
  let current = volumeRoot;
  for (const part of ["", ...rel.split(/[\\/]+/).filter(Boolean)]) {
    if (part !== "") current = resolve(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current) {
      throw new AihError(`unsafe external file custody parent: ${current}`, "AIH_CONFIG");
    }
    parents.push({ path: current, dev: String(stat.dev), ino: String(stat.ino) });
  }
  return {
    path,
    sha256,
    maxBytes: Math.max(1, file.size),
    describe,
    external: true,
    trustedBase: parent,
    externalCustody: { file: { dev: String(file.dev), ino: String(file.ino) }, parents },
  };
}

/** Transaction pins for the profile and each external executable consumed at launch. */
export function openCodeSandboxAssertions(root: string): FileAssertion[] {
  const resolvedRoot = resolve(root);
  const profile = readProfile(resolvedRoot);
  externalExecutable(
    resolvedRoot,
    profile.bwrapExecutable,
    "persisted bubblewrap",
    profile.bwrapSha256,
  );
  externalExecutable(
    resolvedRoot,
    profile.seccompExecutable,
    "persisted seccomp",
    profile.seccompSha256,
  );
  externalExecutable(
    resolvedRoot,
    profile.opencodeExecutable,
    "persisted OpenCode",
    profile.opencodeSha256,
  );
  externalPolicy(resolvedRoot, profile.policy, profile.policySha256);
  assertPathIdentities(profile);
  const profilePath = join(resolvedRoot, OPENCODE_SANDBOX_PROFILE);
  const profileBytes = readFileSync(profilePath);
  return [
    {
      path: OPENCODE_SANDBOX_PROFILE,
      sha256: createHash("sha256").update(profileBytes).digest("hex"),
      maxBytes: Math.max(1, profileBytes.length),
      describe: "persisted OpenCode sandbox profile",
    },
    externalFileAssertion(
      profile.bwrapExecutable,
      profile.bwrapSha256,
      "pinned bubblewrap executable",
    ),
    externalFileAssertion(
      profile.seccompExecutable,
      profile.seccompSha256,
      "pinned seccomp executable",
    ),
    externalFileAssertion(
      profile.opencodeExecutable,
      profile.opencodeSha256,
      "pinned OpenCode executable",
    ),
    externalFileAssertion(profile.policy, profile.policySha256, "pinned organization policy"),
  ];
}

function hiddenPathArgs(path: string): string[] {
  return lstatSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path];
}

function containsPath(parent: string, child: string): boolean {
  const base = resolve(parent);
  const candidate = resolve(child);
  const fromBase = relative(base, candidate);
  return (
    fromBase === "" ||
    (fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase))
  );
}

function validateExposure(profile: OpenCodeSandboxProfile): void {
  for (const configured of [...profile.hiddenPaths, ...profile.readOnlyPaths]) {
    if (containsPath(configured, profile.root)) {
      throw new AihError(
        `OpenCode sandbox exposure path cannot contain the project root: ${configured}`,
        "AIH_CONFIG",
      );
    }
  }
  for (const hidden of profile.hiddenPaths) {
    for (const exposed of [
      ...profile.readOnlyPaths,
      profile.policy,
      profile.opencodeExecutable,
      profile.seccompExecutable,
      profile.bwrapExecutable,
    ]) {
      if (containsPath(hidden, exposed) || containsPath(exposed, hidden)) {
        throw new AihError(
          `OpenCode sandbox refuses overlapping hidden and required path: ${hidden}`,
          "AIH_CONFIG",
        );
      }
    }
  }
}

function externalPolicy(
  root: string,
  value: unknown,
  expectedSha256?: string,
): { path: string; sha256: string } {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new AihError(
      "OpenCode sandbox setup requires an absolute external --policy",
      "AIH_CONFIG",
    );
  }
  const path = resolve(value);
  if (containsPath(root, path)) {
    throw new AihError("OpenCode sandbox policy must be outside the project root", "AIH_CONFIG");
  }
  const bytes = readStableRegularFile(
    path,
    `OpenCode sandbox policy is missing or unsafe: ${path}`,
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw new AihError(`OpenCode sandbox policy changed after setup: ${path}`, "AIH_CONFIG");
  }
  return { path, sha256 };
}

export function openCodeSandboxActions(ctx: PlanContext): Action[] {
  const launch = ctx.options.launch === true;
  const configuring =
    values(ctx.options.binding).length > 0 ||
    values(ctx.options.hidePath).length > 0 ||
    values(ctx.options.readOnlyPath).length > 0 ||
    values(ctx.options.clientArg).length > 0 ||
    ctx.options.opencodeExecutable !== undefined ||
    ctx.options.seccompExecutable !== undefined ||
    ctx.options.bwrapExecutable !== undefined;
  if (!launch && !configuring) return [];
  if (process.platform !== "linux" && ctx.host.platform !== "linux") {
    throw new AihError("OpenCode sandbox launch is supported on Linux only", "AIH_CONFIG");
  }
  if (!selectedOpenCode(ctx.options.cli)) {
    throw new AihError("OpenCode sandbox setup requires exactly --cli opencode", "AIH_CONFIG");
  }

  const root = resolve(ctx.root);
  const opencode = launch
    ? undefined
    : externalExecutable(root, ctx.options.opencodeExecutable, "--opencode-executable");
  const seccomp = launch
    ? undefined
    : externalExecutable(root, ctx.options.seccompExecutable, "--seccomp-executable");
  const bwrap = launch
    ? undefined
    : externalExecutable(root, ctx.options.bwrapExecutable, "--bwrap-executable");
  const policy = launch ? undefined : externalPolicy(root, ctx.env.AIH_ORG_POLICY);
  const hiddenPaths = launch ? undefined : absolutePaths(root, ctx.options.hidePath, "--hide-path");
  const readOnlyPaths = launch
    ? undefined
    : absolutePaths(root, ctx.options.readOnlyPath, "--read-only-path");
  const profile = launch
    ? readProfile(root)
    : ProfileSchema.parse({
        schemaVersion: 1,
        client: "opencode",
        root,
        policy: policy?.path,
        policySha256: policy?.sha256,
        bwrapExecutable: bwrap?.path,
        bwrapSha256: bwrap?.sha256,
        opencodeExecutable: opencode?.path,
        opencodeSha256: opencode?.sha256,
        seccompExecutable: seccomp?.path,
        seccompSha256: seccomp?.sha256,
        environment: bindings(ctx.options.binding),
        hiddenPaths,
        readOnlyPaths,
        pathIdentities: Object.fromEntries(
          [...(hiddenPaths ?? []), ...(readOnlyPaths ?? [])].map((path) => [
            path,
            pathIdentity(path),
          ]),
        ),
        clientArgs: values(ctx.options.clientArg),
      });
  validateExposure(profile);
  assertPathIdentities(profile);

  if (!launch) {
    try {
      lstatSync(profile.policy);
    } catch {
      throw new AihError(`--policy path does not exist: ${profile.policy}`, "AIH_CONFIG");
    }
    return [
      writeJson(
        OPENCODE_SANDBOX_PROFILE,
        profile,
        "Persist this root's non-secret OpenCode Linux sandbox bindings",
      ),
      writeText(
        `${OPENCODE_SANDBOX_HOME}/.keep`,
        "",
        "Create this root's disposable OpenCode sandbox home",
      ),
    ];
  }

  for (const path of [
    ...profile.hiddenPaths,
    ...profile.readOnlyPaths,
    profile.policy,
    join(root, OPENCODE_PROJECT_CONFIG),
    join(root, AIH_PROJECT_CONFIG),
  ]) {
    try {
      lstatSync(path);
    } catch {
      throw new AihError(`OpenCode sandbox required path is unavailable: ${path}`, "AIH_CONFIG");
    }
  }
  externalExecutable(
    root,
    profile.opencodeExecutable,
    "persisted OpenCode",
    profile.opencodeSha256,
  );
  externalExecutable(root, profile.bwrapExecutable, "persisted bubblewrap", profile.bwrapSha256);
  externalExecutable(root, profile.seccompExecutable, "persisted seccomp", profile.seccompSha256);
  externalPolicy(root, profile.policy, profile.policySha256);
  if (profile.clientArgs.length === 0) {
    throw new AihError(
      "OpenCode sandbox launch requires persisted non-interactive --client-arg values",
      "AIH_CONFIG",
    );
  }
  const home = join(root, OPENCODE_SANDBOX_HOME);
  const controlDirectory = join(root, ".aih");
  const argv = [
    profile.bwrapExecutable,
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    root,
    root,
    "--ro-bind",
    join(root, OPENCODE_PROJECT_CONFIG),
    join(root, OPENCODE_PROJECT_CONFIG),
    "--ro-bind",
    join(root, AIH_PROJECT_CONFIG),
    join(root, AIH_PROJECT_CONFIG),
    "--ro-bind",
    controlDirectory,
    controlDirectory,
    "--bind",
    home,
    home,
    ...profile.hiddenPaths.flatMap(hiddenPathArgs),
    ...profile.readOnlyPaths.flatMap((path) => ["--ro-bind", path, path]),
    "--chdir",
    root,
    "--clearenv",
    "--setenv",
    "HOME",
    home,
    "--setenv",
    "XDG_CONFIG_HOME",
    join(home, ".config"),
    "--setenv",
    "PATH",
    profile.environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "AIH_ORG_POLICY",
    profile.policy,
    ...Object.entries(profile.environment)
      .filter(([name]) => name !== "PATH" && name !== "AIH_ORG_POLICY")
      .flatMap(([name, value]) => ["--setenv", name, value]),
    "--",
    profile.seccompExecutable,
    profile.opencodeExecutable,
    ...profile.clientArgs,
  ];
  return [
    exec("Launch OpenCode in this root's persisted Linux sandbox", argv, {
      cwd: root,
      env: { PATH: ctx.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      timeoutMs: 120_000,
      expect: {
        path: OPENCODE_SANDBOX_PROFILE,
        sha256: createHash("sha256")
          .update(readFileSync(join(root, OPENCODE_SANDBOX_PROFILE)))
          .digest("hex"),
      },
    }),
  ];
}
