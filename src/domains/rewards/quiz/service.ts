/**
 * Quiz session management.
 *
 * Handles session lifecycle: start, answer, advance, complete.
 * Persists sessions to IndexedDB for resume support.
 */

import { db } from "../../../db";
import { generateId, now } from "../../../lib/utils";
import { StorageError } from "../../../lib/errors";
import type { QuizSession, QuizQuestion } from "../types";
import { generateQuestions } from "./generator";
import type { DictionaryEntry } from "../../dictionary/types";

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a new quiz session from dictionary entries.
 * Returns null if there aren't enough entries for a quiz.
 */
export async function startSession(
  entries: DictionaryEntry[],
  questionCount = 10
): Promise<QuizSession | null> {
  const questions = generateQuestions(entries, questionCount);
  if (questions.length === 0) return null;

  const session: QuizSession = {
    id: generateId(),
    questions,
    currentIndex: 0,
    answers: {},
    correctCount: 0,
    status: "in-progress",
    startedAt: now(),
  };

  await db.quizSessions.add(session);
  return session;
}

/**
 * Get an existing session by ID.
 */
export async function getSession(
  id: string
): Promise<QuizSession | undefined> {
  return db.quizSessions.get(id);
}

/**
 * Get the current question in a session.
 * Returns undefined if the session is completed or not found.
 */
export async function getCurrentQuestion(
  sessionId: string
): Promise<QuizQuestion | undefined> {
  const session = await db.quizSessions.get(sessionId);
  if (!session || session.status === "completed") return undefined;
  return session.questions[session.currentIndex];
}

// ---------------------------------------------------------------------------
// Answer evaluation
// ---------------------------------------------------------------------------

export interface AnswerResult {
  correct: boolean;
  correctOptionIndex: number;
  /** Question that was just answered (useful for wrong-answer lookup UI). */
  question: QuizQuestion;
  /** Whether the session is now complete (no more questions). */
  sessionComplete: boolean;
  session: QuizSession;
}

/**
 * Submit an answer for the current question.
 * Advances to the next question or completes the session.
 */
export async function submitAnswer(
  sessionId: string,
  selectedOptionIndex: number
): Promise<AnswerResult> {
  const session = await db.quizSessions.get(sessionId);
  if (!session) {
    throw new StorageError(`Quiz session not found: ${sessionId}`);
  }
  if (session.status === "completed") {
    throw new StorageError(`Quiz session already completed: ${sessionId}`);
  }

  const question = session.questions[session.currentIndex];
  const correctOptionIndex = question.options.findIndex((o) => o.isCorrect);
  const correct = selectedOptionIndex === correctOptionIndex;

  // Update session state
  const updated: QuizSession = {
    ...session,
    answers: {
      ...session.answers,
      [question.id]: selectedOptionIndex,
    },
    correctCount: correct ? session.correctCount + 1 : session.correctCount,
    currentIndex: session.currentIndex + 1,
  };

  // Check if session is complete
  const sessionComplete = updated.currentIndex >= updated.questions.length;
  if (sessionComplete) {
    updated.status = "completed";
    updated.completedAt = now();
  }

  await db.quizSessions.put(updated);

  return {
    correct,
    correctOptionIndex,
    question,
    sessionComplete,
    session: updated,
  };
}

// ---------------------------------------------------------------------------
// Session queries
// ---------------------------------------------------------------------------

/**
 * Get all in-progress sessions.
 */
export async function getActiveSessions(): Promise<QuizSession[]> {
  return db.quizSessions.where("status").equals("in-progress").toArray();
}

/**
 * Get completed sessions, most recent first.
 */
export async function getCompletedSessions(
  limit = 20
): Promise<QuizSession[]> {
  return db.quizSessions
    .where("status")
    .equals("completed")
    .reverse()
    .sortBy("startedAt")
    .then((sessions) => sessions.slice(0, limit));
}

/**
 * Delete a session.
 */
export async function deleteSession(id: string): Promise<void> {
  await db.quizSessions.delete(id);
}
