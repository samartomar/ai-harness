import { createInterface } from "node:readline";

/**
 * A minimal question/answer seam so interactive prompts stay testable: production
 * code wires {@link makeReadlinePrompter}; tests inject a fake that returns canned
 * answers. The harness stays non-interactive by default — a prompter is only wired
 * when the user explicitly opts in (e.g. `--detect`) AND the session is a TTY.
 */
export interface Prompter {
  /** Print `question`, read one line, and return the trimmed answer ("" on bare Enter/EOF). */
  ask(question: string): Promise<string>;
}

/**
 * True only when both stdin and stdout are real TTYs, so a prompt makes sense.
 * `AIH_NO_PROMPT=1` forces non-interactive (for CI / automation that runs in a TTY).
 */
export function isInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AIH_NO_PROMPT === "1") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** A readline-backed prompter over stdin/stdout. The interface is opened per-ask. */
export function makeReadlinePrompter(): Prompter {
  return {
    ask(question: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
    },
  };
}
