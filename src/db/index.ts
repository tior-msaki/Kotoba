/**
 * Dexie database instance.
 *
 * Single shared instance used by all storage modules.
 */

import Dexie, { type EntityTable } from "dexie";
import type {
  StoredDictionaryEntry,
  StoredNote,
  StoredPlaylist,
  StoredSong,
  StoredLineAnalysis,
  StoredStanzaAnalysis,
  StoredSongAnalysis,
  StoredQuizSession,
  StoredCurrencyTransaction,
  StoredPhotocardInventoryItem,
  StoredPopupQuizHistory,
  StoredPopupQuizIssued,
} from "./schema";

type KotobaDB = Dexie & {
  dictionaryEntries: EntityTable<StoredDictionaryEntry, "id">;
  notes: EntityTable<StoredNote, "id">;
  playlistsCache: EntityTable<StoredPlaylist, "id">;
  songsCache: EntityTable<StoredSong, "id">;
  lineAnalysesCache: EntityTable<StoredLineAnalysis, "id">;
  stanzaAnalysesCache: EntityTable<StoredStanzaAnalysis, "id">;
  songAnalysesCache: EntityTable<StoredSongAnalysis, "id">;
  quizSessions: EntityTable<StoredQuizSession, "id">;
  currencyLedger: EntityTable<StoredCurrencyTransaction, "id">;
  photocardInventory: EntityTable<StoredPhotocardInventoryItem, "id">;
  popupQuizHistory: EntityTable<StoredPopupQuizHistory, "id">;
  popupQuizIssued: EntityTable<StoredPopupQuizIssued, "id">;
};

const db = new Dexie("KotobaDB") as KotobaDB;

db.version(1).stores({
  dictionaryEntries: "id, [surface+romaji], firstLetter, type, updatedAt",
  notes: "id, updatedAt",
  playlistsCache: "id, fetchedAt",
  songsCache: "id",
  lineAnalysesCache: "id, songId",
  stanzaAnalysesCache: "id, songId",
  songAnalysesCache: "id, songId",
  quizSessions: "id, status, startedAt",
  currencyLedger: "id, type, createdAt",
  photocardInventory: "id, photocardId, rarity",
});

// v2: direction-aware dedupe index + language filtering indexes
db.version(2).stores({
  dictionaryEntries: "id, [surface+romaji+direction], firstLetter, type, direction, sourceLanguage, updatedAt",
});

// v3: popup-quiz history. Additive only — every existing table is left
// alone so prior stored data is preserved across the version bump.
db.version(3).stores({
  popupQuizHistory: "id, sourceId, kind, answeredAt, correct",
});

// v4: popup-quiz issued (delivered-but-unanswered) questions. Enables
// server-side answer verification + farming protection. Additive only.
db.version(4).stores({
  popupQuizIssued: "id, issuedAt",
});

export { db };
export type { KotobaDB };
