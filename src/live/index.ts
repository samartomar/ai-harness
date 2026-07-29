import { closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { basename, resolve } from "node:path";
import { LiveConsentError, LiveInputError } from "../errors.js";
import { type CommandSpec, dynamicDigest, plan } from "../internals/plan.js";
import { LIVE_CLIS, type LiveCli, type LiveProcessSeam, runLiveCli, safetyFor } from "./runner.js";

export const MAX_LIVE_PROMPT_BYTES = 1024 * 1024;
export const LIVE_PROCESS_OPTION = "__liveProcess";

function parseCli(value: unknown): LiveCli {
  const selected =
    typeof value === "string"
      ? value
      : Array.isArray(value) && value.length === 1 && typeof value[0] === "string"
        ? value[0]
        : undefined;
  if (selected === undefined || !LIVE_CLIS.includes(selected as LiveCli)) {
    throw new LiveInputError();
  }
  return selected as LiveCli;
}

function parseTimeout(value: unknown, cli: LiveCli): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new LiveInputError(cli, safetyFor(cli));
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 3600) {
    throw new LiveInputError(cli, safetyFor(cli));
  }
  return seconds * 1000;
}

function sameFile(before: Stats, opened: Stats, after: Stats): boolean {
  return (
    before.dev === opened.dev &&
    before.ino === opened.ino &&
    opened.dev === after.dev &&
    opened.ino === after.ino &&
    before.size === opened.size &&
    opened.size === after.size &&
    before.mtimeMs === opened.mtimeMs &&
    opened.mtimeMs === after.mtimeMs &&
    before.ctimeMs === opened.ctimeMs &&
    opened.ctimeMs === after.ctimeMs
  );
}

function deniedPromptPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  const base = basename(path).toLowerCase();
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    parts.some((part) => part.toLowerCase() === "secrets")
  );
}

/** Strict UTF-8 prompt read that preserves every decoded character and rejects file races. */
export interface LivePromptFileSeam {
  lstat: (path: string) => Stats;
  open: (path: string, flags: string) => number;
  fstat: (descriptor: number) => Stats;
  read: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  close: (descriptor: number) => void;
}

const defaultPromptFileSeam: LivePromptFileSeam = {
  lstat: lstatSync,
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
};

export function readLivePromptFile(
  root: string,
  supplied: unknown,
  file: LivePromptFileSeam = defaultPromptFileSeam,
): string {
  if (
    typeof supplied !== "string" ||
    supplied.length === 0 ||
    supplied === "-" ||
    supplied.includes("\0")
  ) {
    throw new LiveInputError();
  }
  const path = resolve(root, supplied);
  if (deniedPromptPath(path)) throw new LiveInputError();

  let before: Stats;
  try {
    before = file.lstat(path);
  } catch {
    throw new LiveInputError();
  }
  if (!before.isFile() || before.size === 0 || before.size > MAX_LIVE_PROMPT_BYTES) {
    throw new LiveInputError();
  }

  let descriptor: number | undefined;
  try {
    descriptor = file.open(path, "r");
    const opened = file.fstat(descriptor);
    if (!opened.isFile() || opened.size !== before.size) throw new LiveInputError();
    const bytes = Buffer.allocUnsafe(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = file.read(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = file.fstat(descriptor);
    if (offset !== opened.size || !sameFile(before, opened, after)) throw new LiveInputError();
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch {
      throw new LiveInputError();
    }
  } catch (error) {
    if (error instanceof LiveInputError) throw error;
    throw new LiveInputError();
  } finally {
    if (descriptor !== undefined) {
      try {
        file.close(descriptor);
      } catch {
        // The stable command result must not be replaced by raw filesystem diagnostics.
      }
    }
  }
}

function injectedProcess(value: unknown): LiveProcessSeam | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as LiveProcessSeam).spawn === "function" &&
    typeof (value as LiveProcessSeam).kill === "function" &&
    typeof (value as LiveProcessSeam).platform === "string"
  ) {
    return value as LiveProcessSeam;
  }
  return undefined;
}

export const command: CommandSpec = {
  name: "live",
  summary: "stream bounded progress from one explicitly selected local AI CLI",
  readOnly: true,
  options: [
    {
      flags: "--prompt-file <file>",
      description: "bounded strict-UTF-8 prompt file",
      sensitive: true,
    },
    {
      flags: "--cli <cli>",
      description: "one local CLI: codex/claude read_only; kimi non_read_only",
      repeatable: true,
    },
    { flags: "--timeout <seconds>", description: "bounded CLI timeout", default: "120" },
    {
      flags: "--allow-kimi-non-read-only",
      description:
        "required only for Kimi non_read_only; acknowledge native tools may change the worktree",
    },
  ],
  plan(ctx) {
    const cli = parseCli(ctx.options.cli);
    const timeoutMs = parseTimeout(ctx.options.timeout, cli);
    if (ctx.options.allowKimiNonReadOnly === true && cli !== "kimi") {
      throw new LiveInputError(cli, safetyFor(cli));
    }
    const promptFile = ctx.options.promptFile;
    if (
      typeof promptFile !== "string" ||
      promptFile.length === 0 ||
      promptFile === "-" ||
      promptFile.includes("\0")
    ) {
      throw new LiveInputError(cli, safetyFor(cli));
    }
    if (cli === "kimi" && ctx.options.allowKimiNonReadOnly !== true) {
      throw new LiveConsentError();
    }

    return plan(
      "live",
      dynamicDigest("live result", async () => {
        let prompt: string;
        try {
          prompt = readLivePromptFile(ctx.root, promptFile);
        } catch (error) {
          if (error instanceof LiveInputError) {
            throw new LiveInputError(cli, safetyFor(cli));
          }
          throw error;
        }
        if (cli === "kimi" && prompt.includes("\0")) {
          throw new LiveInputError(cli, safetyFor(cli));
        }
        const result = await runLiveCli(cli, {
          prompt,
          cwd: ctx.root,
          timeoutMs,
          env: ctx.env,
          progress: (event) => ctx.progress?.(JSON.stringify(event)),
          deferCleanup: (cleanup) => ctx.deferCleanup?.(cleanup),
          process: injectedProcess(ctx.options[LIVE_PROCESS_OPTION]),
        });
        return {
          text: [
            `Live result`,
            `CLI: ${result.cli}`,
            `Safety: ${result.safety}`,
            result.result,
          ].join("\n"),
          data: result,
        };
      }),
    );
  },
};
