import { beforeEach, describe, expect, it, vi } from "vitest";
import { fragmentNavigation, queryNavigation } from "../src/navigation.js";

/**
 * Routing belongs to the host. The CLI host routes in the query because its
 * fragment carries the request token of the local server, which must survive
 * every navigation byte for byte.
 */

const TOKEN = "a".repeat(64);

beforeEach(() => {
  history.replaceState(null, "", "/aih-policy-workbench.html");
  location.hash = "";
});

describe("fragment navigation", () => {
  it("reads, writes and links the two routes", () => {
    const navigation = fragmentNavigation();
    expect(navigation.current()).toBe("admin");
    expect(navigation.href("user")).toBe("#/user");
    navigation.go("user");
    expect(location.hash).toBe("#/user");
    expect(navigation.current()).toBe("user");
    navigation.go("admin");
    expect(navigation.current()).toBe("admin");
  });

  it("tells a subscriber when the fragment changes", () => {
    const navigation = fragmentNavigation();
    const listener = vi.fn();
    const stop = navigation.subscribe(listener);
    navigation.go("user");
    expect(listener).toHaveBeenCalled();
    stop();
  });
});

describe("query navigation", () => {
  it("keeps the request token in the fragment byte for byte", () => {
    history.replaceState(null, "", `/aih-policy-workbench.html#${TOKEN}`);
    const navigation = queryNavigation();
    expect(navigation.current()).toBe("admin");
    expect(navigation.href("user")).toBe(`/aih-policy-workbench.html?page=user#${TOKEN}`);
    navigation.go("user");
    expect(location.hash).toBe(`#${TOKEN}`);
    expect(location.search).toBe("?page=user");
    expect(navigation.current()).toBe("user");
  });

  it("restores the page on popstate and tells its subscribers", () => {
    history.replaceState(null, "", `/aih-policy-workbench.html?page=admin#${TOKEN}`);
    const navigation = queryNavigation();
    const listener = vi.fn();
    const stop = navigation.subscribe(listener);
    navigation.go("user");
    expect(navigation.current()).toBe("user");
    listener.mockClear();

    history.back();
    window.dispatchEvent(new Event("popstate"));
    expect(listener).toHaveBeenCalled();
    expect(navigation.current()).toBe("admin");
    expect(location.hash).toBe(`#${TOKEN}`);
    stop();
  });

  it("treats an unknown page as the admin page", () => {
    history.replaceState(null, "", "/aih-policy-workbench.html?page=root");
    expect(queryNavigation().current()).toBe("admin");
  });
});

describe("the CLI host's request token", () => {
  it("is captured once and never changes with the fragment or the route", async () => {
    history.replaceState(null, "", `/aih-policy-workbench.html#${TOKEN}`);
    vi.resetModules();
    const { requestToken } = await import("../hosts/cli/main.js");
    expect(requestToken()).toBe(TOKEN);

    queryNavigation().go("user");
    expect(requestToken()).toBe(TOKEN);
    location.hash = "#something-else";
    expect(requestToken()).toBe(TOKEN);
  });

  it("is undefined when the fragment is not a token", async () => {
    history.replaceState(null, "", "/aih-policy-workbench.html#/admin");
    vi.resetModules();
    const { requestToken } = await import("../hosts/cli/main.js");
    expect(requestToken()).toBeUndefined();
  });
});
