/**
 * Study Context Builder.
 *
 * Reads live study data out of Dexie (dictionary, line analyses, songs)
 * and composes a recency-sorted `StudyContext` snapshot. Pure reads —
 * never mutates existing tables. Used by the popup quiz service as
 * source material for a future NVIDIA generator.
 */

import { db } from "../../../db";
import type {
  DictionaryDirection,
  DictionaryEntry,
} from "../../dictionary/types";
import type {
  StudyContext,
  StudyDictionaryPick,
  StudyLinePick,
  StudySongPick,
} from "./popupTypes";

export interface BuildStudyContextOptions {
  /** Cap per-bucket (dictionary / lines / songs). Default 12. */
  maxItems?: number;
  /** Optional direction filter — limits dictionary to entries of this direction. */
  direction?: DictionaryDirection;
}

const DEFAULT_MAX = 12;

/**
 * Build a snapshot of the user's recent study activity.
 *
 * Bucket sources:
 *   - Dictionary (recently updated)  → from `dictionaryEntries` sorted by `updatedAt` desc.
 *   - Dictionary (most encountered)  → from `dictionaryEntries` sorted by `encounterCount` desc.
 *   - Line analyses (recently cached) → from `lineAnalysesCache` sorted by `cachedAt` desc.
 *   - Song lookups (recently cached)  → from `songsCache` sorted by `cachedAt` desc.
 *
 * Returns a {@link StudyContext}. Never throws on empty tables — empty
 * buckets just come back as empty arrays, and the caller (future
 * generator) decides how to handle "no study data yet".
 */
export async function buildStudyContext(
  options: BuildStudyContextOptions = {}
): Promise<StudyContext> {
  const max = Math.max(1, options.maxItems ?? DEFAULT_MAX);

  const [recentDictionary, frequentDictionary, recentLines, recentSongs] =
    await Promise.all([
      buildRecentDictionary(max, options.direction),
      buildFrequentDictionary(max, options.direction),
      buildRecentLines(max),
      buildRecentSongs(max),
    ]);

  return {
    recentDictionary,
    frequentDictionary,
    recentLines,
    recentSongs,
    direction: options.direction,
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Bucket builders
// ---------------------------------------------------------------------------

async function buildRecentDictionary(
  max: number,
  direction: DictionaryDirection | undefined
): Promise<StudyDictionaryPick[]> {
  let q = db.dictionaryEntries.orderBy("updatedAt").reverse();
  if (direction) {
    q = q.filter((e: DictionaryEntry) => e.direction === direction);
  }
  const entries = await q.limit(max).toArray();
  return entries.map((entry) => ({ entry, reason: "recently-updated" as const }));
}

async function buildFrequentDictionary(
  max: number,
  direction: DictionaryDirection | undefined
): Promise<StudyDictionaryPick[]> {
  // No dedicated `encounterCount` index — this table is small enough
  // that a full scan + in-memory sort is fine. If it ever grows we can
  // add `encounterCount` to the schema's compound index list; not worth
  // a schema bump today.
  const all = await db.dictionaryEntries.toArray();
  const filtered = direction
    ? all.filter((e) => e.direction === direction)
    : all;
  filtered.sort((a, b) => (b.encounterCount ?? 0) - (a.encounterCount ?? 0));
  return filtered
    .slice(0, max)
    .map((entry) => ({ entry, reason: "frequently-encountered" as const }));
}

async function buildRecentLines(max: number): Promise<StudyLinePick[]> {
  // `lineAnalysesCache` is indexed by `songId`, not by time. The table
  // tends to stay small (lines the user actually clicked translate on),
  // so toArray + sort is acceptable and costs one Dexie round-trip.
  const rows = await db.lineAnalysesCache.toArray();
  rows.sort((a, b) => (b.cachedAt ?? 0) - (a.cachedAt ?? 0));
  return rows.slice(0, max).map((row) => ({
    songId: row.songId,
    analysis: row.analysis,
    cachedAt: row.cachedAt,
  }));
}

async function buildRecentSongs(max: number): Promise<StudySongPick[]> {
  const rows = await db.songsCache.toArray();
  rows.sort((a, b) => (b.cachedAt ?? 0) - (a.cachedAt ?? 0));
  return rows.slice(0, max).map((row) => ({
    id: row.id,
    title: row.song.title,
    artist: row.song.artist,
    provider: row.song.source.provider,
    externalId: row.song.source.externalId,
    cachedAt: row.cachedAt,
  }));
}
