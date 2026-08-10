import { AihError } from "../../errors.js";
import { executePlan, type PlanResult } from "../../internals/execute.js";
import { type CommandSpec, digest, type PlanContext, plan } from "../../internals/plan.js";
import { reconcileSkillPackCapabilityPackage } from "./domains/skill-pack-coordinator.js";
import {
  type CapabilityPackageContextOperation,
  type CapabilityPackageContextReport,
  inspectCapabilityPackageContext,
} from "./live-context.js";

function packageId(ctx: PlanContext): string | undefined {
  const value = ctx.options.packageId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function reportText(report: CapabilityPackageContextReport): string {
  const rows = report.packages.map(
    (pkg) =>
      `${pkg.id}  [${pkg.lifecycle}] [${pkg.requested ? "requested" : "available"}] ` +
      `[${pkg.owned ? "owned" : "unowned"}]  ${pkg.members.length} members`,
  );
  const refusals = report.refusals.map(({ stage, reason }) => `refused at ${stage}: ${reason}`);
  const preview =
    report.preview === undefined
      ? []
      : [
          `preview ${report.preview.operation} ${report.preview.packageId}: ` +
            `${report.preview.changes.add.length} add, ${report.preview.changes.update.length} update, ` +
            `${report.preview.changes.remove.length} remove, ${report.preview.changes.unchanged.length} unchanged`,
          "preview is local and read-only: 0 writes, 0 processes, 0 network, 0 component loads",
          ...(report.preview.policyChangeRequired
            ? ["policy selection must be changed before this preview can become admissible"]
            : []),
        ];
  const sourceRows =
    report.operation === "doctor"
      ? Object.entries(report.sources).map(([stage, source]) => `${stage}: ${source.state}`)
      : [];
  const body = [...rows, ...sourceRows, ...preview, ...refusals];
  return `${body.length === 0 ? "no capability packages found" : body.join("\n")}\n`;
}

function commandPlan(operation: CapabilityPackageContextOperation, ctx: PlanContext) {
  const report = inspectCapabilityPackageContext({
    root: ctx.root,
    contextDir: ctx.contextDir,
    operation,
    ...(packageId(ctx) === undefined ? {} : { packageId: packageId(ctx) }),
  });
  return plan(
    `capability package ${operation}`,
    digest(`capability package ${operation}`, reportText(report), report),
  );
}

export async function executeCapabilityPackageCommand(
  operation: "add" | "update" | "remove",
  ctx: PlanContext,
): Promise<PlanResult> {
  if (!ctx.apply) return executePlan(commandPlan(operation, ctx), ctx);
  const id = packageId(ctx);
  if (id === undefined) throw new AihError("capability package id is required", "AIH_CONFIG");
  const mutation = reconcileSkillPackCapabilityPackage({
    root: ctx.root,
    contextDir: ctx.contextDir,
    operation,
    packageId: id,
    apply: true,
  });
  if (mutation.status === "refused") {
    throw new AihError(
      `capability package reconciliation refused at ${mutation.stage}: ${mutation.reason}`,
      "AIH_TRUST",
    );
  }
  const text =
    mutation.status === "retained-drift"
      ? `Capability package ${operation} retained drifted owned content; no ownership state was advanced.\n`
      : `Capability package ${operation} ${mutation.status}.\n`;
  return {
    capability: `capability package ${operation}`,
    applied: true,
    writes: mutation.writes.map((path) => ({
      path,
      describe: "capability package reconciliation",
      merged: false,
      effect: "overwrite" as const,
    })),
    docs: [],
    probes: [],
    execs: [],
    digests: [{ describe: `capability package ${operation}`, text, data: mutation }],
    backups: [],
    removed: mutation.removes.map((path) => ({
      path,
      describe: "receipt-bound capability package subtraction",
      effect: "delete" as const,
    })),
  };
}

const REQUIRED_PACKAGE = {
  name: "package-id",
  description: "policy package id",
  required: true,
  optionName: "packageId",
} as const;

const OPTIONAL_PACKAGE = {
  name: "package-id",
  description: "optional policy package id",
  optionName: "packageId",
} as const;

export const capabilityPackageListCommand: CommandSpec = {
  name: "list",
  summary: "List locally cataloged capability packages and governed selection state",
  readOnly: true,
  zeroWrite: true,
  plan: (ctx) => commandPlan("list", ctx),
};

export const capabilityPackageShowCommand: CommandSpec = {
  name: "show",
  summary: "Show one capability package from exact local policy and authority bytes",
  readOnly: true,
  zeroWrite: true,
  positional: REQUIRED_PACKAGE,
  plan: (ctx) => commandPlan("show", ctx),
};

export const capabilityPackageStatusCommand: CommandSpec = {
  name: "status",
  summary: "Show governed intent, ownership, custody, and domain status",
  readOnly: true,
  zeroWrite: true,
  positional: OPTIONAL_PACKAGE,
  plan: (ctx) => commandPlan("status", ctx),
};

export const capabilityPackageDoctorCommand: CommandSpec = {
  name: "doctor",
  summary: "Diagnose the local capability package policy and authority chain",
  readOnly: true,
  zeroWrite: true,
  plan: (ctx) => commandPlan("doctor", ctx),
};

export const capabilityPackageAddCommand: CommandSpec = {
  name: "add",
  summary: "Preview or apply a policy-selected capability package",
  readOnly: false,
  zeroWrite: true,
  positional: REQUIRED_PACKAGE,
  plan: (ctx) => commandPlan("add", ctx),
};

export const capabilityPackageUpdateCommand: CommandSpec = {
  name: "update",
  summary: "Preview or apply reconciliation of a selected capability package",
  readOnly: false,
  zeroWrite: true,
  positional: REQUIRED_PACKAGE,
  plan: (ctx) => commandPlan("update", ctx),
};

export const capabilityPackageRemoveCommand: CommandSpec = {
  name: "remove",
  summary: "Preview or apply conservative subtraction of a deselected package",
  readOnly: false,
  zeroWrite: true,
  positional: REQUIRED_PACKAGE,
  plan: (ctx) => commandPlan("remove", ctx),
};

export const CAPABILITY_PACKAGE_COMMAND_SPECS = [
  capabilityPackageListCommand,
  capabilityPackageShowCommand,
  capabilityPackageStatusCommand,
  capabilityPackageDoctorCommand,
  capabilityPackageAddCommand,
  capabilityPackageUpdateCommand,
  capabilityPackageRemoveCommand,
] as const;
