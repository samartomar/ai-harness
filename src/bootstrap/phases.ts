import { lines } from "../internals/render.js";

/**
 * The four delivery phases of the blueprint's "Project Delivery and Scaled
 * Rollout Roadmap". `bootstrap` composes the WORKSTATION-scoped capabilities
 * (certs / hardware / vdi / telemetry) under these phase headers; the cloud-only
 * milestones (Phase 3 SSO MCP gateway, Phase 4 MDM distribution) are emitted as
 * guidance, never executed — that keeps the harness on the local side of the
 * boundary.
 *
 * `objective` is quoted verbatim from the blueprint so the generated header is a
 * faithful restatement of the milestone, not a paraphrase.
 */
export interface PhaseMeta {
  /** "1".."4" — matches `--phase`. */
  id: string;
  /** Blueprint phase title. */
  title: string;
  /** Blueprint milestone objective (verbatim). */
  objective: string;
  /** Workstation capabilities composed under this phase, in order. */
  capabilities: readonly ("certs" | "hardware" | "vdi" | "telemetry")[];
}

export const PHASES: readonly PhaseMeta[] = [
  {
    id: "1",
    title: "Phase 1: Baseline & Security Setup",
    objective:
      "Configure network settings to ensure secure, uninterrupted connections to developer registries behind the corporate proxy and execute codebase-level profilers.",
    capabilities: ["certs"],
  },
  {
    id: "2",
    title: "Phase 2: Sandbox, ECC, & Performance Sizing",
    objective:
      "Establish process, tool profiles, and hardware boundaries on developer workstations to isolate AI executions.",
    capabilities: ["hardware", "vdi"],
  },
  {
    id: "3",
    title: "Phase 3: Centralized SSO MCP Gateway Launch & Context Synchronization",
    objective:
      "Scale tool authorization, synchronize codebase logic securely, and prevent loop cost acceleration.",
    capabilities: [],
  },
  {
    id: "4",
    title: "Phase 4: Global Observability & CI Safety Nets",
    objective: "Deploy global governance models, trace telemetry, and enforce license checks.",
    capabilities: ["telemetry"],
  },
] as const;

/** Render a phase banner: title + objective, used as the per-phase `doc` header. */
export function phaseHeader(meta: PhaseMeta): string {
  return lines(meta.title, "", `Objective: ${meta.objective}`);
}

/**
 * Phase 3 is a CLOUD milestone: Entra ID / Okta application registration and the
 * agentgateway control plane live off-workstation, so the whole phase is doc-only
 * guidance (exact commands, never run). The workstation-local half of Phase 3
 * (thin adapters, CRISPY, MCP servers) is laid down by `aih init`, not here.
 */
export function ssoGatewayDoc(): string {
  return lines(
    "Centralized SSO MCP gateway — provision off-workstation, then point the host at it.",
    "These steps register a corporate identity application and a managed agent gateway;",
    "aih never authenticates to or mutates these remote systems — run them yourself:",
    "",
    "  1. Register the gateway as an application in Microsoft Entra ID (or Okta):",
    "       az ad app create --display-name 'AI MCP Gateway' \\",
    "         --web-redirect-uris https://gateway.corp.example/callback",
    "     (Okta equivalent: create an OIDC web app and capture client id/secret.)",
    "",
    "  2. Map user-group roles to backend tool scopes on the gateway control plane,",
    "     then write the resolved endpoint + tenant into the local agentgateway config:",
    "       ~/.config/agentgateway/config.yaml",
    "",
    "  3. Verify the workstation can reach the gateway and complete the SSO handshake:",
    "       agentgateway login --check",
  );
}

/**
 * Phase 4's distribution half is also off-workstation: global steering configs go
 * out through an MDM solution (Intune / Jamf / Workspace ONE) to every endpoint.
 * Doc-only — the SCA copyleft gate is likewise a CI concern, documented not run.
 */
export function mdmDistributionDoc(): string {
  return lines(
    "Global steering distribution — push canonical configs to endpoints via MDM (doc-only).",
    "Standardize the team's steering guidelines under .ai-context/ and distribute them",
    "centrally; aih does not talk to the MDM backend — operate it from your console:",
    "",
    "  - Package the canonical context dir (.ai-context/) and thin IDE adapters as a",
    "    managed configuration payload.",
    "  - Distribute via your MDM (Microsoft Intune / Jamf Pro / Workspace ONE) to all",
    "    developer endpoints so every workstation resolves the same system of record.",
    "  - Map Software Composition Analysis (SCA) copyleft/vulnerability checks into the",
    "    central CI/CD pipeline (e.g. .github/workflows/sca.yml; snyk test --json) rather",
    "    than running them locally.",
  );
}
