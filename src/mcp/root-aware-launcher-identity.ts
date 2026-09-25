import { createHash } from "node:crypto";
import {
  CODE_REVIEW_GRAPH_RUNTIME_PIN,
  CODEBASE_MEMORY_RUNTIME_PIN,
  DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
} from "../ecc-profile/default-mcp-runtime-lock.js";
import { SERENA_RUNTIME_PIN } from "../ecc-profile/mcp-profile.js";
import { SERENA_DEPENDENCY_LOCK_SHA256 } from "../ecc-profile/native-registration.js";
import { stableJson } from "../org-policy/policy-identity.js";

/**
 * The portable identity of Core's root-aware MCP launchers (`defaultNativeMcpServers`).
 *
 * A launcher entry names this machine's Node executable, Core's installed wrapper, and
 * project, state and cache paths, so its `mcpApprovalSubject` can never equal a subject
 * declared once for every machine. The identity document instead names what the launch
 * actually pins: the server, the launcher kind, Core's wrapper and its option contract,
 * the package, the dependency lock and the risk axes. Machine paths never enter it.
 *
 * The wrapper is named by a versioned id rather than a content digest: the runtime only
 * reports this identity after verifying the entry runs Core's own wrapper from Core's own
 * installation (the trust domain that performs the check), a digest of a build output is
 * not available when the declaration is emitted from source, and the wrapper's option
 * contract is part of the document, so a contract change changes the subject.
 */
export const ROOT_AWARE_LAUNCHER_IDS = [
  "code-review-graph",
  "codebase-memory-mcp",
  "serena",
] as const;

export type RootAwareLauncherId = (typeof ROOT_AWARE_LAUNCHER_IDS)[number];

export interface RootAwareLauncherSpecV1 {
  package: string;
  dependencyLockSha256: string;
  /** Core's packaged dependency-lock directory that `--lock-root` must name. */
  lockDirectory: "default-mcp-runtime" | "serena-runtime";
  /** Options whose values are fixed for every machine, in launch order. */
  fixedOptions: Readonly<Record<string, string>>;
  /** Options whose values are this machine's absolute paths, in launch order. */
  pathOptions: readonly string[];
}

const RISK = {
  classification: "local",
  egress: "local-only",
  credentials: "none",
  supplyChain: "pinned",
} as const;

const SPECS: Readonly<Record<RootAwareLauncherId, RootAwareLauncherSpecV1>> = {
  "code-review-graph": {
    package: CODE_REVIEW_GRAPH_RUNTIME_PIN.package,
    dependencyLockSha256: DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
    lockDirectory: "default-mcp-runtime",
    fixedOptions: {},
    pathOptions: ["--project", "--state-root", "--uv-cache"],
  },
  "codebase-memory-mcp": {
    package: CODEBASE_MEMORY_RUNTIME_PIN.package,
    dependencyLockSha256: DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
    lockDirectory: "default-mcp-runtime",
    fixedOptions: {},
    pathOptions: [
      "--project",
      "--state-root",
      "--coordination-root",
      "--runtime-home",
      "--uv-cache",
    ],
  },
  serena: {
    package: SERENA_RUNTIME_PIN.package,
    dependencyLockSha256: SERENA_DEPENDENCY_LOCK_SHA256,
    lockDirectory: "serena-runtime",
    fixedOptions: { "--context": "ide-assistant", "--mode": "no-memories" },
    pathOptions: ["--project", "--state-root"],
  },
};

export function isRootAwareLauncherId(id: string): id is RootAwareLauncherId {
  return (ROOT_AWARE_LAUNCHER_IDS as readonly string[]).includes(id);
}

export function rootAwareLauncherSpecV1(id: RootAwareLauncherId): RootAwareLauncherSpecV1 {
  return SPECS[id];
}

/** Every option the wrapper receives for this launcher, each exactly once. */
export function rootAwareLauncherOptionsV1(id: RootAwareLauncherId): string[] {
  const spec = SPECS[id];
  return [
    "--package",
    "--dependency-lock-sha256",
    "--lock-root",
    ...Object.keys(spec.fixedOptions),
    ...spec.pathOptions,
  ];
}

/** The risk axes a launcher entry must carry; they are part of the identity. */
export function rootAwareLauncherRiskV1(): typeof RISK {
  return { ...RISK };
}

export function rootAwareLauncherIdentityV1(id: RootAwareLauncherId) {
  const spec = SPECS[id];
  return {
    format: "aih-root-aware-mcp-launcher-identity",
    version: 1,
    server: id,
    launcher: { kind: "aih-core-root-aware-launcher", version: 1 },
    wrapper: {
      id: "aih-core-ecc-runtime",
      protocol: 1,
      mode: id,
      options: rootAwareLauncherOptionsV1(id),
    },
    package: spec.package,
    dependencyLockSha256: spec.dependencyLockSha256,
    lockDirectory: spec.lockDirectory,
    fixedOptions: { ...spec.fixedOptions },
    pathOptions: [...spec.pathOptions],
    risk: rootAwareLauncherRiskV1(),
  };
}

/** The same `mcp-server-sha256:` form as `mcpApprovalSubject`, over the identity document. */
export function rootAwareLauncherSubjectV1(id: RootAwareLauncherId): string {
  const digest = createHash("sha256")
    .update(stableJson(rootAwareLauncherIdentityV1(id)), "utf8")
    .digest("hex");
  return `mcp-server-sha256:${digest}`;
}
