import type { PatronusResult } from "./types.js";

/**
 * Canonical list of corporeal Patronus forms.
 * Ordered from most common to rarest.
 */
const PATRONUS_FORMS = [
  "otter",
  "stag",
  "doe",
  "pheasant",
  "tabby cat",
  "fox",
  "wolf",
  "swan",
  "hare",
  "horse",
  "dolphin",
  "dragon",
  "phoenix",
  "lion",
  "eagle",
  "snake",
  "badger",
  "raven",
  "terrier",
  "weasel",
  "cheetah",
  "ostrich",
  "bat",
  "hummingbird",
  "polar bear",
];

const NON_CORPOREAL_FORMS = ["mist", "silver vapour", "wisp", "glimmer"];

/**
 * Deterministically derives a Patronus form from a user id.
 * Uses a simple hash function so repeated casts for the same
 * user always produce the same Patronus.
 */
function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Casts a Patronus charm for the given user.
 * The Patronus form is deterministically derived from the user id.
 * A small percentage (~5%) of users receive non-corporeal Patronuses,
 * also deterministically.
 */
export function castPatronus(
  userId: string,
  charm: string,
): PatronusResult {
  const hash = hashUserId(userId);

  // ~5% chance of non-corporeal Patronus based on hash
  const isCorporeal = (hash % 20) !== 0;
  const formIndex = hash % (isCorporeal ? PATRONUS_FORMS.length : NON_CORPOREAL_FORMS.length);

  const form = isCorporeal
    ? PATRONUS_FORMS[formIndex]
    : NON_CORPOREAL_FORMS[formIndex];

  return {
    form,
    corporeal: isCorporeal,
  };
}
