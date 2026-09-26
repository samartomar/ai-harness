import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  explicitEccMcpReceiptRecord,
  explicitEccMcpRenderPlan,
} from "../../packages/framework-ecc/src/legacy-cleanup/explicit-mcp.js";
import { parseExplicitAddReceipt, receiptJson } from "../../src/ecc/mcp-explicit-add-receipt.js";
import { plan, writeJson, writeText } from "../../src/internals/plan.js";

/** Seed historical aih MCP ownership in cleanup tests; production exposes no Add route. */
export function planLegacyEccMcpFixtureAdd(input: {
  root: string;
  policy: unknown;
  id: string;
  target: string;
}) {
  const rendered = explicitEccMcpRenderPlan(input.policy, input.id, input.target);
  if (rendered.target !== "claude" || rendered.config.format !== "json")
    throw new Error("legacy MCP fixture supports only project-local Claude JSON");
  const receiptPath = join(input.root, ".aih", "ecc-mcp-explicit-add-v1.json");
  const prior = existsSync(receiptPath)
    ? parseExplicitAddReceipt(JSON.parse(readFileSync(receiptPath, "utf8")))
    : { format: "aih-ecc-mcp-explicit-add" as const, version: 1 as const, records: [] };
  return plan(
    "historical ECC MCP fixture",
    writeJson(
      rendered.config.path,
      { [rendered.config.key]: { [rendered.id]: rendered.rendered } },
      "seed historical ECC MCP config",
      { merge: true },
    ),
    writeText(
      ".aih/ecc-mcp-explicit-add-v1.json",
      receiptJson({
        ...prior,
        records: [
          ...prior.records.filter(
            (record) => record.id !== rendered.id || record.target !== rendered.target,
          ),
          explicitEccMcpReceiptRecord(rendered),
        ],
      }),
      "seed historical ECC MCP receipt",
    ),
  );
}
