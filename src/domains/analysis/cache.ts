/**
 * Analysis cache layer.
 *
 * Thin read/write against the three analysis cache tables.
 * Cache keys are deterministic composites of songId + position numbers.
 */

import { db } from "../../db";
import { now } from "../../lib/utils";
import type { AnalysisLine, AnalysisStanza, SongAnalysis } from "./types";
import type {
  StoredLineAnalysis,
  StoredStanzaAnalysis,
  StoredSongAnalysis,
} from "../../db/schema";

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

export function lineCacheKey(
  songId: string,
  stanzaNumber: number,
  lineNumber: number
): string {
  return `${songId}:${stanzaNumber}:${lineNumber}`;
}

export function stanzaCacheKey(
  songId: string,
  stanzaNumber: number
): string {
  return `${songId}:${stanzaNumber}`;
}

export function songCacheKey(songId: string): string {
  return songId;
}

// ---------------------------------------------------------------------------
// Line cache
// ---------------------------------------------------------------------------

export async function getCachedLine(
  songId: string,
  stanzaNumber: number,
  lineNumber: number
): Promise<AnalysisLine | undefined> {
  const key = lineCacheKey(songId, stanzaNumber, lineNumber);
  const stored = await db.lineAnalysesCache.get(key);
  return stored?.analysis;
}

export async function cacheLine(
  songId: string,
  analysis: AnalysisLine
): Promise<void> {
  const key = lineCacheKey(songId, analysis.stanzaNumber, analysis.lineNumber);
  const record: StoredLineAnalysis = {
    id: key,
    songId,
    analysis,
    cachedAt: now(),
  };
  await db.lineAnalysesCache.put(record);
}

/** Fetch every cached line for a song, in stanza/line order. Used by
 *  the lyric-overlay rehydration path so a returning user sees all of
 *  their prior per-line analyses without re-hitting the model. */
export async function getCachedLinesForSong(
  songId: string
): Promise<AnalysisLine[]> {
  const rows = await db.lineAnalysesCache
    .where("songId")
    .equals(songId)
    .toArray();
  return rows
    .map((r) => r.analysis)
    .sort((a, b) => {
      if (a.stanzaNumber !== b.stanzaNumber) {
        return a.stanzaNumber - b.stanzaNumber;
      }
      return a.lineNumber - b.lineNumber;
    });
}

// ---------------------------------------------------------------------------
// Stanza cache
// ---------------------------------------------------------------------------

export async function getCachedStanza(
  songId: string,
  stanzaNumber: number
): Promise<AnalysisStanza | undefined> {
  const key = stanzaCacheKey(songId, stanzaNumber);
  const stored = await db.stanzaAnalysesCache.get(key);
  return stored?.analysis;
}

export async function cacheStanza(
  songId: string,
  analysis: AnalysisStanza
): Promise<void> {
  const key = stanzaCacheKey(songId, analysis.stanzaNumber);
  const record: StoredStanzaAnalysis = {
    id: key,
    songId,
    analysis,
    cachedAt: now(),
  };
  await db.stanzaAnalysesCache.put(record);
}

// ---------------------------------------------------------------------------
// Song cache
// ---------------------------------------------------------------------------

export async function getCachedSong(
  songId: string
): Promise<SongAnalysis | undefined> {
  const key = songCacheKey(songId);
  const stored = await db.songAnalysesCache.get(key);
  return stored?.analysis;
}

export async function cacheSongAnalysis(
  songId: string,
  analysis: SongAnalysis
): Promise<void> {
  const key = songCacheKey(songId);
  const record: StoredSongAnalysis = {
    id: key,
    songId,
    analysis,
    cachedAt: now(),
  };
  await db.songAnalysesCache.put(record);
}

// ---------------------------------------------------------------------------
// Bulk cache helpers
// ---------------------------------------------------------------------------

/** Cache all lines from a stanza analysis in one batch. */
export async function cacheStanzaLines(
  songId: string,
  stanza: AnalysisStanza
): Promise<void> {
  const records: StoredLineAnalysis[] = stanza.lines.map((line) => ({
    id: lineCacheKey(songId, stanza.stanzaNumber, line.lineNumber),
    songId,
    analysis: line,
    cachedAt: now(),
  }));
  await db.lineAnalysesCache.bulkPut(records);
}

/** Cache all stanzas (and their lines) from a full song analysis. */
export async function cacheSongStanzas(
  songId: string,
  analysis: SongAnalysis
): Promise<void> {
  const stanzaRecords: StoredStanzaAnalysis[] = [];
  const lineRecords: StoredLineAnalysis[] = [];
  const timestamp = now();

  for (const stanza of analysis.stanzas) {
    stanzaRecords.push({
      id: stanzaCacheKey(songId, stanza.stanzaNumber),
      songId,
      analysis: stanza,
      cachedAt: timestamp,
    });
    for (const line of stanza.lines) {
      lineRecords.push({
        id: lineCacheKey(songId, stanza.stanzaNumber, line.lineNumber),
        songId,
        analysis: line,
        cachedAt: timestamp,
      });
    }
  }

  await Promise.all([
    db.stanzaAnalysesCache.bulkPut(stanzaRecords),
    db.lineAnalysesCache.bulkPut(lineRecords),
  ]);
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

/** Clear all cached analyses for a given song. */
export async function evictSongCache(songId: string): Promise<void> {
  const [lineKeys, stanzaKeys, songKeys] = await Promise.all([
    db.lineAnalysesCache.where("songId").equals(songId).primaryKeys(),
    db.stanzaAnalysesCache.where("songId").equals(songId).primaryKeys(),
    db.songAnalysesCache.where("songId").equals(songId).primaryKeys(),
  ]);
  await Promise.all([
    db.lineAnalysesCache.bulkDelete(lineKeys),
    db.stanzaAnalysesCache.bulkDelete(stanzaKeys),
    db.songAnalysesCache.bulkDelete(songKeys),
  ]);
}
