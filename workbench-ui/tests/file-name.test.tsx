import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { alertText, createTestHost, fixtureModel, statusText } from "./test-host.js";

/**
 * Editor 3: the file name rules and the validate command hint. The intent is
 * ported from `tests/org-policy/workbench/new-shell-download-compat.test.ts`
 * (the download path's refusal and its success message) and from
 * `ui/shell/file-transfer.ts` `updateFilenameHelp`.
 */

const SAFE_HELP =
  "Use one safe JSON filename per project or team. The browser chooses the download folder; move the file into an administrator-controlled policy folder when required.";
const REFUSED_HELP = "Use a JSON filename without folders, spaces, or hidden characters.";
const BLOCKED = `Download blocked: ${REFUSED_HELP}`;

beforeEach(() => {
  location.hash = "#/admin";
});
afterEach(cleanup);

async function openReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review Changes" }));
  return screen.getByRole("dialog", { name: "Review changes" });
}

async function setName(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  value: string,
) {
  const field = within(dialog).getByLabelText("File name");
  await user.clear(field);
  if (value !== "") await user.type(field, value);
  return field as HTMLInputElement;
}

describe("policy file name", () => {
  it("describes a safe name and hints the validate command for it", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    const field = await setName(user, review, "payments-team-policy.json");

    expect(field.getAttribute("aria-invalid")).toBeNull();
    const described = (field.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => review.ownerDocument.getElementById(id)?.textContent ?? "");
    expect(described).toContain(SAFE_HELP);
    expect(described).toContain(
      "aih policy validate <target-root> --policy payments-team-policy.json",
    );
  });

  it("marks an unsafe name invalid, says the rule, and hints a placeholder", async () => {
    const user = userEvent.setup();
    render(<App host={createTestHost()} model={fixtureModel()} />);

    const review = await openReview(user);
    for (const unsafe of ["../evil.json", "policy", "a b.json", ".hidden.json"]) {
      const field = await setName(user, review, unsafe);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      const described = (field.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => review.ownerDocument.getElementById(id)?.textContent ?? "");
      expect(described).toContain(REFUSED_HELP);
      expect(described).toContain(
        "aih policy validate <target-root> --policy <safe-policy-file.json>",
      );
    }
  });

  it("refuses to download an unsafe name and writes no file", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    render(<App host={host} model={fixtureModel()} />);

    const review = await openReview(user);
    await setName(user, review, "../evil.json");
    await user.click(within(review).getByRole("button", { name: "Download" }));

    expect(host.save).not.toHaveBeenCalled();
    expect(alertText()).toContain(BLOCKED);
  });

  it("downloads a safe name and names the command to validate it", async () => {
    const user = userEvent.setup();
    const host = createTestHost();
    render(<App host={host} model={fixtureModel()} />);

    const review = await openReview(user);
    await setName(user, review, "payments-team-policy.json");
    await user.click(within(review).getByRole("button", { name: "Download" }));

    expect(host.save).toHaveBeenCalledTimes(1);
    expect(host.save.mock.calls[0]?.[0]?.name).toBe("payments-team-policy.json");
    expect(statusText()).toContain(
      "Policy download started. Validate this file with: aih policy validate <target-root> --policy payments-team-policy.json",
    );
  });
});
