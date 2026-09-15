import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1 } from "../../../baseline-evidence/scanner-publication-policy.js";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../../../contract/strict-json-v1.js";
import {
  type EccRuntimeDescriptorSealV1,
  type EccRuntimeDescriptorV1,
  inspectEccRuntimeDescriptorSealV1,
  type PreparedEccRuntimeDescriptorV1,
} from "../../../ecc/runtime-descriptor.js";
import { readRegularFileWithStats } from "../../../internals/fsxn.js";
import { VERSION } from "../../../version.js";
import { CATALOG_QUALIFICATION_RELEASE_POLICY_V1 } from "./catalog-qualification-policy-v1.js";
import { sealPreparedEccRuntimeDescriptorV1 } from "./source-data-runtime-descriptor-custody.js";

// Changing verification semantics invalidates receipts created by older code.
const VERIFIER_POLICY = "workbench-source-verifier/v1";
const VERIFIER_POLICY_DIGEST = canonicalStrictJsonSha256V1({
  version: VERIFIER_POLICY,
  coreVersion: VERSION,
  scanner: SCANNER_BASELINE_PUBLICATION_PUBLISHERS_V1,
  catalog: CATALOG_QUALIFICATION_RELEASE_POLICY_V1,
});
const ReceiptSchema = z
  .object({
    version: z.enum(["local-workbench-verification/v1", "local-workbench-verification/v2"]),
    verifierPolicy: z.literal(VERIFIER_POLICY),
    verifierPolicyDigest: z.literal(VERIFIER_POLICY_DIGEST),
    store: z.string().regex(/^[a-f0-9]{64}$/),
    envelopeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    trustDigest: z.string().regex(/^[a-f0-9]{64}$/),
    summaryDigest: z.string().regex(/^[a-f0-9]{64}$/),
    verifiedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    runtimeDescriptor: z
      .object({
        bytesBase64: z
          .string()
          .min(1)
          .max(16 * 1024 * 1024),
        sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      (receipt.version === "local-workbench-verification/v1") !==
      (receipt.runtimeDescriptor === undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["runtimeDescriptor"],
        message: "runtime descriptor receipt version mismatch",
      });
  });
const SignedSchema = z
  .object({ payload: ReceiptSchema, signature: z.string().length(88) })
  .strict();
type Receipt = z.infer<typeof ReceiptSchema>;
function fail(): never {
  throw new TypeError(
    "Workbench local verification receipt unavailable or invalid; reimport original proofs on this PC.",
  );
}
function storeId(root: string) {
  const store = realpathSync(root);
  let ancestor = resolve(privateRoot());
  const parts: string[] = [];
  while (!existsSync(ancestor)) {
    parts.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) fail();
    ancestor = parent;
  }
  const local = join(realpathSync(ancestor), ...parts);
  const within = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  if (within(store, local) || within(local, store)) fail();
  return createHash("sha256").update(store).digest("hex");
}
function privateRoot() {
  const override = process.env.AIH_WORKBENCH_VERIFIER_HOME;
  if (override !== undefined && (!isAbsolute(override) || override.includes("\0"))) fail();
  return override ?? join(homedir(), ".aih", "workbench-verifier", "v1");
}
function permissions(path: string, initialize = false, keyPath?: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail();
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail();
    return;
  }
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) fail();
  // Paths are data passed through the environment, never interpolated in script.
  const script = `$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($p in @($env:AIH_VERIFIER_DIRECTORY,$env:AIH_VERIFIER_KEY)) {
  if([string]::IsNullOrEmpty($p)){continue}
  $isDir=[System.IO.Directory]::Exists($p)
  if($env:AIH_VERIFIER_INITIALIZE -eq '1') {
    if($isDir){$acl=[System.Security.AccessControl.DirectorySecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}
    else{$acl=[System.Security.AccessControl.FileSecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')}
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule)
    if($isDir){[System.IO.Directory]::SetAccessControl($p,$acl)}else{[System.IO.File]::SetAccessControl($p,$acl)}
  }
  if($isDir){$acl=[System.IO.Directory]::GetAccessControl($p)}else{$acl=[System.IO.File]::GetAccessControl($p)}
  if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'permission mismatch'}
  foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -ne $sid.Value){throw 'permission mismatch'}}
}
'OK'`;
  const result = execFileSync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AIH_VERIFIER_DIRECTORY: path,
        AIH_VERIFIER_KEY: keyPath ?? "",
        AIH_VERIFIER_INITIALIZE: initialize ? "1" : "0",
      },
    },
  );
  if (result.trim() !== "OK") fail();
}
function writeNewPrivateFile(path: string, bytes: string | Buffer): void {
  // Acquire atomically; never write through a path observed by an earlier check.
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
}
function key(create: boolean) {
  const root = privateRoot();
  const initialize = !existsSync(root);
  if (initialize) {
    if (!create) fail();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    permissions(root, true);
  }
  const path = join(root, "verification-key.pkcs8.pem");
  const existingKey = existsSync(path);
  // Check both ACLs before acquiring existing private bytes. The regular-file
  // reader then enforces handle identity, link count, and bounded reads.
  if (existingKey) permissions(root, false, path);
  else if (!initialize) permissions(root);
  let material = readRegularFileWithStats(path, { maxBytes: 8192 });
  if (!material) {
    // Never regenerate a missing key next to existing receipts.
    if (!create || existsSync(join(root, "initialized"))) fail();
    const generated = generateKeyPairSync("ed25519");
    writeNewPrivateFile(path, generated.privateKey.export({ format: "pem", type: "pkcs8" }));
    permissions(path, true);
    writeNewPrivateFile(join(root, "initialized"), "local-verification/v1");
    material = readRegularFileWithStats(path, { maxBytes: 8192 });
  }
  if (!material) fail();
  const stat = material.stats;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 8192 ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
  )
    fail();
  if (!existingKey) permissions(root, false, path);
  const privateKey = createPrivateKey(material.contents);
  if (privateKey.asymmetricKeyType !== "ed25519") fail();
  return { root, privateKey };
}
function receiptPath(root: string, digest: string, directory: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail();
  return join(directory, `${storeId(root)}-${digest.slice(7)}.json`);
}

/** Local receipt only: neither portable public provenance nor Scanner/Catalog authority. */
export function writeSourceDataLocalReceiptV1(
  root: string,
  receipt: Omit<
    Receipt,
    "version" | "verifierPolicy" | "verifierPolicyDigest" | "store" | "runtimeDescriptor"
  > & { runtimeDescriptor?: PreparedEccRuntimeDescriptorV1 },
): void {
  storeId(root);
  const local = key(true);
  const runtimeDescriptor =
    receipt.runtimeDescriptor === undefined
      ? undefined
      : sealPreparedEccRuntimeDescriptorV1(receipt.runtimeDescriptor);
  const payload = ReceiptSchema.parse({
    ...receipt,
    version:
      runtimeDescriptor === undefined
        ? "local-workbench-verification/v1"
        : "local-workbench-verification/v2",
    verifierPolicy: VERIFIER_POLICY,
    verifierPolicyDigest: VERIFIER_POLICY_DIGEST,
    store: storeId(root),
    ...(runtimeDescriptor === undefined ? {} : { runtimeDescriptor }),
  });
  const bytes = canonicalStrictJsonBytesV1({
    payload,
    signature: sign(null, canonicalStrictJsonBytesV1(payload), local.privateKey).toString("base64"),
  });
  const path = receiptPath(root, payload.envelopeDigest, local.root);
  const temporary = join(local.root, `${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

export function verifySourceDataLocalReceiptV1(
  root: string,
  expected: Pick<Receipt, "envelopeDigest" | "trustDigest" | "summaryDigest">,
  now: string,
  historical: boolean,
): Receipt {
  storeId(root);
  const local = key(false);
  const path = receiptPath(root, expected.envelopeDigest, local.root);
  const material = readRegularFileWithStats(path, { maxBytes: 20 * 1024 * 1024 });
  if (material?.identity.nlink !== 1n) fail();
  const bytes = material.contents.toString("utf8");
  const receipt = SignedSchema.parse(parseStrictJsonObjectV1(bytes, "Local verification receipt"));
  const signature = Buffer.from(receipt.signature, "base64");
  if (
    canonicalStrictJsonBytesV1(receipt).toString("utf8") !== bytes ||
    signature.toString("base64") !== receipt.signature ||
    !verify(
      null,
      canonicalStrictJsonBytesV1(receipt.payload),
      createPublicKey(local.privateKey),
      signature,
    ) ||
    receipt.payload.store !== storeId(root) ||
    Object.entries(expected).some(
      ([field, value]) => receipt.payload[field as keyof Receipt] !== value,
    ) ||
    Date.parse(receipt.payload.verifiedAt) > Date.parse(now) ||
    (!historical && Date.parse(receipt.payload.expiresAt) <= Date.parse(now))
  )
    fail();
  return receipt.payload;
}

/** Reads a descriptor only after the same local signature and source-data digests pass. */
export function readSourceDataLocalRuntimeDescriptorV1(
  root: string,
  expected: Pick<Receipt, "envelopeDigest" | "trustDigest" | "summaryDigest">,
  now: string,
  historical: boolean,
): EccRuntimeDescriptorV1 | undefined {
  const receipt = verifySourceDataLocalReceiptV1(root, expected, now, historical);
  if (receipt.runtimeDescriptor === undefined) return undefined;
  return inspectEccRuntimeDescriptorSealV1(receipt.runtimeDescriptor as EccRuntimeDescriptorSealV1);
}

/** Canonical digests of independently verified facts, never a replacement for the local signature. */
export function sourceDataReceiptDigestsV1(
  envelopeDigest: string,
  trust: unknown,
  summaries: unknown,
) {
  return {
    envelopeDigest,
    trustDigest: canonicalStrictJsonSha256V1(trust),
    summaryDigest: canonicalStrictJsonSha256V1(summaries),
  };
}

const HeadSchema = z
  .object({
    payload: z
      .object({
        version: z.literal("local-workbench-head/v1"),
        store: z.string().regex(/^[a-f0-9]{64}$/),
        indexDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    signature: z.string().length(88),
  })
  .strict();
/** The trusted local head prevents rollback of the untrusted active pointer and history together. */
export function verifySourceDataLocalHeadV1(root: string, index: unknown): void {
  const path = join(privateRoot(), `head-${storeId(root)}.json`);
  if (!existsSync(path)) return;
  const local = key(false);
  const material = readRegularFileWithStats(path, { maxBytes: 4096 });
  if (material?.identity.nlink !== 1n) fail();
  const head = HeadSchema.parse(
    parseStrictJsonObjectV1(material.contents.toString("utf8"), "Local source head"),
  );
  const signature = Buffer.from(head.signature, "base64");
  if (
    head.payload.store !== storeId(root) ||
    head.payload.indexDigest !== canonicalStrictJsonSha256V1(index) ||
    signature.toString("base64") !== head.signature ||
    !verify(
      null,
      canonicalStrictJsonBytesV1(head.payload),
      createPublicKey(local.privateKey),
      signature,
    )
  )
    fail();
}
/** Stage the protected head first; a crash before pointer commit fails closed until explicit reimport. */
export function stageSourceDataLocalHeadV1(
  root: string,
  previous: unknown,
  next: unknown,
): () => void {
  try {
    verifySourceDataLocalHeadV1(root, previous);
  } catch {
    verifySourceDataLocalHeadV1(root, next);
  }
  const local = key(true);
  const path = join(local.root, `head-${storeId(root)}.json`);
  const priorMaterial = readRegularFileWithStats(path, { maxBytes: 4096 });
  if (!priorMaterial && existsSync(path)) fail();
  const before = priorMaterial?.contents;
  const payload = {
    version: "local-workbench-head/v1",
    store: storeId(root),
    indexDigest: canonicalStrictJsonSha256V1(next),
  };
  const bytes = canonicalStrictJsonBytesV1({
    payload,
    signature: sign(null, canonicalStrictJsonBytesV1(payload), local.privateKey).toString("base64"),
  });
  const atomic = (contents: Buffer) => {
    const temp = join(local.root, `${randomUUID()}.tmp`);
    writeFileSync(temp, contents, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  };
  atomic(bytes);
  return () => {
    if (before === undefined) unlinkSync(path);
    else atomic(before);
  };
}
