import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "secrets",
  summary: "Scan for plaintext secrets and write agent deny rules + vault guidance",
  options: [],
  plan: pendingPlan(
    "secrets",
    "Scan for .env* and secrets/ files, write Read(./.env*) deny rules into .claude/settings.json, and emit dynamic-vault-injection guidance (Vault/AWS SM/1Password).",
  ),
};
