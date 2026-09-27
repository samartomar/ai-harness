import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CoreProductDeclarationsSourceV1,
  coreProductDeclarationsV1Bytes,
} from "../org-policy/core-product-declarations.js";
import { PACKAGE_NAME } from "../version.js";
import { hermeticGitEnv } from "./git-env.js";

export interface EmitCoreProductDeclarationsV1Input {
  /** The Core checkout whose package version and HEAD name the declarations. */
  checkout: string;
  /** A new file; an existing one is never replaced. */
  output: string;
}

export interface EmitCoreProductDeclarationsV1Result {
  output: string;
  source: CoreProductDeclarationsSourceV1;
  sha256: string;
}

const LABEL = "Core product declarations";
const GIT = {
  encoding: "utf8",
  windowsHide: true,
  timeout: 10_000,
  maxBuffer: 1024 * 1024,
} as const;

/** The release version from the checkout's package.json and its clean HEAD commit. */
export function coreCheckoutSourceV1(checkout: string): CoreProductDeclarationsSourceV1 {
  const manifest = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as unknown;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error(`${LABEL}: the checkout's package.json is not an object`);
  const { name, version } = manifest as { name?: unknown; version?: unknown };
  if (name !== PACKAGE_NAME)
    throw new Error(
      `${LABEL}: the checkout's package is ${JSON.stringify(name)}, not ${PACKAGE_NAME}`,
    );
  if (typeof version !== "string")
    throw new Error(`${LABEL}: the checkout's package.json has no version`);
  const status = execFileSync(
    "git",
    ["-C", checkout, "status", "--porcelain", "--untracked-files=all"],
    { ...GIT, env: hermeticGitEnv() },
  );
  if (status.trim() !== "")
    throw new Error(`${LABEL}: the Core checkout must be clean so HEAD names what was rendered`);
  const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
    ...GIT,
    env: hermeticGitEnv(),
  }).trim();
  return { version, commit };
}

/**
 * Render Core's product declarations for the checkout's release and HEAD and
 * write them once. The declarations themselves always come from this running
 * Core; the CLI runs it only against its own checkout.
 */
export function emitCoreProductDeclarationsV1(
  input: EmitCoreProductDeclarationsV1Input,
): EmitCoreProductDeclarationsV1Result {
  const source = coreCheckoutSourceV1(input.checkout);
  const bytes = coreProductDeclarationsV1Bytes(source);
  writeFileSync(input.output, bytes, { flag: "wx", mode: 0o644 });
  return {
    output: input.output,
    source,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
