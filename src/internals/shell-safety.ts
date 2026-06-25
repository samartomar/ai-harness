import { AihError } from "../errors.js";

/**
 * cmd.exe command-injection metacharacters: chaining (`&` `|`), redirection
 * (`<` `>`), escape (`^`), quote-breaking (`"`), and newlines. `(` `)` `%` `!`
 * are deliberately NOT included — they appear in legitimate Windows paths
 * (`Program Files (x86)`) and cannot by themselves chain a new command in an
 * un-quoted `cmd /c <verb> <path>` launcher.
 */
const CMD_INJECTION = /[&|<>^\r\n"]/;

/**
 * Reject a user-controlled value before it is placed in a Windows `cmd /c` argv.
 * `cmd.exe` re-parses its arguments, so `C:\tmp & calc.exe` would chain a second
 * command during an `--apply` flow. POSIX argv is handed to spawn WITHOUT a shell,
 * so callers apply this guard only on Windows. Fail closed with a stable code.
 */
export function assertNoCmdInjection(value: string, label: string): void {
  if (CMD_INJECTION.test(value)) {
    throw new AihError(
      `${label} contains a shell metacharacter (one of & | < > ^ " or a newline) that is ` +
        `unsafe for a Windows cmd launcher: ${JSON.stringify(value)}`,
      "AIH_UNSAFE_PATH",
    );
  }
}
