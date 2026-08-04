import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { readRegularFile, readRegularFileWithStats, retryTransient } from "../internals/fsxn.js";
import { defaultRunner, type Runner } from "../internals/proc.js";

const sourceRuntimeFiles = [
  {
    path: "package.json",
    rawSha256: "ef40426f722f4492b51308672e569f7cc38597f8e3722b60193527db9841a458",
    bytes: 16_913,
    fileType: "regular",
    modeIntent: "package-metadata",
  },
  {
    path: "scripts/plan-canvas.js",
    rawSha256: "5717add7a61b33833be3d2a542354ca9e8118ac46c0070da3f98eeb3e4ba550e",
    bytes: 13_587,
    fileType: "regular",
    modeIntent: "node-entrypoint",
  },
  {
    path: "scripts/lib/loopback-guard.js",
    rawSha256: "3efcc93c9c631876f824e61f97945a8260fba9ad7ea14baffee3de0781b74bcb",
    bytes: 1_801,
    fileType: "regular",
    modeIntent: "commonjs-module",
  },
  {
    path: "scripts/lib/plan-canvas/markdown.js",
    rawSha256: "bb68dda565690e3830c93c64fb502dc4dc1ecf036c0cfdbd6d38d78022b58d72",
    bytes: 9_657,
    fileType: "regular",
    modeIntent: "commonjs-module",
  },
  {
    path: "scripts/lib/plan-canvas/sdk.js",
    rawSha256: "26c0618591cbf6aac5cebf1b9555dc364ba87ad8213876a886318712b0324359",
    bytes: 10_531,
    fileType: "regular",
    modeIntent: "commonjs-module",
  },
  {
    path: "scripts/lib/plan-canvas/server.js",
    rawSha256: "cf60c4a2f295355bf1173a9cd2beb043a76a4e09322471572316d8b1eb95db5b",
    bytes: 19_290,
    fileType: "regular",
    modeIntent: "commonjs-module",
  },
  {
    path: "scripts/lib/plan-canvas/sessions.js",
    rawSha256: "12c0d16b99910bbaff7d462f4fab6865e92426fc2b179f577bb920011ead7d32",
    bytes: 8_219,
    fileType: "regular",
    modeIntent: "commonjs-module",
  },
  {
    path: "scripts/lib/plan-canvas/ui.js",
    rawSha256: "806bb5efd86b8336769da7532e83208c852ff65afbf30166562a8c5e4b45b685",
    bytes: 28_040,
    fileType: "regular",
    modeIntent: "commonjs-module",
  },
] as const;

interface RuntimeFileReceipt {
  path: string;
  rawSha256: string;
  bytes: number;
  fileType: "regular";
  modeIntent: string;
}

const HARDENED_SERVER_SOURCE_SHA256 =
  "cf60c4a2f295355bf1173a9cd2beb043a76a4e09322471572316d8b1eb95db5b";
const HARDENED_SERVER_SHA256 = "d250a6cd4945f6763202e8a233a87da54e51b269ae8943b34b9cddee44691919";
const HARDENED_SERVER_BYTES = 21_700;

const runtimeFiles = sourceRuntimeFiles.map((file) =>
  file.path === "scripts/lib/plan-canvas/server.js"
    ? {
        ...file,
        rawSha256: HARDENED_SERVER_SHA256,
        bytes: HARDENED_SERVER_BYTES,
        modeIntent: "aih-hardened-commonjs-module",
      }
    : file,
) as readonly RuntimeFileReceipt[];

export const PLAN_CANVAS_RUNTIME_PIN = {
  package: "ecc-universal",
  exactVersion: "2.1.0",
  integrity:
    "sha512-+WiK+Ray5/xUtPbzrNkiNCG90ZeKXXSOXGMUPkcPAt1U473jSkSiurH69Kqy4AWZDvKRWZ6ZeA6Vx3cNsMOiCg==",
  sourceRepository: "https://github.com/affaan-m/ECC",
  releaseAncestorCommit: "4da6deac1888690e7fb8572d097ee23db630f7a0",
  license: "MIT",
  entrypoint: "scripts/plan-canvas.js",
  sourceClosureSha256: "ffafd7303cff4728bbe39b0921d03b3e2d5e63c1f8afe4116b9f8297bb96a947",
  closureSha256: "49a23db55afab57cae37ece5426544fcdbf5c03165603d813a3529bdad720bdf",
  hardeningOverlay: {
    sourceCommit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    path: "scripts/lib/loopback-guard.js",
    rawSha256: "3efcc93c9c631876f824e61f97945a8260fba9ad7ea14baffee3de0781b74bcb",
    reason: "Reject malformed and out-of-range Host-header ports before URL parsing.",
  },
  serverHardening: {
    sourcePath: "scripts/lib/plan-canvas/server.js",
    sourceSha256: HARDENED_SERVER_SOURCE_SHA256,
    outputSha256: HARDENED_SERVER_SHA256,
    behavior:
      "Require every session artifact and served asset to remain a regular, non-linked file under the managed review root.",
  },
  sourceFiles: sourceRuntimeFiles,
  files: runtimeFiles,
} as const;

export const PLAN_CANVAS_LIMITS = {
  maxArtifactBytes: 2 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxReplyBytes: 16 * 1024,
  maxCommandTimeoutMs: 5 * 60 * 1000,
  idleTimeoutMs: 30 * 60 * 1000,
} as const;

const SHA256 = /^[a-f0-9]{64}$/;
const SUPPORTED_ARTIFACT_EXTENSIONS = new Set([".html", ".md", ".markdown"]);
const NO_EGRESS_MERMAID_MODULE =
  "data:text/javascript,export%20default%20%7Binitialize()%7B%7D,async%20run()%7B%7D%7D";
const PINNED_MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";

export interface VerifiedPlanCanvasRuntime {
  readonly root: string;
  readonly entrypoint: string;
  readonly integrity: typeof PLAN_CANVAS_RUNTIME_PIN.integrity;
  readonly closureSha256: typeof PLAN_CANVAS_RUNTIME_PIN.closureSha256;
}

const authenticatedRuntimes = new WeakSet<VerifiedPlanCanvasRuntime>();

export interface PlanCanvasReview {
  version: 1;
  id: string;
  originalPath: string;
  snapshotPath: string;
  reviewRoot: string;
  revisionSha256: string;
  bytes: number;
}

interface ArtifactSnapshotOptions {
  artifactRoot: string;
  artifactPath: string;
  stateRoot: string;
}

interface AdapterOptions {
  runtime: VerifiedPlanCanvasRuntime;
  stateRoot: string;
  nodeCommand?: string;
  run?: Runner;
  renderingEgress?: "disabled" | "pinned-mermaid";
  port?: number;
}

interface OpenOptions {
  launchBrowser?: boolean;
}

export interface PlanCanvasFeedback {
  status: "feedback" | "ended" | "missing" | "waiting";
  revisionSha256: string;
  items?: readonly Record<string, unknown>[];
  sessionEnded?: boolean;
  endedBy?: string;
  note?: string;
}

export interface PlanCanvasAdapter {
  open(review: Readonly<PlanCanvasReview>, options?: OpenOptions): Promise<Record<string, unknown>>;
  awaitFeedback(review: Readonly<PlanCanvasReview>, reply?: string): Promise<PlanCanvasFeedback>;
  end(review: Readonly<PlanCanvasReview>): Promise<void>;
  stop(): Promise<void>;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function directory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be an existing non-linked directory`);
  }
  return realpathSync(path);
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertContained(root: string, target: string, label: string): void {
  if (!isContained(root, target)) throw new Error(`${label} escapes its trusted root`);
}

function assertNoLinkedParents(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} escapes its trusted root`);
  let current = root;
  for (const segment of rel.split(/[\\/]+/).slice(0, -1)) {
    if (!segment) continue;
    current = join(current, segment);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} has a linked or non-directory parent`);
    }
  }
}

function runtimeClosureDigest(files: readonly RuntimeFileReceipt[]): string {
  return sha256(JSON.stringify(files));
}

function readRuntimeClosure(
  runtimeRoot: string,
  files: readonly RuntimeFileReceipt[],
  label: string,
): { root: string; files: ReadonlyMap<string, Buffer> } {
  const root = directory(resolve(runtimeRoot), label);
  const openedFiles = new Map<string, Buffer>();
  for (const expected of files) {
    const target = join(root, ...expected.path.split("/"));
    assertContained(root, target, `${label} file ${expected.path}`);
    assertNoLinkedParents(root, target, `${label} file ${expected.path}`);
    const opened = readRegularFileWithStats(target, { maxBytes: expected.bytes });
    if (opened === undefined || opened.stats.size !== expected.bytes) {
      throw new Error(`${label} file ${expected.path} is missing or not a regular file`);
    }
    openedFiles.set(expected.path, opened.contents);
  }
  for (const expected of files) {
    const contents = openedFiles.get(expected.path);
    if (contents === undefined || sha256(contents) !== expected.rawSha256) {
      throw new Error(`${label} file ${expected.path} hash mismatch`);
    }
  }
  return { root, files: openedFiles };
}

function replaceExactlyOnce(source: string, needle: string, replacement: string): string {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error("Plan Canvas server source does not match its reviewed hardening transform");
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`;
}

/**
 * Apply the reviewed deterministic text transform. Production always reaches
 * this through the source-hash-bound wrapper below; the string seam keeps the
 * transform independently testable without vendoring the upstream runtime.
 */
export function applyReviewedPlanCanvasServerTransform(source: string): string {
  let output = source;
  output = replaceExactlyOnce(
    output,
    "const MAX_BODY_BYTES = 1024 * 1024;",
    `const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

function isContained(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveArtifactRoot(env = process.env) {
  const configured = String(env.AIH_PLAN_CANVAS_ARTIFACT_ROOT || '');
  if (!path.isAbsolute(configured)) throw new Error('AIH Plan Canvas artifact root must be absolute');
  const info = fs.lstatSync(configured);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('AIH Plan Canvas artifact root must be a non-linked directory');
  }
  return fs.realpathSync(configured);
}

const ARTIFACT_ROOT = resolveArtifactRoot();

function readContainedFile(file, { baseDir = null, maxBytes = MAX_ARTIFACT_BYTES } = {}) {
  const requested = path.resolve(file);
  const beforeInfo = fs.lstatSync(requested);
  if (beforeInfo.isSymbolicLink() || !beforeInfo.isFile()) throw new Error('artifact must be a non-linked regular file');
  const canonical = fs.realpathSync(requested);
  if (!isContained(ARTIFACT_ROOT, canonical)) throw new Error('artifact escapes the managed review root');
  if (baseDir && !isContained(baseDir, canonical)) throw new Error('asset escapes its artifact directory');
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(requested, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    const afterInfo = fs.lstatSync(requested);
    const afterCanonical = fs.realpathSync(requested);
    if (!opened.isFile() || afterInfo.isSymbolicLink() || !afterInfo.isFile() || afterCanonical !== canonical) {
      throw new Error('artifact identity changed while opening');
    }
    if (opened.dev !== afterInfo.dev || !opened.ino || opened.ino !== afterInfo.ino) {
      throw new Error('artifact path no longer names the opened file');
    }
    if (opened.size > maxBytes) throw new Error('artifact exceeds its size limit');
    const data = fs.readFileSync(fd);
    if (data.length > maxBytes || data.length !== opened.size) throw new Error('artifact changed while reading');
    return { path: canonical, data };
  } finally {
    fs.closeSync(fd);
  }
}`,
  );
  output = replaceExactlyOnce(
    output,
    `  function watchSession(session) {
    if (watchers.has(session.key)) return;
    const dir = path.dirname(session.file);`,
    `  function watchSession(session) {
    if (watchers.has(session.key)) return;
    const reviewed = readContainedFile(session.file);
    if (reviewed.path !== session.file) throw new Error('session artifact is not canonical');
    const dir = path.dirname(reviewed.path);`,
  );
  output = replaceExactlyOnce(
    output,
    `      if (!fs.existsSync(path.resolve(body.file))) {
        return sendJson(res, 404, { error: \`artifact not found: \${body.file}\` });
      }
      const { session, refused } = store.open(body.file, { reopen: Boolean(body.reopen) });`,
    `      let reviewed;
      try {
        reviewed = readContainedFile(body.file);
      } catch {
        return sendJson(res, 403, { error: 'artifact is outside the managed review root or unsafe' });
      }
      const { session, refused } = store.open(reviewed.path, { reopen: Boolean(body.reopen) });`,
  );
  output = replaceExactlyOnce(
    output,
    `      let content;
      try {
        content = fs.readFileSync(session.file, 'utf8');
      } catch {
        return sendHtml(res, 404, \`<h1>Artifact missing</h1><p>\${session.file} no longer exists.</p>\`, { csp: false });
      }`,
    `      let content;
      try {
        content = readContainedFile(session.file).data.toString('utf8');
      } catch {
        return sendHtml(res, 404, '<h1>Artifact unavailable</h1>', { csp: false });
      }`,
  );
  output = replaceExactlyOnce(
    output,
    `    let data;
    try {
      data = fs.readFileSync(resolved);
    } catch {
      return sendJson(res, 404, { error: 'asset not found' });
    }`,
    `    let data;
    try {
      data = readContainedFile(resolved, { baseDir }).data;
    } catch {
      return sendJson(res, 404, { error: 'asset unavailable' });
    }`,
  );
  return output;
}

/** Apply the transform only to the exact independently pinned source bytes. */
function hardenPlanCanvasServer(source: Buffer): Buffer {
  if (sha256(source) !== HARDENED_SERVER_SOURCE_SHA256) {
    throw new Error("Plan Canvas server source is not the reviewed pinned revision");
  }
  return Buffer.from(applyReviewedPlanCanvasServerTransform(source.toString("utf8")), "utf8");
}

function verifyPlanCanvasSourceRoot(runtimeRoot: string, verifiedIntegrity: string) {
  if (verifiedIntegrity !== PLAN_CANVAS_RUNTIME_PIN.integrity) {
    throw new Error("Plan Canvas runtime integrity does not match the independent pin");
  }
  if (runtimeClosureDigest(sourceRuntimeFiles) !== PLAN_CANVAS_RUNTIME_PIN.sourceClosureSha256) {
    throw new Error("Plan Canvas source closure receipt is internally inconsistent");
  }
  return readRuntimeClosure(runtimeRoot, sourceRuntimeFiles, "Plan Canvas source runtime root");
}

export function materializePlanCanvasRuntime(options: {
  sourceRoot: string;
  verifiedIntegrity: string;
  destinationRoot: string;
}): VerifiedPlanCanvasRuntime {
  const source = verifyPlanCanvasSourceRoot(options.sourceRoot, options.verifiedIntegrity);
  const destination = resolve(options.destinationRoot);
  if (!isAbsolute(options.destinationRoot)) {
    throw new Error("Plan Canvas materialized runtime destination must be absolute");
  }
  const parent = directory(dirname(destination), "Plan Canvas runtime destination parent");
  assertContained(parent, destination, "Plan Canvas runtime destination");
  try {
    const current = lstatSync(destination);
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new Error("Plan Canvas runtime destination is linked or not a directory");
    }
    return verifyPlanCanvasRuntimeRoot(destination, options.verifiedIntegrity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const staging = mkdtempSync(join(parent, ".aih-plan-canvas-runtime-"));
  try {
    for (const expected of sourceRuntimeFiles) {
      const target = join(staging, ...expected.path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const sourceBytes = source.files.get(expected.path);
      if (sourceBytes === undefined)
        throw new Error("Plan Canvas source closure became incomplete");
      const contents =
        expected.path === PLAN_CANVAS_RUNTIME_PIN.serverHardening.sourcePath
          ? hardenPlanCanvasServer(sourceBytes)
          : sourceBytes;
      writeFileSync(target, contents, {
        flag: "wx",
        mode: expected.modeIntent === "node-entrypoint" ? 0o700 : 0o600,
      });
    }
    retryTransient(() => renameSync(staging, destination));
  } catch (error) {
    retryTransient(() => rmSync(staging, { recursive: true, force: true }));
    throw error;
  }
  return verifyPlanCanvasRuntimeRoot(destination, options.verifiedIntegrity);
}

/**
 * Re-authenticate the minimal runtime closure after the npm acquisition boundary
 * has SRI-verified and unpacked the exact tarball. No caller-owned digest can
 * replace the independently recorded package SRI or file receipt.
 */
export function verifyPlanCanvasRuntimeRoot(
  runtimeRoot: string,
  verifiedIntegrity: string,
): VerifiedPlanCanvasRuntime {
  if (verifiedIntegrity !== PLAN_CANVAS_RUNTIME_PIN.integrity) {
    throw new Error("Plan Canvas runtime integrity does not match the independent pin");
  }
  if (runtimeClosureDigest(runtimeFiles) !== PLAN_CANVAS_RUNTIME_PIN.closureSha256) {
    throw new Error("Plan Canvas runtime closure receipt is internally inconsistent");
  }
  const closure = readRuntimeClosure(runtimeRoot, runtimeFiles, "Plan Canvas runtime root");
  const packageBytes = closure.files.get("package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageBytes?.toString("utf8") ?? "");
  } catch {
    throw new Error("Plan Canvas package.json is malformed");
  }
  const packageSchema = z
    .object({
      name: z.literal(PLAN_CANVAS_RUNTIME_PIN.package),
      version: z.literal(PLAN_CANVAS_RUNTIME_PIN.exactVersion),
      license: z.literal(PLAN_CANVAS_RUNTIME_PIN.license),
      bin: z.object({ "ecc-plan-canvas": z.literal(PLAN_CANVAS_RUNTIME_PIN.entrypoint) }),
    })
    .passthrough();
  if (!packageSchema.safeParse(manifest).success) {
    throw new Error("Plan Canvas package.json contradicts the independent runtime pin");
  }
  const verified = Object.freeze({
    root: closure.root,
    entrypoint: join(closure.root, ...PLAN_CANVAS_RUNTIME_PIN.entrypoint.split("/")),
    integrity: PLAN_CANVAS_RUNTIME_PIN.integrity,
    closureSha256: PLAN_CANVAS_RUNTIME_PIN.closureSha256,
  });
  authenticatedRuntimes.add(verified);
  return verified;
}

function safeArtifact(options: ArtifactSnapshotOptions): {
  artifactRoot: string;
  stateRoot: string;
  originalPath: string;
  contents: Buffer;
} {
  const artifactRoot = directory(resolve(options.artifactRoot), "Plan Canvas artifact root");
  const stateRoot = directory(resolve(options.stateRoot), "Plan Canvas state root");
  const requested = isAbsolute(options.artifactPath)
    ? resolve(options.artifactPath)
    : resolve(artifactRoot, options.artifactPath);
  assertContained(artifactRoot, requested, "Plan Canvas artifact");
  assertNoLinkedParents(artifactRoot, requested, "Plan Canvas artifact");
  const requestedStats = lstatSync(requested);
  if (requestedStats.isSymbolicLink() || !requestedStats.isFile()) {
    throw new Error("Plan Canvas artifact must be a non-linked regular file");
  }
  const before = realpathSync(requested);
  assertContained(artifactRoot, before, "Plan Canvas artifact");
  const extension = extname(before).toLowerCase();
  if (!SUPPORTED_ARTIFACT_EXTENSIONS.has(extension)) {
    throw new Error(`Plan Canvas artifact extension is not supported: ${extension || "(none)"}`);
  }
  const opened = readRegularFileWithStats(requested, {
    maxBytes: PLAN_CANVAS_LIMITS.maxArtifactBytes,
  });
  if (opened === undefined) {
    throw new Error(
      "Plan Canvas artifact is missing, linked, not a regular file, or exceeds its size limit",
    );
  }
  const after = realpathSync(requested);
  if (after !== before || opened.stats.size !== opened.contents.length) {
    throw new Error("Plan Canvas artifact identity changed while it was being read");
  }
  return { artifactRoot, stateRoot, originalPath: before, contents: opened.contents };
}

/** Copy one reviewed artifact into an immutable, content-addressed state slot. */
export function createPlanCanvasArtifactSnapshot(
  options: ArtifactSnapshotOptions,
): PlanCanvasReview {
  const safe = safeArtifact(options);
  const revisionSha256 = sha256(safe.contents);
  const id = sha256(`${safe.originalPath}\0${revisionSha256}`).slice(0, 24);
  const reviewRoot = join(safe.stateRoot, "reviews", id);
  mkdirSync(reviewRoot, { recursive: true, mode: 0o700 });
  const canonicalReviewRoot = realpathSync(reviewRoot);
  assertContained(safe.stateRoot, canonicalReviewRoot, "Plan Canvas review state");
  const extension = extname(safe.originalPath).toLowerCase();
  const snapshotPath = join(canonicalReviewRoot, `artifact${extension}`);
  const existing = readRegularFile(snapshotPath, { maxBytes: PLAN_CANVAS_LIMITS.maxArtifactBytes });
  if (existing === undefined) {
    writeFileSync(snapshotPath, safe.contents, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(snapshotPath, 0o600);
  } else if (!existing.equals(safe.contents)) {
    throw new Error("Plan Canvas revision snapshot conflicts with existing managed state");
  }
  return {
    version: 1,
    id,
    originalPath: safe.originalPath,
    snapshotPath,
    reviewRoot: canonicalReviewRoot,
    revisionSha256,
    bytes: safe.contents.length,
  };
}

const feedbackItemSchema = z
  .object({
    kind: z.enum(["annotation", "chat", "verdict"]),
    text: z.string().max(PLAN_CANVAS_LIMITS.maxReplyBytes).optional(),
    verdict: z.enum(["approve", "request-changes"]).optional(),
  })
  .passthrough()
  .superRefine((item, context) => {
    if (item.kind === "verdict" && item.verdict === undefined) {
      context.addIssue({ code: "custom", message: "verdict feedback requires a verdict" });
    }
  });

const runtimeResultSchema = z
  .object({
    status: z.enum(["ended", "feedback", "missing", "not running", "open", "stopping", "waiting"]),
    items: z.array(feedbackItemSchema).max(256).optional(),
    sessionEnded: z.boolean().optional(),
    endedBy: z.string().max(128).optional(),
    note: z.string().max(4096).optional(),
  })
  .passthrough();

function validateReview(review: Readonly<PlanCanvasReview>, stateRoot: string): Buffer {
  if (
    review.version !== 1 ||
    !/^[a-f0-9]{24}$/.test(review.id) ||
    !SHA256.test(review.revisionSha256)
  ) {
    throw new Error("Plan Canvas review identity is malformed");
  }
  const expectedRoot = join(stateRoot, "reviews", review.id);
  if (resolve(review.reviewRoot) !== resolve(expectedRoot)) {
    throw new Error("Plan Canvas review state is outside its managed root");
  }
  assertContained(review.reviewRoot, resolve(review.snapshotPath), "Plan Canvas snapshot");
  const bytes = readRegularFile(review.snapshotPath, {
    maxBytes: PLAN_CANVAS_LIMITS.maxArtifactBytes,
  });
  if (
    bytes === undefined ||
    bytes.length !== review.bytes ||
    sha256(bytes) !== review.revisionSha256
  ) {
    throw new Error("Plan Canvas reviewed revision changed or is unavailable");
  }
  return bytes;
}

function validateRuntimeIdentity(runtime: VerifiedPlanCanvasRuntime): void {
  if (!authenticatedRuntimes.has(runtime)) {
    throw new Error("Plan Canvas adapter requires an authenticated runtime acquisition result");
  }
  if (
    runtime.integrity !== PLAN_CANVAS_RUNTIME_PIN.integrity ||
    runtime.closureSha256 !== PLAN_CANVAS_RUNTIME_PIN.closureSha256
  ) {
    throw new Error("Plan Canvas adapter requires the independently verified runtime");
  }
  const expectedEntrypoint = join(runtime.root, ...PLAN_CANVAS_RUNTIME_PIN.entrypoint.split("/"));
  if (resolve(runtime.entrypoint) !== resolve(expectedEntrypoint)) {
    throw new Error("Plan Canvas runtime entrypoint contradicts the verified closure");
  }
}

function processEnvironment(
  stateRoot: string,
  renderingEgress: "disabled" | "pinned-mermaid",
  port: number | undefined,
): NodeJS.ProcessEnv {
  return {
    SYSTEMROOT: process.env.SYSTEMROOT,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    TEMP: stateRoot,
    TMP: stateRoot,
    AIH_PLAN_CANVAS_ARTIFACT_ROOT: join(stateRoot, "reviews"),
    ECC_PLAN_CANVAS_STATE_DIR: join(stateRoot, "runtime-state"),
    ECC_PLAN_CANVAS_IDLE_MS: String(PLAN_CANVAS_LIMITS.idleTimeoutMs),
    ...(port !== undefined ? { ECC_PLAN_CANVAS_PORT: String(port) } : {}),
    ECC_PLAN_CANVAS_MERMAID_URL:
      renderingEgress === "pinned-mermaid" ? PINNED_MERMAID_URL : NO_EGRESS_MERMAID_MODULE,
  };
}

/**
 * AIH-owned transport over the pinned CLI. It never exposes `server --host`,
 * operates only on managed snapshots, and defaults rendering to no network egress.
 */
export function createPlanCanvasAdapter(options: AdapterOptions): PlanCanvasAdapter {
  validateRuntimeIdentity(options.runtime);
  const stateRoot = directory(resolve(options.stateRoot), "Plan Canvas state root");
  const runtimeState = join(stateRoot, "runtime-state");
  const reviewsRoot = join(stateRoot, "reviews");
  mkdirSync(runtimeState, { recursive: true, mode: 0o700 });
  mkdirSync(reviewsRoot, { recursive: true, mode: 0o700 });
  assertContained(stateRoot, realpathSync(runtimeState), "Plan Canvas runtime state");
  assertContained(stateRoot, realpathSync(reviewsRoot), "Plan Canvas review state");
  const nodeCommand = options.nodeCommand ?? process.execPath;
  if (!isAbsolute(nodeCommand)) throw new Error("Plan Canvas Node runtime must be absolute");
  const run = options.run ?? defaultRunner;
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65_535)
  ) {
    throw new Error("Plan Canvas port must be an unprivileged TCP port");
  }
  const env = processEnvironment(stateRoot, options.renderingEgress ?? "disabled", options.port);
  const pendingCleanup = new Set<string>();

  const removeReviewRoot = (managedRoot: string): boolean => {
    try {
      retryTransient(() => rmSync(managedRoot, { recursive: true, force: true }));
      pendingCleanup.delete(managedRoot);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
        pendingCleanup.add(managedRoot);
        return false;
      }
      throw error;
    }
  };

  const invoke = async (
    review: Readonly<PlanCanvasReview> | undefined,
    args: string[],
    timeoutMs: number,
  ): Promise<z.infer<typeof runtimeResultSchema>> => {
    if (review !== undefined) validateReview(review, stateRoot);
    const cwd = review === undefined ? stateRoot : dirname(review.snapshotPath);
    const result = await run([nodeCommand, options.runtime.entrypoint, ...args], {
      cwd,
      env,
      timeoutMs: Math.min(timeoutMs, PLAN_CANVAS_LIMITS.maxCommandTimeoutMs),
      maxBufferBytes: PLAN_CANVAS_LIMITS.maxOutputBytes,
    });
    if (result.spawnError || result.code !== 0 || result.truncated) {
      throw new Error("Plan Canvas runtime command failed or exceeded its process boundary");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Plan Canvas runtime returned malformed JSON");
    }
    const validated = runtimeResultSchema.safeParse(parsed);
    if (!validated.success) throw new Error("Plan Canvas runtime returned an invalid result");
    return validated.data;
  };

  return {
    async open(review, openOptions = {}) {
      const args = ["open", review.snapshotPath];
      if (openOptions.launchBrowser !== true) args.push("--no-open");
      const result = await invoke(review, args, 30_000);
      if (result.status !== "open") throw new Error("Plan Canvas runtime did not open the review");
      return { ...result, revisionSha256: review.revisionSha256 };
    },
    async awaitFeedback(review, reply) {
      if (
        reply !== undefined &&
        Buffer.byteLength(reply, "utf8") > PLAN_CANVAS_LIMITS.maxReplyBytes
      ) {
        throw new Error("Plan Canvas reply exceeds its size limit");
      }
      const serverTimeoutMs = PLAN_CANVAS_LIMITS.maxCommandTimeoutMs - 5_000;
      const args = ["await", review.snapshotPath, "--timeout-ms", String(serverTimeoutMs)];
      if (reply !== undefined) args.push("--reply", reply);
      const result = await invoke(review, args, PLAN_CANVAS_LIMITS.maxCommandTimeoutMs);
      if (!["feedback", "ended", "missing", "waiting"].includes(result.status)) {
        throw new Error("Plan Canvas runtime returned an invalid await status");
      }
      validateReview(review, stateRoot);
      return {
        status: result.status as PlanCanvasFeedback["status"],
        revisionSha256: review.revisionSha256,
        ...(result.items !== undefined ? { items: result.items } : {}),
        ...(result.sessionEnded !== undefined ? { sessionEnded: result.sessionEnded } : {}),
        ...(result.endedBy !== undefined ? { endedBy: result.endedBy } : {}),
        ...(result.note !== undefined ? { note: result.note } : {}),
      };
    },
    async end(review) {
      const result = await invoke(review, ["end", review.snapshotPath], 30_000);
      if (result.status !== "ended" && result.status !== "missing") {
        throw new Error("Plan Canvas runtime did not end the review");
      }
      validateReview(review, stateRoot);
      const managedRoot = join(stateRoot, "reviews", review.id);
      if (resolve(review.reviewRoot) !== resolve(managedRoot)) {
        throw new Error("refusing to clean an unmanaged Plan Canvas review root");
      }
      removeReviewRoot(managedRoot);
    },
    async stop() {
      const result = await invoke(undefined, ["stop"], 30_000);
      if (result.status !== "stopping" && result.status !== "not running") {
        throw new Error("Plan Canvas runtime did not stop cleanly");
      }
      for (let attempt = 0; attempt < 20 && pendingCleanup.size > 0; attempt++) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        for (const managedRoot of [...pendingCleanup]) removeReviewRoot(managedRoot);
      }
      if (pendingCleanup.size > 0) {
        throw new Error("Plan Canvas stopped but managed review cleanup remained locked");
      }
    },
  };
}

export const PLAN_CANVAS_RENDERING_POLICY = {
  default: "disabled",
  pinnedMermaidUrl: PINNED_MERMAID_URL,
  behavior:
    "Remote Mermaid rendering is disabled by default and may use only the reviewed exact URL when explicitly enabled.",
} as const;

export function planCanvasReviewLabel(review: Readonly<PlanCanvasReview>): string {
  return `${basename(review.originalPath)}@${review.revisionSha256.slice(0, 12)}`;
}
