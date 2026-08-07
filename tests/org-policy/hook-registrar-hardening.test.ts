import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  adoptedHookRegistrations,
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_MAX_DESTINATION_BYTES,
  HOOK_REGISTRAR_RECEIPT_PATH,
  type HookAdoptionDeclaration,
  type HookRegistration,
  hookRegistrarDrift,
  hookRegistrarProjectionActions,
  hookRegistrarReport,
  hookRegistrarRevocationActions,
  hookRegistrarState,
  MAX_REPORTED_HOOK_ENTRIES,
  projectedHookSettings,
  readHookRegistrarReceipt,
} from "../../src/org-policy/hook-registrar.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { eccStopRegistrations, sha256 } from "./hook-registrar-fixtures.js";

/**
 * Hardening pins for the hook registrar's read path: what it transports, what
 * it refuses, and what it is allowed to display. Every case runs against a
 * temporary fixture root this file creates and removes.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-hook-registrar-hardening-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(apply: boolean): PlanContext {
  const run = fakeRunner(() => ({ code: 0, stdout: "" }));
  return {
    root: dir,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ run, env: process.env }),
    env: process.env,
    options: {},
    targets: ["claude"],
  };
}

function writeDestination(contents: string): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), contents, "utf8");
}

function seed(destination: unknown): void {
  writeDestination(`${JSON.stringify(destination, null, 2)}\n`);
}

function readDestination(): string | undefined {
  try {
    return readFileSync(join(dir, HOOK_REGISTRAR_DESTINATION), "utf8");
  } catch {
    return undefined;
  }
}

function destinationHooks(): Record<string, unknown> {
  return JSON.parse(readDestination() ?? "{}").hooks;
}

async function run(actions: ReturnType<typeof hookRegistrarProjectionActions>): Promise<void> {
  await executePlan(plan("hook registrar", ...actions), ctx(true), { skipWorktreeGate: true });
}

function selectedCommand(): string {
  const [selected] = eccStopRegistrations();
  if (selected === undefined) throw new Error("expected a registration");
  return selected.command;
}

function refusalFor(destination: unknown): string {
  seed(destination);
  const before = readDestination();
  let message = "";
  try {
    hookRegistrarProjectionActions(ctx(false), eccStopRegistrations());
  } catch (error) {
    message = (error as Error).message;
  }
  // Refusal is not enough on its own: the content must still be on disk.
  expect(readDestination()).toBe(before);
  return message;
}

describe("A4 — recorded prior evidence is always readable back", () => {
  /**
   * The receipt caps the prior bytes it can carry. A destination bigger than
   * that cap must never be projected onto and then recorded: the receipt would
   * refuse to parse for the rest of its life, so revocation could never run and
   * every projected third-party entry would be stuck on disk with no removal
   * path — the exact defect this projector exists to eliminate.
   */
  it("refuses a destination larger than the receipt can carry, and revokes once it is trimmed", async () => {
    const oversized = `${JSON.stringify({
      note: "z".repeat(HOOK_REGISTRAR_MAX_DESTINATION_BYTES),
    })}\n`;
    writeDestination(oversized);

    expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).toThrowError(
      /receipt/i,
    );
    // Refusal is fail-closed: nothing was written, nothing was recorded.
    expect(readDestination()).toBe(oversized);
    expect(readHookRegistrarReceipt(dir)).toBeUndefined();

    // Trimmed back under the cap, the whole lifecycle works again.
    writeDestination(`${JSON.stringify({ note: "z" })}\n`);
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const receipt = readHookRegistrarReceipt(dir);
    expect(receipt?.prior.state).toBe("present");
    await run(hookRegistrarRevocationActions(ctx(false)));
    expect(readHookRegistrarReceipt(dir)).toBeUndefined();
    expect(readDestination() ?? "").not.toContain("run-with-flags.js");
  });
});

describe("H1/H2 — richer native content is transported, never destroyed or flattened away", () => {
  /**
   * The projection writes with `replaceJsonKeys: ["hooks"]`, so anything the
   * flattening cannot see is destroyed. That is what makes faithfulness a
   * correctness property rather than tidiness — but refusing such content at
   * flattening time is the wrong remedy: it pre-empts the machinery the
   * contract already gives for unowned content (A3, with adoption as the way
   * out) and leaves the projector with no capability at all on the real client
   * configurations it exists for. It must SURFACE, be named, and be adoptable.
   */
  const matcherScoped = {
    hooks: {
      Stop: [
        {
          matcher: "Write",
          description: "scoped to writes",
          id: "third-party-1",
          hooks: [{ type: "command", command: selectedCommand(), timeout: 45, async: true }],
        },
      ],
    },
  };

  it("surfaces a matcher-scoped entry as unowned and offers it for adoption", () => {
    seed(matcherScoped);
    const report = hookRegistrarReport(dir);

    expect(report.state).toBe("unowned");
    expect(report.unowned).toHaveLength(1);
    expect(report.unowned[0]?.event).toBe("Stop");
    expect(report.adoption).toHaveLength(1);
    expect(report.adoption[0]?.command).toBe(selectedCommand());
  });

  it("refuses to project over it, naming it, and leaves every byte in place", () => {
    // Its command matches a selected registration, but the entry AIH would
    // emit is not the entry on disk — so it is not already-known, and the A3
    // refusal is what fires.
    const message = refusalFor(matcherScoped);
    expect(message).toMatch(/did not emit/);
    expect(message).toMatch(/Stop/);
    expect(destinationHooks().Stop).toEqual(matcherScoped.hooks.Stop);
  });

  it("adopts it and re-projects it byte-faithfully, matcher and all", async () => {
    seed(matcherScoped);
    const [offer] = hookRegistrarReport(dir).adoption;
    if (offer === undefined) throw new Error("expected an adoption offer");
    const adopted = adoptedHookRegistrations(dir, [
      {
        event: offer.event,
        commandSha256: offer.commandSha256,
        id: "adopted-scoped-stop",
        functionTags: ["scoped-stop"],
        spawns: 2,
        owner: { kind: "unknown" },
      },
    ]);

    // The captured registration carries the native envelope, not just the command.
    expect(adopted[0]?.nativeGroup).toEqual({
      matcher: "Write",
      description: "scoped to writes",
      id: "third-party-1",
    });
    expect(adopted[0]?.nativeHook).toEqual({ type: "command", async: true });
    expect(adopted[0]?.timeout).toBe(45);

    await run(hookRegistrarProjectionActions(ctx(false), adopted));
    expect(destinationHooks()).toEqual(matcherScoped.hooks);
    // And owning it is stable: the re-read matches the receipt exactly.
    expect(hookRegistrarState(dir).state).toBe("active");
  });

  it("keeps an entry AIH itself authored round-tripping through its own projection", async () => {
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    expect(hookRegistrarState(dir).state).toBe("active");
    // Projecting the same selection twice is deterministic and reports no drift.
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    expect(hookRegistrarReport(dir).unowned).toEqual([]);
  });

  it("holds no entry for an empty group or an empty event list, and refuses neither", () => {
    // Neither can lose an entry, because neither holds one.
    seed({ hooks: { Stop: [], SessionStart: [{ matcher: "*", hooks: [] }] } });
    const state = hookRegistrarState(dir);
    expect(state.state).toBe("absent");
    expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).not.toThrow();
  });

  /**
   * The parity contract: the ownership key must cover EVERY field the projector
   * emits. A field in one and not the other is a field AIH re-emits differently
   * from how it found it while still calling the entry already-known — the
   * whole-key replace then rewrites it silently, one field over.
   */
  it("keys ownership on every field it emits", () => {
    const registration: HookRegistration = {
      id: "parity-entry",
      event: "Stop",
      command: "node parity.js",
      functionTags: ["parity"],
      spawns: 1,
      timeout: 30,
      nativeGroup: { matcher: "Write", description: "d", id: "g" },
      nativeHook: { type: "command", async: true },
      owner: { kind: "aih" },
    };
    const emitted = projectedHookSettings([registration]).hooks.Stop?.[0];
    if (emitted === undefined) throw new Error("expected a projected group");

    const isOwned = (group: unknown): boolean =>
      hookRegistrarDrift({
        destination: { hooks: { Stop: [group] } },
        registrations: [registration],
      }).unowned.length === 0;

    expect(isOwned(JSON.parse(JSON.stringify(emitted)))).toBe(true);

    const mutations: { where: string; mutate: (group: Record<string, unknown>) => void }[] = [
      ...Object.keys(emitted)
        .filter((key) => key !== "hooks")
        .map((key) => ({
          where: `group.${key}`,
          mutate: (group: Record<string, unknown>) => {
            group[key] = "mutated";
          },
        })),
      ...Object.keys(emitted.hooks[0] ?? {}).map((key) => ({
        where: `hook.${key}`,
        mutate: (group: Record<string, unknown>) => {
          const [hook] = group.hooks as Record<string, unknown>[];
          if (hook === undefined) throw new Error("expected a projected hook");
          hook[key] = key === "timeout" ? 31 : key === "command" ? "node other.js" : "mutated";
        },
      })),
    ];
    // Every emitted field, group-level and hook-level alike, is load-bearing.
    expect(mutations.map((mutation) => mutation.where).sort()).toEqual([
      "group.description",
      "group.id",
      "group.matcher",
      "hook.async",
      "hook.command",
      "hook.timeout",
      "hook.type",
    ]);
    for (const { where, mutate } of mutations) {
      const group = JSON.parse(JSON.stringify(emitted));
      mutate(group);
      expect(isOwned(group), `${where} must change the ownership key`).toBe(false);
    }
  });
});

describe("H1 — structure that cannot be interpreted at all still refuses", () => {
  it("refuses a hook entry that is not an object", () => {
    expect(refusalFor({ hooks: { Stop: [{ hooks: ["node bare.js"] }] } })).toMatch(/not an object/);
  });

  it("refuses a hook entry whose command is not a string", () => {
    expect(
      refusalFor({ hooks: { Stop: [{ hooks: [{ type: "command", command: { $ref: "x" } }] }] } }),
    ).toMatch(/command is not a string/);
  });

  it("refuses a hook entry whose timeout is not a number", () => {
    expect(
      refusalFor({ hooks: { Stop: [{ hooks: [{ command: "node t.js", timeout: "30s" }] }] } }),
    ).toMatch(/timeout is not a number/);
  });

  it("refuses a native field AIH cannot transport back", () => {
    expect(
      refusalFor({
        hooks: {
          Stop: [{ matcher: "x".repeat(9000), hooks: [{ command: "node big.js" }] }],
        },
      }),
    ).toMatch(/cannot transport/);
  });

  /**
   * `parseJsoncText` does not give a `__proto__` member an own property — it
   * SETS THE PROTOTYPE, so the entry is invisible to `Object.keys` and to
   * `Object.getOwnPropertyNames` alike and the whole-key replace would delete it
   * with nothing reported. The poisoned prototype is its one observable trace.
   */
  it("refuses a hooks object whose prototype was replaced by a __proto__ member", () => {
    writeDestination(
      '{"hooks":{"__proto__":[{"hooks":[{"type":"command","command":"node evil.js"}]}],"Stop":[]}}\n',
    );
    expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).toThrowError(
      /__proto__/,
    );
    expect(hookRegistrarState(dir).state).toBe("invalid");
  });
});

describe("H1 — duplicate copies of an owned entry are counted, not collapsed", () => {
  it("reports the extra copy as unowned instead of deleting it unreported", async () => {
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const hooks = destinationHooks() as Record<string, unknown[]>;
    const [firstGroup] = hooks.Stop ?? [];
    if (firstGroup === undefined) throw new Error("expected a projected group");
    // A third party writes a second, byte-identical copy of one owned entry.
    hooks.Stop = [...(hooks.Stop ?? []), JSON.parse(JSON.stringify(firstGroup))];
    seed({ hooks });

    const report = hookRegistrarReport(dir);
    expect(report.unowned).toHaveLength(1);
    expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).toThrowError(
      /did not emit/,
    );
  });
});

describe("H2 — a receipt that contradicts itself is refused at parse", () => {
  interface TamperableReceipt {
    prior: { state: string; sha256?: string; contents?: string };
    entries: {
      id: string;
      owner: string;
      commandSha256: string;
      pin?: { launcherSha256: string };
    }[];
  }

  async function projectThenTamper(mutate: (receipt: TamperableReceipt) => void): Promise<void> {
    writeDestination(`${JSON.stringify({ note: "operator" })}\n`);
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const path = join(dir, HOOK_REGISTRAR_RECEIPT_PATH);
    const receipt = JSON.parse(readFileSync(path, "utf8")) as TamperableReceipt;
    mutate(receipt);
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }

  it("refuses an entry whose recorded hash does not match its recorded command", async () => {
    await projectThenTamper((receipt) => {
      const [entry] = receipt.entries;
      if (entry === undefined) throw new Error("expected a receipt entry");
      entry.commandSha256 = sha256("a launcher this receipt does not carry");
    });
    expect(() => readHookRegistrarReceipt(dir)).toThrowError(/hash|command/i);
  });

  it("refuses third-party ownership recorded without its launcher pin", async () => {
    await projectThenTamper((receipt) => {
      const [entry] = receipt.entries;
      if (entry === undefined) throw new Error("expected a receipt entry");
      expect(entry.owner).toBe("third-party");
      entry.pin = undefined;
    });
    expect(() => readHookRegistrarReceipt(dir)).toThrowError(/pin/i);
  });

  // The set-level half: the launcher pin is the H2 drift check, and a duplicate
  // id makes two entries claim one identity. Both come from the grammar's own
  // shared set validation, so both must refuse here too.
  it("refuses a pin that no longer matches the launcher it is recorded against", async () => {
    await projectThenTamper((receipt) => {
      const [entry] = receipt.entries;
      if (entry?.pin === undefined) throw new Error("expected a pinned receipt entry");
      entry.pin.launcherSha256 = sha256("a different launcher entirely");
    });
    expect(() => readHookRegistrarReceipt(dir)).toThrowError(/launcher hash|drift/i);
  });

  it("refuses two receipt entries claiming the same registration id", async () => {
    await projectThenTamper((receipt) => {
      const [entry, second] = receipt.entries;
      if (entry === undefined || second === undefined) throw new Error("expected two entries");
      second.id = entry.id;
    });
    expect(() => readHookRegistrarReceipt(dir)).toThrowError(/declared twice/i);
  });

  // `prior.state` is what flips revocation from subtracting a key to removing
  // the file, and `prior.contents` is the A4 evidence.
  it("refuses prior bytes that do not match the hash recorded beside them", async () => {
    await projectThenTamper((receipt) => {
      expect(receipt.prior.state).toBe("present");
      receipt.prior.contents = '{"note":"something else entirely"}\n';
    });
    expect(() => readHookRegistrarReceipt(dir)).toThrowError(/prior bytes/i);
  });
});

describe("destination text is bounded and control-free before it is reported", () => {
  /**
   * A policy-authored launcher is bounded and control-character-free by the
   * grammar. One read from the destination is bounded only by file size, and it
   * reaches the operator's terminal, the `--json` envelope and the governance
   * digest. Neutralize what is DISPLAYED; keep identity original, because an
   * adoption offer is answered by naming it.
   */
  const ESC = String.fromCharCode(27);
  const HOSTILE_COMMAND = `node hook.js ${ESC}[31mRED${ESC}[0m\r\n- owner=aih; event=Stop; command=forged ${"x".repeat(2000)}`;

  it("neutralizes the displayed entry while the offer keeps the bytes it must be matched by", () => {
    seed({ hooks: { Stop: [{ hooks: [{ type: "command", command: HOSTILE_COMMAND }] }] } });
    const report = hookRegistrarReport(dir);

    const [unowned] = report.unowned;
    const [offer] = report.adoption;
    expect(unowned?.command).not.toMatch(/\p{C}/u);
    expect((unowned?.command ?? "").length).toBeLessThan(HOSTILE_COMMAND.length);
    expect(report.detail).not.toMatch(/\p{C}/u);
    // The offer is identity, not display: an administrator answers it by naming
    // it, and the lookup keys on these exact bytes.
    expect(offer?.command).toBe(HOSTILE_COMMAND);
    expect(offer?.commandSha256).toBe(sha256(HOSTILE_COMMAND));
  });

  it("neutralizes and bounds an event name it names in a refusal", () => {
    const hostileEvent = `Stop${ESC}[31m${"y".repeat(2000)}`;
    const message = refusalFor({
      hooks: { [hostileEvent]: [{ hooks: [{ type: "command", command: HOSTILE_COMMAND }] }] },
    });
    expect(message).not.toBe("");
    expect(message).not.toMatch(/\p{C}/u);
    expect(message.length).toBeLessThan(hostileEvent.length);
  });

  it("bounds the NUMBER of reported entries, not only each string", () => {
    const groups = Array.from({ length: MAX_REPORTED_HOOK_ENTRIES + 25 }, (_, index) => ({
      hooks: [{ type: "command", command: `node hook-${index}.js ${"z".repeat(400)}` }],
    }));
    seed({ hooks: { Stop: groups } });

    const report = hookRegistrarReport(dir);
    expect(report.unowned).toHaveLength(MAX_REPORTED_HOOK_ENTRIES);
    expect(report.adoption).toHaveLength(MAX_REPORTED_HOOK_ENTRIES);
    // Bounded, and honest about what it left out.
    expect(report.detail).toMatch(/\+25 more not listed/);

    let message = "";
    try {
      hookRegistrarProjectionActions(ctx(false), eccStopRegistrations());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/\+25 more/);
    expect(message.length).toBeLessThan(20_000);
  });
});

describe("fail closed on ambiguity — unreadable is not absent", () => {
  /**
   * `absent` is not a neutral verdict here. It is the flag that authorizes
   * deleting the destination on revocation, and the flag that skips the
   * unowned-entry check entirely. A path AIH merely failed to read — a
   * directory, a symlink, a special file — must never be recorded as one.
   */
  it("refuses a destination path occupied by a directory", () => {
    mkdirSync(join(dir, HOOK_REGISTRAR_DESTINATION), { recursive: true });

    expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).toThrowError(
      /regular file/i,
    );
    const state = hookRegistrarState(dir);
    expect(state.state).toBe("invalid");
    expect(state.detail).toMatch(/regular file/i);
  });
});

describe("a shadowed receipt path is refused, never read as no receipt", () => {
  /**
   * The receipt is the only removal authority a projected third-party entry
   * has. Reading a directory or a symlink at the receipt path as `undefined` —
   * indistinguishable from "no receipt was ever written" — makes the registrar
   * drop out of the plan entirely: revocation returns nothing to do, and the
   * projected launchers stay on disk with nothing claiming them.
   */
  async function projectThenShadowTheReceipt(): Promise<void> {
    writeDestination(`${JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2)}\n`);
    await run(hookRegistrarProjectionActions(ctx(false), eccStopRegistrations()));
    const receiptPath = join(dir, HOOK_REGISTRAR_RECEIPT_PATH);
    rmSync(receiptPath);
    mkdirSync(receiptPath, { recursive: true });
  }

  it("refuses to drop every registration while the receipt path is shadowed", async () => {
    await projectThenShadowTheReceipt();

    // Dropping every registration routes to revocation, which used to return an
    // empty plan: six projected third-party entries silently orphaned.
    expect(() => hookRegistrarProjectionActions(ctx(false), [])).toThrowError(/regular file/i);
    expect(() => readHookRegistrarReceipt(dir)).toThrowError(/regular file/i);
    expect(readDestination()).toContain("run-with-flags.js");
  });

  it("still treats a genuinely absent receipt as nothing to revoke", () => {
    expect(readHookRegistrarReceipt(dir)).toBeUndefined();
    expect(hookRegistrarRevocationActions(ctx(false))).toEqual([]);
  });
});

describe("symlinked parents are refused, not followed off-root", () => {
  /**
   * The no-follow reads guard the LEAF only. Every sibling lifecycle also
   * guards the parents, and for the same reason: with `.claude` or `.aih`
   * redirected, ownership state is read from outside the root and reported as
   * if it were in it — and the executor refuses a symlinked parent outright, so
   * the removal the report promises would die inside the action loop instead of
   * degrading to an advisory.
   */
  function linkDirectory(target: string, linkPath: string): string | undefined {
    try {
      symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      return `this platform cannot create a directory link in a fixture root: ${(error as Error).message}`;
    }
    return lstatSync(linkPath).isSymbolicLink()
      ? undefined
      : "this platform does not report the created directory link as a symlink";
  }

  it("refuses a destination reached through a symlinked parent", (test) => {
    const outside = mkdtempSync(join(tmpdir(), "aih-hook-registrar-outside-"));
    try {
      writeFileSync(
        join(outside, "settings.json"),
        `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node outside.js" }] }] } })}\n`,
        "utf8",
      );
      const cannotLink = linkDirectory(outside, join(dir, ".claude"));
      if (cannotLink !== undefined) test.skip(cannotLink);

      const state = hookRegistrarState(dir);
      expect(state.state).toBe("invalid");
      expect(state.detail).toMatch(/symlink/i);
      expect(() => hookRegistrarProjectionActions(ctx(false), eccStopRegistrations())).toThrowError(
        /symlink/i,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a receipt reached through a symlinked parent", (test) => {
    const outside = mkdtempSync(join(tmpdir(), "aih-hook-registrar-outside-"));
    try {
      writeFileSync(join(outside, "org-policy-hook-registrar-receipt.json"), "{}\n", "utf8");
      const cannotLink = linkDirectory(outside, join(dir, ".aih"));
      if (cannotLink !== undefined) test.skip(cannotLink);

      expect(() => readHookRegistrarReceipt(dir)).toThrowError(/symlink/i);
      expect(hookRegistrarState(dir).state).toBe("invalid");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("adoption refuses an ambiguous offer rather than guessing", () => {
  it("will not capture one of two entries that share an event and a launcher", () => {
    const command = "node ambiguous.js";
    seed({
      hooks: {
        Stop: [
          { matcher: "Write", hooks: [{ type: "command", command }] },
          { matcher: "Bash", hooks: [{ type: "command", command }] },
        ],
      },
    });
    const declaration: HookAdoptionDeclaration = {
      event: "Stop",
      commandSha256: sha256(command),
      id: "ambiguous-stop",
      functionTags: ["ambiguous"],
      spawns: 1,
      owner: { kind: "unknown" },
    };
    expect(() => adoptedHookRegistrations(dir, [declaration])).toThrowError(
      /more than one|native fields/i,
    );
  });
});
