import type { WorkbenchNavigation, WorkbenchRoute } from "./host.js";

/**
 * Routing is a host responsibility: the preview and the hosted site put the
 * route in the fragment, the CLI host puts it in the query because its
 * fragment carries the request token and must survive byte for byte.
 */

function routeOf(value: string | null | undefined): WorkbenchRoute {
  return value === "user" ? "user" : "admin";
}

function subscriber(event: "hashchange" | "popstate") {
  const listeners = new Set<() => void>();
  let attached = false;
  const onEvent = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    notify: onEvent,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (!attached) {
        window.addEventListener(event, onEvent);
        attached = true;
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && attached) {
          window.removeEventListener(event, onEvent);
          attached = false;
        }
      };
    },
  };
}

/** `#/admin` and `#/user`, as the preview has always routed. */
export function fragmentNavigation(): WorkbenchNavigation {
  const hub = subscriber("hashchange");
  return {
    current: () => (location.hash === "#/user" ? "user" : "admin"),
    go(route) {
      const next = `#/${route}`;
      if (location.hash !== next) location.hash = next;
      hub.notify();
    },
    href: (route) => `#/${route}`,
    subscribe: hub.subscribe,
  };
}

/**
 * `?page=admin|user` for the CLI host. The fragment is copied over unchanged:
 * it carries the request token of the local server and is never rewritten.
 */
export function queryNavigation(): WorkbenchNavigation {
  const hub = subscriber("popstate");
  const href = (route: WorkbenchRoute) => `${location.pathname}?page=${route}${location.hash}`;
  return {
    current: () => routeOf(new URLSearchParams(location.search).get("page")),
    go(route) {
      history.pushState(null, "", href(route));
      hub.notify();
    },
    href,
    subscribe: hub.subscribe,
  };
}
