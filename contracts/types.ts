// Shared contracts between the runtime (Part A) and the Evolve service (Part B).
// Changing anything here requires agreement from both sides.

export interface TranscriptResult {
  text: string;
  model: string;
  confidence?: number;
}

export interface EntityRef {
  entity_id: string;
  /** How the entity appeared in this turn's text. */
  surface: string;
  /** Canonical display spelling from the entity registry, if resolved. */
  canonical_text?: string;
}

export type DeliveryEventType =
  | "passthrough_submitted"
  | "playback_start"
  | "playback_end"
  | "interrupted"
  | "superseded";

export interface DeliveryEvent {
  type: DeliveryEventType;
  /** Milliseconds on the single client clock (plan §3: one client clock for within-browser timing). */
  client_ts: number;
}

/**
 * Contract 1 — Evidence API. Runtime → Evolve, one POST per completed
 * (or superseded) utterance: POST /api/evidence/turn
 */
export interface EvidenceTurn {
  tenant: string;
  session_id: string;
  turn_id: string;
  utterance_id: string;
  /** Effective version snapshot the turn ran under, e.g. "base-1+overlay.3". */
  effective_version: string;
  /** Access-controlled links; raw audio never travels in this payload. */
  mic_audio_url?: string;
  primary_transcript?: TranscriptResult;
  entities: EntityRef[];
  /** What the UI displays. */
  intended_text?: string;
  /** What was actually sent to TTS (phoneme markup included), serialized segments. */
  speech_input?: SpeechSegment[];
  generated_audio_url?: string;
  delivery_events: DeliveryEvent[];
  /** Label of a deliberately seeded fault, or null for organic behavior (plan §12). */
  injected_fault: string | null;
  server_ts: string;
}

export type RepairType = "pronunciation" | "entity_rebinding";

export interface RepairScope {
  tenant: string;
  entity_id: string;
  /** Present for session-scoped repairs; absent means tenant-wide. */
  session_id?: string;
}

export interface PronunciationPayload {
  /** Phoneme string for the scoped entity, in the TTS engine's phoneme alphabet. */
  phonemes: string;
  /** Voice/model version the repair was verified against (plan §7). */
  voice_model_version: string;
}

export interface EntityRebindingPayload {
  entity_id: string;
  canonical_text: string;
}

export interface Repair {
  repair_id: string;
  type: RepairType;
  scope: RepairScope;
  payload: PronunciationPayload | EntityRebindingPayload;
  expires: "session_end" | string;
  predecessor: string | null;
  /**
   * sha256 over the canonical repair body (see contracts/artifact.ts); the
   * runtime verifies it before applying (plan §10). Optional for
   * back-compatibility — an unsigned repair is accepted, a WRONG hash is not.
   */
  artifact_hash?: string;
  /** Overlay version the gate issued this repair at; the hash covers it. */
  issued_overlay_version?: number;
}

/**
 * Contract 2 — Repair API. Runtime ← Evolve:
 * GET /api/session/{session_id}/repairs
 */
export interface RepairOverlay {
  session_id: string;
  overlay_version: number;
  repairs: Repair[];
}

/** A speech-input segment: plain text, or a phoneme-rendered entity. */
export type SpeechSegment =
  | { kind: "text"; text: string }
  | { kind: "phoneme"; display: string; phonemes: string; entity_id: string };
