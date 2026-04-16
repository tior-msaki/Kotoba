/**
 * Dictionary deduplication logic.
 *
 * Deterministic, local-only. No LLM calls.
 * Direction-aware: a Japanese word (ja-en) and an English word (en-ja)
 * with the same surface will not collide.
 */

import { db } from "../../db";
import { now } from "../../lib/utils";
import type {
  DictionaryEntry,
  DedupeKey,
  DedupeDecision,
  ContextMeaning,
} from "./types";
import type { AnalysisKanji } from "../analysis/types";

// ---------------------------------------------------------------------------
// Dedupe check
// ---------------------------------------------------------------------------

/**
 * Check whether an entry with the same surface+romaji+direction already exists.
 * Uses the compound Dexie index for O(1) lookup.
 */
export async function checkDuplicate(key: DedupeKey): Promise<DedupeDecision> {
  const existing = await db.dictionaryEntries
    .where("[surface+romaji+direction]")
    .equals([key.surface, key.romaji, key.direction])
    .first();

  if (!existing) {
    return { action: "insert" };
  }
  return { action: "merge", existingId: existing.id };
}

// ---------------------------------------------------------------------------
// Meaning comparison
// ---------------------------------------------------------------------------

export function meaningDiffers(stored: string, incoming: string): boolean {
  return stored.toLowerCase().trim() !== incoming.toLowerCase().trim();
}

function hasContextMeaning(
  existing: ContextMeaning[],
  incoming: ContextMeaning
): boolean {
  return existing.some(
    (c) => c.songTitle === incoming.songTitle && c.line === incoming.line
  );
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Summarize the main definition from all context meanings + the original.
 * Deterministic: dedupes meanings, joins unique ones with "; ".
 */
export function summarizeMeaning(
  originalMeaning: string,
  contextMeanings: ContextMeaning[]
): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  const normalized = originalMeaning.toLowerCase().trim();
  if (normalized.length > 0) {
    seen.add(normalized);
    parts.push(originalMeaning.trim());
  }

  for (const ctx of contextMeanings) {
    const norm = ctx.meaning.toLowerCase().trim();
    if (norm.length > 0 && !seen.has(norm)) {
      seen.add(norm);
      parts.push(ctx.meaning.trim());
    }
  }

  return parts.join("; ");
}

/** Merge kanji lists. Deduplicates by character. Incoming replaces existing. */
export function mergeKanjiLists(
  existing: AnalysisKanji[],
  incoming: AnalysisKanji[]
): AnalysisKanji[] {
  const byChar = new Map<string, AnalysisKanji>();
  for (const k of existing) byChar.set(k.character, k);
  for (const k of incoming) byChar.set(k.character, k);
  return [...byChar.values()];
}

/**
 * Produce a merged entry from an existing entry and new incoming data.
 * Always returns an updated entry (at minimum, encounterCount is bumped).
 */
export function mergeEntry(
  existing: DictionaryEntry,
  incoming: {
    meaningInContext: string;
    contextMeaning?: ContextMeaning;
    kanjiList?: AnalysisKanji[];
  }
): DictionaryEntry {
  const merged = { ...existing };
  merged.encounterCount = existing.encounterCount + 1;
  merged.updatedAt = now();

  // Add context meaning if new
  if (incoming.contextMeaning) {
    if (!hasContextMeaning(existing.contextMeanings, incoming.contextMeaning)) {
      merged.contextMeanings = [
        ...existing.contextMeanings,
        incoming.contextMeaning,
      ];
    }
  }

  // Re-summarize meaning if the incoming one materially differs
  if (meaningDiffers(existing.meaning, incoming.meaningInContext)) {
    merged.meaning = summarizeMeaning(existing.meaning, merged.contextMeanings);
  }

  // Merge kanji lists (only relevant for Japanese entries)
  if (incoming.kanjiList && incoming.kanjiList.length > 0) {
    merged.kanjiList = mergeKanjiLists(existing.kanjiList, incoming.kanjiList);
  }

  return merged;
}
