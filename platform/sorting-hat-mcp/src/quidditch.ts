import type { QuidditchEvent } from "./types.js";

/**
 * Quidditch Streaming — emits Snitch-shaped progress events
 * while a tool call is in flight. Replaces the default spinner
 * with a golden snitch loader for Gryffindor-sorted tools.
 */

const SNITCH_EVENTS: QuidditchEvent[] = [
  { type: "snitch_sighting", timestamp: 0, message: "Golden Snitch spotted!", progress: 0.1 },
  { type: "goal", timestamp: 1, message: "Goal! 10 points!", progress: 0.25 },
  { type: "bludger", timestamp: 2, message: "Bludger incoming — evasive manoeuvres!", progress: 0.4 },
  { type: "snitch_sighting", timestamp: 3, message: "Snitch is gaining altitude!", progress: 0.55 },
  { type: "goal", timestamp: 4, message: "Another goal! Chasers are on fire!", progress: 0.7 },
  { type: "foul", timestamp: 5, message: "Foul! Penalty shot incoming!", progress: 0.8 },
  { type: "snitch_sighting", timestamp: 6, message: "Snitch is slowing down — Seeker, now!", progress: 0.9 },
  { type: "final", timestamp: 7, message: "Seeker catches the Snitch! Game over!", progress: 1.0 },
];

export interface QuidditchStreamOptions {
  fps?: number;
  onEvent?: (event: QuidditchEvent) => void;
}

/**
 * Simulates a Quidditch match as progress events for a tool call.
 * Designed to be called repeatedly — each call advances the stream.
 */
export function getStreamEvent(
  toolCallId: string,
  elapsedMs: number,
): QuidditchEvent {
  const totalDuration = 8000; // 8 seconds for the full stream
  const progress = Math.min(elapsedMs / totalDuration, 1);
  const eventIndex = Math.min(
    Math.floor(progress * SNITCH_EVENTS.length),
    SNITCH_EVENTS.length - 1,
  );

  return {
    ...SNITCH_EVENTS[eventIndex],
    timestamp: elapsedMs / 1000,
    progress,
  };
}

/**
 * Returns the full set of events for rendering the Snitch loader.
 */
export function getSnitchLoaderEvents(): QuidditchEvent[] {
  return SNITCH_EVENTS;
}
