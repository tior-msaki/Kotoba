/**
 * Quiz question generator.
 *
 * Builds multiple-choice questions from dictionary entries.
 * Each question tests one of: meaning, reading, or kanji recognition.
 */

import type { DictionaryEntry } from "../../dictionary/types";
import type { QuizQuestion, QuizOption, QuizQuestionType } from "../types";
import { generateId } from "../../../lib/utils";

const OPTIONS_PER_QUESTION = 4;

// ---------------------------------------------------------------------------
// Randomness — isolated for testability
// ---------------------------------------------------------------------------

export type RngFn = () => number;

let rng: RngFn = Math.random;

/** Override the RNG for deterministic testing. */
export function setRng(fn: RngFn): void {
  rng = fn;
}

export function resetRng(): void {
  rng = Math.random;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickRandom<T>(arr: T[], count: number): T[] {
  return shuffle(arr).slice(0, count);
}

// ---------------------------------------------------------------------------
// Question builders
// ---------------------------------------------------------------------------

/**
 * "What does [surface] mean?"
 * Prompt: Japanese word. Correct answer: English meaning.
 */
function buildMeaningQuestion(
  target: DictionaryEntry,
  distractors: DictionaryEntry[]
): QuizQuestion {
  const wrongOptions = pickRandom(distractors, OPTIONS_PER_QUESTION - 1).map(
    (d): QuizOption => ({ text: d.meaning, isCorrect: false })
  );
  const correctOption: QuizOption = {
    text: target.meaning,
    isCorrect: true,
  };
  return {
    id: generateId(),
    prompt: target.surface,
    questionType: "meaning",
    options: shuffle([correctOption, ...wrongOptions]),
    dictionaryEntryId: target.id,
  };
}

/**
 * "How do you read [surface]?"
 * Prompt: Japanese word. Correct answer: romaji reading.
 */
function buildReadingQuestion(
  target: DictionaryEntry,
  distractors: DictionaryEntry[]
): QuizQuestion {
  const wrongOptions = pickRandom(distractors, OPTIONS_PER_QUESTION - 1).map(
    (d): QuizOption => ({ text: d.romaji, isCorrect: false })
  );
  const correctOption: QuizOption = {
    text: target.romaji,
    isCorrect: true,
  };
  return {
    id: generateId(),
    prompt: target.surface,
    questionType: "reading",
    options: shuffle([correctOption, ...wrongOptions]),
    dictionaryEntryId: target.id,
  };
}

/**
 * "Which word means [meaning]?"
 * Prompt: English meaning. Correct answer: Japanese word.
 */
function buildKanjiQuestion(
  target: DictionaryEntry,
  distractors: DictionaryEntry[]
): QuizQuestion {
  const wrongOptions = pickRandom(distractors, OPTIONS_PER_QUESTION - 1).map(
    (d): QuizOption => ({ text: d.surface, isCorrect: false })
  );
  const correctOption: QuizOption = {
    text: target.surface,
    isCorrect: true,
  };
  return {
    id: generateId(),
    prompt: target.meaning,
    questionType: "kanji",
    options: shuffle([correctOption, ...wrongOptions]),
    dictionaryEntryId: target.id,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const QUESTION_TYPES: QuizQuestionType[] = ["meaning", "reading", "kanji"];

/**
 * Generate quiz questions from a set of dictionary entries.
 * Requires at least OPTIONS_PER_QUESTION entries to build valid questions.
 * Returns an empty array if there aren't enough entries.
 */
export function generateQuestions(
  entries: DictionaryEntry[],
  count: number
): QuizQuestion[] {
  if (entries.length < OPTIONS_PER_QUESTION) return [];

  const selected = pickRandom(entries, count);
  const questions: QuizQuestion[] = [];

  for (const target of selected) {
    const distractors = entries.filter((e) => e.id !== target.id);
    const questionType =
      QUESTION_TYPES[Math.floor(rng() * QUESTION_TYPES.length)];

    switch (questionType) {
      case "meaning":
        questions.push(buildMeaningQuestion(target, distractors));
        break;
      case "reading":
        questions.push(buildReadingQuestion(target, distractors));
        break;
      case "kanji":
        questions.push(buildKanjiQuestion(target, distractors));
        break;
    }
  }

  return questions;
}
