import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BindingContext, ProvisionRequest } from "../../../src/binding/adapter.js";
import {
  createDormantGstackAdapter,
  GSTACK_DORMANT_NOTICE,
} from "../../../src/binding/frameworks/gstack.js";
import { createBindingAdapterRegistry } from "../../../src/binding/frameworks/registry.js";
import { BindingNotSupportedError, type ScanDisposition } from "../../../src/binding/scan-gate.js";
import { fakeRunner } from "../../../src/internals/proc.js";

/**
 * v1 dormancy (2026-07-23 maintainer scope decision): gstack stays fully built
 * and tested (see gstack.test.ts — the raw factory), but the PRODUCT assembly
 * refuses NEW binds while keeping the exit path alive. These tests pin exactly
 * that split.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-gstack-dormant-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const runner = fakeRunner(() => undefined);

// plan/provision must refuse BEFORE reading their arguments, so minimal casts
// stand in — a dormant adapter that got far enough to inspect them would
// already have failed this suite's purpose.
const DUMMY_CONTEXT = {} as BindingContext;
const DUMMY_REQUEST = {} as ProvisionRequest;
const DUMMY_DISPOSITION = {} as ScanDisposition;

describe("createDormantGstackAdapter (v1 dormancy)", () => {
  it("refuses plan with the decision-citing notice, before any side effect", () => {
    const adapter = createDormantGstackAdapter({ root, runner });
    expect(() => adapter.plan(DUMMY_CONTEXT)).toThrowError(BindingNotSupportedError);
    expect(() => adapter.plan(DUMMY_CONTEXT)).toThrowError(/EVALUATED_DEFERRED/);
    expect(() => adapter.plan(DUMMY_CONTEXT)).toThrowError(/exit path/);
  });

  it("refuses provision with the same notice", () => {
    const adapter = createDormantGstackAdapter({ root, runner });
    expect(() => adapter.provision(DUMMY_REQUEST, DUMMY_DISPOSITION)).toThrowError(
      BindingNotSupportedError,
    );
    expect(() => adapter.provision(DUMMY_REQUEST, DUMMY_DISPOSITION)).toThrowError(
      /EVALUATED_DEFERRED/,
    );
  });

  it("keeps identity and the non-mutating contract surfaces intact", async () => {
    const adapter = createDormantGstackAdapter({ root, runner });
    expect(adapter.framework).toBe("gstack");
    expect(adapter.adapterType).toBe("shared-runtime");
    // inspect is the cheapest pass-through proof: it must run normally, not
    // throw the dormancy notice.
    const report = await adapter.inspect({ treePath: root });
    expect(report.framework).toBe("gstack");
    expect(() => adapter.verify(DUMMY_CONTEXT)).not.toThrowError(BindingNotSupportedError);
    expect(() => adapter.remove(DUMMY_CONTEXT)).not.toThrowError(BindingNotSupportedError);
  });

  it("the product registry assembles the DORMANT variant", () => {
    const registry = createBindingAdapterRegistry({ root, runner });
    const adapter = registry.get("gstack");
    expect(adapter).toBeDefined();
    expect(() => adapter?.plan(DUMMY_CONTEXT)).toThrowError(/EVALUATED_DEFERRED/);
  });

  it("the notice names the operative facts: deferral, retained code, exit path, re-entry bar", () => {
    expect(GSTACK_DORMANT_NOTICE).toContain("EVALUATED_DEFERRED");
    expect(GSTACK_DORMANT_NOTICE).toContain("retained");
    expect(GSTACK_DORMANT_NOTICE).toContain("verify/remove/report");
    expect(GSTACK_DORMANT_NOTICE).toContain("maintainer decision");
  });
});
