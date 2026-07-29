import { closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { basename, resolve } from "node:path";
import { ChangeProfileInputError } from "../errors.js";
import { type CommandSpec, dynamicDigest, plan } from "../internals/plan.js";
import { classifyChangeProfile, renderChangeProfile } from "./change-profile.js";

export const MAX_CHANGE_PROFILE_INPUT_BYTES = 128 * 1024 * 1024;

function inputError(issueCode: string, path = "changes"): ChangeProfileInputError {
  return new ChangeProfileInputError([{ issueCode, path }]);
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

function deniedInputPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  const base = basename(path).toLowerCase();
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    parts.some((part) => part.toLowerCase() === "secrets")
  );
}

/** Read one deliberately named regular file without allowing growth or replacement races. */
export interface ChangeProfileInputFileSeam {
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

const defaultInputFileSeam: ChangeProfileInputFileSeam = {
  lstat: lstatSync,
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
};

export function readChangeProfileInputFile(
  root: string,
  supplied: unknown,
  file: ChangeProfileInputFileSeam = defaultInputFileSeam,
): unknown {
  if (
    typeof supplied !== "string" ||
    supplied.length === 0 ||
    supplied === "-" ||
    supplied.includes("\0")
  ) {
    throw inputError("input.file");
  }
  const path = resolve(root, supplied);
  if (deniedInputPath(path)) throw inputError("input.file");

  let before: Stats;
  try {
    before = file.lstat(path);
  } catch {
    throw inputError("input.missing");
  }
  if (!before.isFile()) throw inputError("input.not-regular");
  if (before.size === 0) throw inputError("input.empty");
  if (before.size > MAX_CHANGE_PROFILE_INPUT_BYTES) throw inputError("input.too-large");

  let descriptor: number | undefined;
  try {
    descriptor = file.open(path, "r");
    const opened = file.fstat(descriptor);
    if (!opened.isFile() || opened.size !== before.size) throw inputError("input.changed");
    const bytes = Buffer.allocUnsafe(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = file.read(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = file.fstat(descriptor);
    if (offset !== opened.size || !sameFile(before, opened, after)) {
      throw inputError("input.changed");
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, offset),
      );
    } catch {
      throw inputError("input.utf8");
    }
    if (text.trim().length === 0) throw inputError("input.empty");
    try {
      return JSON.parse(text);
    } catch {
      throw inputError("input.json");
    }
  } catch (error) {
    if (error instanceof ChangeProfileInputError) throw error;
    throw inputError("input.read");
  } finally {
    if (descriptor !== undefined) {
      try {
        file.close(descriptor);
      } catch {
        // The bounded read already settled; do not replace its stable result with raw I/O text.
      }
    }
  }
}

export const command: CommandSpec = {
  name: "change-profile",
  summary: "classify one explicit normalized change-facts file",
  readOnly: true,
  options: [
    {
      flags: "--input <file>",
      description: "bounded change-facts JSON file",
      sensitive: true,
    },
  ],
  plan(ctx) {
    const supplied = ctx.options.input;
    if (
      typeof supplied !== "string" ||
      supplied.length === 0 ||
      supplied === "-" ||
      supplied.includes("\0")
    ) {
      throw inputError("input.file");
    }
    return plan(
      "change-profile",
      dynamicDigest("change profile", () => {
        const profile = classifyChangeProfile(readChangeProfileInputFile(ctx.root, supplied));
        return { text: renderChangeProfile(profile), data: profile };
      }),
    );
  },
};
