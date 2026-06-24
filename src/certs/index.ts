import { pendingPlan } from "../commands/stub.js";
import type { CommandSpec } from "../internals/plan.js";

export const command: CommandSpec = {
  name: "certs",
  summary: "Extract corporate root CA(s) and propagate trust to npm/pip/cargo/conda",
  options: [
    {
      flags: "--ca-pattern <pattern>",
      description: "subject substring to match in the OS trust store",
      default: "Zscaler",
    },
    {
      flags: "--out <dir>",
      description: "directory for the exported PEM bundle",
      default: "~/.config/enterprise-ca",
    },
  ],
  plan: pendingPlan(
    "certs",
    "Extract the corporate root CA from the OS trust store, write a locked-down PEM, and propagate NODE_EXTRA_CA_CERTS / PIP_CERT / SSL_CERT_FILE plus per-manager config.",
  ),
};
