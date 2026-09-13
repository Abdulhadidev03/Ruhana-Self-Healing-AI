import { describe, expect, it, vi } from "vitest";
import { RepairsClient } from "../src/repairs-client.ts";
import { SessionOverlayStore } from "../src/overlay.ts";
import type { RepairOverlay } from "../../contracts/types.ts";

const overlay: RepairOverlay = {
  session_id: "s-42",
  overlay_version: 1,
  repairs: [],
};

describe("RepairsClient", () => {
  it("stages a newer overlay from the API", async () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => overlay });
    const client = new RepairsClient("http://evolve", "s-42", store, fetchMock as unknown as typeof fetch);
    expect(await client.pollOnce()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://evolve/api/session/s-42/repairs");
    store.applyAtTurnBoundary();
    expect(store.snapshot().overlayVersion).toBe(1);
  });

  it("ignores unchanged overlays and API errors", async () => {
    const store = new SessionOverlayStore("base-1", "demo", "s-42");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...overlay, overlay_version: 0 }) })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    const client = new RepairsClient("http://evolve", "s-42", store, fetchMock as unknown as typeof fetch);
    expect(await client.pollOnce()).toBe(false);
    expect(await client.pollOnce()).toBe(false);
  });
});
