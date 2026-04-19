/**
 * Popup quiz — frontend integration contract.
 *
 * Thin adapter layer over `popupService.ts`. This is the stable surface
 * the UI team hooks into. No logic lives here — only type-narrowing and
 * composite reads. Answer-key material (`isCorrect`, `correctOptionIndex`,
 * `explanation`) is stripped from the question payload that crosses the
 * contract boundary and is only surfaced in the submit response, so a
 * curious user cannot peek via devtools before answering.
 *
 * ─────────────────────────────────────────────────────────────────────
 * INTEGRATION NOTE (for frontend teammates wiring the popup later)
 * ─────────────────────────────────────────────────────────────────────
 *
 * All popup-quiz traffic flows through the `popupQuiz` namespace on
 *   import { popupQuiz, type PopupQuizQuestionView } from "src/services/app";
 *
 * Convention follows the rest of the codebase: the facade is typed
 * TypeScript functions — no HTTP, no server action, no RPC. The popup
 * UI calls these directly from the React bridge (or an iframe bridge
 * mirroring the dictionary / lyric patterns).
 *
 * Contract:
 *
 *   popupQuiz.getState(): Promise<PopupQuizState>
 *       Lightweight composite read. Safe to call on mount, after answer
 *       submit, and on a short polling loop if desired. Never triggers
 *       an LLM call.
 *
 *   popupQuiz.getNext(options?): Promise<PopupQuizQuestionView | null>
 *       Returns the current outstanding question when one exists, else
 *       generates one. Returns `null` when the user has no study data
 *       to draw from — render the empty state. The returned view has
 *       NO correct-answer signal; only `{ id, kind, prompt, options: [{text}],
 *       source, createdAt }`.
 *
 *   popupQuiz.submit(questionId, selectedOptionIndex): Promise<PopupQuizSubmitResponse>
 *       Server-verified evaluation. Idempotent on question id — safe to
 *       retry after a transient UI failure. Response carries correctness,
 *       the revealed correct option index, the model's explanation,
 *       currencyAwarded (0 when wrong), the new balance, and the new
 *       streak snapshot so the UI can update without a second round-trip.
 *       Throws `StorageError` only when the id is unknown / expired —
 *       that case is recoverable by calling `getNext()` again.
 *
 *   popupQuiz.prefetchNext(): void
 *       Fire-and-forget warm-up. Call on popup mount so the first
 *       question is ready before the user clicks "start". No-op if an
 *       outstanding question already exists. Never throws — errors are
 *       logged in the project's existing style and swallowed.
 *
 *   popupQuiz.recentHistory(limit?): Promise<PopupQuizHistoryEntry[]>
 *       Recent answered questions, newest-first. Useful for a recap
 *       strip or debug UI. No secrets.
 *
 * Everything else on `popupQuiz.*` (e.g. `registerGenerator`,
 * `buildStudyContext`, `finalizeQuestion`, `LEDGER_REASON`) is internal
 * wiring. Frontend should ignore it.
 *
 * Anti-abuse is enforced on the backend side — the frontend cannot
 * double-award currency by re-submitting the same id, cannot tamper
 * with which option is correct (the correct option index lives in the
 * persisted issued row and is never trusted from the caller), and
 * cannot drain the LLM by spamming `getNext()` (rapid calls return the
 * same outstanding question until it's answered).
 * ─────────────────────────────────────────────────────────────────────
 */

import { getBalance } from "../currency/service";
import { GACHA_PULL_COST } from "../currency/service";
import type { CurrencyBalance } from "../types";
import {
  getPopupQuizHistory,
  getPopupQuizStreak,
  requestNextPopupQuestion,
  submitPopupQuizAnswer,
  type RequestNextQuestionOptions,
  type PopupQuizStreak,
} from "./popupService";
import { findLatestUnansweredIssued } from "./popupStorage";
import type {
  PopupQuestionKind,
  PopupQuizHistoryEntry,
  PopupQuizQuestion,
  PopupQuizSourceRef,
} from "./popupTypes";

// ---------------------------------------------------------------------------
// Public shapes — these are what the frontend sees
// ---------------------------------------------------------------------------

/**
 * Sanitised question view handed to the frontend. Matches
 * {@link PopupQuizQuestion} but omits every field that reveals the
 * correct answer. The backend still holds the full question in the
 * `popupQuizIssued` table — the caller supplies only the id + their
 * pick when submitting.
 */
export interface PopupQuizQuestionView {
  id: string;
  kind: PopupQuestionKind;
  prompt: string;
  options: Array<{ text: string }>;
  source: PopupQuizSourceRef;
  createdAt: number;
}

/**
 * Composite lightweight state read for the popup button. Answers
 * questions like "does the user have a question waiting?" and "how
 * close are they to a pack pull?" without triggering any LLM calls.
 */
export interface PopupQuizState {
  balance: CurrencyBalance;
  streak: PopupQuizStreak;
  hasOutstandingQuestion: boolean;
  /** Copy of GACHA_PULL_COST so the UI can render progress toward a pull. */
  gachaPullCost: number;
}

/**
 * Stable submit response. Combines the evaluation result with a fresh
 * balance + streak snapshot so the UI doesn't need a follow-up call.
 */
export interface PopupQuizSubmitResponse {
  correct: boolean;
  correctOptionIndex: number;
  explanation: string;
  currencyAwarded: number;
  /** Balance AFTER the award (or unchanged on incorrect). */
  balance: CurrencyBalance;
  /** Streak AFTER this answer. */
  streak: PopupQuizStreak;
  /** Sanitised question view — same shape the UI got from getNext. */
  question: PopupQuizQuestionView;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function toView(question: PopupQuizQuestion): PopupQuizQuestionView {
  return {
    id: question.id,
    kind: question.kind,
    prompt: question.prompt,
    // NB: drop isCorrect — frontend never sees which option is the
    // correct one until after submit.
    options: question.options.map((o) => ({ text: o.text })),
    source: { ...question.source },
    createdAt: question.createdAt,
  };
}

/**
 * Cheap composite read for the popup button. No LLM call, no question
 * generation — just four Dexie reads in parallel.
 */
export async function getPopupQuizState(): Promise<PopupQuizState> {
  const [balance, streak, outstanding] = await Promise.all([
    getBalance(),
    getPopupQuizStreak(),
    findLatestUnansweredIssued(),
  ]);
  return {
    balance,
    streak,
    hasOutstandingQuestion: outstanding != null,
    gachaPullCost: GACHA_PULL_COST,
  };
}

/**
 * Fetch the next question as a sanitised view. Returns null when the
 * user doesn't have enough study data for the generator (and the local
 * fallback) to build a question — the UI should render an empty state
 * in that case.
 */
export async function getNextPopupQuestion(
  options?: RequestNextQuestionOptions
): Promise<PopupQuizQuestionView | null> {
  const question = await requestNextPopupQuestion(options);
  return question ? toView(question) : null;
}

/**
 * Evaluate an answer against the server-persisted question. Combines
 * the evaluation result with a refreshed balance + streak so the UI
 * can update with one call.
 */
export async function submitPopupAnswerForFrontend(
  questionId: string,
  selectedOptionIndex: number
): Promise<PopupQuizSubmitResponse> {
  const result = await submitPopupQuizAnswer(questionId, selectedOptionIndex);
  const [balance, streak] = await Promise.all([
    getBalance(),
    getPopupQuizStreak(),
  ]);
  return {
    correct: result.correct,
    correctOptionIndex: result.correctOptionIndex,
    explanation: result.explanation,
    currencyAwarded: result.currencyAwarded,
    balance,
    streak,
    question: toView(result.question),
  };
}

/**
 * Best-effort warm-up. Safe to call on popup mount. No-op if an
 * outstanding question already exists (the service layer's own
 * outstanding-question lookup short-circuits the generator). Errors
 * are logged in the project's existing style and swallowed so a
 * warm-up failure never surfaces in the UI.
 */
export function prefetchNextPopupQuestion(): void {
  void requestNextPopupQuestion().catch((err) => {
    console.warn(
      "[popupQuiz] prefetch failed:",
      err instanceof Error ? err.message : String(err)
    );
  });
}

/**
 * Recent answered questions, newest-first. Delegates to the existing
 * history reader; kept here so the frontend's integration surface is
 * in one place.
 */
export async function getPopupQuizRecentHistory(
  limit = 20
): Promise<PopupQuizHistoryEntry[]> {
  return getPopupQuizHistory(limit);
}
