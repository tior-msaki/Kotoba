/**
 * Popup quiz — service boundary.
 *
 * Glues together:
 *   - study context (src/domains/rewards/quiz/studyContext.ts)
 *   - a registered question generator (NVIDIA impl in popupGenerator.ts)
 *   - popup persistence (popupStorage.ts)
 *   - existing currency earn path (src/domains/rewards/currency/service.ts)
 *
 * The frontend popup (built by the UI team separately) will only talk
 * to this module via the `popupQuiz` namespace on `services/app.ts`.
 * No function here calls into translation, playlist, CD, dictionary
 * mutations, or persistent memory — strictly read-only against those.
 */

import { db } from "../../../db";
import { generateId, now } from "../../../lib/utils";
import { StorageError } from "../../../lib/errors";
import {
  getHistory as getCurrencyHistory,
  QUIZ_CORRECT_REWARD,
} from "../currency/service";
import type {
  StoredCurrencyTransaction,
  StoredPopupQuizHistory,
} from "../../../db/schema";
import { generateQuestions } from "./generator";
import { buildStudyContext, type BuildStudyContextOptions } from "./studyContext";
import {
  findLatestUnansweredIssued,
  getIssuedQuestion,
  getRecentHistory,
  getRecentSourceIds,
  pruneStaleIssued,
  saveIssuedQuestion,
} from "./popupStorage";
import type {
  PopupQuestionKind,
  PopupQuizAnswerResult,
  PopupQuizGenerator,
  PopupQuizGeneratorOptions,
  PopupQuizHistoryEntry,
  PopupQuizOption,
  PopupQuizQuestion,
  StudyContext,
} from "./popupTypes";
import type { CurrencyTransaction } from "../types";
import type { DictionaryDirection } from "../../dictionary/types";

// ---------------------------------------------------------------------------
// Study context — exposed directly for the future generator + debugging
// ---------------------------------------------------------------------------

export { buildStudyContext } from "./studyContext";
export type { BuildStudyContextOptions } from "./studyContext";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Ledger reason for popup-quiz rewards. Separate from the pre-existing
 * "quiz_correct" used by the pack-opening QuizSession so the two
 * systems can be summarised independently without touching the old
 * flow's ledger rows.
 */
export const POPUP_QUIZ_LEDGER_REASON = "popup_quiz_correct";

// ---------------------------------------------------------------------------
// Generator registry
// ---------------------------------------------------------------------------

let registeredGenerator: PopupQuizGenerator | null = null;

export function registerPopupQuizGenerator(
  generator: PopupQuizGenerator | null
): void {
  registeredGenerator = generator;
}

export function getRegisteredPopupQuizGenerator(): PopupQuizGenerator | null {
  return registeredGenerator;
}

// ---------------------------------------------------------------------------
// Fallback generator — reuses the existing local dictionary-driven quiz
// generator so the popup works end-to-end even if no generator has been
// registered yet (or the NVIDIA generator throws an un-recoverable error
// and its own internal fallback also declined to produce a question).
// ---------------------------------------------------------------------------

const fallbackGenerator: PopupQuizGenerator = {
  async generate(
    context: StudyContext,
    options?: PopupQuizGeneratorOptions
  ): Promise<PopupQuizQuestion | null> {
    const excluded = new Set(options?.excludeSourceIds ?? []);
    const pool = new Map<string, (typeof context.recentDictionary)[number]>();
    for (const pick of context.recentDictionary) pool.set(pick.entry.id, pick);
    for (const pick of context.frequentDictionary) {
      if (!pool.has(pick.entry.id)) pool.set(pick.entry.id, pick);
    }
    const entries = [...pool.values()]
      .map((p) => p.entry)
      .filter((e) => !excluded.has(e.id));

    const [q] = generateQuestions(entries, 1);
    if (!q) return null;

    const correctOptionIndex = q.options.findIndex((o) => o.isCorrect);
    if (correctOptionIndex < 0) return null;

    const sourceEntry = entries.find((e) => e.id === q.dictionaryEntryId);
    return {
      id: q.id,
      kind:
        q.questionType === "meaning"
          ? "word-meaning"
          : q.questionType === "reading"
            ? "word-reading"
            : "reverse-meaning",
      prompt: q.prompt,
      options: q.options.map((o): PopupQuizOption => ({
        text: o.text,
        isCorrect: o.isCorrect,
      })),
      correctOptionIndex,
      explanation: "",
      source: {
        kind: "dictionaryEntry",
        id: q.dictionaryEntryId,
        surface: sourceEntry?.surface,
        songTitle: sourceEntry?.sourceTrackName,
        artistName: sourceEntry?.artistName,
      },
      createdAt: now(),
    };
  },
};

// ---------------------------------------------------------------------------
// Public service surface — the frontend popup calls these
// ---------------------------------------------------------------------------

export interface RequestNextQuestionOptions {
  direction?: DictionaryDirection;
  /** How many prior answered source ids to avoid on this request. Default 20. */
  excludeRecent?: number;
  /** Override for the study-context bucket size. */
  studyContext?: BuildStudyContextOptions;
  /**
   * Force a new question even if an unanswered one is outstanding.
   * Normal UX leaves this false so rapid re-renders don't burn LLM
   * calls and so a closed/re-opened popup re-shows the same question.
   */
  force?: boolean;
}

/**
 * Build a fresh popup question from the user's live study context, OR
 * return the most-recent unanswered question when one exists (so the
 * popup is stable across re-renders and rapid opens). Returns null
 * when the user doesn't have enough study data yet. The returned
 * question is persisted — its `id` is the handle the caller must pass
 * back to {@link submitPopupQuizAnswer}.
 */
export async function requestNextPopupQuestion(
  options: RequestNextQuestionOptions = {}
): Promise<PopupQuizQuestion | null> {
  // Clean up any abandoned issued rows before the outstanding-question
  // lookup so stale items can't pin the popup on an obsolete prompt.
  await pruneStaleIssued();

  if (!options.force) {
    const outstanding = await findLatestUnansweredIssued();
    if (outstanding) return outstanding;
  }

  const generator = registeredGenerator ?? fallbackGenerator;
  const context = await buildStudyContext({
    ...(options.studyContext ?? {}),
    direction: options.direction ?? options.studyContext?.direction,
  });
  const recent = await getRecentSourceIds(options.excludeRecent ?? 20);
  const question = await generator.generate(context, {
    direction: options.direction,
    excludeSourceIds: [...recent],
  });

  if (!question) {
    // Generator + its internal fallbacks all declined. Try the
    // service-level dictionary fallback as a final safety net so the
    // UI always gets something renderable when there's at least some
    // study data in Dexie.
    const last = await fallbackGenerator.generate(context, {
      direction: options.direction,
      excludeSourceIds: [...recent],
    });
    if (!last) return null;
    await saveIssuedQuestion(last);
    return last;
  }

  await saveIssuedQuestion(question);
  return question;
}

/**
 * Submit an answer for a previously-delivered question.
 *
 * Server-verified: the correct answer comes from the persisted question
 * payload, not the caller. Idempotent per question id — calling this a
 * second time for the same id returns the stored result and does NOT
 * re-award currency. Throws {@link StorageError} if the id is unknown
 * (expired TTL, never issued, or already consumed).
 *
 * The entire read-and-mutate sequence runs inside a single Dexie
 * transaction covering popupQuizHistory + popupQuizIssued +
 * currencyLedger so simultaneous duplicate submits of the same id
 * cannot both evaluate and award — Dexie serialises the transactions,
 * and the second caller observes the first's history row and returns
 * the cached result without re-awarding.
 */
export async function submitPopupQuizAnswer(
  questionId: string,
  selectedOptionIndex: number
): Promise<PopupQuizAnswerResult> {
  if (typeof questionId !== "string" || questionId.length === 0) {
    throw new StorageError("popupQuiz: questionId required");
  }

  return db.transaction(
    "rw",
    [db.popupQuizHistory, db.popupQuizIssued, db.currencyLedger],
    async () => {
      // Idempotency gate — if we already recorded a result for this id,
      // reuse it so re-submits (retries, double-clicks, concurrent
      // debounced clicks) don't re-pay.
      const prior = await db.popupQuizHistory.get(questionId);
      if (prior) {
        // The issued row has almost certainly been deleted by the
        // original consuming transaction, so we synthesise a minimal
        // question echo from the history row for the UI's convenience.
        const priorQuestion = await getIssuedQuestion(questionId);
        return {
          correct: prior.correct,
          correctOptionIndex: priorQuestion?.correctOptionIndex ?? -1,
          explanation: priorQuestion?.explanation ?? "",
          question: priorQuestion ?? synthesizePriorQuestion(prior),
          currencyAwarded: prior.currencyAwarded,
        } satisfies PopupQuizAnswerResult;
      }

      // Identity verification — the caller must be submitting an id
      // that this engine actually issued. Arbitrary payloads refused.
      const issued = await getIssuedQuestion(questionId);
      if (!issued) {
        throw new StorageError(
          `popupQuiz: unknown or expired question id "${questionId}"`
        );
      }

      const chosen = issued.options[selectedOptionIndex];
      const correct =
        selectedOptionIndex === issued.correctOptionIndex &&
        Boolean(chosen?.isCorrect);

      let currencyAwarded = 0;
      if (correct) {
        // Inline ledger write so there's no ambiguity about Dexie
        // transaction-zone binding across module boundaries. Uses the
        // same reason string as the earlier earn() call so downstream
        // balance / history queries see identical rows.
        const ledgerRow: StoredCurrencyTransaction = {
          id: generateId(),
          type: "earn",
          amount: QUIZ_CORRECT_REWARD,
          reason: POPUP_QUIZ_LEDGER_REASON,
          createdAt: now(),
        };
        await db.currencyLedger.add(ledgerRow);
        currencyAwarded = QUIZ_CORRECT_REWARD;
      }

      // Record history inside the transaction so concurrent callers
      // see this row as soon as the transaction commits. Denormalised
      // fields let the UI render without a ledger join.
      const historyRow: StoredPopupQuizHistory = {
        id: issued.id,
        sourceId: issued.source.id,
        kind: issued.kind,
        answeredAt: now(),
        correct,
        selectedOptionIndex,
        currencyAwarded,
      };
      await db.popupQuizHistory.put(historyRow);

      // Drop the issued row once consumed so the id can't be
      // resubmitted for credit if the history row is ever cleared
      // manually (defence in depth; the history idempotency gate above
      // is the primary guard).
      await db.popupQuizIssued.delete(questionId);

      return {
        correct,
        correctOptionIndex: issued.correctOptionIndex,
        explanation: issued.explanation,
        question: issued,
        currencyAwarded,
      } satisfies PopupQuizAnswerResult;
    }
  );
}

/**
 * Read the popup-quiz history for the UI's recent-activity strip.
 */
export async function getPopupQuizHistory(
  limit = 20
): Promise<PopupQuizHistoryEntry[]> {
  return getRecentHistory(limit);
}

// ---------------------------------------------------------------------------
// Streak + recent rewards — both derived, no extra storage.
// ---------------------------------------------------------------------------

export interface PopupQuizStreak {
  /** Current unbroken streak of correct answers (resets on a wrong one). */
  current: number;
  /** Longest streak in the recent history window. */
  best: number;
  /** Total correct in the recent history window. */
  totalCorrect: number;
  /** Total incorrect in the recent history window. */
  totalIncorrect: number;
}

/**
 * Derive streak info from `popupQuizHistory`. Informational only — does
 * NOT affect reward payout. Payout stays deterministic per the spec.
 */
export async function getPopupQuizStreak(
  window = 50
): Promise<PopupQuizStreak> {
  const rows = await getRecentHistory(window);
  // rows are newest-first.
  let current = 0;
  for (const row of rows) {
    if (row.correct) current++;
    else break;
  }
  let totalCorrect = 0;
  let totalIncorrect = 0;
  // Best streak: walk chronologically (oldest → newest) so we count
  // consecutive `correct: true` runs within the window.
  let running = 0;
  let best = 0;
  const chronological = [...rows].reverse();
  for (const row of chronological) {
    if (row.correct) {
      totalCorrect++;
      running++;
      if (running > best) best = running;
    } else {
      totalIncorrect++;
      running = 0;
    }
  }
  if (current > best) best = current;
  return { current, best, totalCorrect, totalIncorrect };
}

/**
 * Recent popup-quiz reward ledger entries — useful for the UI's
 * "+1 coin" ticker. Reads the shared `currencyLedger` filtered by the
 * popup-specific reason so existing pack-quiz rewards never appear
 * here and existing callers of `getHistory` are unaffected.
 */
export async function getPopupQuizRecentRewards(
  limit = 20
): Promise<CurrencyTransaction[]> {
  // The ledger is small; fetch a generous slice and filter client-side
  // rather than adding a schema index just for this view.
  const rows = await getCurrencyHistory(Math.max(limit * 4, 80));
  return rows
    .filter((r) => r.type === "earn" && r.reason === POPUP_QUIZ_LEDGER_REASON)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Finalize helper — used by the NVIDIA generator + fallback so id /
// createdAt / correctOptionIndex assignment lives in one place.
// ---------------------------------------------------------------------------

export function finalizePopupQuestion(
  partial: Omit<PopupQuizQuestion, "id" | "createdAt" | "correctOptionIndex"> & {
    correctOptionIndex?: number;
  }
): PopupQuizQuestion {
  const correctOptionIndex =
    typeof partial.correctOptionIndex === "number"
      ? partial.correctOptionIndex
      : partial.options.findIndex((o) => o.isCorrect);
  return {
    ...partial,
    id: generateId(),
    correctOptionIndex,
    createdAt: now(),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal question echo when re-submits arrive after the
 * issued row was cleaned up. The shape lets the UI render a "you
 * already answered this" state without re-fetching the full question.
 */
function synthesizePriorQuestion(record: {
  id: string;
  kind: string;
  sourceId: string;
  answeredAt: number;
}): PopupQuizQuestion {
  return {
    id: record.id,
    kind: record.kind as PopupQuestionKind,
    prompt: "",
    options: [],
    correctOptionIndex: -1,
    explanation: "",
    source: {
      kind: "dictionaryEntry",
      id: record.sourceId,
    },
    createdAt: record.answeredAt,
  };
}
