/**
 * Dictionary search.
 *
 * Local, instant search across all searchable fields.
 * Results are ranked: exact match > startsWith > includes.
 * Supports optional filtering by language/direction.
 */

import { db } from "../../db";
import { normalize, scoreField, scoreArray } from "../../lib/search";
import type { DictionaryEntry, DictionarySearchResult, SearchFilter } from "./types";

function scoreEntry(entry: DictionaryEntry, query: string): number {
  const scores = [
    scoreField(entry.surface, query) * 1.0,
    scoreField(entry.meaning, query) * 0.9,
    scoreArray(entry.contextMeanings.map((c) => c.meaning), query) * 0.7,
    scoreArray(entry.tags, query) * 0.65,
    scoreField(entry.sourceTrackName, query) * 0.6,
    scoreField(entry.artistName, query) * 0.6,
    scoreArray(entry.contextMeanings.map((c) => c.songTitle), query) * 0.55,
    scoreField(entry.notes, query) * 0.5,
  ];

  if (entry.romaji.length > 0) {
    scores.push(scoreField(entry.romaji, query) * 0.95);
  }
  if (entry.reading.length > 0) {
    scores.push(scoreField(entry.reading, query) * 0.93);
  }

  return Math.max(...scores);
}

function matchesFilter(entry: DictionaryEntry, filter: SearchFilter): boolean {
  if (filter.sourceLanguage && entry.sourceLanguage !== filter.sourceLanguage) return false;
  if (filter.targetLanguage && entry.targetLanguage !== filter.targetLanguage) return false;
  if (filter.direction && entry.direction !== filter.direction) return false;
  return true;
}

function scoreAndRank(
  entries: DictionaryEntry[],
  query: string,
  limit: number,
  filter?: SearchFilter
): DictionarySearchResult[] {
  const results: DictionarySearchResult[] = [];
  for (const entry of entries) {
    if (filter && !matchesFilter(entry, filter)) continue;
    const score = scoreEntry(entry, query);
    if (score > 0) results.push({ entry, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export async function searchEntries(
  query: string,
  limit = 50,
  filter?: SearchFilter
): Promise<DictionarySearchResult[]> {
  const q = normalize(query);
  if (q.length === 0) return [];
  const entries = await db.dictionaryEntries.toArray();
  return scoreAndRank(entries, q, limit, filter);
}

export async function searchByLetter(
  letter: string,
  query: string,
  limit = 50,
  filter?: SearchFilter
): Promise<DictionarySearchResult[]> {
  const q = normalize(query);
  if (q.length === 0) return [];
  const entries = await db.dictionaryEntries
    .where("firstLetter")
    .equals(letter.toLowerCase())
    .toArray();
  return scoreAndRank(entries, q, limit, filter);
}
