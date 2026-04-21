/**
 * Popup quiz — persistence layer.
 *
 * Owns the new `popupQuizHistory` Dexie table. Every function here is
 * a single-table read/write; no cross-table transactions. Keeps the
 * popup quiz self-contained so the existing `QuizSession` tables and
 * currency ledger are never touched by this surface.
 */

import { db } from "../../../db";
import type {
  StoredPopupQuizHistory,
  StoredPopupQuizIssued,
} from "../../../db/schema";
import type {
  PopupQuestionKind,
  PopupQuizHistoryEntry,
  PopupQuizQuestion,
} from "./popupTypes";

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record an answered question. Idempotent on `id`: re-recording the same
 * question id overwrites the prior entry (useful if the UI resubmits).
 */
export async function recordAnsweredQuestion(
  question: PopupQuizQuestion,
  correct: boolean,
  selectedOptionIndex: number,
  currencyAwarded: number,
  answeredAt: number = Date.now()
): Promise<PopupQuizHistoryEntry> {
  const record: StoredPopupQuizHistory = {
    id: question.id,
    sourceId: question.source.id,
    kind: question.kind,
    answeredAt,
    correct,
    selectedOptionIndex,
    currencyAwarded,
  };
  await db.popupQuizHistory.put(record);
  return toHistoryEntry(record);
}

/**
 * Return the stored history row for a question id (if any). Used by the
 * submit-answer path to enforce one-reward-per-question idempotency.
 */
export async function getAnsweredRecord(
  questionId: string
): Promise<StoredPopupQuizHistory | undefined> {
  return db.popupQuizHistory.get(questionId);
}

/**
 * Drop one history entry. Exists so the UI can let the user clear a
 * specific question, and so tests don't need to wipe the whole table.
 */
export async function deleteHistoryEntry(id: string): Promise<void> {
  await db.popupQuizHistory.delete(id);
}

/**
 * Clear all popup-quiz history. Called by the settings Erase-All path
 * via the existing dynamic-store-clear logic — this function is here
 * so callers that need targeted cleanup (tests, debug tooling) don't
 * have to enumerate tables themselves.
 */
export async function clearAllHistory(): Promise<void> {
  await db.popupQuizHistory.clear();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Most-recent N history entries, newest first.
 */
export async function getRecentHistory(
  limit = 20
): Promise<PopupQuizHistoryEntry[]> {
  const rows = await db.popupQuizHistory
    .orderBy("answeredAt")
    .reverse()
    .limit(limit)
    .toArray();
  return rows.map(toHistoryEntry);
}

/**
 * Source ids recently answered — used by the generator-seam anti-repeat
 * logic to avoid immediately re-asking the same word/line.
 */
export async function getRecentSourceIds(limit = 20): Promise<Set<string>> {
  const rows = await db.popupQuizHistory
    .orderBy("answeredAt")
    .reverse()
    .limit(limit)
    .toArray();
  return new Set(rows.map((r) => r.sourceId));
}

/**
 * Count how many times a given source has been answered. Useful for
 * future prioritisation ("show me words I've answered wrong recently").
 * Left here so the next iteration doesn't need another schema touch.
 */
export async function getHistoryCountBySource(
  sourceId: string
): Promise<number> {
  return db.popupQuizHistory.where("sourceId").equals(sourceId).count();
}

/**
 * History by question kind — used by future UI surfaces that want to
 * show per-kind accuracy. Not exposed in this prompt's facade yet.
 */
export async function getHistoryByKind(
  kind: PopupQuestionKind,
  limit = 50
): Promise<PopupQuizHistoryEntry[]> {
  const rows = await db.popupQuizHistory
    .where("kind")
    .equals(kind)
    .reverse()
    .sortBy("answeredAt");
  return rows.slice(0, limit).map(toHistoryEntry);
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function toHistoryEntry(row: StoredPopupQuizHistory): PopupQuizHistoryEntry {
  return {
    id: row.id,
    kind: row.kind as PopupQuestionKind,
    sourceId: row.sourceId,
    answeredAt: row.answeredAt,
    correct: row.correct,
  };
}

// ---------------------------------------------------------------------------
// Issued-question store — delivered-but-unanswered. Used by the engine
// to (a) verify answer submissions against the server-persisted question
// payload, and (b) dedupe rapid requestNext calls so one LLM call
// produces at most one outstanding question.
// ---------------------------------------------------------------------------

/** TTL for stale unanswered issued questions, in ms. */
const ISSUED_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function saveIssuedQuestion(
  question: PopupQuizQuestion,
  issuedAt: number = Date.now()
): Promise<void> {
  const record: StoredPopupQuizIssued = {
    id: question.id,
    question: {
      id: question.id,
      kind: question.kind,
      prompt: question.prompt,
      options: question.options.map((o) => ({
        text: o.text,
        isCorrect: o.isCorrect,
      })),
      correctOptionIndex: question.correctOptionIndex,
      explanation: question.explanation,
      source: {
        kind: question.source.kind,
        id: question.source.id,
        surface: question.source.surface,
        songTitle: question.source.songTitle,
        artistName: question.source.artistName,
      },
      createdAt: question.createdAt,
    },
    issuedAt,
  };
  await db.popupQuizIssued.put(record);
}

export async function getIssuedQuestion(
  questionId: string
): Promise<PopupQuizQuestion | undefined> {
  const row = await db.popupQuizIssued.get(questionId);
  if (!row) return undefined;
  return toPopupQuestion(row);
}

export async function deleteIssuedQuestion(questionId: string): Promise<void> {
  await db.popupQuizIssued.delete(questionId);
}

/**
 * Find the most-recently-issued question that has NOT been answered yet
 * (i.e. still present in popupQuizIssued) and is newer than the TTL.
 * Lets `requestNextPopupQuestion` return a stable outstanding question
 * across rapid re-renders instead of burning a fresh LLM call each time.
 */
export async function findLatestUnansweredIssued(): Promise<
  PopupQuizQuestion | undefined
> {
  const cutoff = Date.now() - ISSUED_TTL_MS;
  const rows = await db.popupQuizIssued
    .where("issuedAt")
    .above(cutoff)
    .reverse()
    .sortBy("issuedAt");
  const row = rows[0];
  return row ? toPopupQuestion(row) : undefined;
}

/**
 * Evict issued rows older than the TTL. Called opportunistically on
 * each requestNext so unanswered piles can't grow unbounded.
 */
export async function pruneStaleIssued(): Promise<void> {
  const cutoff = Date.now() - ISSUED_TTL_MS;
  const staleKeys = await db.popupQuizIssued
    .where("issuedAt")
    .below(cutoff)
    .primaryKeys();
  if (staleKeys.length > 0) {
    await db.popupQuizIssued.bulkDelete(staleKeys);
  }
}

function toPopupQuestion(row: StoredPopupQuizIssued): PopupQuizQuestion {
  const q = row.question;
  return {
    id: q.id,
    kind: q.kind as PopupQuestionKind,
    prompt: q.prompt,
    options: q.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
    correctOptionIndex: q.correctOptionIndex,
    explanation: q.explanation,
    source: {
      kind: q.source.kind as PopupQuizQuestion["source"]["kind"],
      id: q.source.id,
      surface: q.source.surface,
      songTitle: q.source.songTitle,
      artistName: q.source.artistName,
    },
    createdAt: q.createdAt,
  };
}
