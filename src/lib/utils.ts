/**
 * Shared utility functions used across all domains.
 */

export function generateId(): string {
  return crypto.randomUUID();
}

export function now(): number {
  return Date.now();
}

/**
 * Extracts the first character of a romaji string, lowercased.
 * Used as an index key for dictionary grouping.
 */
export function firstLetter(romaji: string): string {
  return romaji.charAt(0).toLowerCase();
}
