import { existsSync } from "node:fs";
import { join } from "node:path";
import { startPolicyWorkbenchUi } from "../../src/org-policy/ui-server.js";

const root = process.cwd();
const ui = await startPolicyWorkbenchUi({ openBrowser: async () => {} });

try {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/aih-policy-workbench\.html#[a-f0-9]{64}$/.test(ui.url))
    throw new Error("rootless UI server did not return its loopback URL");
  for (const path of ["aih-policy-workbench.html", ".aih"])
    if (existsSync(join(root, path))) throw new Error(`rootless UI server wrote ${path}`);
  process.stdout.write("rootless UI server preserved the temporary directory\n");
} finally {
  await ui.close();
}
