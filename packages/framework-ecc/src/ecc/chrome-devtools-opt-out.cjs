"use strict";
// The one chrome-devtools-mcp opt-out predicate (see codex.ts beside it). The ECC
// plugin loads this file by its absolute path from its own installation twice: in process at
// plan time, and in the Codex merge child at apply time, so every TOML spelling
// gets one verdict at both stages over the same parser (smol-toml).
// `chromeDevtoolsOptOutMissing` returns undefined for a server that does not
// launch chrome-devtools-mcp, otherwise the opt-outs it lacks.
function chromeDevtoolsOptOutMissing(server) {
  const optOuts = ["CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS", "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS"];
  const mentions = (value) => typeof value === "string" ? /chrome-devtools-mcp/i.test(value) : Array.isArray(value) ? value.some(mentions) : value !== null && typeof value === "object" ? Object.values(value).some(mentions) : false;
  if (!mentions(server)) return undefined;
  const table = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const env = table(table(server).env);
  return optOuts.filter((name) => env[name] !== "1");
}
function chromeDevtoolsOptOutRefusals(configs, parse, exempt) {
  const optOuts = ["CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS", "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS"];
  const decoded = (text) => text.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (match, short, long) => { try { return String.fromCodePoint(Number.parseInt(short || long, 16)); } catch { return match; } });
  const refusals = [];
  for (const { scope, configPath, raw } of configs) {
    if (raw === undefined) continue;
    let document;
    try { document = parse(raw); } catch {
      if (/chrome-devtools-mcp/i.test(decoded(raw))) refusals.push({ scope, configPath, entry: "(unparseable config)", missing: optOuts.slice(), unparseable: true });
      continue;
    }
    const servers = document.mcp_servers;
    if (servers === undefined) continue;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
      if (chromeDevtoolsOptOutMissing(servers) !== undefined) refusals.push({ scope, configPath, entry: "(non-table MCP representation)", missing: optOuts.slice() });
      continue;
    }
    for (const entry of Object.keys(servers)) {
      const missing = chromeDevtoolsOptOutMissing(servers[entry]);
      if (missing === undefined || missing.length === 0 || exempt(scope, entry)) continue;
      refusals.push({ scope, configPath, entry, missing });
    }
  }
  return refusals;
}
module.exports = { chromeDevtoolsOptOutMissing, chromeDevtoolsOptOutRefusals };
