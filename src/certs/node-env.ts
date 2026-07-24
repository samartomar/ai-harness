import { join, posix, win32 } from "node:path";
import { SettingsError } from "../errors.js";
import type { EnvVar } from "../internals/envfile.js";
import { type Action, exec, type PlanContext, probe, writeText } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";

export const NODE_USE_SYSTEM_CA = "NODE_USE_SYSTEM_CA";
export const NODE_EXTRA_CA_CERTS = "NODE_EXTRA_CA_CERTS";

const SETX_MAX_VALUE_LEN = 1024;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const LAUNCH_AGENT_LABEL = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertNormalizedAbsolutePath(value: string, name: string): void {
  if (hasControlCharacter(value)) {
    throw new SettingsError(`${name} contains a control character`);
  }
  const windowsRoot = win32.parse(value).root;
  const windowsFullyAbsolute =
    win32.isAbsolute(value) && (windowsRoot.includes(":") || windowsRoot.startsWith("\\\\"));
  const pathApi = posix.isAbsolute(value) ? posix : windowsFullyAbsolute ? win32 : undefined;
  if (pathApi === undefined || pathApi.normalize(value) !== value) {
    throw new SettingsError(`${name} must be an absolute normalized path`);
  }
}

function assertSelectedVar(variable: EnvVar): void {
  if (!ENV_KEY.test(variable.key)) {
    throw new SettingsError("Node trust environment key is invalid");
  }
  if (variable.key === NODE_USE_SYSTEM_CA) {
    if (variable.value !== "1") {
      throw new SettingsError(`${NODE_USE_SYSTEM_CA} must be exactly 1`);
    }
    return;
  }
  if (variable.key === NODE_EXTRA_CA_CERTS) {
    assertNormalizedAbsolutePath(variable.value, NODE_EXTRA_CA_CERTS);
    return;
  }
  throw new SettingsError(`unsupported Node trust environment key: ${variable.key}`);
}

function selectedVars(vars: readonly EnvVar[]): EnvVar[] {
  const seen = new Set<string>();
  return vars.map((variable) => {
    assertSelectedVar(variable);
    if (seen.has(variable.key)) {
      throw new SettingsError(`duplicate Node trust environment key: ${variable.key}`);
    }
    seen.add(variable.key);
    return { key: variable.key, value: variable.value };
  });
}

export function nodeTrustEnvVars(extraCaPath?: string): EnvVar[] {
  if (extraCaPath !== undefined) {
    assertNormalizedAbsolutePath(extraCaPath, NODE_EXTRA_CA_CERTS);
  }
  return [
    { key: NODE_USE_SYSTEM_CA, value: "1" },
    ...(extraCaPath === undefined ? [] : [{ key: NODE_EXTRA_CA_CERTS, value: extraCaPath }]),
  ];
}

function xmlEscape(value: string): string {
  if (hasControlCharacter(value)) {
    throw new SettingsError("LaunchAgent value contains a control character");
  }
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function launchAgentLabel(key: string): string {
  if (!ENV_KEY.test(key)) throw new SettingsError("LaunchAgent environment key is invalid");
  const label = `dev.aih.env.${key.toLowerCase().replace(/_/g, "-")}`;
  if (!LAUNCH_AGENT_LABEL.test(label)) {
    throw new SettingsError("LaunchAgent label is invalid");
  }
  return label;
}

export function macLaunchAgentPlist(label: string, key: string, value: string): string {
  if (!LAUNCH_AGENT_LABEL.test(label) || label !== launchAgentLabel(key)) {
    throw new SettingsError("LaunchAgent label is invalid");
  }
  assertSelectedVar({ key, value });
  const escapedLabel = xmlEscape(label);
  const escapedKey = xmlEscape(key);
  const escapedValue = xmlEscape(value);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapedLabel}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/launchctl</string>",
    "    <string>setenv</string>",
    `    <string>${escapedKey}</string>`,
    `    <string>${escapedValue}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function persistenceFailure(key: string, code: number | null | undefined): Check {
  return {
    name: `cert: persist ${key} at user scope`,
    verdict: "fail" as const,
    code: "cert.ca-missing",
    detail: `could not persist ${key} at user scope (exit ${code ?? "signal"}); packaged GUI applications may not inherit the selected Node trust setting`,
  };
}

function persistenceExec(describe: string, argv: string[], key: string): Action {
  return exec(describe, argv, {
    requiresPriorExecSuccess: true,
    blockProbesOnFailure: true,
    failureCheck: (result) => persistenceFailure(key, result.code),
  });
}

export function nodeTrustPersistenceActions(ctx: PlanContext, vars: readonly EnvVar[]): Action[] {
  const selected = selectedVars(vars);
  if (ctx.host.platform === "linux") return [];

  if (ctx.host.platform === "windows") {
    const oversized = selected.filter((variable) => variable.value.length > SETX_MAX_VALUE_LEN);
    if (oversized.length > 0) {
      return oversized.map((variable) =>
        probe(`cert: persist ${variable.key} at user scope`, () => ({
          name: `cert: persist ${variable.key} at user scope`,
          verdict: "fail",
          code: "cert.ca-missing",
          detail: `${variable.key} is ${variable.value.length} chars; setx truncates values over ${SETX_MAX_VALUE_LEN}`,
        })),
      );
    }
    return selected.map((variable) => {
      const argv = ctx.host.persistentEnvArgv(variable.key, variable.value);
      if (
        argv.length !== 3 ||
        argv[0] !== "setx" ||
        argv[1] !== variable.key ||
        argv[2] !== variable.value
      ) {
        throw new SettingsError("Windows Node trust persistence must use direct literal setx argv");
      }
      return persistenceExec(
        `persist ${variable.key} for GUI-launched Node runtimes`,
        argv,
        variable.key,
      );
    });
  }

  const home = ctx.env.HOME;
  if (home === undefined) throw new SettingsError("HOME is required for macOS LaunchAgents");
  assertNormalizedAbsolutePath(home, "HOME");
  const launchAgents = join(home, "Library", "LaunchAgents");
  assertNormalizedAbsolutePath(launchAgents, "LaunchAgents directory");
  const sorted = [...selected].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const writes: Action[] = [];
  const execs: Action[] = [];
  for (const variable of sorted) {
    const label = launchAgentLabel(variable.key);
    const path = join(launchAgents, `${label}.plist`);
    assertNormalizedAbsolutePath(path, "LaunchAgent path");
    writes.push(
      writeText(
        path,
        macLaunchAgentPlist(label, variable.key, variable.value),
        `persist ${variable.key} in a user LaunchAgent`,
        { external: true },
      ),
    );
    execs.push(
      persistenceExec(
        `set ${variable.key} in the current launchd user environment`,
        ["/bin/launchctl", "setenv", variable.key, variable.value],
        variable.key,
      ),
    );
  }
  return [...writes, ...execs];
}
