import { realpathSync, statSync } from "node:fs";
import { join, win32 } from "node:path";
import { parseDocument } from "yaml";

export interface SerenaRuntimeConfigScope {
  readonly project: string;
  readonly home: string;
  readonly allowedTools: readonly string[];
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function projectMetadataTemplate(home: string): string {
  return join(home, "projects", "$projectFolderName", ".serena");
}

function sameWindowsDirectoryIdentity(
  candidate: unknown,
  expected: string,
  platform: NodeJS.Platform,
): boolean {
  if (
    platform !== "win32" ||
    typeof candidate !== "string" ||
    !win32.isAbsolute(candidate) ||
    !win32.isAbsolute(expected) ||
    win32.normalize(win32.parse(candidate).root).toLowerCase() !==
      win32.normalize(win32.parse(expected).root).toLowerCase()
  ) {
    return false;
  }
  try {
    const candidateStats = statSync(candidate, { bigint: true });
    const expectedStats = statSync(expected, { bigint: true });
    return (
      candidateStats.isDirectory() &&
      expectedStats.isDirectory() &&
      candidateStats.dev !== 0n &&
      candidateStats.ino !== 0n &&
      candidateStats.dev === expectedStats.dev &&
      candidateStats.ino === expectedStats.ino &&
      realpathSync.native(candidate) === realpathSync.native(expected)
    );
  } catch {
    return false;
  }
}

function registeredProjectsMatch(
  value: unknown,
  expected: string,
  platform: NodeJS.Platform,
): boolean {
  return (
    exactStringArray(value, []) ||
    exactStringArray(value, [expected]) ||
    (Array.isArray(value) &&
      value.length === 1 &&
      sameWindowsDirectoryIdentity(value[0], expected, platform))
  );
}

/** Complete Serena 1.7 configuration that does not trigger permissive default migration. */
export function renderSerenaRuntimeConfig(scope: SerenaRuntimeConfigScope): string {
  return [
    "language_backend: LSP",
    "gui_log_window: false",
    "web_dashboard: false",
    "web_dashboard_open_on_launch: false",
    "web_dashboard_interface: browser",
    "web_dashboard_listen_address: 127.0.0.1",
    "web_dashboard_trusted_hosts:",
    "  - 127.0.0.1",
    "  - localhost",
    "fixed_tools:",
    ...scope.allowedTools.map((tool) => `  - ${tool}`),
    "excluded_tools: []",
    "included_optional_tools: []",
    "base_modes:",
    "  - interactive",
    "  - editing",
    "default_modes: []",
    "projects: []",
    "symbol_info_budget: 10.0",
    "read_only_memory_patterns: []",
    "ignored_memory_patterns: []",
    "ls_specific_settings: {}",
    "log_level: 20",
    "trace_lsp_communication: false",
    "jetbrains_plugin_server_address: 127.0.0.1",
    "jetbrains_launch_command: null",
    "tool_timeout: 240",
    "token_count_estimator: CHAR_COUNT",
    "default_max_tool_answer_chars: 150000",
    "ignored_paths: []",
    `project_serena_folder_location: ${JSON.stringify(projectMetadataTemplate(scope.home))}`,
    "trusted_project_path_patterns: []",
    "ls_priorities: {}",
    "line_ending: native",
    "",
  ].join("\n");
}

/** Accept the initial config and Serena's sole supported mutation: registering this exact project. */
export function assertHardenedSerenaRuntimeConfig(
  source: string,
  scope: SerenaRuntimeConfigScope,
  platform: NodeJS.Platform = process.platform,
): void {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error("Serena config conflicts with the AIH-owned hardened profile");
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("Serena config conflicts with the AIH-owned hardened profile");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Serena config conflicts with the AIH-owned hardened profile");
  }
  const config = value as Record<string, unknown>;
  const expectedScalars: Readonly<Record<string, string | number | boolean | null>> = {
    language_backend: "LSP",
    gui_log_window: false,
    web_dashboard: false,
    web_dashboard_open_on_launch: false,
    web_dashboard_interface: "browser",
    web_dashboard_listen_address: "127.0.0.1",
    symbol_info_budget: 10,
    log_level: 20,
    trace_lsp_communication: false,
    jetbrains_plugin_server_address: "127.0.0.1",
    jetbrains_launch_command: null,
    tool_timeout: 240,
    token_count_estimator: "CHAR_COUNT",
    default_max_tool_answer_chars: 150000,
    project_serena_folder_location: projectMetadataTemplate(scope.home),
    line_ending: "native",
  };
  const scalarsMatch = Object.entries(expectedScalars).every(
    ([key, expected]) => config[key] === expected,
  );
  const mapsMatch = [config.ls_specific_settings, config.ls_priorities].every(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 0,
  );
  const arraysMatch =
    exactStringArray(config.web_dashboard_trusted_hosts, ["127.0.0.1", "localhost"]) &&
    exactStringArray(config.fixed_tools, scope.allowedTools) &&
    exactStringArray(config.excluded_tools, []) &&
    exactStringArray(config.included_optional_tools, []) &&
    exactStringArray(config.base_modes, ["interactive", "editing"]) &&
    exactStringArray(config.default_modes, []) &&
    exactStringArray(config.read_only_memory_patterns, []) &&
    exactStringArray(config.ignored_memory_patterns, []) &&
    exactStringArray(config.ignored_paths, []) &&
    exactStringArray(config.trusted_project_path_patterns, []) &&
    registeredProjectsMatch(config.projects, scope.project, platform);
  if (!scalarsMatch || !mapsMatch || !arraysMatch) {
    throw new Error("Serena config conflicts with the AIH-owned hardened profile");
  }
}
