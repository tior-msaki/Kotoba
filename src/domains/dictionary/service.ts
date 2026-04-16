/**
 * Dictionary service — public API for the dictionary domain.
 *
 * Composes repository, search, export, and deduplication.
 * No direct DB access here.
 */

import type {
  DictionaryExport,
  DictionaryDirection,
} from "./types";
import { getAllEntries } from "./repository";
import { now } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Re-export repository (CRUD)
// ---------------------------------------------------------------------------

export {
  createEntry,
  getEntry,
  getAllEntries,
  getEntriesByLetter,
  getEntryCount,
  updateEntry,
  deleteEntry,
  deleteAllEntries,
} from "./repository";

// ---------------------------------------------------------------------------
// Re-export search
// ---------------------------------------------------------------------------

export { searchEntries, searchByLetter } from "./search";

// ---------------------------------------------------------------------------
// Re-export analysis export pipeline
// ---------------------------------------------------------------------------

export { exportWord, exportLine, exportSong } from "./export";

// ---------------------------------------------------------------------------
// Dictionary data export
// ---------------------------------------------------------------------------

export async function exportDictionary(
  direction: DictionaryDirection = "ja-en"
): Promise<DictionaryExport> {
  const entries = await getAllEntries();
  const filtered = entries.filter((e) => e.direction === direction);
  return {
    entries: filtered,
    exportedAt: now(),
    direction,
    totalCount: filtered.length,
  };
}

// ---------------------------------------------------------------------------
// Alphabetical index
// ---------------------------------------------------------------------------

export async function getAvailableLetters(): Promise<string[]> {
  const entries = await getAllEntries();
  const letters = new Set(entries.map((e) => e.firstLetter));
  return [...letters].sort();
}
