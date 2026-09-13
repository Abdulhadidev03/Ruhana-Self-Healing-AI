// The Ruhana Voice Memory registry (plan §7, §15).
//
// Split deliberately into two interfaces:
//
//   ReferenceRegistry  — read-only. This is what specialists and candidate
//                        generators see. A candidate cannot redefine the correct
//                        answer to make itself pass (plan §15).
//   MutableRegistry    — write access, held only by the release path after a
//                        repair has passed the gate.
//
// Keeping these apart in the type system is the cheap version of the plan's
// "keep source reference records immutable from the repair agent's perspective".

import type { EntityRecord } from "./model.ts";

export interface ReferenceRegistry {
  get(tenant: string, entityId: string): EntityRecord | null;
  /** All entity records for a tenant, read-only. */
  list(tenant: string): readonly EntityRecord[];
}

export interface MutableRegistry extends ReferenceRegistry {
  /** Records a repair as active for an entity. Reference fields are never touched. */
  recordActiveRepair(tenant: string, entityId: string, repairId: string): void;
  quarantine(tenant: string, entityId: string, reason: string): void;
}

export class InMemoryRegistry implements MutableRegistry {
  private records = new Map<string, EntityRecord>();
  private activeRepairs = new Map<string, string>();
  private quarantineReasons = new Map<string, string>();

  private key(tenant: string, entityId: string): string {
    return tenant + ":" + entityId;
  }

  seed(record: EntityRecord): void {
    this.records.set(this.key(record.tenant, record.entity_id), { ...record });
  }

  get(tenant: string, entityId: string): EntityRecord | null {
    const r = this.records.get(this.key(tenant, entityId));
    // Hand back a copy: callers must not be able to mutate the reference.
    return r ? { ...r, recognition_hints: [...r.recognition_hints], must_not_rewrite: [...r.must_not_rewrite] } : null;
  }

  list(tenant: string): readonly EntityRecord[] {
    return [...this.records.values()]
      .filter((r) => r.tenant === tenant)
      .map((r) => ({ ...r }));
  }

  recordActiveRepair(tenant: string, entityId: string, repairId: string): void {
    this.activeRepairs.set(this.key(tenant, entityId), repairId);
  }

  activeRepairFor(tenant: string, entityId: string): string | null {
    return this.activeRepairs.get(this.key(tenant, entityId)) ?? null;
  }

  quarantine(tenant: string, entityId: string, reason: string): void {
    const k = this.key(tenant, entityId);
    const r = this.records.get(k);
    if (r) r.status = "quarantined";
    this.quarantineReasons.set(k, reason);
  }

  quarantineReason(tenant: string, entityId: string): string | null {
    return this.quarantineReasons.get(this.key(tenant, entityId)) ?? null;
  }
}

/** A read-only façade, so an agent cannot cast its way to the mutable methods. */
export function readOnly(registry: ReferenceRegistry): ReferenceRegistry {
  return {
    get: (t, e) => registry.get(t, e),
    list: (t) => registry.list(t),
  };
}
