import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  type Stats,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { ChangeProfileInputError } from "../../src/errors.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  command as changeProfileCommand,
  MAX_CHANGE_PROFILE_INPUT_BYTES,
  readChangeProfileInputFile,
} from "../../src/profile/change-profile-command.js";
import { buildProgram } from "../../src/program.js";

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-change-profile-"));
  roots.push(root);
  return root;
}

function text(value: string) {
  return { kind: "text", text: value, byteLength: Buffer.byteLength(value) };
}

function validInput() {
  return {
    schemaVersion: 1,
    source: "worktree",
    changes: [
      {
        scope: "staged",
        status: "modified",
        path: "src/main.ts",
        previousPath: null,
        before: text("export const value = 1;\r\n"),
        after: text("export const value = 2;\n"),
      },
    ],
  };
}

function command(argv: string[]): Command {
  return new Command("change-profile")
    .argument("[root]")
    .option("--json")
    .option("--posture <posture>", "", "vibe")
    .option("--root <dir>")
    .option("--support-out <dir>")
    .option("--no-log")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--input <file>")
    .parse(argv, { from: "user" });
}

async function run(
  root: string,
  inputPath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCapability(
    changeProfileCommand,
    command(["--json", "--input", inputPath, "--root", root]),
    {
      env: { AIH_LOG: "0" },
      run: fakeRunner(() => undefined),
      write: (text) => {
        stdout += text;
      },
      writeError: (text) => {
        stderr += text;
      },
    },
  );
  return { code, stdout, stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("aih change-profile command adapter", () => {
  it("is canonically registered as read-only with file-only input", () => {
    const registered = buildProgram().commands.find(
      (candidate) => candidate.name() === "change-profile",
    );
    expect(changeProfileCommand.readOnly).toBe(true);
    expect(registered?.registeredArguments.map((argument) => argument.name())).toEqual(["root"]);
    expect(registered?.options.map((option) => option.flags)).toContain("--input <file>");
    expect(registered?.options.map((option) => option.flags)).not.toContain("--stdin");
  });

  it("emits one canonical digest with the profile at digests[0].data", async () => {
    const root = fixtureRoot();
    const inputPath = join(root, "changes.json");
    writeFileSync(inputPath, JSON.stringify(validInput()));

    const result = await run(root, inputPath);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout);
    expect(envelope.capability).toBe("change-profile");
    expect(envelope.digests).toHaveLength(1);
    expect(envelope.digests[0]).toMatchObject({
      describe: "change profile",
      data: {
        schemaVersion: 1,
        classifierVersion: "1.0.0",
        ruleTableVersion: "1.0.0",
      },
    });
    expect(envelope.digests[0].text).toContain("Change profile 1.0.0");
  });

  it("rejects stdin, missing, empty, non-regular, oversized, malformed, and invalid UTF-8 input", () => {
    const root = fixtureRoot();
    const empty = join(root, "empty.json");
    const directory = join(root, "directory");
    const oversized = join(root, "oversized.json");
    const malformed = join(root, "malformed.json");
    const invalidUtf8 = join(root, "invalid-utf8.json");
    writeFileSync(empty, "");
    mkdirSync(directory);
    const descriptor = openSync(oversized, "w");
    closeSync(descriptor);
    truncateSync(oversized, MAX_CHANGE_PROFILE_INPUT_BYTES + 1);
    writeFileSync(malformed, `${JSON.stringify(validInput())}\n{}`);
    writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]));

    for (const [value, issueCode] of [
      ["-", "input.file"],
      [join(root, "missing.json"), "input.missing"],
      [empty, "input.empty"],
      [directory, "input.not-regular"],
      [oversized, "input.too-large"],
      [malformed, "input.json"],
      [invalidUtf8, "input.utf8"],
    ]) {
      expect(() => readChangeProfileInputFile(root, value)).toThrow(
        expect.objectContaining({
          code: "AIH_CHANGE_PROFILE_INPUT",
          issues: [expect.objectContaining({ issueCode })],
        }),
      );
    }
  });

  it("maps parser and classifier failures to one bounded code without exposing input/path/revisions", async () => {
    const root = fixtureRoot();
    const hostilePath = join(root, "private-parser-path.json");
    const secretRevision = "f".repeat(40);
    const supplied = {
      ...validInput(),
      changes: [
        {
          ...validInput().changes[0],
          path: "../private-path",
          beforeRevision: secretRevision,
          after: text("top-secret-content"),
        },
      ],
    };
    writeFileSync(hostilePath, JSON.stringify(supplied));

    const result = await run(root, hostilePath);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.code).toBe("AIH_CHANGE_PROFILE_INPUT");
    expect(envelope.error.message).toContain("change.path@changes.0.path");
    expect(result.stdout).not.toContain(hostilePath);
    expect(result.stdout).not.toContain(root);
    expect(result.stdout).not.toContain("private-path");
    expect(result.stdout).not.toContain(secretRevision);
    expect(result.stdout).not.toContain("top-secret-content");
  });

  it("rejects control and bidi characters before a successful command can echo change paths", async () => {
    const base = validInput().changes[0];
    for (const [change, issue] of [
      [{ ...base, path: "src/\u001bmain.ts" }, "change.path@changes.0.path"],
      [{ ...base, path: "src/\u0085main.ts" }, "change.path@changes.0.path"],
      [
        { ...base, status: "renamed", previousPath: "src/\u202eold.ts" },
        "change.previous-path@changes.0.previousPath",
      ],
    ] as const) {
      const root = fixtureRoot();
      const inputPath = join(root, "changes.json");
      writeFileSync(
        inputPath,
        JSON.stringify({
          ...validInput(),
          changes: [change],
        }),
      );
      const result = await run(root, inputPath);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: "AIH_CHANGE_PROFILE_INPUT",
        message: expect.stringContaining(issue),
      });
      expect(result.stdout).not.toContain(change.path);
      if (change.previousPath !== null) {
        expect(result.stdout).not.toContain(change.previousPath);
      }
    }
  });

  it("fails closed with input.changed when the file changes after opening", () => {
    const root = fixtureRoot();
    const inputPath = join(root, "changes.json");
    writeFileSync(inputPath, JSON.stringify(validInput()));
    let fstatCount = 0;
    expect(() =>
      readChangeProfileInputFile(root, inputPath, {
        lstat: lstatSync,
        open: openSync,
        fstat: (descriptor) => {
          const stats = fstatSync(descriptor);
          fstatCount++;
          return fstatCount === 2 ? ({ ...stats, ctimeMs: stats.ctimeMs + 1 } as Stats) : stats;
        },
        read: readSync,
        close: closeSync,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "AIH_CHANGE_PROFILE_INPUT",
        issues: [expect.objectContaining({ issueCode: "input.changed" })],
      }),
    );
    expect(fstatCount).toBe(2);
  });

  it("sanitizes, stable-sorts, and caps rendered issue records at 20 while retaining the total", () => {
    const issues = Array.from({ length: 25 }, (_, index) => ({
      issueCode: index % 2 === 0 ? "z.issue" : "a.issue",
      path: index === 0 ? `changes.0.path\u001b[31mC:\\private` : `changes.${index}.path`,
    }));
    const error = new ChangeProfileInputError(issues);

    expect(error.code).toBe("AIH_CHANGE_PROFILE_INPUT");
    expect(error.issueTotal).toBe(25);
    expect(error.issues).toHaveLength(20);
    expect(error.issues[0]).toEqual({ issueCode: "a.issue", path: "changes.1.path" });
    expect(error.message).toContain("(25 issues)");
    expect(error.message).toContain("+5 more");
    expect(error.message).not.toContain("C:\\private");
    expect(error.message).not.toContain("\u001b");
    expect((error.message.match(/@/g) ?? []).length).toBe(20);
  });
});
