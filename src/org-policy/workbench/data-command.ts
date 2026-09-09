import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  canonicalStrictJsonBytesV1,
  parseStrictJsonObjectV1,
} from "../../contract/strict-json-v1.js";
import { type CommandSpec, digest, plan } from "../../internals/plan.js";
import { policyStudioModel } from "../studio-model.js";
import {
  extractWorkbenchSourceDataV1,
  importWorkbenchSourceDataWithProofsV1,
  readWorkbenchSourceDataFileV1,
  verifyWorkbenchSourceDataEnvelopeV1,
  WorkbenchSourceDataPayloadV1Schema,
  workbenchSourceDataRootV1,
} from "./core/source-data.js";

export const WORKBENCH_DATA_COMMAND_SPECS_V1: readonly CommandSpec[] = [
  {
    name: "prepare",
    summary: "Prepare an unsigned source-data payload",
    flags: [
      "--source <id>",
      "--source-bundle <path>",
      "--qualification-proof <path>",
      "--scanner-proof <path>",
      "--evidence-only",
      "--sequence <number>",
      "--previous-digest <digest>",
      "--out <path>",
    ],
  },
  {
    name: "sign",
    summary: "Sign source data under an explicitly configured publisher role",
    flags: ["--input <path>", "--key <path>", "--trust <path>", "--out <path>"],
  },
  {
    name: "import",
    summary: "Independently verify and atomically accept source data",
    flags: ["--input <path>", "--store <path>", "--scanner-source <path>", "--proof-root <path>"],
  },
].map(({ name, summary, flags }) => ({
  name,
  summary,
  requireExplicitApply: true,
  zeroWrite: true,
  options: flags.map((flags) => ({ flags, description: "Source-data operator input" })),
  plan: () =>
    plan(
      `policy data ${name}`,
      digest("Source data", `${summary}; no files changed without explicit --apply.`),
    ),
}));

function explicitApply(command: Command): boolean {
  if (command.opts().apply === true && command.getOptionValueSource("apply") === "cli") return true;
  process.stdout.write("Source-data dry run: no files changed; pass --apply for this operation.\n");
  return false;
}

function read(path: string) {
  return parseStrictJsonObjectV1(
    readWorkbenchSourceDataFileV1(resolve(path)),
    "Workbench source data input",
  );
}
function write(path: string, value: unknown) {
  writeFileSync(resolve(path), canonicalStrictJsonBytesV1(value), { flag: "wx", mode: 0o600 });
}
/** Explicit operator workflow; normal --ui only reads previously accepted data. */
export function registerWorkbenchDataCommandsV1(policy: Command): void {
  const data = policy
    .command("data")
    .description("Prepare, sign, and accept versioned source data without a Core package update");
  data
    .command("prepare")
    .option("--apply", "write the explicitly named prepared output")
    .description("Prepare an unsigned source-data payload; no publication or trust is created")
    .requiredOption("--source <id>", "exact source id")
    .option(
      "--source-bundle <path>",
      "new compatible source bundle from approved compiler preparation",
    )
    .option(
      "--qualification-proof <path>",
      "independent raw Catalog artifacts and downloaded attestations",
    )
    .option(
      "--scanner-proof <path>",
      "raw Scanner publications, compiler input and downloaded attestations",
    )
    .requiredOption("--sequence <number>", "monotonic per-source sequence")
    .option("--evidence-only", "refresh evidence only for unchanged installed AIH definitions")
    .option("--previous-digest <digest>", "exact previous accepted signed bundle digest")
    .requiredOption("--out <path>", "new output file (never overwritten)")
    .action(
      (
        options: {
          source: string;
          sourceBundle?: string;
          qualificationProof?: string;
          scannerProof?: string;
          evidenceOnly?: boolean;
          sequence: string;
          previousDigest?: string;
          out: string;
        },
        command: Command,
      ) => {
        if (!explicitApply(command)) return;
        const now = new Date();
        const sourceBundle = options.sourceBundle
          ? read(options.sourceBundle)
          : extractWorkbenchSourceDataV1(policyStudioModel().workbenchBundle, options.source);
        const payload = WorkbenchSourceDataPayloadV1Schema.parse({
          version: "workbench-source-data/v1",
          compatibility: "core-workbench-data/v1",
          ...(options.evidenceOnly ? { updateKind: "evidence-only" } : {}),
          sequence: Number(options.sequence),
          previousDigest: options.previousDigest ?? null,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
          sourceBundle,
          ...(options.qualificationProof
            ? { qualification: read(options.qualificationProof) }
            : {}),
          ...(options.scannerProof ? { scanner: read(options.scannerProof) } : {}),
        });
        if (Object.keys(payload.sourceBundle.sources).join() !== options.source)
          throw new TypeError("Source data preparation identity mismatch");
        write(options.out, payload);
        process.stdout.write("Unsigned source-data payload prepared; not activated.\n");
      },
    );
  data
    .command("sign")
    .option("--apply", "write the explicitly named signed output")
    .description(
      "Sign data under an explicitly configured administrator role; does not activate it",
    )
    .requiredOption("--input <path>", "prepared payload")
    .requiredOption("--key <path>", "protected Ed25519 private-key file (never printed)")
    .requiredOption("--trust <path>", "independently configured role and public-root policy")
    .requiredOption("--out <path>", "new signed output file")
    .action(
      (options: { input: string; key: string; trust: string; out: string }, command: Command) => {
        if (!explicitApply(command)) return;
        const payload = WorkbenchSourceDataPayloadV1Schema.parse(read(options.input));
        const privateKey = createPrivateKey(
          readWorkbenchSourceDataFileV1(resolve(options.key), 8_192),
        );
        if (privateKey.asymmetricKeyType !== "ed25519")
          throw new TypeError("Source data signing requires Ed25519");
        const keyId = createHash("sha256")
          .update(createPublicKey(privateKey).export({ format: "der", type: "spki" }))
          .digest("hex");
        const signed = {
          version: "signed-workbench-source-data/v1",
          keyId,
          payload,
          signature: sign(null, canonicalStrictJsonBytesV1(payload), privateKey).toString("base64"),
        };
        const bytes = canonicalStrictJsonBytesV1(signed).toString("utf8");
        const checked = verifyWorkbenchSourceDataEnvelopeV1(
          bytes,
          read(options.trust),
          new Date().toISOString(),
        );
        write(options.out, signed);
        process.stdout.write(
          JSON.stringify({ sourceId: checked.sourceId, digest: checked.digest, activated: false }) +
            "\n",
        );
      },
    );
  data
    .command("import")
    .option("--apply", "verify proofs and activate the named source-data snapshot")
    .description(
      "Verify compatible signed data and atomically activate it, retaining previous snapshots",
    )
    .requiredOption("--input <path>", "signed source data file")
    .option("--store <path>", "configured store (default: per-user .aih/workbench-data/v1)")
    .option(
      "--scanner-source <path>",
      "exact source checkout for independent Scanner proof reconstruction",
    )
    .option(
      "--proof-root <path>",
      "immutable hash-named raw proof blobs; needed only during import",
    )
    .action(
      async (
        options: { input: string; store?: string; scannerSource?: string; proofRoot?: string },
        command: Command,
      ) => {
        if (!explicitApply(command)) return;
        const root = options.store ? resolve(options.store) : workbenchSourceDataRootV1();
        // trust.json is intentionally never imported from the bundle or changed by this command.
        readWorkbenchSourceDataFileV1(join(root, "trust.json"), 64_000);
        const checked = await importWorkbenchSourceDataWithProofsV1(
          root,
          readWorkbenchSourceDataFileV1(resolve(options.input)),
          {
            sourceRoot: options.scannerSource ? resolve(options.scannerSource) : undefined,
            proofRoot: options.proofRoot ? resolve(options.proofRoot) : undefined,
          },
        );
        process.stdout.write(
          JSON.stringify({
            sourceId: checked.sourceId,
            digest: checked.digest,
            sequence: checked.payload.sequence,
            activated: true,
          }) + "\n",
        );
      },
    );
}
