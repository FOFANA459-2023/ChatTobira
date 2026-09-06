"use client";

/** Where a spoken turn's time actually goes, measured on the student's side.
 *
 * The server already logs its own half (`lib/timing.ts`), and that half is
 * blind to most of a spoken turn. It cannot see how long the microphone waited
 * for the student to stop talking, how long Whisper took, or the gap between
 * the answer being written and the first syllable being heard — and those
 * three are the majority of the silence a student actually sits through.
 * Optimising the half you can see is how a turn ends up "fast" on the server
 * and slow in the room.
 *
 * One line per turn, in the browser console, same shape as the server's so the
 * two read together. Nothing is sent anywhere: this is instrumentation for
 * whoever is developing the app, not telemetry about students.
 */

export type VoiceStage =
  /** Microphone open until the endpointer decided the student had finished. */
  | "capture"
  /** Upload plus Whisper. */
  | "stt"
  /** The chat request, until the first token of the answer arrives. */
  | "llm_first_token"
  /** First token to the last. */
  | "llm_generation"
  /** Answer complete until the first audio actually plays. */
  | "tts_first_audio";

export interface VoiceTurnMetrics {
  stages: Partial<Record<VoiceStage, number>>;
  /** Microphone open to first audio out. `capture` is the part of it the
   * student spent talking, which is not latency — subtract it to get the
   * silence they actually sat through waiting for a reply. */
  total: number;
}

/** The turn being measured. One at a time, because one student speaks at a
 * time; a turn abandoned half way is simply overwritten by the next. */
let current: { started: number; last: number; stages: Partial<Record<VoiceStage, number>> } | null =
  null;

/** The microphone opened. The turn is timed from here so the endpointer's own
 * delay — the 1.1 seconds of silence it waits for before deciding the student
 * has finished — is inside the measurement rather than invisible beside it. */
export function beginVoiceTurn(): void {
  const now = Date.now();
  current = { started: now, last: now, stages: {} };
}

/** Record the time since the previous stage ended. */
export function markVoiceStage(stage: VoiceStage): void {
  if (!current) return;
  const now = Date.now();
  current.stages[stage] = now - current.last;
  current.last = now;
}

/** Close the turn and report it. Returns the metrics so a test — or a future
 * on-screen debug panel — can read them without scraping the console. */
export function endVoiceTurn(label = "voice turn"): VoiceTurnMetrics | null {
  if (!current) return null;
  const metrics: VoiceTurnMetrics = {
    stages: current.stages,
    total: Date.now() - current.started,
  };
  current = null;

  if (typeof console !== "undefined") {
    const slowest = Object.entries(metrics.stages).sort(([, a], [, b]) => b - a);
    console.info(
      `${label} total=${metrics.total}ms ${slowest
        .map(([stage, ms]) => `${stage}=${ms}ms`)
        .join(" ")}`,
    );
  }
  return metrics;
}

/** Test seam — no production caller. */
export function resetVoiceMetrics(): void {
  current = null;
}
