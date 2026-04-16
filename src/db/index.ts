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

export { db };
export type { KotobaDB };
