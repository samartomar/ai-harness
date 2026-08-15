import { join } from "node:path";
import { readRegularFile } from "../internals/fsxn.js";
import { parseJsoncText } from "../internals/merge.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  type ExactUvxPackagePin,
  MCP_PIN_CONFIG_FILES,
  mcpLaunchLabel,
  mcpResolverLike,
  mcpResolverPinState,
  uvxPrimaryPin,
} from "./pins.js";

/**
 * Resolved-artifact attestation for uvx MCP pins (issue #502). An exact pin in
 * `.mcp.json` proves what the config ASKS FOR, never what the resolved artifact
 * actually is: in the field, a launched server's self-reported
 * `serverInfo.version` (the MCP `initialize` result) has differed from the
 * honored pin. Doctor previously verified allowlist/config shape only, so that
 * state was invisible.
 *
 * The probe always renders a row (an unattested pin is a visible advisory, never
 * silence). Actually LAUNCHING the pinned server executes a third-party artifact
 * and may touch the network, so the live handshake is OPT-IN via
 * `aih doctor --attest-mcp-pins` — mirroring heal's `--probe-mcp-endpoints`
 * boundary for config-derived targets. Only a literal `uvx` command with exact
 * end-to-end pins and no config-supplied environment is ever executed
 * ({@link mcpResolverPinState} is the fail-closed gate); everything else is
 * reported as unattestable. A mismatch WARNS (an advisory coded `skip`) rather
 * than hard-failing: packaging lag can be benign, but it must be seen and
 * reviewed. The server's output is cross-boundary data — parsed defensively and
 * sanitized before it is echoed into the report.
 */

/** `ctx.options` key for the `--attest-mcp-pins` doctor flag. */
export const ATTEST_MCP_PINS_OPTION = "attestMcpPins";

const PROBE_NAME = "mcp-uvx-pin-attestation";
const ATTEST_TIMEOUT_MS = 30_000;

/**
 * One-shot MCP stdio handshake: an `initialize` request plus the `initialized`
 * notification. The runner closes stdin after writing (the stdio transport's
 * shutdown signal), so a compliant server answers on stdout and exits; the run
 * timeout is the backstop for servers that linger.
 */
const INITIALIZE_INPUT = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "aih-doctor", version: "pin-attestation" },
  },
})}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`;

interface UvxLaunch {
  server: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface PinnedLaunch extends UvxLaunch {
  pin: ExactUvxPackagePin;
}

type UvxConfig =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "none" }
  | { state: "servers"; launches: UvxLaunch[] };

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    return undefined;
  }
  return value;
}

function envRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Every uvx-like stdio launch declared in the repo's repo-local MCP configs. */
function readUvxLaunches(root: string): UvxConfig {
  const launches: UvxLaunch[] = [];
  let sawFile = false;
  let sawInvalid = false;
  for (const rel of MCP_PIN_CONFIG_FILES) {
    const raw = readRegularFile(join(root, rel))?.toString("utf8");
    if (raw === undefined) continue;
    sawFile = true;
    let parsed: unknown;
    try {
      parsed = parseJsoncText(raw);
    } catch {
      sawInvalid = true;
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      sawInvalid = true;
      continue;
    }
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers === undefined) continue;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      sawInvalid = true;
      continue;
    }
    for (const [server, entry] of Object.entries(servers)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const command = typeof record.command === "string" ? record.command : "";
      if (mcpResolverLike(command) !== "uvx") continue;
      // Malformed args carry no exact-pin evidence — kept, so the launch surfaces
      // as unattestable instead of silently vanishing from the report.
      const args = stringArray(record.args) ?? [];
      launches.push({
        server: mcpLaunchLabel(server, rel),
        command,
        args,
        env: envRecord(record.env),
      });
    }
  }
  if (!sawFile) return { state: "absent" };
  // An unreadable config must never read as clean: one bad file among several would
  // otherwise let the rest attest green while its servers went uninspected.
  if (sawInvalid) return { state: "invalid" };
  return launches.length === 0 ? { state: "none" } : { state: "servers", launches };
}

/** Printable, bounded echo of a cross-boundary string (server output → report). */
function sanitizeExternal(value: string): string {
  const cleaned = [...value]
    .map((ch) => (ch >= " " && ch <= "~" ? ch : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "<unprintable>";
}

/** The first `serverInfo.version` in a stdio server's initialize output, if any. */
function serverInfoVersion(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const message = JSON.parse(trimmed) as {
        result?: { serverInfo?: { version?: unknown } };
      };
      const version = message.result?.serverInfo?.version;
      if (typeof version === "string") return sanitizeExternal(version);
    } catch {
      // Not a JSON-RPC line (a misbehaving server logging to stdout) — keep scanning.
    }
  }
  return undefined;
}

/**
 * The doctor probe. Verdict grammar: `pass` only when every uvx pin was launched
 * and its `serverInfo.version` matches the pin; a mismatch is an advisory `skip`
 * coded `mcp.version-drift`; every not-attested state (opt-in flag absent,
 * unpinned launcher, launch/handshake failure) is an advisory `skip` coded
 * `mcp.pin-unattested` — visible, never green.
 */
export async function mcpUvxPinAttestationProbe(ctx: PlanContext): Promise<Check> {
  const name = PROBE_NAME;
  const cfg = readUvxLaunches(ctx.root);
  if (cfg.state === "absent") {
    return {
      name,
      verdict: "skip",
      detail:
        "no repo-local MCP config (.mcp.json / .kiro/settings/mcp.json) — no MCP servers configured",
    };
  }
  if (cfg.state === "invalid") {
    return {
      name,
      verdict: "skip",
      detail: "invalid .mcp.json — cannot attest MCP package pins",
      code: "mcp.config-invalid",
    };
  }
  if (cfg.state === "none") {
    return { name, verdict: "skip", detail: "no uvx MCP servers in .mcp.json to attest" };
  }

  const pinned: PinnedLaunch[] = [];
  const unpinned: string[] = [];
  for (const launch of [...cfg.launches].sort((a, b) => a.server.localeCompare(b.server))) {
    const pin =
      mcpResolverPinState(launch.command, launch.args, launch.env) === "pinned"
        ? uvxPrimaryPin(launch.args)
        : undefined;
    if (pin === undefined) unpinned.push(launch.server);
    else pinned.push({ ...launch, pin });
  }
  const unpinnedNote =
    unpinned.length > 0
      ? `; unattestable without an exact end-to-end pin: ${unpinned.join(", ")} — pin as pkg==x.y.z (or pkg@x.y.z)`
      : "";

  if (pinned.length === 0) {
    return {
      name,
      verdict: "skip",
      code: "mcp.pin-unattested",
      detail: `uvx launcher(s) lack exact end-to-end pins and cannot be attested: ${unpinned.join(", ")} — pin as pkg==x.y.z (or pkg@x.y.z)`,
    };
  }

  if (ctx.options[ATTEST_MCP_PINS_OPTION] !== true) {
    const list = pinned.map((p) => `${p.server} (${p.pin.spec})`).join(", ");
    return {
      name,
      verdict: "skip",
      code: "mcp.pin-unattested",
      detail:
        `${pinned.length} uvx pin(s) not attested: ${list} — run \`aih doctor --attest-mcp-pins\` ` +
        `to launch each pinned server and compare its self-reported serverInfo.version to the pin${unpinnedNote}`,
    };
  }

  const attested: string[] = [];
  const mismatched: string[] = [];
  const unattested: string[] = [];
  for (const launch of pinned) {
    // Safe by construction: mcpResolverPinState only returns "pinned" for the
    // literal `uvx` command, exact pins end-to-end, and no config-supplied env.
    const res = await ctx.run([launch.command, ...launch.args], {
      input: INITIALIZE_INPUT,
      timeoutMs: ATTEST_TIMEOUT_MS,
    });
    const version = serverInfoVersion(res.stdout);
    if (version === undefined) {
      const why = res.spawnError
        ? "launch failed or timed out before an initialize response"
        : res.code !== 0
          ? `exited ${res.code} without an initialize response`
          : "no serverInfo in the initialize response";
      // Hardened pins carry `--offline`, and attestation requires execution: on
      // a cold uv cache the package cannot resolve and the launch dies before
      // the handshake — the exact machine (a fresh workstation) that most wants
      // attestation. Name the cause and the one-time remedy instead of leaving
      // an undiagnosable exit code (6.0.1 field report).
      const offlineNote =
        launch.args.includes("--offline") && (res.spawnError || res.code !== 0)
          ? " — the launcher pins --offline, so a cold uv cache cannot resolve the package; pre-warm it by running the launcher once without --offline, then re-run --attest-mcp-pins"
          : "";
      unattested.push(`${launch.server} (${launch.pin.spec}): ${why}${offlineNote}`);
    } else if (version === launch.pin.version) {
      attested.push(`${launch.server} (${launch.pin.spec})`);
    } else {
      mismatched.push(
        `${launch.server}: pin honors ${launch.pin.spec} but serverInfo.version self-reports ${version}`,
      );
    }
  }

  if (mismatched.length > 0) {
    const rest = [
      attested.length > 0 ? `attested clean: ${attested.join(", ")}` : "",
      unattested.length > 0 ? `could not attest: ${unattested.join("; ")}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("; ");
    return {
      name,
      verdict: "skip",
      code: "mcp.version-drift",
      detail: `${mismatched.join("; ")}${rest.length > 0 ? `; ${rest}` : ""}${unpinnedNote}`,
    };
  }
  if (unattested.length > 0) {
    return {
      name,
      verdict: "skip",
      code: "mcp.pin-unattested",
      detail: `could not attest: ${unattested.join("; ")}${
        attested.length > 0 ? `; attested clean: ${attested.join(", ")}` : ""
      }${unpinnedNote}`,
    };
  }
  if (unpinned.length > 0) {
    return {
      name,
      verdict: "skip",
      code: "mcp.pin-unattested",
      detail: `attested clean: ${attested.join(", ")}${unpinnedNote}`,
    };
  }
  return {
    name,
    verdict: "pass",
    detail: `${attested.length} uvx pin(s) attested — serverInfo.version matches the pin: ${attested.join(", ")}`,
  };
}
