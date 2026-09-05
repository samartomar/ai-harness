/** Browser-safe policy command argument validation shared with Core schema parsing. */
const HOST_WITH_OPTIONAL_PORT =
  "[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::(?:[0-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?";
const EXACT_HTTPS_ORIGIN = new RegExp(`^https://${HOST_WITH_OPTIONAL_PORT}$`);

export function safePolicyCommandArgument(
  value: string,
  httpsOriginPrefixes: readonly string[],
): boolean {
  const prefix = httpsOriginPrefixes.find((candidate) => value.startsWith(candidate));
  if (prefix !== undefined) {
    try {
      if (value !== value.trim() || !EXACT_HTTPS_ORIGIN.test(value.slice(prefix.length)))
        return false;
      const url = new URL(value.slice(prefix.length));
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }
  return (
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.includes("..") &&
    !/[\\/;|&`$<>\p{C}]/u.test(value)
  );
}
