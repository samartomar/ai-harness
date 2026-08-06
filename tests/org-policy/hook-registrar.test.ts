import { describe, expect, it } from "vitest";
import {
  assertHookRegistrations,
  HOOK_REGISTRAR_DESTINATION,
  hookOverlaps,
  hookRegistrarDrift,
  hookSpawnProjection,
  projectedHookSettings,
} from "../../src/org-policy/hook-registrar.js";
import {
  aihDispatcher,
  eccStopRegistrations,
  measuredStopEvent,
  overlappingRegistrations,
  repositoryStopHook,
  sha256,
  sourceDisabledRegistration,
} from "./hook-registrar-fixtures.js";

describe("H2 — verbatim third-party commands", () => {
  it("projects a third-party launcher byte-for-byte", () => {
    const registrations = eccStopRegistrations();
    const settings = projectedHookSettings(registrations);
    const projected = settings.hooks.Stop?.flatMap((group) => group.hooks.map((h) => h.command));
    for (const registration of registrations) {
      expect(projected).toContain(registration.command);
    }
  });

  it("proves verbatim reproduction by hash against the pinned launcher", () => {
    for (const registration of eccStopRegistrations()) {
      if (registration.owner.kind !== "third-party")
        throw new Error("expected a third-party owner");
      expect(sha256(registration.command)).toBe(registration.owner.pin.launcherSha256);
    }
  });

  it("never parses, wraps or re-emits a third-party command", () => {
    const [registration] = eccStopRegistrations();
    if (registration === undefined) throw new Error("expected a registration");
    const settings = projectedHookSettings([registration]);
    const entry = settings.hooks.Stop?.[0]?.hooks[0];
    if (entry === undefined) throw new Error("expected a projected entry");
    // The projected command is the source's own launcher and nothing else: no
    // AIH dispatcher, no shell wrapper, no re-encoding.
    expect(entry.command).toBe(registration.command);
    expect(entry.command).not.toContain("ecc-runtime");
    expect(entry.command).not.toContain("aih");
  });

  it("rejects a launcher whose hash no longer matches its pin as drift, never a silent update", () => {
    const [registration] = eccStopRegistrations();
    if (registration === undefined || registration.owner.kind !== "third-party") {
      throw new Error("expected a third-party registration");
    }
    const mutated = { ...registration, command: `${registration.command} --extra` };
    expect(() => assertHookRegistrations([mutated])).toThrowError(/launcher hash/i);
  });
});

describe("H1 — single registrar, unowned entries are drift", () => {
  const registrations = eccStopRegistrations();

  function destinationFrom(commands: readonly string[]): unknown {
    return {
      hooks: { Stop: [{ hooks: commands.map((command) => ({ type: "command", command })) }] },
    };
  }

  it("reports no drift when every entry on disk was emitted by AIH", () => {
    const settings = projectedHookSettings(registrations);
    const report = hookRegistrarDrift({
      destination: { hooks: settings.hooks },
      registrations,
    });
    expect(report.unowned).toEqual([]);
    expect(report.drifted).toEqual([]);
  });

  it("reports an entry AIH did not emit as drift, listed by owner and event", () => {
    const foreign =
      "node -e \"require('~/.claude/scripts/hooks/run-with-flags.js').run('rogue.js')\"";
    const settings = projectedHookSettings(registrations);
    const onDisk = {
      hooks: {
        ...settings.hooks,
        Stop: [...(settings.hooks.Stop ?? []), { hooks: [{ type: "command", command: foreign }] }],
      },
    };
    const report = hookRegistrarDrift({ destination: onDisk, registrations });
    expect(report.unowned).toHaveLength(1);
    expect(report.unowned[0]?.event).toBe("Stop");
    expect(report.unowned[0]?.command).toBe(foreign);
    expect(report.unowned[0]?.owner).toBe("unknown");
    // Reported and offered for adoption — never silently absorbed.
    expect(report.adoption).toHaveLength(1);
    expect(report.adoption[0]?.command).toBe(foreign);
  });

  it("detects a mutated projected entry as drift", () => {
    const settings = projectedHookSettings(registrations);
    const commands = (settings.hooks.Stop ?? []).flatMap((group) =>
      group.hooks.map((hook) => hook.command),
    );
    const [first, ...rest] = commands;
    if (first === undefined) throw new Error("expected a projected command");
    const report = hookRegistrarDrift({
      destination: destinationFrom([`${first} --tampered`, ...rest]),
      registrations,
    });
    expect(report.drifted.map((entry) => entry.reason)).toContain("missing");
    expect(report.unowned).toHaveLength(1);
  });

  it("detects a mutated launcher hash as drift without touching the destination", () => {
    const [registration] = registrations;
    if (registration === undefined || registration.owner.kind !== "third-party") {
      throw new Error("expected a third-party registration");
    }
    const repinned = {
      ...registration,
      owner: {
        ...registration.owner,
        pin: { ...registration.owner.pin, launcherSha256: sha256("some other launcher") },
      },
    };
    const settings = projectedHookSettings([registration]);
    const report = hookRegistrarDrift({
      destination: { hooks: settings.hooks },
      registrations: [repinned],
    });
    expect(report.drifted.map((entry) => entry.reason)).toContain("launcher-pin-mismatch");
  });
});

describe("H5 — overlap is surfaced, never auto-resolved", () => {
  const registrations = overlappingRegistrations();

  it("names both owners for each of the three real overlaps", () => {
    const overlaps = hookOverlaps(registrations);
    const byTag = new Map(overlaps.map((overlap) => [overlap.functionTag, overlap]));
    for (const tag of ["mcp-health", "verification-bypass-guard", "pre-compaction-summary"]) {
      const overlap = byTag.get(tag);
      expect(overlap, `overlap on ${tag}`).toBeDefined();
      expect(overlap?.owners).toContain("aih");
      expect(overlap?.owners).toContain("ecc");
    }
  });

  it("still projects every overlapping entry — no silent merging", () => {
    const settings = projectedHookSettings(registrations);
    const projected = Object.values(settings.hooks)
      .flat()
      .flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(projected).toHaveLength(registrations.length);
    for (const registration of registrations) {
      expect(projected).toContain(registration.command);
    }
  });

  it("does not report an overlap when two hooks share an event but no function", () => {
    const overlaps = hookOverlaps([
      aihDispatcher("Stop", ["continuity-checkpoint"]),
      repositoryStopHook(),
    ]);
    expect(overlaps).toEqual([]);
  });
});

describe("H7 — cost is projected, not discovered", () => {
  it("reproduces the measured Stop event: 8 entries, 18 process spawns", () => {
    const projection = hookSpawnProjection(measuredStopEvent());
    const stop = projection.events.find((event) => event.event === "Stop");
    expect(stop?.entries).toBe(8);
    expect(stop?.spawns).toBe(18);
  });

  it("counts nested launcher spawns, not just entries", () => {
    const projection = hookSpawnProjection(eccStopRegistrations());
    const stop = projection.events.find((event) => event.event === "Stop");
    // Six entries; four target scripts have no run() export, so run-with-flags
    // spawns a legacy child for each: 4 x 3 + 2 x 2 = 16.
    expect(stop?.entries).toBe(6);
    expect(stop?.spawns).toBe(16);
  });

  it("charges a source-disabled third-party hook a full process", () => {
    const disabled = sourceDisabledRegistration();
    const projection = hookSpawnProjection([disabled]);
    const event = projection.events.find((entry) => entry.event === disabled.event);
    // ECC evaluates ECC_DISABLED_HOOKS inside run-with-flags.js, after the OS
    // process already exists. A disabled hook costs a process.
    expect(event?.spawns).toBeGreaterThanOrEqual(1);
    expect(projection.sourceDisabledSpawns).toBeGreaterThanOrEqual(1);
  });

  it("totals entries and spawns across every event", () => {
    const projection = hookSpawnProjection([
      ...measuredStopEvent(),
      aihDispatcher("PreCompact", ["pre-compaction-summary"]),
    ]);
    expect(projection.totalEntries).toBe(9);
    expect(projection.totalSpawns).toBe(19);
  });
});

describe("projector identity", () => {
  it("targets the client's own native hook configuration", () => {
    expect(HOOK_REGISTRAR_DESTINATION).toBe(".claude/settings.json");
  });
});
