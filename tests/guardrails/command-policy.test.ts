import { describe, expect, it } from "vitest";
import {
  COMMAND_LEXICON,
  type CommandRule,
  claudeBashPermissions,
  commandPolicyDoc,
  sandboxExecPolicy,
} from "../../src/guardrails/command-policy.js";

const patterns = (rules: CommandRule[]): string[] => rules.map((r) => r.pattern);

describe("COMMAND_LEXICON deny tier", () => {
  it("carries every ported deny pattern with a non-empty reason", () => {
    expect(COMMAND_LEXICON.deny.length).toBeGreaterThan(0);
    for (const rule of COMMAND_LEXICON.deny) {
      expect(rule.reason).toBeTruthy();
      expect((rule.reason as string).length).toBeGreaterThan(0);
    }
  });

  it("spot-asserts the high-severity destructive patterns (verbatim)", () => {
    const deny = patterns(COMMAND_LEXICON.deny);
    expect(deny).toContain("rm -rf /");
    expect(deny).toContain("rm -rf ~");
    expect(deny).toContain("rm -rf .git");
    expect(deny).toContain("git push --force*");
    expect(deny).toContain("git reset --hard*");
    expect(deny).toContain("*DROP DATABASE*");
    expect(deny).toContain("*DROP TABLE*");
    expect(deny).toContain("cat .env*");
    expect(deny).toContain("printenv*");
    expect(deny).toContain("*> /dev/sd*");
    expect(deny).toContain("dd if=*");
    expect(deny).toContain("mkfs*");
    expect(deny).toContain(":(){ :|:& };:*"); // fork bomb
  });
});

describe("COMMAND_LEXICON ask tier", () => {
  it("covers every package manager install/update + git mutation + deploy/curl|sh + rm -r", () => {
    const ask = patterns(COMMAND_LEXICON.ask);
    for (const p of [
      "npm install*",
      "npm update*",
      "npm ci*",
      "pnpm add*",
      "pnpm install*",
      "yarn add*",
      "bun add*",
      "pip install*",
      "poetry add*",
      "cargo add*",
      "git push*",
      "git reset*",
      "git clean*",
      "*migrate reset*",
      "*db reset*",
      "*deploy*",
      "*curl*|*sh*",
      "rm -r*",
    ]) {
      expect(ask).toContain(p);
    }
  });

  it("every ask rule carries a reason", () => {
    for (const rule of COMMAND_LEXICON.ask) {
      expect(rule.reason).toBeTruthy();
    }
  });
});

describe("COMMAND_LEXICON safe tiers", () => {
  it("safe_read_only carries the git inspection + file read commands", () => {
    const safe = patterns(COMMAND_LEXICON.safe_read_only);
    expect(safe).toContain("git status*");
    expect(safe).toContain("git diff*");
    expect(safe).toContain("git log*");
    expect(safe).toContain("ls*");
    expect(safe).toContain("grep*");
    expect(safe).toContain("rg*");
  });

  it("safe_verification carries the test/lint/typecheck runners across ecosystems", () => {
    const safe = patterns(COMMAND_LEXICON.safe_verification);
    expect(safe).toContain("npm test*");
    expect(safe).toContain("pnpm typecheck*");
    expect(safe).toContain("pytest*");
    expect(safe).toContain("go test*");
    expect(safe).toContain("cargo test*");
    expect(safe).toContain("node --check*");
  });
});

describe("claudeBashPermissions() — pure 1:1 projection", () => {
  it("maps each tier to Bash(<exact pattern>) with no transformation or dedupe", () => {
    const perms = claudeBashPermissions();
    // deny: same length, exact Bash(...) wrap, same order.
    expect(perms.deny).toHaveLength(COMMAND_LEXICON.deny.length);
    expect(perms.deny).toEqual(COMMAND_LEXICON.deny.map((r) => `Bash(${r.pattern})`));
    // ask: same length + exact wrap.
    expect(perms.ask).toHaveLength(COMMAND_LEXICON.ask.length);
    expect(perms.ask).toEqual(COMMAND_LEXICON.ask.map((r) => `Bash(${r.pattern})`));
    // allow: the two safe tiers concatenated (read-only then verification).
    expect(perms.allow).toHaveLength(
      COMMAND_LEXICON.safe_read_only.length + COMMAND_LEXICON.safe_verification.length,
    );
    expect(perms.allow[0]).toBe("Bash(git status*)");
    expect(perms.allow).toContain("Bash(npm test*)");
  });

  it("includes the canonical Bash(rm -rf /) deny rule", () => {
    expect(claudeBashPermissions().deny).toContain("Bash(rm -rf /)");
  });
});

describe("sandboxExecPolicy()", () => {
  it("round-trips through JSON and carries commandPolicy.deny[].{pattern,reason}", () => {
    const policy = JSON.parse(JSON.stringify(sandboxExecPolicy())) as {
      commandPolicy: {
        deny: Array<{ pattern: string; reason?: string }>;
        ask: Array<{ pattern: string; reason?: string }>;
        safeReadOnly: string[];
        safeVerification: string[];
      };
    };
    const rmRule = policy.commandPolicy.deny.find((r) => r.pattern === "rm -rf /");
    expect(rmRule?.reason).toBe("Refuses to delete filesystem root.");
    expect(policy.commandPolicy.safeReadOnly).toContain("git status*");
    expect(policy.commandPolicy.safeVerification).toContain("npm test*");
  });
});

describe("commandPolicyDoc()", () => {
  it("is deterministic (byte-identical across calls)", () => {
    expect(commandPolicyDoc()).toBe(commandPolicyDoc());
  });

  it("carries the advisory banner + the enforce/document split", () => {
    const doc = commandPolicyDoc();
    expect(doc).toContain("Advisory vs. enforced");
    expect(doc).toContain("**Enforced**");
    expect(doc).toContain("**Documented**");
    // Claude is the one enforced tool; a non-Claude tool is documented (advisory).
    expect(doc).toContain("Claude Code");
    expect(doc).toContain("Codex CLI");
    expect(doc).toContain("`rm -rf /`");
  });
});
