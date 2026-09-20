import { useSyncExternalStore } from "react";
import { AdminPage } from "./AdminPage.js";
import type { WorkbenchHost, WorkbenchRoute } from "./host.js";
import { useWorkbenchMode } from "./mode.js";
import { UserPage } from "./UserPage.js";

export interface AppProps {
  readonly host: WorkbenchHost;
  /** The page model as the host prepared it. Validated by the engine, never trusted. */
  readonly model: unknown;
}

function useRoute(host: WorkbenchHost): WorkbenchRoute {
  const { navigation } = host;
  return useSyncExternalStore(navigation.subscribe, navigation.current, navigation.current);
}

/**
 * The two pages of this slice. Both stay mounted so each keeps its own draft
 * while the other is shown: download the organization policy, switch, import
 * it on the user page. The host decides where the route lives.
 */
export function App({ host, model }: AppProps) {
  const route = useRoute(host);
  const mode = useWorkbenchMode();
  return (
    <>
      <div aria-hidden={route !== "admin"} hidden={route !== "admin"}>
        <AdminPage host={host} mode={mode} model={model} />
      </div>
      <div aria-hidden={route !== "user"} hidden={route !== "user"}>
        <UserPage host={host} mode={mode} model={model} />
      </div>
    </>
  );
}
