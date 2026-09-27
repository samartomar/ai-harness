/** Quote one argument for a Windows command line. */
export function windowsCommandArg(value: string): string {
  let quoted = "";
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    quoted +=
      char === '"' ? `${"\\".repeat(backslashes * 2)}\\"` : `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `"${quoted}${"\\".repeat(backslashes * 2)}"`;
}
