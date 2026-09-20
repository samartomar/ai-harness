import type { Plugin } from "vite";

const FIXTURE_ROUTE = "/preview-fixture.json";
const FIXTURE_MODULE = "/../tests/org-policy/studio-test-fixture.ts";
const REAL_ROUTE = "/preview-real.json";
const REAL_MODULE = "/../src/org-policy/studio-model.ts";

/** The hosts the tiny fixture omits; the AI tools editor needs some to offer. */
const PREVIEW_HOSTS = [
  { id: "claude", label: "Claude Code", policyTarget: true, mcpSupport: "managed" },
  { id: "codex", label: "Codex", policyTarget: true, mcpSupport: "managed" },
];

/**
 * Development only: serves the test fixture model to the preview page, so the
 * live preview and the component tests run on the same input. It is a dev
 * server route and is never part of a production build.
 */
export function previewFixture(): Plugin {
  return {
    name: "aih-workbench-preview-fixture",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(FIXTURE_ROUTE, (_request, response) => {
        server
          .ssrLoadModule(FIXTURE_MODULE)
          .then((loaded) => {
            const model = (
              loaded as { tinyStudioModel(): { catalog: { hosts: unknown[] } } }
            ).tinyStudioModel();
            model.catalog.hosts = PREVIEW_HOSTS;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(model));
          })
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(error instanceof Error ? error.message : "The preview fixture failed.");
          });
      });
      // The packaged catalog, as the hosted build embeds it
      // (`tools/build-workbench-ui.mjs` `runPackageOnlyModel`).
      server.middlewares.use(REAL_ROUTE, (_request, response) => {
        server
          .ssrLoadModule(REAL_MODULE)
          .then((loaded) => {
            const model = (
              loaded as { packageOnlyPolicyStudioModelV1(): unknown }
            ).packageOnlyPolicyStudioModelV1();
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(model));
          })
          .catch((error: unknown) => {
            response.statusCode = 500;
            response.end(error instanceof Error ? error.message : "The packaged model failed.");
          });
      });
    },
  };
}
