/**
 * Rewards service — unified public API.
 *
 * Only functions that wire across sub-domains live here.
 * Everything else is re-exported directly from quiz/currency/gacha.
 */

import type { CurrencyBalance } from "./types";
import {
  startSession,
  submitAnswer,
  getActiveSessions,
  getCompletedSessions,
} from "./quiz/service";
import type { AnswerResult } from "./quiz/service";
import { earnFromQuiz, getBalance } from "./currency/service";
import { getCollectionProgress } from "./gacha/service";
import type { DictionaryEntry } from "../dictionary/types";

// ---------------------------------------------------------------------------
// Quiz — with currency wiring
// ---------------------------------------------------------------------------

export { startSession as startQuiz };

/**
 * Submit a quiz answer. If correct, automatically awards 1 currency.
 */
export async function submitQuizAnswer(
  sessionId: string,
  selectedOptionIndex: number
): Promise<AnswerResult & { currencyAwarded: number }> {
  const result = await submitAnswer(sessionId, selectedOptionIndex);
  let currencyAwarded = 0;
  if (result.correct) {
    await earnFromQuiz();
    currencyAwarded = 1;
  }
  return { ...result, currencyAwarded };
}

/**
 * Perpetual quiz helper:
 * - Submit answer
 * - Award currency on correct
 * - If this question ended the session, immediately create a new one
 *   from the same dictionary pool so the user can keep going until they exit.
 */
export async function submitQuizAnswerAndContinue(
  sessionId: string,
  selectedOptionIndex: number,
  dictionaryEntries: DictionaryEntry[],
  questionCount = 10
): Promise<
  (AnswerResult & {
    currencyAwarded: number;
    lookupOnWrong?: { dictionaryEntryId: string; prompt: string };
  }) & { nextSessionId?: string }
> {
  const result = await submitAnswer(sessionId, selectedOptionIndex);
  let currencyAwarded = 0;
  if (result.correct) {
    await earnFromQuiz();
    currencyAwarded = 1;
  }

  let nextSessionId: string | undefined;
  if (result.sessionComplete) {
    const next = await startSession(dictionaryEntries, questionCount);
    nextSessionId = next?.id;
  }

  return {
    ...result,
    currencyAwarded,
    nextSessionId,
    lookupOnWrong: result.correct
      ? undefined
      : {
          dictionaryEntryId: result.question.dictionaryEntryId,
          prompt: result.question.prompt,
        },
  };
}

// ---------------------------------------------------------------------------
// Re-exports — no wrapping needed
// ---------------------------------------------------------------------------

export {
  getSession,
  getCurrentQuestion,
  getActiveSessions,
  getCompletedSessions,
  deleteSession,
} from "./quiz/service";
export type { AnswerResult } from "./quiz/service";

export {
  getBalance,
  getHistory,
  earn,
  GACHA_PULL_COST,
} from "./currency/service";

export {
  pull as gachaPull,
  pullMulti as gachaPullMulti,
  getInventory,
  getInventoryByRarity,
  getCollectionProgress,
} from "./gacha/service";

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

export interface RewardsSummary {
  balance: CurrencyBalance;
  activeQuizzes: number;
  completedQuizzes: number;
  collectionProgress: { owned: number; total: number };
}

export async function getRewardsSummary(): Promise<RewardsSummary> {
  const [balance, active, completed, collection] = await Promise.all([
    getBalance(),
    getActiveSessions(),
    getCompletedSessions(0),
    getCollectionProgress(),
  ]);
  return {
    balance,
    activeQuizzes: active.length,
    completedQuizzes: completed.length,
    collectionProgress: collection,
  };
}
