import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseOrgPolicy } from "./schema.js";
import { policyStudioModel } from "./studio-model.js";
import { policyStudioHtml } from "./studio-template.js";
import { resolveConnectedGithubSkillV1 } from "./workbench/core/bounded-github-skill-resolver.js";
import { bridgeConnectedGithubSkillV1 } from "./workbench/core/connected-github-skill-bridge.js";

const LOOPBACK_HOST = "127.0.0.1";
const WORKBENCH_PATH = "/aih-policy-workbench.html";
const RESOLVE_GITHUB_SKILL_PATH = "/api/artifact-intake/github-skill/resolve";
const PREPARE_GITHUB_SKILL_PATH = "/api/artifact-intake/github-skill/prepare";
const MAX_RESOLVE_REQUEST_BYTES = 4096;
const MAX_PREPARE_REQUEST_BYTES = 1_000_000;

export interface PolicyWorkbenchUi {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartPolicyWorkbenchUiOptions {
  openBrowser?: (url: string) => Promise<void> | void;
  writeError?: (message: string) => void;
}

function defaultBrowserCommand(url: string): readonly [string, readonly string[]] {
  if (process.platform === "win32") {
    return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  }
  if (process.platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

async function openDefaultBrowser(url: string): Promise<void> {
  const [command, args] = defaultBrowserCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(body)),
    "Content-Type": "application/json; charset=utf-8",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(body);
}

function sameToken(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(received, "utf8"));
}

function connectedGithubResolutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("GitHub ")) return message;
  return "GitHub could not be reached to resolve this Skill pin. The candidate remains unpinned.";
}

function isResolveRequest(value: unknown): value is {
  readonly token: string;
  readonly repository: string;
  readonly skill: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    Object.keys(record).every(
      (key) => key === "token" || key === "repository" || key === "skill",
    ) &&
    typeof record.token === "string" &&
    typeof record.repository === "string" &&
    typeof record.skill === "string"
  );
}

interface ConnectedSkillIdentityV1 {
  readonly repository: string;
  readonly skill: string;
  readonly commit: string;
  readonly path: string;
}

function isConnectedSkillIdentity(value: unknown): value is ConnectedSkillIdentityV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    Object.keys(record).every(
      (key) => key === "repository" || key === "skill" || key === "commit" || key === "path",
    ) &&
    typeof record.repository === "string" &&
    typeof record.skill === "string" &&
    typeof record.commit === "string" &&
    typeof record.path === "string"
  );
}

function matchesResolvedSkill(
  identity: ConnectedSkillIdentityV1,
  resolved: NonNullable<Awaited<ReturnType<typeof resolveConnectedGithubSkillV1>>>,
): boolean {
  return (
    identity.repository === resolved.source.repository &&
    identity.skill === resolved.skill &&
    identity.commit === resolved.source.commit &&
    identity.path === resolved.source.path
  );
}

function isPrepareRequest(value: unknown): value is {
  readonly token: string;
  readonly policy: object;
  readonly source: ConnectedSkillIdentityV1;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    Object.keys(record).every((key) => key === "token" || key === "policy" || key === "source") &&
    typeof record.token === "string" &&
    typeof record.policy === "object" &&
    record.policy !== null &&
    !Array.isArray(record.policy) &&
    isConnectedSkillIdentity(record.source)
  );
}

function isSameOriginJsonRequest(
  request: import("node:http").IncomingMessage,
  loopbackOrigin: string,
): boolean {
  return (
    request.headers.host === loopbackOrigin.slice("http://".length) &&
    request.headers.origin === loopbackOrigin &&
    request.headers["sec-fetch-site"] === "same-origin" &&
    request.headers["content-type"]?.toLowerCase() === "application/json"
  );
}

async function boundedJsonBody(
  request: import("node:http").IncomingMessage,
  maximum: number,
): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maximum)
  ) {
    throw new Error("request too large");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximum) throw new Error("request too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid JSON");
  }
}

/**
 * Serve the in-package, portable Workbench without resolving a repository or
 * writing an artifact into the current directory. The ephemeral server binds
 * only to IPv4 loopback and exposes one immutable HTML route.
 */
export async function startPolicyWorkbenchUi(
  options: StartPolicyWorkbenchUiOptions = {},
): Promise<PolicyWorkbenchUi> {
  let html = policyStudioHtml(policyStudioModel());
  let htmlLength = Buffer.byteLength(html);
  const requestToken = randomBytes(32).toString("hex");
  let resolvedSkill: Awaited<ReturnType<typeof resolveConnectedGithubSkillV1>> | undefined;
  let loopbackOrigin = "";
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const pathname = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`).pathname;
    if (pathname === RESOLVE_GITHUB_SKILL_PATH || pathname === PREPARE_GITHUB_SKILL_PATH) {
      const resolving = pathname === RESOLVE_GITHUB_SKILL_PATH;
      if (method !== "POST") {
        response.writeHead(405, { Allow: "POST", "Content-Length": "0" });
        response.end();
        return;
      }
      if (!isSameOriginJsonRequest(request, loopbackOrigin)) {
        json(response, 403, { error: "connected Workbench request was not same-origin" });
        return;
      }
      let body: unknown;
      try {
        body = await boundedJsonBody(
          request,
          resolving ? MAX_RESOLVE_REQUEST_BYTES : MAX_PREPARE_REQUEST_BYTES,
        );
      } catch {
        json(response, 400, { error: "connected Workbench request is invalid" });
        return;
      }
      const requestBody = resolving
        ? isResolveRequest(body)
          ? body
          : undefined
        : isPrepareRequest(body)
          ? body
          : undefined;
      if (requestBody === undefined || !sameToken(requestToken, requestBody.token)) {
        json(response, 403, { error: "connected Workbench request was rejected" });
        return;
      }
      try {
        if (resolving) {
          const resolveRequest = requestBody as {
            readonly repository: string;
            readonly skill: string;
          };
          resolvedSkill = await resolveConnectedGithubSkillV1({
            repository: resolveRequest.repository,
            skill: resolveRequest.skill,
          });
          json(response, 200, resolvedSkill);
          return;
        }
        if (resolvedSkill === undefined) {
          json(response, 409, {
            error: "Resolve the connected Skill before preparing its pending request.",
          });
          return;
        }
        const prepareRequest = requestBody as {
          readonly policy: Record<string, unknown>;
          readonly source: ConnectedSkillIdentityV1;
        };
        if (!matchesResolvedSkill(prepareRequest.source, resolvedSkill)) {
          json(response, 409, {
            error:
              "The pending Skill changed. Resolve the displayed source again before preparing it.",
          });
          return;
        }
        const bridge = bridgeConnectedGithubSkillV1(prepareRequest.policy, resolvedSkill);
        const nextModel = policyStudioModel(undefined, undefined, {
          organizationManifestBytes: bridge.manifestBytes,
        });
        nextModel.initialPolicy = parseOrgPolicy(bridge.policy);
        const expected = nextModel.workbenchBundle.assets[bridge.root.assetId];
        if (
          expected === undefined ||
          expected.sourceId !== bridge.root.sourceId ||
          expected.sourceRevisionId !== bridge.root.sourceRevisionId ||
          expected.contentDigest !== bridge.root.contentDigest
        ) {
          throw new TypeError("Core-rendered Workbench did not retain the pending Skill pin");
        }
        html = policyStudioHtml(nextModel);
        htmlLength = Buffer.byteLength(html);
        json(response, 200, {
          version: bridge.version,
          state: bridge.state,
          reload: true,
        });
      } catch (error) {
        json(response, 502, {
          error: resolving
            ? connectedGithubResolutionError(error)
            : "Core could not prepare this pending Skill request. The current policy was unchanged.",
        });
      }
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
      response.end();
      return;
    }

    if (pathname === "/") {
      response.writeHead(302, {
        "Cache-Control": "no-store",
        "Content-Length": "0",
        Location: WORKBENCH_PATH,
      });
      response.end();
      return;
    }
    if (pathname !== WORKBENCH_PATH) {
      response.writeHead(404, {
        "Cache-Control": "no-store",
        "Content-Length": "0",
        "X-Content-Type-Options": "nosniff",
      });
      response.end();
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": String(htmlLength),
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(method === "HEAD" ? undefined : html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Policy Workbench server did not receive a loopback TCP address");
  }
  const port = (address as AddressInfo).port;
  loopbackOrigin = `http://${LOOPBACK_HOST}:${port}`;
  const url = `${loopbackOrigin}${WORKBENCH_PATH}#${requestToken}`;
  const openBrowser = options.openBrowser ?? openDefaultBrowser;
  try {
    await openBrowser(url);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const writeError = options.writeError ?? ((message: string) => process.stderr.write(message));
    writeError(`aih: could not open the browser (${detail}). Open ${url}\n`);
  }

  let closing: Promise<void> | undefined;
  return {
    url,
    close: () => {
      closing ??= closeServer(server);
      return closing;
    },
  };
}

export interface RunPolicyWorkbenchUiOptions extends StartPolicyWorkbenchUiOptions {
  write?: (message: string) => void;
}

/** Keep the CLI process alive until Ctrl+C or a termination signal closes it. */
export async function runPolicyWorkbenchUi(
  options: RunPolicyWorkbenchUiOptions = {},
): Promise<void> {
  const ui = await startPolicyWorkbenchUi(options);
  const write = options.write ?? ((message: string) => process.stdout.write(message));
  write(`AIH Policy Workbench: ${ui.url}\nPress Ctrl+C to stop.\n`);

  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void ui.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
