import type { DigestAction, PlanContext } from "../internals/plan.js";
import { digest } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { scanConfigSecrets, scanSecrets } from "../secrets/scan.js";

/** Scan-derived, value-blind leak-prevention posture half for the governance plane. */
export function leakPreventionsDigest(ctx: PlanContext): DigestAction | undefined {
  const plaintext = scanSecrets(ctx.root);
  const configSecrets = scanConfigSecrets(ctx.root);
  const total = plaintext.matches.length + configSecrets.length;
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
    ...(configSecrets.length > 0
      ? [
          `  Hardcoded MCP config secrets (${configSecrets.length}):`,
          ...configSecrets.map((hit) =>
            `    - ${hit.file}${hit.key ? ` (${hit.key})` : ""}: ${hit.kind}`,
          ),
        ]
      : []),
  );

  return digest(`Leak preventions — ${total} finding${total === 1 ? "" : "s"}`, body, {
    total,
    plaintext: plaintext.matches.length,
    mcpHardcoded: configSecrets.length,
    paths: plaintext.matches,
    configFiles: configSecrets.map((hit) => hit.file),
    codes: [
      ...(plaintext.matches.length > 0 ? ["secrets.plaintext-detected"] : []),
      ...(configSecrets.length > 0 ? ["mcp.hardcoded-secret"] : []),
    ],
  });
}
