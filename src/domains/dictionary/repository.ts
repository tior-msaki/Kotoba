/**
 * Dictionary repository — data access only.
 *
 * CRUD operations against db.dictionaryEntries.
 * No business logic, no search, no dedup, no export.
 */

import { db } from "../../db";
import { generateId, now, firstLetter } from "../../lib/utils";
import { StorageError } from "../../lib/errors";
import type {
  DictionaryEntry,
  DictionaryDirection,
  DictionaryLanguage,
  CreateDictionaryEntryInput,
  UpdateDictionaryEntryInput,
} from "./types";

function deriveLanguages(direction: DictionaryDirection): {
  sourceLanguage: DictionaryLanguage;
  targetLanguage: DictionaryLanguage;
} {
  return direction === "ja-en"
    ? { sourceLanguage: "ja", targetLanguage: "en" }
    : { sourceLanguage: "en", targetLanguage: "ja" };
}

function deriveFirstLetter(romaji: string, surface: string): string {
  if (romaji.length > 0) return firstLetter(romaji);
  return surface.charAt(0).toLowerCase();
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createEntry(
  input: CreateDictionaryEntryInput
): Promise<DictionaryEntry> {
  const timestamp = now();
  const direction = input.direction ?? "ja-en";
  const romaji = input.romaji ?? "";
  const langs = deriveLanguages(direction);

  const entry: DictionaryEntry = {
    id: generateId(),
    surface: input.surface,
    normalizedTerm: input.surface.toLowerCase(),
    reading: input.reading ?? "",
    romaji,
    firstLetter: deriveFirstLetter(romaji, input.surface),
    type: input.type,
    meaning: input.meaning,
    contextMeanings: input.contextMeaning ? [input.contextMeaning] : [],
    kanjiList: input.kanjiList ?? [],
    encounterCount: 1,
    exampleSentence: input.exampleSentence ?? "",
    exampleTranslation: input.exampleTranslation ?? "",
    notes: input.notes ?? "",
    tags: input.tags ?? [],
    sourceTrackId: input.sourceTrackId ?? "",
    sourceTrackName: input.sourceTrackName ?? "",
    artistName: input.artistName ?? "",
    sourceLanguage: langs.sourceLanguage,
    targetLanguage: langs.targetLanguage,
    direction,
    sourceLyricLanguage: langs.sourceLanguage,
    learningLanguage: langs.sourceLanguage,
    aiExplanationCached: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await db.dictionaryEntries.add(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getEntry(
  id: string
): Promise<DictionaryEntry | undefined> {
  return db.dictionaryEntries.get(id);
}

export async function getAllEntries(): Promise<DictionaryEntry[]> {
  return db.dictionaryEntries.orderBy("updatedAt").reverse().toArray();
}

export async function getEntriesByLetter(
  letter: string
): Promise<DictionaryEntry[]> {
  return db.dictionaryEntries
    .where("firstLetter")
    .equals(letter.toLowerCase())
    .toArray();
}

export async function getEntryCount(): Promise<number> {
  return db.dictionaryEntries.count();
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateEntry(
  id: string,
  input: UpdateDictionaryEntryInput
): Promise<DictionaryEntry> {
  const existing = await db.dictionaryEntries.get(id);
  if (!existing) {
    throw new StorageError(`Dictionary entry not found: ${id}`);
  }

  const updated: DictionaryEntry = { ...existing, updatedAt: now() };
  if (input.meaning !== undefined) updated.meaning = input.meaning;
  if (input.contextMeaning) {
    updated.contextMeanings = [...updated.contextMeanings, input.contextMeaning];
  }
  if (input.kanjiList !== undefined) updated.kanjiList = input.kanjiList;
  if (input.exampleSentence !== undefined) updated.exampleSentence = input.exampleSentence;
  if (input.exampleTranslation !== undefined) updated.exampleTranslation = input.exampleTranslation;
  if (input.notes !== undefined) updated.notes = input.notes;
  if (input.tags !== undefined) updated.tags = input.tags;
  if (input.aiExplanationCached !== undefined) updated.aiExplanationCached = input.aiExplanationCached;

  await db.dictionaryEntries.put(updated);
  return updated;
}

/** Full replace. Used by deduplication merge logic. */
export async function putEntry(entry: DictionaryEntry): Promise<void> {
  await db.dictionaryEntries.put(entry);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteEntry(id: string): Promise<void> {
  await db.dictionaryEntries.delete(id);
}

export async function deleteAllEntries(): Promise<void> {
  await db.dictionaryEntries.clear();
}
