import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPackedMarkdownLinks } from "../src/internals/check-packed-doc-links.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || !isAbsolute(npmCli) || !existsSync(npmCli))
  throw new Error("packed-admin-docs-npm-cli-unavailable");

function runNode(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `packed-admin-docs-command-failed:${args.join(" ")}:${(result.stderr || result.stdout).slice(0, 240)}`,
    );
  return result;
}

function read(path) {
  return readFileSync(path, "utf8");
}

const exactCommands = [
  "aih policy resolve <root>",
  "aih policy supported accept --root <root>",
  "aih policy supported inspect --root <root>",
  "aih policy managed usage-metering describe --json",
  "aih policy managed usage-metering reconcile <root>",
  "aih policy managed usage-metering inspect <root>",
  "aih policy observe npm-package <root>",
  "aih policy lifecycle npm-package <root>",
  "aih policy observe upstream-artifact <root>",
  "aih policy lifecycle upstream-artifact <root>",
  "aih policy evaluate <root> --no-log --json",
  "aih report <root> --no-log",
];

const helpSurfaces = [
  { args: ["--help"], required: ["policy", "report"] },
  {
    args: ["policy", "--help"],
    required: ["resolve", "supported", "managed", "observe", "lifecycle", "evaluate"],
  },
  {
    args: ["policy", "resolve", "--help"],
    required: [
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <id>",
      "--effect <effect>",
      "--evidence <root-relative-file>",
      "--json",
    ],
  },
  {
    args: ["policy", "supported", "accept", "--help"],
    required: [
      "--root <dir>",
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <id>",
      "--apply",
      "--json",
    ],
  },
  {
    args: ["policy", "supported", "inspect", "--help"],
    required: ["--root <dir>", "--json"],
  },
  {
    args: ["policy", "managed", "usage-metering", "describe", "--help"],
    required: ["--json"],
  },
  {
    args: ["policy", "managed", "usage-metering", "reconcile", "--help"],
    required: [
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <id>",
      "--evidence <root-relative-file>",
      "--apply",
      "--json",
    ],
  },
  {
    args: ["policy", "managed", "usage-metering", "inspect", "--help"],
    required: ["--root <dir>", "--json"],
  },
  {
    args: ["policy", "observe", "npm-package", "--help"],
    required: [
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <cli>",
      "--evidence <path>",
      "--json",
    ],
  },
  {
    args: ["policy", "lifecycle", "npm-package", "--help"],
    required: [
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <cli>",
      "--evidence <path>",
      "--apply",
      "--json",
    ],
  },
  {
    args: ["policy", "observe", "upstream-artifact", "--help"],
    required: [
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <cli>",
      "--evidence <path>",
      "--manifest <path>",
      "--json",
    ],
  },
  {
    args: ["policy", "lifecycle", "upstream-artifact", "--help"],
    required: [
      "--decision <id>",
      "--decision-digest <sha256>",
      "--target <cli>",
      "--evidence <path>",
      "--manifest <path>",
      "--apply",
      "--json",
    ],
  },
  {
    args: ["policy", "evaluate", "--help"],
    required: ["[root]", "--no-log", "--json"],
  },
  { args: ["report", "--help"], required: ["[root]", "--no-log"] },
];

const tempBase = resolve(tmpdir());
const temp = mkdtempSync(resolve(tempBase, "aih-packed-admin-docs-"));
try {
  const packed = runNode(root, [npmCli, "pack", "--json", "--pack-destination", temp]);
  const manifest = JSON.parse(packed.stdout);
  const entry = Array.isArray(manifest) ? manifest[0] : undefined;
  if (
    typeof entry?.filename !== "string" ||
    !Array.isArray(entry.files) ||
    entry.files.some((file) => typeof file?.path !== "string")
  )
    throw new Error("packed-admin-docs-pack-manifest");

  const consumer = resolve(temp, "consumer");
  mkdirSync(consumer);
  writeFileSync(resolve(consumer, "package.json"), '{"name":"cold-packed-admin-docs"}\n');
  runNode(consumer, [
    npmCli,
    "install",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    resolve(temp, entry.filename),
  ]);

  const installed = resolve(consumer, "node_modules", "@aihq", "harness");
  const cli = resolve(installed, "dist", "cli.js");
  const packageFiles = entry.files.map((file) => file.path);
  for (const required of ["README.md", "guides/enterprise-admin-guide.md", "docs/commands.md"])
    if (!packageFiles.includes(required) || !existsSync(resolve(installed, required)))
      throw new Error(`packed-admin-docs-missing:${required}`);
  if (packageFiles.includes("docs/README.md")) throw new Error("packed-admin-docs-repository-index");

  const problems = inspectPackedMarkdownLinks(installed, packageFiles);
  if (problems.length > 0)
    throw new Error(`packed-admin-docs-links:${JSON.stringify(problems.slice(0, 10))}`);

  const navigation = `${read(resolve(installed, "README.md"))}\n${read(resolve(
    installed,
    "guides",
    "enterprise-admin-guide.md",
  ))}\n${read(resolve(installed, "docs", "commands.md"))}`;
  for (const command of exactCommands)
    if (!navigation.includes(command)) throw new Error(`packed-admin-docs-command:${command}`);

  if (!existsSync(cli)) throw new Error("packed-admin-docs-cli");
  for (const surface of helpSurfaces) {
    const output = runNode(consumer, [cli, ...surface.args]).stdout;
    for (const required of surface.required)
      if (!output.includes(required))
        throw new Error(`packed-admin-docs-help:${surface.args.join(" ")}:${required}`);
  }

  process.stdout.write(
    `${JSON.stringify({ status: "PASS", packageFiles: packageFiles.length, markdownFiles: packageFiles.filter((path) => path.toLowerCase().endsWith(".md")).length, commandSurfaces: helpSurfaces.length })}\n`,
  );
} finally {
  const resolvedTemp = resolve(temp);
  const prefix = `${tempBase}${process.platform === "win32" ? "\\" : "/"}`;
  if (resolvedTemp.startsWith(prefix) && resolvedTemp !== tempBase)
    rmSync(resolvedTemp, { recursive: true, force: true });
}
