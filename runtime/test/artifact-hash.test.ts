import { describe, expect, it } from "vitest";
import { hashRepair, verifyWireRepair } from "../../contracts/artifact.ts";
import { SessionOverlayStore } from "../src/overlay.ts";
import type { Repair, RepairOverlay } from "../../contracts/types.ts";

const base: Repair = {
  repair_id: "r-9",
  type: "pronunciation",
  scope: { tenant: "demo", entity_id: "demo-person-17", session_id: "s-42" },
  payload: { phonemes: "aɪˈiːʃə", voice_model_version: "mock-voice-1" },
  expires: "session_end",
  predecessor: null,
};

function signed(repair: Repair, baseVersion: string, issuedAt: number): Repair {
  return {
    ...repair,
    artifact_hash: hashRepair(repair, baseVersion, issuedAt),
    issued_overlay_version: issuedAt,
  };
}

const overlay = (version: number, repairs: Repair[]): RepairOverlay => ({
  session_id: "s-42",
  overlay_version: version,
  repairs,
});

describe("verifyWireRepair", () => {
  it("verifies a correctly signed repair", () => {
    expect(verifyWireRepair(signed(base, "base-1", 1), "base-1")).toBe("verified");
  });

  it("treats a missing hash as unsigned", () => {
    expect(verifyWireRepair(base, "base-1")).toBe("unsigned");
  });

  it("rejects a tampered payload", () => {
    const s = signed(base, "base-1", 1);
    const tampered = { ...s, payload: { phonemes: "evil", voice_model_version: "mock-voice-1" } };
    expect(verifyWireRepair(tampered, "base-1")).toBe("invalid");
  });

  it("rejects a hash issued for a different base version", () => {
    expect(verifyWireRepair(signed(base, "base-2", 1), "base-1")).toBe("invalid");
  });

  it("rejects a hash without its issue version", () => {
    const s = signed(base, "base-1", 1);
    delete (s as Partial<Repair>).issued_overlay_version;
    expect(verifyWireRepair(s, "base-1")).toBe("invalid");
  });

  it("wire-only fields do not affect the hash body", () => {
    const s = signed(base, "base-1", 1);
    expect(hashRepair(s, "base-1", 1)).toBe(hashRepair(base, "base-1", 1));
  });
});

describe("SessionOverlayStore artifact verification", () => {
  it("stages an overlay whose repairs verify", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    expect(store.stage(overlay(1, [signed(base, "base-1", 1)]))).toBe(true);
  });

  it("rejects an overlay containing a tampered repair", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    const s = signed(base, "base-1", 1);
    const tampered = { ...s, payload: { phonemes: "evil", voice_model_version: "x" } };
    expect(store.stage(overlay(1, [tampered]))).toBe(false);
    store.applyAtTurnBoundary();
    expect(store.snapshot().overlayVersion).toBe(0);
  });

  it("still accepts unsigned repairs (back-compat with the mock)", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    expect(store.stage(overlay(1, [base]))).toBe(true);
  });

  it("accepts a rollback overlay re-serving a repair issued at an earlier version", () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    const first = signed(base, "base-1", 1);
    const second = signed({ ...base, repair_id: "r-10" }, "base-1", 2);
    store.stage(overlay(2, [first, second]));
    store.applyAtTurnBoundary();
    // Rollback of r-10: HIGHER version, r-9 still signed at version 1.
    expect(store.stage(overlay(3, [first]))).toBe(true);
    store.applyAtTurnBoundary();
    expect(store.snapshot().repairs.map((r) => r.repair_id)).toEqual(["r-9"]);
  });
});
