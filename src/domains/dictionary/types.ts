/**
 * Dictionary domain types.
 *
 * Supports bilingual entries:
 *   - Japanese songs → learn Japanese from English (ja-en)
 *   - English songs → learn English from Japanese (en-ja)
 *
 * Japanese-specific enrichment (kanji, romaji, reading) is optional.
 */

import type { AnalysisKanji, WordType } from "../analysis/types";

export type DictionaryLanguage = "ja" | "en";
export type DictionaryDirection = "ja-en" | "en-ja";

/** A persisted dictionary entry. */
export interface DictionaryEntry {
  id: string;
  /** The word/expression in the source language. */
  surface: string;
  /** Lowercase surface for consistent search/sort. */
  normalizedTerm: string;
  /** Hiragana reading. Japanese entries only, empty for English. */
  reading: string;
  /** Romaji transliteration. Japanese entries only, empty for English. */
  romaji: string;
  /** First character for alphabetical grouping. */
  firstLetter: string;
  /** Part of speech. */
  type: WordType;
  /** Primary translation in the target language. */
  meaning: string;
  /** Context-specific meanings collected from different songs. */
  contextMeanings: ContextMeaning[];
  /** Kanji data. Japanese entries only, empty array for English. */
  kanjiList: AnalysisKanji[];
  /** Number of times this word has been encountered across analyses. */
  encounterCount: number;
  /** Example sentence from a song lyric. */
  exampleSentence: string;
  /** Translation of the example sentence. */
  exampleTranslation: string;
  /** Free-form user notes. */
  notes: string;
  /** User-defined tags for grouping/filtering. */
  tags: string[];
  /** Provider track ID where this word was first encountered. */
  sourceTrackId: string;
  /** Track name where this word was first encountered. */
  sourceTrackName: string;
  /** Artist name where this word was first encountered. */
  artistName: string;
  /** Language of the word being learned. */
  sourceLanguage: DictionaryLanguage;
  /** Language of the translation. */
  targetLanguage: DictionaryLanguage;
  /** Translation direction shorthand. */
  direction: DictionaryDirection;
  /** Language of the song lyrics this word came from. */
  sourceLyricLanguage: DictionaryLanguage;
  /** What the user is learning (= sourceLanguage). */
  learningLanguage: DictionaryLanguage;
  /** Cached AI explanation. null if not yet fetched. */
  aiExplanationCached: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A meaning encountered in a specific song context. */
export interface ContextMeaning {
  meaning: string;
  songTitle: string;
  artistName: string;
  line: string;
}

/** Input for creating a new dictionary entry. */
export interface CreateDictionaryEntryInput {
  surface: string;
  reading?: string;
  romaji?: string;
  type: WordType;
  meaning: string;
  contextMeaning?: ContextMeaning;
  kanjiList?: AnalysisKanji[];
  exampleSentence?: string;
  exampleTranslation?: string;
  notes?: string;
  tags?: string[];
  sourceTrackId?: string;
  sourceTrackName?: string;
  artistName?: string;
  direction?: DictionaryDirection;
}

/** Input for updating an existing dictionary entry. */
export interface UpdateDictionaryEntryInput {
  meaning?: string;
  contextMeaning?: ContextMeaning;
  kanjiList?: AnalysisKanji[];
  exampleSentence?: string;
  exampleTranslation?: string;
  notes?: string;
  tags?: string[];
  aiExplanationCached?: string | null;
}

/** Canonical key used for deduplication. */
export interface DedupeKey {
  surface: string;
  romaji: string;
  direction: DictionaryDirection;
}

/** Result of a duplicate check before insertion. */
export type DedupeDecision =
  | { action: "insert" }
  | { action: "merge"; existingId: string };

/** Optional filters for search. */
export interface SearchFilter {
  sourceLanguage?: DictionaryLanguage;
  targetLanguage?: DictionaryLanguage;
  direction?: DictionaryDirection;
}

/** A dictionary entry with a relevance score from search. */
export interface DictionarySearchResult {
  entry: DictionaryEntry;
  /** 0–1 relevance score. */
  score: number;
}

/** Exported dictionary data for external use. */
export interface DictionaryExport {
  entries: DictionaryEntry[];
  exportedAt: number;
  direction: DictionaryDirection;
  totalCount: number;
}
