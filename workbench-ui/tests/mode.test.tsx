import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { createTestHost, fixtureModel } from "./test-host.js";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  try {
    localStorage.removeItem("wb-mode");
  } catch {
    // Storage is optional.
  }
});

const root = () => document.documentElement;

/** The prototype's order (screens/mode.js): the query wins, then the last choice, then dark. */
describe("light and dark mode", () => {
  it("starts dark and flips from the header button", async () => {
    render(<App host={createTestHost()} model={fixtureModel()} />);
    expect(root().classList.contains("dark")).toBe(true);
    expect(root().dataset.mode).toBe("dark");
    const [toggle] = screen.getAllByRole("button", { name: "Switch to light mode" });
    if (toggle === undefined) throw new Error("expected the mode button");
    await userEvent.click(toggle);
    expect(root().classList.contains("light")).toBe(true);
    expect(root().classList.contains("dark")).toBe(false);
    expect(screen.getAllByRole("button", { name: "Switch to dark mode" }).length).toBeGreaterThan(
      0,
    );
  });

  it("lets ?mode=light win over the default", () => {
    history.replaceState(null, "", "/?mode=light");
    render(<App host={createTestHost()} model={fixtureModel()} />);
    expect(root().classList.contains("light")).toBe(true);
    expect(root().dataset.mode).toBe("light");
  });
});
