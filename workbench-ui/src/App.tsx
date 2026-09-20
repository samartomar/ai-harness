import { useEffect, useState } from "react";
import { AdminPage } from "./AdminPage.js";
import type { WorkbenchHost } from "./host.js";
import { useWorkbenchMode } from "./mode.js";
import { UserPage } from "./UserPage.js";

export interface AppProps {
  readonly host: WorkbenchHost;
  /** The page model as the host prepared it. Validated by the engine, never trusted. */
  readonly model: unknown;
}

type Route = "admin" | "user";

function routeOf(hash: string): Route {
  return hash === "#/user" ? "user" : "admin";
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeOf(location.hash));
  useEffect(() => {
    const listen = () => setRoute(routeOf(location.hash));
    window.addEventListener("hashchange", listen);
    return () => window.removeEventListener("hashchange", listen);
  }, []);
  return route;
}

/**
 * The two pages of this slice. Both stay mounted so each keeps its own draft
 * while the other is shown: download the organization policy, switch, import
 * it on the user page.
 */
export function App({ host, model }: AppProps) {
  const route = useHashRoute();
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
