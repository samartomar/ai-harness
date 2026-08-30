import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { policyStudioModel } from "./studio-model.js";
import { policyStudioHtml } from "./studio-template.js";

const LOOPBACK_HOST = "127.0.0.1";
const WORKBENCH_PATH = "/aih-policy-workbench.html";

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

/**
 * Serve the in-package, portable Workbench without resolving a repository or
 * writing an artifact into the current directory. The ephemeral server binds
 * only to IPv4 loopback and exposes one immutable HTML route.
 */
export async function startPolicyWorkbenchUi(
  options: StartPolicyWorkbenchUiOptions = {},
): Promise<PolicyWorkbenchUi> {
  const html = policyStudioHtml(policyStudioModel());
  const htmlLength = Buffer.byteLength(html);
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
      response.end();
      return;
    }

    const pathname = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`).pathname;
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
  const url = `http://${LOOPBACK_HOST}:${port}${WORKBENCH_PATH}`;
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
