import { createHash, randomBytes } from "node:crypto";
import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseNativeStrictJsonObjectV1 } from "../contract/native-strict-json-object-v1.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { readRegularFileWithStats, retryTransient } from "../internals/fsxn.js";
import type { StdioServer } from "../mcp/servers.js";
import {
  HEADROOM_DEPENDENCY_LOCK_SHA256,
  HEADROOM_EXCLUDE_NEWER,
  HEADROOM_RUNTIME_PIN,
  HEADROOM_RUNTIME_PYPROJECT_SHA256,
  HEADROOM_RUNTIME_SWITCHES,
  HEADROOM_RUNTIME_UV_LOCK_SHA256,
  HEADROOM_TOKENIZER_VOCABULARIES,
  type HeadroomLayout,
  type HeadroomPlatform,
  headroomLauncherDigest,
} from "./headroom.js";

export const HEADROOM_RECEIPT_VERSION = "aih-headroom-activation-receipt/v1" as const;
const MAX_RECEIPT_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const RISK_VALUES = {
  classification: new Set(["local", "third-party-hosted"]),
  egress: new Set(["none", "local-only", "vendor-incumbent", "third-party"]),
  credentials: new Set(["none", "oauth", "token"]),
  supplyChain: new Set(["pinned", "unpinned", "hosted-remote"]),
} as const;

/**
 * The activation record Headroom alone owns. It is the only evidence of the
 * user's consent; without a valid receipt no host entry is written and the
 * launcher refuses to start.
 */
export interface HeadroomActivationReceipt {
  readonly version: typeof HEADROOM_RECEIPT_VERSION;
  readonly canonicalRoot: string;
  readonly stateRoot: string;
  readonly consent: {
    readonly activateHeadroom: true;
    readonly acceptHeadroomEgress: true;
    readonly acceptedAt: string;
  };
  readonly pin: {
    readonly package: string;
    readonly version: string;
    readonly sourceCommit: string;
    readonly platform: HeadroomPlatform;
    readonly wheelSha256: string;
  };
  readonly lock: {
    readonly pyprojectSha256: string;
    readonly uvLockSha256: string;
    readonly dependencyLockSha256: string;
    readonly excludeNewer: string;
  };
  readonly vocabularies: readonly { readonly encoding: string; readonly sha256: string }[];
  readonly egressControls: Readonly<Record<string, string>>;
  readonly hosts: readonly string[];
  readonly launcher: { readonly sha256: string; readonly server: StdioServer };
}

export type HeadroomReceiptState =
  | { readonly state: "absent" }
  | {
      readonly state: "valid";
      readonly receipt: HeadroomActivationReceipt;
      readonly sha256: string;
    }
  | {
      readonly state: "stale";
      readonly receipt: HeadroomActivationReceipt;
      readonly sha256: string;
      readonly reason: string;
    }
  | { readonly state: "invalid"; readonly reason: string };

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseServer(value: unknown): StdioServer {
  const server = object(value, "Headroom launcher server");
  exactKeys(
    server,
    [
      "type",
      "command",
      "args",
      "description",
      "classification",
      "egress",
      "credentials",
      "supplyChain",
    ],
    "Headroom launcher server",
  );
  if (server.type !== "stdio") throw new Error("Headroom launcher server must be stdio");
  if (
    !Array.isArray(server.args) ||
    server.args.length > 64 ||
    server.args.some((arg) => typeof arg !== "string" || arg.length > 8_192)
  ) {
    throw new Error("Headroom launcher arguments are invalid");
  }
  for (const [field, allowed] of Object.entries(RISK_VALUES)) {
    if (!allowed.has(server[field] as never)) {
      throw new Error(`Headroom launcher ${field} is invalid`);
    }
  }
  return {
    type: "stdio",
    command: text(server.command, "Headroom launcher command"),
    args: [...(server.args as string[])],
    description: text(server.description, "Headroom launcher description"),
    classification: server.classification as StdioServer["classification"],
    egress: server.egress as StdioServer["egress"],
    credentials: server.credentials as StdioServer["credentials"],
    supplyChain: server.supplyChain as StdioServer["supplyChain"],
  };
}

function parseReceipt(value: unknown, layout: HeadroomLayout): HeadroomActivationReceipt {
  const root = object(value, "Headroom activation receipt");
  exactKeys(
    root,
    [
      "version",
      "canonicalRoot",
      "stateRoot",
      "consent",
      "pin",
      "lock",
      "vocabularies",
      "egressControls",
      "hosts",
      "launcher",
    ],
    "Headroom activation receipt",
  );
  if (root.version !== HEADROOM_RECEIPT_VERSION) {
    throw new Error("Headroom activation receipt version is unsupported");
  }
  if (root.canonicalRoot !== layout.project || root.stateRoot !== layout.stateRoot) {
    throw new Error("Headroom activation receipt belongs to another worktree or state root");
  }
  const consent = object(root.consent, "Headroom consent");
  exactKeys(
    consent,
    ["activateHeadroom", "acceptHeadroomEgress", "acceptedAt"],
    "Headroom consent",
  );
  if (
    consent.activateHeadroom !== true ||
    consent.acceptHeadroomEgress !== true ||
    typeof consent.acceptedAt !== "string" ||
    !UTC_TIMESTAMP.test(consent.acceptedAt) ||
    Number.isNaN(Date.parse(consent.acceptedAt))
  ) {
    throw new Error("Headroom consent record is invalid");
  }
  const pin = object(root.pin, "Headroom pin");
  exactKeys(pin, ["package", "version", "sourceCommit", "platform", "wheelSha256"], "Headroom pin");
  if (
    typeof pin.platform !== "string" ||
    !Object.hasOwn(HEADROOM_RUNTIME_PIN.wheels, pin.platform)
  ) {
    throw new Error("Headroom pin platform is unsupported");
  }
  const lock = object(root.lock, "Headroom lock");
  exactKeys(
    lock,
    ["pyprojectSha256", "uvLockSha256", "dependencyLockSha256", "excludeNewer"],
    "Headroom lock",
  );
  if (!Array.isArray(root.vocabularies) || root.vocabularies.length > 8) {
    throw new Error("Headroom vocabularies are invalid");
  }
  const vocabularies = root.vocabularies.map((item) => {
    const entry = object(item, "Headroom vocabulary");
    exactKeys(entry, ["encoding", "sha256"], "Headroom vocabulary");
    return {
      encoding: text(entry.encoding, "Headroom vocabulary encoding"),
      sha256: digest(entry.sha256, "Headroom vocabulary"),
    };
  });
  const controls = object(root.egressControls, "Headroom egress controls");
  const egressControls: Record<string, string> = {};
  for (const [key, entry] of Object.entries(controls)) {
    egressControls[key] = text(entry, `Headroom egress control ${key}`);
  }
  if (
    !Array.isArray(root.hosts) ||
    root.hosts.some((host) => !(SUPPORTED_CLIS as readonly unknown[]).includes(host)) ||
    new Set(root.hosts).size !== root.hosts.length
  ) {
    throw new Error("Headroom receipt hosts are invalid");
  }
  const launcher = object(root.launcher, "Headroom launcher");
  exactKeys(launcher, ["sha256", "server"], "Headroom launcher");
  const server = parseServer(launcher.server);
  if (digest(launcher.sha256, "Headroom launcher") !== headroomLauncherDigest(server)) {
    throw new Error("Headroom launcher digest does not match its recorded server");
  }
  return {
    version: HEADROOM_RECEIPT_VERSION,
    canonicalRoot: layout.project,
    stateRoot: layout.stateRoot,
    consent: { activateHeadroom: true, acceptHeadroomEgress: true, acceptedAt: consent.acceptedAt },
    pin: {
      package: text(pin.package, "Headroom pin package"),
      version: text(pin.version, "Headroom pin version"),
      sourceCommit: text(pin.sourceCommit, "Headroom pin source commit"),
      platform: pin.platform as HeadroomPlatform,
      wheelSha256: digest(pin.wheelSha256, "Headroom wheel"),
    },
    lock: {
      pyprojectSha256: digest(lock.pyprojectSha256, "Headroom pyproject"),
      uvLockSha256: digest(lock.uvLockSha256, "Headroom uv lock"),
      dependencyLockSha256: digest(lock.dependencyLockSha256, "Headroom dependency lock"),
      excludeNewer: text(lock.excludeNewer, "Headroom exclude-newer"),
    },
    vocabularies,
    egressControls,
    hosts: [...(root.hosts as string[])],
    launcher: { sha256: launcher.sha256 as string, server },
  };
}

function stalenessReason(receipt: HeadroomActivationReceipt): string | undefined {
  const current = currentPins(receipt.pin.platform);
  if (
    receipt.pin.package !== current.pin.package ||
    receipt.pin.version !== current.pin.version ||
    receipt.pin.sourceCommit !== current.pin.sourceCommit ||
    receipt.pin.wheelSha256 !== current.pin.wheelSha256
  ) {
    return `the activation installed ${receipt.pin.package}, but this Core pins ${current.pin.package}`;
  }
  if (JSON.stringify(receipt.lock) !== JSON.stringify(current.lock)) {
    return "the activation used a different Headroom dependency lock";
  }
  if (JSON.stringify(receipt.vocabularies) !== JSON.stringify(current.vocabularies)) {
    return "the activation pre-provisioned different tokenizer vocabularies";
  }
  if (JSON.stringify(receipt.egressControls) !== JSON.stringify(current.egressControls)) {
    return "the activation recorded different upstream network switches";
  }
  return undefined;
}

function currentPins(platform: HeadroomPlatform) {
  return {
    pin: {
      package: HEADROOM_RUNTIME_PIN.package,
      version: HEADROOM_RUNTIME_PIN.version,
      sourceCommit: HEADROOM_RUNTIME_PIN.sourceCommit,
      platform,
      wheelSha256: HEADROOM_RUNTIME_PIN.wheels[platform].sha256,
    },
    lock: {
      pyprojectSha256: HEADROOM_RUNTIME_PYPROJECT_SHA256,
      uvLockSha256: HEADROOM_RUNTIME_UV_LOCK_SHA256,
      dependencyLockSha256: HEADROOM_DEPENDENCY_LOCK_SHA256,
      excludeNewer: HEADROOM_EXCLUDE_NEWER,
    },
    vocabularies: HEADROOM_TOKENIZER_VOCABULARIES.map(({ encoding, sha256: hash }) => ({
      encoding,
      sha256: hash,
    })),
    egressControls: { ...HEADROOM_RUNTIME_SWITCHES },
  };
}

/** Read without trusting: a foreign or malformed record is `invalid`, a well-formed old one `stale`. */
export function readHeadroomReceipt(layout: HeadroomLayout): HeadroomReceiptState {
  const opened = readRegularFileWithStats(layout.receiptPath, { maxBytes: MAX_RECEIPT_BYTES });
  if (opened === undefined) {
    const stats = lstatSync(layout.receiptPath, { throwIfNoEntry: false });
    if (stats === undefined) return { state: "absent" };
    return { state: "invalid", reason: "Headroom activation receipt is not a safe regular file" };
  }
  if (opened.stats.nlink !== 1) {
    return { state: "invalid", reason: "Headroom activation receipt must be an unambiguous file" };
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(opened.contents);
    const receipt = parseReceipt(
      parseNativeStrictJsonObjectV1(decoded, "Headroom activation receipt"),
      layout,
    );
    const hash = sha256(opened.contents);
    const reason = stalenessReason(receipt);
    return reason === undefined
      ? { state: "valid", receipt, sha256: hash }
      : { state: "stale", receipt, sha256: hash, reason };
  } catch (error) {
    return { state: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function headroomReceiptFor(input: {
  readonly layout: HeadroomLayout;
  readonly platform: HeadroomPlatform;
  readonly acceptedAt: string;
  readonly hosts: readonly string[];
  readonly server: StdioServer;
}): HeadroomActivationReceipt {
  const current = currentPins(input.platform);
  return {
    version: HEADROOM_RECEIPT_VERSION,
    canonicalRoot: input.layout.project,
    stateRoot: input.layout.stateRoot,
    consent: { activateHeadroom: true, acceptHeadroomEgress: true, acceptedAt: input.acceptedAt },
    pin: current.pin,
    lock: current.lock,
    vocabularies: current.vocabularies,
    egressControls: current.egressControls,
    hosts: [...input.hosts],
    launcher: { sha256: headroomLauncherDigest(input.server), server: input.server },
  };
}

export function stableHeadroomReceipt(receipt: HeadroomActivationReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/**
 * Atomically replace the receipt, refusing when it changed since it was read.
 * Returns false when the stored bytes already match.
 */
export function writeHeadroomReceipt(
  layout: HeadroomLayout,
  receipt: HeadroomActivationReceipt,
  expectedSha256: string | undefined,
): boolean {
  const contents = stableHeadroomReceipt(receipt);
  const current = readRegularFileWithStats(layout.receiptPath, { maxBytes: MAX_RECEIPT_BYTES });
  if ((current === undefined ? undefined : sha256(current.contents)) !== expectedSha256) {
    throw new Error("Headroom activation receipt changed during reconciliation");
  }
  if (current !== undefined && current.contents.toString("utf8") === contents) return false;
  const temporary = join(
    dirname(layout.receiptPath),
    `.activation.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    retryTransient(() => renameSync(temporary, layout.receiptPath));
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed or already absent.
    }
  }
  return true;
}
