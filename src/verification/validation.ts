import { redactSecrets } from "../guardrails/redact.js";

const MAX_DIAGNOSTIC_VALUE_LENGTH = 160;

export function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function printableText(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] ?? "";
        output += value[index + 1] ?? "";
        index += 1;
      } else {
        output += "?";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "?";
      continue;
    }
    output += code < 32 || code === 127 || (code >= 128 && code <= 159) ? " " : value[index];
  }
  return output;
}

export function diagnosticValue(value: unknown): string {
  let raw: string;
  try {
    raw = typeof value === "string" ? value : String(value);
  } catch {
    raw = "[unprintable]";
  }
  const redacted = redactSecrets(printableText(raw));
  if (redacted.length <= MAX_DIAGNOSTIC_VALUE_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH)}...(${redacted.length} chars)`;
}
