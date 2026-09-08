import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalBaselineVetRequestV1Bytes } from "@aihq/scan";
import {
  defineCandidateSourceInventory,
  prepareCandidateBaselineRequests,
} from "../src/baseline-evidence/candidate-preparation.ts";

const INVENTORY_LIMIT = 1024 * 1024;
const FLAGS = new Set(["--inventory", "--source", "--output"]);

function fail(message) {
  throw new Error(`candidate request preparation refused: ${message}`);
}

function argumentsByFlag(argv) {
  if (argv.length !== FLAGS.size * 2) fail("expected --inventory, --source, and --output once");
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.has(flag) || typeof value !== "string" || value.length === 0 || parsed.has(flag)) {
      fail("unknown, duplicate, or empty argument");
    }
    parsed.set(flag, value);
  }
  return Object.fromEntries([...parsed].map(([key, value]) => [key.slice(2), value]));
}

function regularFile(path, maximumBytes) {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > maximumBytes) {
    fail("inventory must be one bounded regular file");
  }
  return absolute;
}

function sourceDirectory(path) {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("source must be one real directory");
  return realpathSync(absolute);
}

function outputDirectory(path) {
  const absolute = resolve(path);
  const parent = realpathSync(dirname(absolute));
  if (resolve(parent, absolute.slice(dirname(absolute).length + 1)) !== absolute) {
    fail("output path is not canonical");
  }
  mkdirSync(absolute, { recursive: false });
  return absolute;
}

const args = argumentsByFlag(process.argv.slice(2));
const inventoryPath = regularFile(args.inventory, INVENTORY_LIMIT);
const sourceRoot = sourceDirectory(args.source);
const inventory = defineCandidateSourceInventory(
  JSON.parse(readFileSync(inventoryPath, "utf8")),
);
const requests = prepareCandidateBaselineRequests({ sourceRoot, inventory });
const output = outputDirectory(args.output);
for (const [index, request] of requests.entries()) {
  const name = `batch-${String(index + 1).padStart(3, "0")}.request.json`;
  writeFileSync(resolve(output, name), canonicalBaselineVetRequestV1Bytes(request), {
    flag: "wx",
    mode: 0o600,
  });
}
