import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { AihError, PathContainmentError } from "../errors.js";
import { type ExecAction, exec, type PlanContext } from "../internals/plan.js";

export type TrustSource = LocalTrustSource | GitHubTrustSource;

export interface LocalTrustSource {
  kind: "local";
  id: string;
  source: string;
  root: string;
  display: string;
}

export interface GitHubTrustSource {
  kind: "github";
  id: string;
  source: string;
  owner: string;
  repo: string;
  ref: string;
  pin?: string;
  quarantineRoot: string;
  treePath: string;
  metadataPath: string;
  display: string;
}

export interface TrustFetchMetadata {
  kind: "github";
  owner: string;
  repo: string;
  ref: string;
  pinnedSha: string;
  source: string;
  treePath: string;
}

const GITHUB_SOURCE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const SAFE_ENV_KEYS = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LOCALAPPDATA",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "UV_CACHE_DIR",
  "WINDIR",
]);

function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "source";
}

function sourceIdForLocal(absPath: string): string {
  return slugify(basename(absPath));
}

function sourceIdForGitHub(owner: string, repo: string): string {
  return slugify(`${owner}-${repo}`);
}

function quarantineRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-quarantine-"));
  try {
    chmodSync(root, 0o700);
  } catch {
    // mkdtemp already creates an owner-only directory on POSIX. Windows ACLs
    // are platform-managed, so chmod failures there should not block resolution.
  }
  return root;
}

export function cleanupQuarantine(source: TrustSource | undefined): Error | undefined {
  if (source?.kind !== "github") return;
  try {
    rmSync(source.quarantineRoot, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.includes("TOKEN") ||
    upper.includes("SECRET") ||
    upper.includes("PASSWORD") ||
    upper.endsWith("_KEY") ||
    upper.endsWith("_CREDENTIALS") ||
    upper.startsWith("AWS_") ||
    upper.startsWith("GITHUB_") ||
    upper.startsWith("ANTHROPIC_") ||
    upper.startsWith("OPENAI_")
  );
}

export function scrubFetchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isSecretEnvKey(key)) continue;
    if (SAFE_ENV_KEYS.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

const FULL_SHA = /^[a-f0-9]{40}$/;
const SAFE_GIT_REF_CHARS = /^[A-Za-z0-9._/-]+$/;

function hasWhitespaceOrControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}

export function isSafeGitRefName(ref: string): boolean {
  if (ref.length === 0 || ref.startsWith("-")) return false;
  if (hasWhitespaceOrControl(ref) || !SAFE_GIT_REF_CHARS.test(ref)) return false;
  if (
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("//") ||
    ref.includes("..") ||
    ref.includes("@{")
  ) {
    return false;
  }
  return ref
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function resolveTrustSource(
  raw: string,
  opts: { root: string; ref?: string; pin?: string; skipDirs?: ReadonlySet<string> } = {
    root: process.cwd(),
  },
): TrustSource {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new AihError("workspace add requires a source", "AIH_TRUST");

  const local = isAbsolute(trimmed) ? trimmed : resolve(opts.root, trimmed);
  if (existsSync(local)) {
    const root = assertTrustTreeSafe(local, { skipDirs: opts.skipDirs });
    return {
      kind: "local",
      id: sourceIdForLocal(root),
      source: root,
      root,
      display: root,
    };
  }

  const gh = GITHUB_SOURCE.exec(trimmed);
  if (!gh) {
    throw new AihError(
      `unsupported trust source: ${raw} (use a local path or owner/repo)`,
      "AIH_TRUST",
    );
  }
  const owner = gh[1] ?? "";
  const repo = gh[2] ?? "";
  if (owner.length === 0 || repo.length === 0) {
    throw new AihError(`unsupported GitHub trust source: ${raw}`, "AIH_TRUST");
  }
  if (opts.pin !== undefined && !FULL_SHA.test(opts.pin)) {
    throw new AihError("--pin must be a lowercase 40-character Git commit SHA", "AIH_TRUST");
  }
  if (opts.ref !== undefined && !isSafeGitRefName(opts.ref)) {
    throw new AihError(
      "--ref must be a safe Git ref (letters, numbers, '/', '.', '_' or '-', and not leading '-')",
      "AIH_TRUST",
    );
  }
  const ref = opts.pin ?? opts.ref ?? "HEAD";
  const root = quarantineRoot();
  return {
    kind: "github",
    id: sourceIdForGitHub(owner, repo),
    source: trimmed,
    owner,
    repo,
    ref,
    pin: opts.pin,
    quarantineRoot: root,
    treePath: join(root, "tree"),
    metadataPath: join(root, "metadata.json"),
    display: `${owner}/${repo}@${ref}`,
  };
}

/**
 * A first-party source: a LOCAL path resolved UNDER the repo root (e.g. a bundled
 * skill in `packs/`). First-party sources are graded on aih-native coverage
 * (skillVerdict) and marked on their approval (card + lockfile) for auditability;
 * a local path OUTSIDE the repo is NOT first-party.
 */
export function isFirstPartySource(root: string, source: TrustSource): boolean {
  if (source.kind !== "local") return false;
  let realRoot: string;
  let realSource: string;
  try {
    realRoot = realpathSync(resolve(root));
    realSource = realpathSync(resolve(source.root));
  } catch {
    return false;
  }
  const rel = relative(realRoot, realSource);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function statSafe(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function assertContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new PathContainmentError(
    `refusing to read outside the trust source\n  root:   ${root}\n  target: ${target}`,
  );
}

export function assertTrustTreeSafe(
  root: string,
  opts: { skipDirs?: ReadonlySet<string> } = {},
): string {
  const absRoot = resolve(root);
  const rootInfo = statSafe(absRoot);
  if (rootInfo === undefined) {
    throw new AihError(`trust source is not a directory: ${root}`, "AIH_TRUST");
  }

  const realRoot = realpathSync(absRoot);
  if (!lstatSync(realRoot).isDirectory()) {
    throw new AihError(`trust source is not a directory: ${root}`, "AIH_TRUST");
  }
  const visit = (abs: string): void => {
    if (abs !== realRoot && opts.skipDirs?.has(basename(abs))) return;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      assertContained(realRoot, realpathSync(abs));
      return;
    }
    if (st.isFile() && st.nlink > 1) {
      throw new AihError(`refusing hard-linked file inside trust source: ${abs}`, "AIH_TRUST");
    }
    assertContained(realRoot, realpathSync(abs));
    if (!st.isDirectory()) return;
    for (const entry of readdirSync(abs)) visit(join(abs, entry));
  };
  visit(realRoot);
  return realRoot;
}

export function readTrustFetchMetadata(source: GitHubTrustSource): TrustFetchMetadata {
  const text = readFileSync(source.metadataPath, "utf8");
  return JSON.parse(text) as TrustFetchMetadata;
}

const GITHUB_FETCH_SCRIPT = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const tls = require("node:tls");
const zlib = require("node:zlib");

const input = JSON.parse(process.argv[1]);
const OWNER_DIR_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

function chmodBestEffort(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Windows ACLs are platform-managed; POSIX paths are already created with
    // owner-only modes below, and chmod just tightens any umask variation.
  }
}

function mkdirOwner(target) {
  fs.mkdirSync(target, { recursive: true, mode: OWNER_DIR_MODE });
  chmodBestEffort(target, OWNER_DIR_MODE);
}

function writeFileOwner(target, data, encoding) {
  fs.writeFileSync(
    target,
    data,
    encoding === undefined
      ? { flag: "wx", mode: OWNER_FILE_MODE }
      : { encoding, flag: "wx", mode: OWNER_FILE_MODE },
  );
  chmodBestEffort(target, OWNER_FILE_MODE);
}

function envValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function noProxyMatches(target) {
  const raw = envValue(["NO_PROXY", "no_proxy"]);
  if (!raw) return false;
  const host = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  for (const item of raw.split(",")) {
    const rule = item.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    const colon = rule.lastIndexOf(":");
    const hasPort = colon > -1 && !rule.startsWith("[") && /^\d+$/.test(rule.slice(colon + 1));
    const ruleHost = hasPort ? rule.slice(0, colon) : rule;
    const rulePort = hasPort ? rule.slice(colon + 1) : "";
    if (rulePort && rulePort !== port) continue;
    if (ruleHost.startsWith(".")) {
      const domain = ruleHost.slice(1);
      if (host === domain || host.endsWith("." + domain)) return true;
    } else if (host === ruleHost || host.endsWith("." + ruleHost)) {
      return true;
    }
  }
  return false;
}

function proxyFor(target) {
  if (noProxyMatches(target)) return undefined;
  const raw = envValue(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]);
  if (!raw) return undefined;
  let proxy;
  try {
    proxy = new URL(raw);
  } catch {
    fail("invalid proxy URL in HTTPS_PROXY/HTTP_PROXY");
  }
  if (proxy.protocol !== "http:") {
    fail("only http:// proxy URLs are supported for quarantined GitHub fetches");
  }
  return proxy;
}

function proxyAuth(proxy) {
  if (!proxy.username && !proxy.password) return undefined;
  const user = decodeURIComponent(proxy.username || "");
  const pass = decodeURIComponent(proxy.password || "");
  return "Basic " + Buffer.from(user + ":" + pass).toString("base64");
}

function connectThroughProxy(target, proxy) {
  return new Promise((resolve, reject) => {
    const targetPort = target.port || "443";
    const connectPath = target.hostname + ":" + targetPort;
    const headers = { Host: connectPath };
    const auth = proxyAuth(proxy);
    if (auth) headers["Proxy-Authorization"] = auth;
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || "80",
      method: "CONNECT",
      path: connectPath,
      headers,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error("proxy CONNECT " + res.statusCode + " for " + connectPath));
        return;
      }
      const secure = tls.connect({ socket, servername: target.hostname });
      secure.once("secureConnect", () => resolve(secure));
      secure.once("error", reject);
    });
    req.once("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("proxy CONNECT timed out: " + connectPath)));
    req.end();
  });
}

function collectResponse(url, res, resolve, reject) {
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    res.resume();
    requestBuffer(new URL(res.headers.location, url).toString()).then(resolve, reject);
    return;
  }
  if (res.statusCode !== 200) {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => reject(new Error("HTTP " + res.statusCode + " from " + url + ": " + Buffer.concat(chunks).toString("utf8").slice(0, 400))));
    return;
  }
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => resolve(Buffer.concat(chunks)));
}

function requestBuffer(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = { "user-agent": "aih-trust-fetch", accept: "application/vnd.github+json" };
    const proxy = proxyFor(target);
    const start = (options) => {
      const req = https.request(target, options, (res) => collectResponse(url, res, resolve, reject));
      req.on("error", reject);
      req.setTimeout(30000, () => req.destroy(new Error("request timed out: " + url)));
      req.end();
    };
    if (!proxy) {
      start({ headers });
      return;
    }
    connectThroughProxy(target, proxy)
      .then((socket) => start({ headers, createConnection: () => socket }))
      .catch(reject);
  });
}

function octal(buf, start, len) {
  const raw = buf.subarray(start, start + len).toString("utf8").replace(/\0.*$/, "").trim();
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

function text(buf, start, len) {
  return buf.subarray(start, start + len).toString("utf8").replace(/\0.*$/, "");
}

function safeRel(name) {
  if (name.includes("\\") || path.isAbsolute(name)) fail("refusing unsafe tar entry: " + name);
  const normalized = name.replace(/\/+$/, "");
  if (!normalized) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "." || part === ".." || part === "")) {
    fail("refusing unsafe tar entry: " + name);
  }
  if (parts.length === 1) return undefined;
  return parts.slice(1).join("/");
}

function ensureContained(root, target) {
  const rel = path.relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return;
  fail("refusing tar path escape: " + target);
}

function prepareQuarantine(root, treePath, metadataPath) {
  const resolvedRoot = path.resolve(root);
  let st;
  try {
    st = fs.lstatSync(resolvedRoot);
  } catch {
    fail("quarantine root is missing: " + resolvedRoot);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    fail("quarantine root is not a regular directory: " + resolvedRoot);
  }
  chmodBestEffort(resolvedRoot, OWNER_DIR_MODE);
  const resolvedTree = path.resolve(treePath);
  const resolvedMetadata = path.resolve(metadataPath);
  ensureContained(resolvedRoot, resolvedTree);
  ensureContained(resolvedRoot, resolvedMetadata);
  fs.rmSync(resolvedTree, { recursive: true, force: true });
  fs.rmSync(resolvedMetadata, { force: true });
  mkdirOwner(resolvedTree);
}

function isTarMetadata(type) {
  return type === "g" || type === "x";
}

function extractTar(buffer, outRoot) {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const fullName = prefix ? prefix + "/" + name : name;
    const linkName = text(header, 157, 100);
    const size = octal(header, 124, 12);
    const type = text(header, 156, 1) || "0";
    offset += 512;
    const rel = safeRel(fullName);
    if (!rel) {
      if (type !== "5" && !isTarMetadata(type)) fail("refusing unsafe tar entry: " + fullName);
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    if (isTarMetadata(type)) {
      offset += Math.ceil(size / 512) * 512;
      continue;
    }
    const target = path.resolve(outRoot, rel);
    ensureContained(outRoot, target);
    if (type === "5") {
      mkdirOwner(target);
    } else if (type === "0" || type === "\0") {
      mkdirOwner(path.dirname(target));
      writeFileOwner(target, buffer.subarray(offset, offset + size));
    } else if (type === "2") {
      fail("refusing tar symlink entry: " + fullName + " -> " + linkName);
    } else {
      fail("refusing non-regular tar entry: " + fullName);
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

(async () => {
  prepareQuarantine(input.quarantineRoot, input.treePath, input.metadataPath);
  const sha = /^[a-f0-9]{40}$/.test(input.pin || "") ? input.pin : undefined;
  const resolvedSha =
    sha ||
    JSON.parse(
      (await requestBuffer(
        "https://api.github.com/repos/" +
          encodeURIComponent(input.owner) +
          "/" +
          encodeURIComponent(input.repo) +
          "/commits/" +
          encodeURIComponent(input.ref || "HEAD"),
      )).toString("utf8"),
    ).sha;
  if (!/^[a-f0-9]{40}$/i.test(resolvedSha)) fail("GitHub did not return a commit SHA");
  const tarball = await requestBuffer(
    "https://codeload.github.com/" +
      encodeURIComponent(input.owner) +
      "/" +
      encodeURIComponent(input.repo) +
      "/tar.gz/" +
      resolvedSha,
  );
  extractTar(zlib.gunzipSync(tarball), input.treePath);
  writeFileOwner(
    input.metadataPath,
    JSON.stringify(
      {
        kind: "github",
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        pinnedSha: resolvedSha,
        source: input.owner + "/" + input.repo,
        treePath: input.treePath,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
})().catch((err) => fail(err && err.message ? err.message : String(err)));
`;

export function trustFetchExec(source: GitHubTrustSource, ctx: PlanContext): ExecAction {
  return exec(
    `fetch ${source.display} tarball into quarantine`,
    [
      process.execPath,
      "-e",
      GITHUB_FETCH_SCRIPT,
      JSON.stringify({
        owner: source.owner,
        repo: source.repo,
        ref: source.ref,
        pin: source.pin,
        quarantineRoot: source.quarantineRoot,
        treePath: source.treePath,
        metadataPath: source.metadataPath,
      }),
    ],
    {
      cwd: source.quarantineRoot,
      env: scrubFetchEnv(ctx.env),
      timeoutMs: 120_000,
      blockProbesOnFailure: true,
      failureCheck: (result) => {
        const reason = (result.stderr || result.stdout || "fetch command failed")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 400);
        return {
          name: "trust.fetch-blocked",
          verdict: "fail",
          code: "trust.fetch-blocked",
          detail: `could not fetch ${source.display} into quarantine (exit ${result.code ?? "signal"}): ${reason}`,
        };
      },
    },
  );
}

export function localFileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function safeSourceRelative(root: string, absPath: string): string {
  const rel = relative(root, absPath).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
    throw new PathContainmentError(
      `refusing source-relative path escape\n  root:   ${root}\n  target: ${absPath}`,
    );
  }
  return rel;
}
