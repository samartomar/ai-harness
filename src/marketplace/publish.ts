import { isAbsolute, join, resolve } from "node:path";
import { sha256Hex, signatureFailureCheck } from "../bundle/index.js";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import {
  type CommandSpec,
  digest,
  exec,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { DEFAULT_MARKETPLACE_OUT } from "./manifest.js";
import { marketplaceReport } from "./validate.js";

/**
 * `aih marketplace publish` — slice 2's signing half: put publisher PROVENANCE
 * on an already-built artifact by signing its `SHA256SUMS` (a cosign detached
 * signature, or a GitHub attestation), so consumers can gate on
 * `aih marketplace validate --require-signature`. Two fail-closed refusals
 * guard the single exec: `--signer` is MANDATORY (a publish without a signer
 * is just a build — that command already exists), and a plan-time PREFLIGHT
 * re-grades the artifact through {@link marketplaceReport} (pure fs reads,
 * #35 — the signing itself only happens via the exec action under `--apply`).
 * ANY failing finding refuses the whole publish: a signature over a broken
 * artifact would launder the breakage as provenance. The exec itself carries an
 * apply-time content pin (`expect`) over `SHA256SUMS`, so the signer can only
 * ever sign the exact bytes the preflight graded — never a file swapped in
 * between plan and apply.
 */

const CHECKSUMS_FILE = "SHA256SUMS";
const SIGNATURE_FILE = "SHA256SUMS.sig";

type Signer = "cosign" | "gh";

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

/** `--signer` is mandatory and closed: without a signature this is just `marketplace build`. */
function requiredSigner(ctx: PlanContext): Signer {
  const raw = ctx.options.signer;
  if (raw === "cosign" || raw === "gh") return raw;
  const got =
    typeof raw === "string" && raw.trim().length > 0 ? ` — got ${JSON.stringify(raw)}` : "";
  throw refuse(
    `marketplace publish requires --signer cosign|gh${got}; ` +
      "a publish without a signer is just a build (`aih marketplace build`)",
  );
}

/** The artifact dir as given (for messages/hints) and resolved (for the exec argv). */
function marketplaceDir(ctx: PlanContext): { display: string; abs: string } {
  const raw = ctx.options.dir;
  const display =
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : DEFAULT_MARKETPLACE_OUT;
  return { display, abs: resolve(isAbsolute(display) ? display : join(ctx.root, display)) };
}

function publishText(dir: string, signer: Signer, verifies: string, hint: string): string {
  return lines(
    `marketplace publish: ${CHECKSUMS_FILE} signed with ${signer} → ${dir}`,
    `- consumers verify ${verifies}`,
    "",
    `gate consumption with \`${hint}\` — provenance rides the artifact; ` +
      "the vet gate still runs at consume time",
  );
}

function marketplacePublishPlan(ctx: PlanContext): Plan {
  const signer = requiredSigner(ctx);
  const { display, abs } = marketplaceDir(ctx);

  // PREFLIGHT (pure reads, #35): the exact findings machinery `marketplace
  // validate` grades with. A signature must only ever land on an artifact that
  // validates clean — any finding refuses before the sign is even planned.
  const report = marketplaceReport(abs);
  if (report.findings.length > 0) {
    const listed = report.findings
      .map((f) => `  - ${f.name}${f.detail !== undefined ? `: ${f.detail}` : ""}`)
      .join("\n");
    throw refuse(
      `publish only what validates — fix these first:\n${listed}\n` +
        `(\`aih marketplace validate --dir ${display}\` re-grades the artifact)`,
    );
  }

  const sums = join(abs, CHECKSUMS_FILE);
  const sig = join(abs, SIGNATURE_FILE);
  // Defense-in-depth against argv-flag smuggling: `sums`/`sig` are resolved
  // under the root-joined artifact dir above, so they cannot start with `-`
  // today — but a leading dash WOULD parse as a flag to cosign/gh rather than
  // a path, so refuse outright instead of trusting the join forever.
  if (sums.startsWith("-") || sig.startsWith("-")) {
    throw refuse(`refusing to sign a path that parses as a flag: ${sums}`);
  }
  const rawKey = ctx.options.key;
  const key = typeof rawKey === "string" && rawKey.trim().length > 0 ? rawKey.trim() : undefined;
  // The same dash guard for the operator-supplied signing key.
  if (key?.startsWith("-")) {
    throw refuse(`refusing to pass a --key value that parses as a flag: ${key}`);
  }

  // Apply-time content pin (closes the validate-then-sign TOCTOU): the signer
  // only ever signs the exact bytes the preflight graded — if SHA256SUMS is
  // swapped between plan and apply, the exec refuses instead of laundering the
  // new bytes as validated provenance. The preflight above guarantees the sums
  // exist; refuse defensively if they vanished since.
  const sumsContent = readIfExists(sums);
  if (sumsContent === undefined) {
    throw refuse(`${CHECKSUMS_FILE} vanished after the preflight graded it — rebuild, then re-run`);
  }
  const expect = { path: sums, sha256: sha256Hex(sumsContent) };

  // ONE exec, signing at --apply time. DELIBERATE divergence from the fleet
  // bundle's best-effort `signAction` (`allowFailure: true`): a bundle
  // signature is an optional extra riding on a checksums gate, but a publish
  // IS the signature — a publish whose signing fails must fail loudly.
  const sign =
    signer === "cosign"
      ? exec(
          "sign marketplace SHA256SUMS with cosign",
          key !== undefined
            ? ["cosign", "sign-blob", "--yes", "--key", key, "--output-signature", sig, sums]
            : ["cosign", "sign-blob", "--yes", "--output-signature", sig, sums],
          {
            allowFailure: false,
            expect,
            failureCheck: signatureFailureCheck("marketplace", "cosign"),
          },
        )
      : exec(
          "sign marketplace SHA256SUMS with GitHub attestations",
          ["gh", "attestation", "sign", sums],
          {
            allowFailure: false,
            expect,
            failureCheck: signatureFailureCheck("marketplace", "gh attestation sign"),
          },
        );

  const verifies =
    signer === "cosign"
      ? `${SIGNATURE_FILE} (detached cosign signature over ${CHECKSUMS_FILE})`
      : `the GitHub attestation recorded for ${CHECKSUMS_FILE}`;
  // The verify hint names the signer + its identity material explicitly:
  // verification must prove WHO signed, so the consumer command is spelled out
  // per signer rather than left to inference.
  const hint =
    signer === "cosign"
      ? `aih marketplace validate --dir ${display} --require-signature --signer cosign --key <pub.key>`
      : `aih marketplace validate --dir ${display} --require-signature --signer gh --repo <owner/repo>`;
  return plan(
    "marketplace publish",
    sign,
    digest("marketplace publish", publishText(display, signer, verifies, hint), {
      dir: display,
      signer,
      verifies,
      verify: hint,
    }),
  );
}

export const marketplacePublishCommand: CommandSpec = {
  name: "publish",
  summary:
    "Sign a validated marketplace artifact's SHA256SUMS (cosign or GitHub attestation) so consumers can require provenance",
  options: [
    {
      flags: "--dir <dir>",
      description: "marketplace artifact directory to sign",
      default: DEFAULT_MARKETPLACE_OUT,
    },
    {
      flags: "--signer <signer>",
      description:
        "signing tool (REQUIRED): cosign | gh — a publish without a signer is refused (that is just a build)",
    },
    {
      flags: "--key <path>",
      description:
        "cosign signing key for sign-blob (omit for keyless); consumers verify with the matching public key",
    },
  ],
  plan: marketplacePublishPlan,
};
