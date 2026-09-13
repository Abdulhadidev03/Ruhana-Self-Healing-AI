import { describe, expect, it } from "vitest";
import { SessionOverlayStore } from "../src/overlay.ts";
import type { Repair, RepairOverlay } from "../../contracts/types.ts";

const pronRepair = (overrides: Partial<Repair> = {}): Repair => ({
  repair_id: "r-1",
  type: "pronunciation",
  scope: { tenant: "demo", entity_id: "demo-person-17", session_id: "s-42" },
  payload: { phonemes: "aɪˈiːʃə", voice_model_version: "mock-voice-1" },
  expires: "session_end",
  predecessor: null,
  ...overrides,
});

const overlay = (version: number, repairs: Repair[]): RepairOverlay => ({
  session_id: "s-42",
  overlay_version: version,
  repairs,
});

describe("SessionOverlayStore", () => {
  it("starts at overlay version 0 with the base version", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    expect(store.snapshot().effectiveVersion).toBe("base-1+overlay.0");
    expect(store.snapshot().repairs).toHaveLength(0);
  });

  it("staged overlays do not change the snapshot until a turn boundary", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    expect(store.stage(overlay(1, [pronRepair()]))).toBe(true);
    expect(store.snapshot().overlayVersion).toBe(0);
    expect(store.applyAtTurnBoundary()).toBe(true);
    expect(store.snapshot().overlayVersion).toBe(1);
    expect(store.snapshot().effectiveVersion).toBe("base-1+overlay.1");
  });

  it("rejects stale or duplicate overlay versions", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    store.stage(overlay(2, [pronRepair()]));
    store.applyAtTurnBoundary();
    expect(store.stage(overlay(2, []))).toBe(false);
    expect(store.stage(overlay(1, []))).toBe(false);
    expect(store.applyAtTurnBoundary()).toBe(false);
  });

  it("rejects overlays for a different session", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    expect(store.stage({ ...overlay(1, []), session_id: "s-99" })).toBe(false);
  });

  it("scopes repairs by tenant, entity, and session", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    store.stage(
      overlay(1, [
        pronRepair(),
        pronRepair({ repair_id: "r-2", scope: { tenant: "demo", entity_id: "other-entity", session_id: "s-42" } }),
        pronRepair({ repair_id: "r-3", scope: { tenant: "demo", entity_id: "demo-person-17", session_id: "s-99" } }),
        pronRepair({ repair_id: "r-4", scope: { tenant: "another-tenant", entity_id: "demo-person-17" } }),
      ]),
    );
    store.applyAtTurnBoundary();
    const snap = store.snapshot();
    const matches = store.repairsForEntity(snap, "demo-person-17");
    expect(matches.map((r) => r.repair_id)).toEqual(["r-1"]);
  });

  it("tenant-wide repairs (no session scope) apply to any session of that tenant", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    store.stage(overlay(1, [pronRepair({ scope: { tenant: "demo", entity_id: "demo-person-17" } })]));
    store.applyAtTurnBoundary();
    expect(store.repairsForEntity(store.snapshot(), "demo-person-17")).toHaveLength(1);
  });
});
