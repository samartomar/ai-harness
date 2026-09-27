/** Validate a Catalog destination mapping without reading install records. */
export function assertOwnedRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.length > 1_024 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => {
      const folded = segment.normalize("NFC").toLowerCase();
      return (
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        folded.startsWith(".aih") ||
        folded === ".git"
      );
    })
  ) {
    throw new Error(`unsafe ECC destination: ${displaySafe(value)}`);
  }
  return normalized;
}

export function displaySafe(value: string, max = 120): string {
  const rendered = String(value)
    .replace(/[\r\n]+/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal controls in messages
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return rendered.length > max ? `${rendered.slice(0, max)}…` : rendered;
}
