/**
 * Analysis-to-dictionary export pipeline.
 *
 * Takes analysis results (words and kanji from lines/stanzas/songs)
 * and upserts them into the dictionary with deduplication.
 * Supports both Japanese and English source songs.
 */

import type { AnalysisWord, AnalysisLine, SongAnalysis } from "../analysis/types";
import type {
  DictionaryEntry,
  CreateDictionaryEntryInput,
  ContextMeaning,
  DictionaryDirection,
} from "./types";
import { checkDuplicate, mergeEntry } from "./deduplication";
import { createEntry, getEntry, putEntry } from "./repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportContext {
  songTitle: string;
  artistName: string;
  sourceTrackId?: string;
  direction?: DictionaryDirection;
}

export interface ExportResult {
  inserted: number;
  updated: number;
  skipped: number;
  entries: DictionaryEntry[];
}

/** Outcome of a single word export. */
export interface WordExportOutcome {
  action: "inserted" | "updated" | "skipped";
  entry: DictionaryEntry | null;
}

// ---------------------------------------------------------------------------
// Single word export
// ---------------------------------------------------------------------------

export async function exportWord(
  word: AnalysisWord,
  lineText: string,
  lineTranslation: string,
  context: ExportContext
): Promise<WordExportOutcome> {
  const direction = context.direction ?? "ja-en";

  const contextMeaning: ContextMeaning = {
    meaning: word.meaningInContext,
    songTitle: context.songTitle,
    artistName: context.artistName,
    line: lineText,
  };

  const decision = await checkDuplicate({
    surface: word.surface,
    romaji: word.romaji,
    direction,
  });

  if (decision.action === "insert") {
    const input: CreateDictionaryEntryInput = {
      surface: word.surface,
      romaji: word.romaji,
      type: word.type,
      meaning: word.meaningInContext,
      contextMeaning,
      kanjiList: word.kanjiList,
      exampleSentence: lineText,
      exampleTranslation: lineTranslation,
      sourceTrackId: context.sourceTrackId,
      sourceTrackName: context.songTitle,
      artistName: context.artistName,
      direction,
    };
    const entry = await createEntry(input);
    return { action: "inserted", entry };
  }

  // Merge with existing
  const existing = await getEntry(decision.existingId);
  if (!existing) return { action: "skipped", entry: null };

  const merged = mergeEntry(existing, {
    meaningInContext: word.meaningInContext,
    contextMeaning,
    kanjiList: word.kanjiList,
  });

  await putEntry(merged);
  return { action: "updated", entry: merged };
}

// ---------------------------------------------------------------------------
// Line export
// ---------------------------------------------------------------------------

export async function exportLine(
  line: AnalysisLine,
  context: ExportContext
): Promise<ExportResult> {
  const result: ExportResult = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    entries: [],
  };

  for (const word of line.words) {
    const outcome = await exportWord(
      word,
      line.japanese,
      line.culturalTranslation,
      context
    );

    if (outcome.entry) {
      result[outcome.action as "inserted" | "updated"]++;
      result.entries.push(outcome.entry);
    } else {
      result.skipped++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Full song export
// ---------------------------------------------------------------------------

export async function exportSong(
  analysis: SongAnalysis,
  context?: Partial<ExportContext>
): Promise<ExportResult> {
  const fullContext: ExportContext = {
    songTitle: analysis.songTitle,
    artistName: analysis.artistName,
    sourceTrackId: context?.sourceTrackId,
    direction: context?.direction,
  };

  const totals: ExportResult = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    entries: [],
  };

  for (const stanza of analysis.stanzas) {
    for (const line of stanza.lines) {
      const lineResult = await exportLine(line, fullContext);
      totals.inserted += lineResult.inserted;
      totals.updated += lineResult.updated;
      totals.skipped += lineResult.skipped;
      totals.entries.push(...lineResult.entries);
    }
  }

  return totals;
}
