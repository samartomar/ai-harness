import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { McpRuntimeObservationV1 } from "../../src/heal/mcp-runtime-evidence.js";
import { currentOpenCodeRuntimeBindings } from "../../src/heal/opencode-runtime-evidence.js";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export interface OpenCodeRuntimeFixture {
  root: string;
  outside: string;
  evidencePath: string;
  paths: {
    profile: string;
    policy: string;
    opencode: string;
    bwrap: string;
    seccomp: string;
    runtime: string;
    fixture: string;
    fixtureConfig: string;
    marker: string;
    plugin: string;
    managedManifest: string;
    managedEntry: string;
    config: string;
  };
  observation: McpRuntimeObservationV1;
  cleanup(): void;
}

const restrictions = [
  "protected-read",
  "protected-write",
  "sandbox-profile-write",
  "native-config-write",
  "control-directory-rename",
  "tcp-connect",
  "unix-connect",
] as const;

export function openCodeRuntimeFixture(): OpenCodeRuntimeFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-opencode-runtime-root-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "aih-opencode-runtime-tools-")));
  const policy = join(outside, "policy.json");
  const opencode = join(outside, "opencode");
  const bwrap = join(outside, "bwrap");
  const seccomp = join(outside, "apply-seccomp");
  const runtime = join(outside, "node");
  const fixture = join(outside, "opencode-repeatable-mcp.mjs");
  const fixtureConfig = join(root, "fixture.json");
  const marker = join(root, "marker.txt");
  const plugin = join(root, ".opencode", "plugins", "aih-loopback.js");
  const managedRoot = join(
    root,
    "node_modules",
    "@modelcontextprotocol",
    "server-sequential-thinking",
  );
  const managedManifest = join(managedRoot, "package.json");
  const managedEntry = join(managedRoot, "dist", "index.js");
  const config = join(root, "opencode.json");
  const profile = join(root, ".aih", "sandbox", "opencode.json");
  const evidencePath = join(outside, "opencode-runtime-observation.json");
  mkdirSync(dirname(plugin), { recursive: true });
  mkdirSync(dirname(profile), { recursive: true });
  mkdirSync(dirname(managedEntry), { recursive: true });
  writeFileSync(policy, '{"organization":"fictional"}\n');
  writeFileSync(opencode, "opencode-binary");
  writeFileSync(bwrap, "bwrap-binary");
  writeFileSync(seccomp, "seccomp-binary");
  writeFileSync(runtime, "node-binary");
  writeFileSync(fixture, "fixture-module");
  writeFileSync(plugin, "provider-plugin");
  writeFileSync(
    managedManifest,
    JSON.stringify({ bin: { "mcp-server-sequential-thinking": "./dist/index.js" } }),
  );
  writeFileSync(managedEntry, "managed-mcp-entry");
  writeFileSync(marker, "CANARY_A\n");
  writeFileSync(
    fixtureConfig,
    JSON.stringify({ root, marker: "CANARY_A\n", policy, nonce: "nonce-a" }),
  );
  writeFileSync(
    config,
    JSON.stringify({
      permission: { "*": "deny", fixture_fixture_probe: "allow" },
      mcp: {
        "sequential-thinking": {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"],
          enabled: true,
        },
        fixture: {
          type: "local",
          command: [runtime, fixture, fixtureConfig],
          enabled: true,
        },
      },
    }),
  );
  writeFileSync(
    profile,
    `${JSON.stringify({
      schemaVersion: 1,
      client: "opencode",
      root,
      policy,
      policySha256: sha256(readFileSync(policy)),
      bwrapExecutable: bwrap,
      bwrapSha256: sha256(readFileSync(bwrap)),
      opencodeExecutable: opencode,
      opencodeSha256: sha256(readFileSync(opencode)),
      seccompExecutable: seccomp,
      seccompSha256: sha256(readFileSync(seccomp)),
      environment: { PATH: `${dirname(runtime)}${delimiter}/usr/bin` },
      hiddenPaths: [],
      readOnlyPaths: [],
      pathIdentities: {},
      clientArgs: ["run", "fixture request"],
    })}\n`,
  );

  const bindings = currentOpenCodeRuntimeBindings(root, "1.18.11");
  const observation: McpRuntimeObservationV1 = {
    schemaVersion: 1,
    kind: "aih-mcp-runtime-observation",
    client: bindings.client,
    target: bindings.target,
    policy: bindings.policy,
    server: bindings.server,
    invocation: bindings.invocation,
    materials: bindings.materials,
    observedAt: "2026-09-13T12:00:00.000Z",
    expiresAt: "2026-09-13T13:00:00.000Z",
    support: { nativeClientStarted: true, configuredServerRecognized: true },
    discovery: { serverConnected: true, tool: "fixture_probe", toolListed: true },
    operation: {
      expectedCanary: bindings.operation?.expectedCanary ?? "",
      actualCanary: bindings.operation?.expectedCanary ?? "",
      succeeded: true,
      sessionId: "A1-native-process",
    },
    restart: {
      actualCanary: bindings.operation?.expectedCanary ?? "",
      succeeded: true,
      sessionId: "A2-native-process",
      observedAt: "2026-09-13T12:05:00.000Z",
    },
    restrictions: ["client-shell", "mcp-subprocess"].flatMap((boundary) =>
      restrictions.map((id) => ({
        id,
        boundary: boundary as "client-shell" | "mcp-subprocess",
        denied: true,
        effectAbsent: true,
      })),
    ),
  };
  writeFileSync(evidencePath, `${JSON.stringify(observation, null, 2)}\n`);

  return {
    root,
    outside,
    evidencePath,
    paths: {
      profile,
      policy,
      opencode,
      bwrap,
      seccomp,
      runtime,
      fixture,
      fixtureConfig,
      marker,
      plugin,
      managedManifest,
      managedEntry,
      config,
    },
    observation,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  };
}
