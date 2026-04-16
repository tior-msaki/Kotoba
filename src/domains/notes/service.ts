/**
 * Notes service — public API for the notes domain.
 *
 * CRUD with blank-note handling + search.
 */

import { db } from "../../db";
import { generateId, now } from "../../lib/utils";
import { StorageError } from "../../lib/errors";
import { normalize, scoreField } from "../../lib/search";
import type { Note, CreateNoteInput, UpdateNoteInput } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBlank(note: Note): boolean {
  return (
    note.title.trim().length === 0 &&
    note.subtitle.trim().length === 0 &&
    note.body.trim().length === 0
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Create a note. Returns null if the input is entirely blank. */
export async function addNote(input: CreateNoteInput): Promise<Note | null> {
  const title = input.title.trim();
  const subtitle = (input.subtitle ?? "").trim();
  const body = (input.body ?? "").trim();

  if (title.length === 0 && subtitle.length === 0 && body.length === 0) {
    return null;
  }

  const timestamp = now();
  const note: Note = {
    id: generateId(),
    title,
    subtitle,
    body,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await db.notes.add(note);
  return note;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getNote(id: string): Promise<Note | undefined> {
  return db.notes.get(id);
}

export async function listNotes(): Promise<Note[]> {
  return db.notes.orderBy("updatedAt").reverse().toArray();
}

export async function getNoteCount(): Promise<number> {
  return db.notes.count();
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** Update a note. If the result is blank, deletes it and returns null. */
export async function editNote(
  id: string,
  input: UpdateNoteInput
): Promise<Note | null> {
  const existing = await db.notes.get(id);
  if (!existing) {
    throw new StorageError(`Note not found: ${id}`);
  }

  const updated: Note = { ...existing, updatedAt: now() };
  if (input.title !== undefined) updated.title = input.title;
  if (input.subtitle !== undefined) updated.subtitle = input.subtitle;
  if (input.body !== undefined) updated.body = input.body;

  if (isBlank(updated)) {
    await db.notes.delete(id);
    return null;
  }

  await db.notes.put(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteNote(id: string): Promise<void> {
  await db.notes.delete(id);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface NoteSearchResult {
  note: Note;
  score: number;
}

export async function searchNotes(
  query: string,
  limit = 50
): Promise<NoteSearchResult[]> {
  const q = normalize(query);
  if (q.length === 0) return [];

  const allNotes = await db.notes.toArray();
  const results: NoteSearchResult[] = [];

  for (const note of allNotes) {
    const score = Math.max(
      scoreField(note.title, q) * 1.0,
      scoreField(note.subtitle, q) * 0.8,
      scoreField(note.body, q) * 0.6
    );
    if (score > 0) results.push({ note, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
