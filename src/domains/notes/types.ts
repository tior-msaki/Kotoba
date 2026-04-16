/**
 * Notes domain types.
 *
 * Plain text notes with title, subtitle, and timestamps.
 */

export interface Note {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** Input for creating a new note. */
export interface CreateNoteInput {
  title: string;
  subtitle?: string;
  body?: string;
}

/** Input for updating an existing note. All fields optional. */
export interface UpdateNoteInput {
  title?: string;
  subtitle?: string;
  body?: string;
}
