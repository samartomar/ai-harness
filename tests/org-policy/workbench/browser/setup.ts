import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { preparePackedWorkbench } from "../../../../tools/prepare-packed-workbench.mjs";

export default function setup(): () => void {
  const directory = mkdtempSync(join(tmpdir(), "aih-workbench-browser-"));
  process.env.AIH_WORKBENCH_FIXTURE_DIR = directory;
  const cleanup = () => {
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
    const packed = preparePackedWorkbench(directory);
    writeFileSync(resolve(directory, "package-receipt.json"), JSON.stringify(packed, null, 2));
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}
