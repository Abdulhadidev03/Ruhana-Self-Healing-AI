// Labelled failure injection (plan §12): the demo seeds a fault in which the
// pronunciation adapter DROPS the pronunciation override for a target entity.
// The fault is explicit and labelled in the evidence — never a silent edit —
// so the incident, wrong audio, and measured repair are all real.

import type { Repair } from "../../contracts/types.ts";

export interface InjectedFault {
  label: string;
  targetEntityId: string;
}

export class FailureInjector {
  private fault: InjectedFault | null = null;

  arm(targetEntityId: string): InjectedFault {
    this.fault = { label: "seeded-pronunciation-drop", targetEntityId };
    return this.fault;
  }

  disarm(): void {
    this.fault = null;
  }

  activeFault(): InjectedFault | null {
    return this.fault;
  }

  /** Applied to the repair list BEFORE speech-input building. */
  filterRepairs(repairs: readonly Repair[]): Repair[] {
    if (!this.fault) return [...repairs];
    const target = this.fault.targetEntityId;
    return repairs.filter(
      (r) => !(r.type === "pronunciation" && r.scope.entity_id === target),
    );
  }
}
