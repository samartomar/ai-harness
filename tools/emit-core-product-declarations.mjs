// Emit the Catalog's core-product-declarations-v1.json from this Core checkout:
// every field comes from the running Core's own declarations, the version from
// package.json and source.commit from the clean HEAD. Usage:
//   npm run emit:core-product-declarations -- --output <new file outside the checkout>
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { emitCoreProductDeclarationsV1 } from "../src/internals/emit-core-product-declarations.ts";

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--output" || !argv[1] || argv[1].startsWith("--"))
  throw new Error("Expected exactly --output <file>.");
const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const requested = resolve(argv[1]);
const output = resolve(realpathSync(dirname(requested)), basename(requested));
const within = relative(checkout, output);
if (within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)))
  throw new Error("The output must be outside the Core checkout, so the checkout stays clean.");
const result = emitCoreProductDeclarationsV1({ checkout, output });
process.stdout.write(
  `${result.output}\n@aihq/core ${result.source.version} at ${result.source.commit}\nsha256 ${result.sha256}\n`,
);
