import type { Command } from "commander";

export function optionSource(command: Command, key: string): string | undefined {
  return command.getOptionValueSourceWithGlobals?.(key) ?? command.getOptionValueSource?.(key);
}
