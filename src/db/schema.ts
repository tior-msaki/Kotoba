/**
 * Storable record types for each IndexedDB table.
 *
 * Domain types that already have an `id` and all necessary fields
 * are re-exported directly. Types that need a cache key, a lookup
 * index, or a wrapping `id` get a dedicated stored record here.
 */

import type { Playlist, SongMeta } from "../domains/playlist/types";
import type {
  AnalysisLine,
  AnalysisStanza,
  SongAnalysis,
} from "../domains/analysis/types";
import type { DictionaryEntry } from "../domains/dictionary/types";
import type { Note } from "../domains/notes/types";
import type {
  QuizSession,
  CurrencyTransaction,
} from "../domains/rewards/types";

// ---------------------------------------------------------------------------
// Dictionary — stored as-is
// ---------------------------------------------------------------------------
export type StoredDictionaryEntry = DictionaryEntry;

// ---------------------------------------------------------------------------
// Notes — stored as-is
// ---------------------------------------------------------------------------
export type StoredNote = Note;

// ---------------------------------------------------------------------------
// Playlist cache — stored as-is (Playlist already has id + fetchedAt)
// ---------------------------------------------------------------------------
export type StoredPlaylist = Playlist;

// ---------------------------------------------------------------------------
// Song cache — SongMeta has no id, so we key by a composite string
// ---------------------------------------------------------------------------
export interface StoredSong {
  /** Deterministic key: `${provider}:${externalId}` */
  id: string;
  song: SongMeta;
  cachedAt: number;
}

// ---------------------------------------------------------------------------
// Analysis caches — analysis types have no id; we key by song reference
// ---------------------------------------------------------------------------

export interface StoredLineAnalysis {
  /** `${songId}:${stanzaNumber}:${lineNumber}` */
  id: string;
  songId: string;
  analysis: AnalysisLine;
  cachedAt: number;
}

export interface StoredStanzaAnalysis {
  /** `${songId}:${stanzaNumber}` */
  id: string;
  songId: string;
  analysis: AnalysisStanza;
  cachedAt: number;
}

export interface StoredSongAnalysis {
  /** Same as the songId */
  id: string;
  songId: string;
  analysis: SongAnalysis;
  cachedAt: number;
}

// ---------------------------------------------------------------------------
// Quiz sessions — stored as-is
// ---------------------------------------------------------------------------
export type StoredQuizSession = QuizSession;

// ---------------------------------------------------------------------------
// Popup quiz history — per-question audit trail for the perpetual-study
// popup. Separate from QuizSession (which is the pack-opening quiz) so
// the two systems evolve independently.
// ---------------------------------------------------------------------------
export interface StoredPopupQuizHistory {
  /** Same as the question id. */
  id: string;
  /** Stable id of the source material (dictionary entry id or line key). */
  sourceId: string;
  /** Question kind label. Indexed for quick "how much of X have I seen" lookups. */
  kind: string;
  answeredAt: number;
  correct: boolean;
  /** Option index the user picked. Retained for UI re-render and debug. */
  selectedOptionIndex: number;
  /** Denormalised reward amount so the history strip can render without
   *  a ledger join. 0 on incorrect. */
  currencyAwarded: number;
}

// ---------------------------------------------------------------------------
// Popup quiz — delivered-but-not-yet-answered questions. This is the
// server-side verification store: a question must come out of this
// table before its answer can be credited. Mutations: insert on
// delivery, delete on submit (or TTL prune). One row per delivered
// question id.
// ---------------------------------------------------------------------------
export interface StoredPopupQuizIssued {
  /** Same as question.id — PK for direct lookup in submit. */
  id: string;
  /** Full question payload, persisted so the caller cannot tamper. */
  question: {
    id: string;
    kind: string;
    prompt: string;
    options: Array<{ text: string; isCorrect: boolean }>;
    correctOptionIndex: number;
    explanation: string;
    source: {
      kind: string;
      id: string;
      surface?: string;
      songTitle?: string;
      artistName?: string;
    };
    createdAt: number;
  };
  issuedAt: number;
}

// ---------------------------------------------------------------------------
// Currency ledger — stored as-is
// ---------------------------------------------------------------------------
export type StoredCurrencyTransaction = CurrencyTransaction;

// ---------------------------------------------------------------------------
// Photocard inventory — flattened for storage with a top-level id
// ---------------------------------------------------------------------------
export interface StoredPhotocardInventoryItem {
  /** Same as photocard.id */
  id: string;
  photocardId: string;
  name: string;
  imageUrl: string;
  rarity: string;
  artist: string;
  quantity: number;
  firstObtainedAt: number;
}
