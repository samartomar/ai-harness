import type { DigestAction, PlanContext } from "../internals/plan.js";
import { digest } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { scanConfigSecrets, scanSecrets } from "../secrets/scan.js";

function configSecretCode(hit: { code?: "mcp.config-invalid" | "mcp.hardcoded-secret" }) {
  return hit.code ?? "mcp.hardcoded-secret";
}

/** Scan-derived, value-blind leak-prevention posture half for the governance plane. */
export function leakPreventionsDigest(ctx: PlanContext): DigestAction | undefined {
  const plaintext = scanSecrets(ctx.root);
  const configFindings = scanConfigSecrets(ctx.root);
  const mcpHardcoded = configFindings.filter(
    (hit) => configSecretCode(hit) === "mcp.hardcoded-secret",
  ).length;
  const mcpConfigInvalid = configFindings.length - mcpHardcoded;
  const total = plaintext.matches.length + configFindings.length;
  if (total === 0) return undefined;

  const body = lines(
    `Leak-prevention findings are scan-derived and value-blind: ${total} finding${total === 1 ? "" : "s"}.`,
    "",
    ...(plaintext.matches.length > 0
      ? [
          `  Plaintext secret paths (${plaintext.matches.length}):`,
          ...plaintext.matches.map((path) => `    - ${path}`),
        ]
      : []),
    ...(configFindings.length > 0
      ? [
          `  MCP config findings (${configFindings.length}):`,
          ...configFindings.map(
            (hit) =>
              `    - ${hit.file}${hit.key ? ` (${hit.key})` : ""}: ${configSecretCode(hit)} — ${hit.kind}`,
          ),
        ]
      : []),
  );

  return digest(`Leak preventions — ${total} finding${total === 1 ? "" : "s"}`, body, {
    total,
    plaintext: plaintext.matches.length,
    mcpHardcoded,
    mcpConfigInvalid,
    paths: plaintext.matches,
    configFiles: configFindings.map((hit) => hit.file),
    codes: [
      ...(plaintext.matches.length > 0 ? ["secrets.plaintext-detected"] : []),
      ...(mcpHardcoded > 0 ? ["mcp.hardcoded-secret"] : []),
      ...(mcpConfigInvalid > 0 ? ["mcp.config-invalid"] : []),
    ],
  });
}
