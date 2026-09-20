import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { createTestHost, fixtureModel } from "./test-host.js";

/**
 * Journey J4 for the two flyouts of this slice: each opens from the keyboard,
 * moves focus inside, keeps Tab inside, closes on Escape, and returns focus to
 * the control that opened it.
 */

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

const FLYOUTS: readonly [string, RegExp | string][] = [
  ["AI tools", /AI tools/u],
  ["Review changes", "Review Changes"],
];

describe("flyout keyboard", () => {
  it.each(FLYOUTS)(
    "opens, traps and closes the %s flyout from the keyboard",
    async (title, triggerName) => {
      const user = userEvent.setup();
      render(<App host={createTestHost()} model={fixtureModel()} />);

      const trigger = screen.getByRole("button", { name: triggerName });
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      await user.keyboard("{Enter}");
      const dialog = screen.getByRole("dialog", { name: title });
      expect(dialog.contains(document.activeElement)).toBe(true);

      for (let step = 0; step < 8; step += 1) {
        await user.tab();
        expect(dialog.contains(document.activeElement)).toBe(true);
      }

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: title })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    },
  );

  it("opens the AI tools flyout with Space and toggles a tool from the keyboard", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const trigger = screen.getByRole("button", { name: /AI tools/u });
    trigger.focus();
    await user.keyboard(" ");
    const dialog = screen.getByRole("dialog", { name: "AI tools" });

    const tool = within(dialog).getByRole("switch", { name: "Claude Code" });
    tool.focus();
    await user.keyboard("{Enter}");
    expect(
      within(screen.getByRole("dialog", { name: "AI tools" }))
        .getByRole("switch", { name: "Claude Code" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
  });
});
