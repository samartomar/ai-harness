import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export default function setup(): () => void {
  const directory = mkdtempSync(join(tmpdir(), "aih-workbench-browser-"));
  process.env.AIH_WORKBENCH_FIXTURE_DIR = directory;
  const previousDataRoot = process.env.AIH_WORKBENCH_DATA;
  const previousVerifierRoot = process.env.AIH_WORKBENCH_VERIFIER_HOME;
  process.env.AIH_WORKBENCH_DATA = join(directory, "no-user-source-data");
  process.env.AIH_WORKBENCH_VERIFIER_HOME = join(directory, "local-verifier");
  const cleanup = () => {
    if (previousDataRoot === undefined) delete process.env.AIH_WORKBENCH_DATA;
    else process.env.AIH_WORKBENCH_DATA = previousDataRoot;
    if (previousVerifierRoot === undefined) delete process.env.AIH_WORKBENCH_VERIFIER_HOME;
    else process.env.AIH_WORKBENCH_VERIFIER_HOME = previousVerifierRoot;
    const target = realpathSync(directory);
    if (dirname(target) !== realpathSync(tmpdir())) throw new Error("Unsafe fixture cleanup path");
    rmSync(target, { recursive: true, force: true });
  };
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("tools/prepare-workbench-fixtures.ts"), directory],
      { encoding: "utf8", stdio: "inherit", windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Workbench fixture compilation failed");
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}
