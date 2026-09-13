// Shared artifact hashing (plan §10). Both sides use this module so the hash
// can never drift: Evolve computes it when the gate issues a repair, the
// runtime recomputes it before trusting one. The hash proves integrity and
// issuer discipline, not correctness.
//
// Node-only for now (node:crypto); a browser runtime build would swap in
// crypto.subtle behind the same function signature.

import { createHash } from "node:crypto";
import type { Repair } from "./types.ts";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Canonical JSON so hashes do not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/**
 * The bytes the hash covers. Field list is explicit and closed: the wire-only
 * fields (artifact_hash, issued_overlay_version) are never part of the body,
 * so enriching a Repair for the wire does not change its hash.
 */
export function artifactBody(repair: Repair, baseVersion: string, overlayVersion: number): string {
  return canonicalJson({
    repair_id: repair.repair_id,
    type: repair.type,
    scope: repair.scope,
    payload: repair.payload,
    expires: repair.expires,
    predecessor: repair.predecessor,
    base_version: baseVersion,
    overlay_version: overlayVersion,
  });
}

export function hashRepair(repair: Repair, baseVersion: string, overlayVersion: number): string {
  return sha256Hex(artifactBody(repair, baseVersion, overlayVersion));
}

export type WireVerification = "verified" | "unsigned" | "invalid";

/**
 * Verify a repair as received over contract 2. A repair is hashed against the
 * overlay version it was ISSUED at (carried as issued_overlay_version), because
 * later overlays — including rollbacks — legitimately re-serve older repairs.
 */
export function verifyWireRepair(repair: Repair, baseVersion: string): WireVerification {
  if (repair.artifact_hash === undefined) return "unsigned";
  if (repair.issued_overlay_version === undefined) return "invalid";
  return hashRepair(repair, baseVersion, repair.issued_overlay_version) === repair.artifact_hash
    ? "verified"
    : "invalid";
}
