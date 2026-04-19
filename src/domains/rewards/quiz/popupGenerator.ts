/**
 * Popup quiz — NVIDIA-backed question generator.
 *
 * Reuses the existing `callNvidiaStructured` transport (same-origin
 * proxy at `/api/nvidia/chat`), so the NVIDIA API key stays on the
 * server. The generator:
 *
 *   1. Picks ONE real study item from the supplied StudyContext
 *      (respecting `excludeSourceIds`) — never lets the model freely
 *      choose what to quiz on, which eliminates the usual
 *      "generated a question for a word the user doesn't have" bug.
 *   2. Builds a prompt carrying the candidate's full payload plus a
 *      distractor pool drawn from the user's other saved words.
 *   3. Asks NVIDIA for a single structured question.
 *   4. Validates the response against a strict allow-list.
 *   5. Retries once on malformed output.
 *   6. Falls back to the local dictionary-only generator on NVIDIA
 *      failure so the UI always gets something renderable when study
 *      data is sufficient.
 *
 * Returned questions are always stamped through `finalizePopupQuestion`
 * so their id + createdAt fields match the rest of the popup pipeline.
 *
 * This file has NO side effects at import — registration into the
 * popup-quiz registry happens from `src/services/app.ts` at facade load
 * time so the generator is available to every consumer of the facade.
 */

import { callNvidiaStructured } from "../../../lib/nvidia";
import { AnalysisError } from "../../../lib/errors";
import type { DictionaryEntry } from "../../dictionary/types";
import { generateQuestions } from "./generator";
import { finalizePopupQuestion } from "./popupService";
import type {
  PopupQuestionKind,
  PopupQuizGenerator,
  PopupQuizGeneratorOptions,
  PopupQuizOption,
  PopupQuizQuestion,
  PopupQuizSourceRef,
  StudyContext,
  StudyDictionaryPick,
  StudyLinePick,
} from "./popupTypes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_KINDS: readonly PopupQuestionKind[] = [
  "word-meaning",
  "word-reading",
  "line-meaning",
  "fill-blank",
  "reverse-meaning",
];

const ALLOWED_SOURCE_KINDS: readonly PopupQuizSourceRef["kind"][] = [
  "dictionaryEntry",
  "lineAnalysis",
  "songAnalysis",
];

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const EXPLANATION_SOFT_CAP = 240;

// Cap on distractor payload sent to the model — enough for variety,
// small enough to keep token cost predictable.
const MAX_DISTRACTORS_IN_PROMPT = 12;

// ---------------------------------------------------------------------------
// Raw LLM response shape (matches the JSON schema below)
// ---------------------------------------------------------------------------

interface RawPopupQuizResponse {
  kind?: unknown;
  prompt?: unknown;
  options?: unknown;
  explanation?: unknown;
  source?: unknown;
}

// ---------------------------------------------------------------------------
// JSON schema contract (embedded in the user message by the middleware).
// Shape mirrors the analysis-domain contracts — keeps provider hints we
// already know work well (`nullable` off, explicit `required`).
// ---------------------------------------------------------------------------

const POPUP_QUIZ_CONTRACT = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ALLOWED_KINDS as unknown as string[],
      description:
        "Question kind — must be one of the listed values. Choose the kind that best fits the candidate study item provided.",
    },
    prompt: {
      type: "string",
      description:
        "The question prompt the user sees. Short and specific. For fill-blank, include the blank marker ___.",
    },
    options: {
      type: "array",
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "Answer option text." },
          isCorrect: {
            type: "boolean",
            description:
              "True for exactly one option — the single correct answer.",
          },
        },
        required: ["text", "isCorrect"],
      },
      description:
        "Multiple-choice options. Between 2 and 6 entries. Exactly one must have isCorrect: true. Wrong-answer texts must come from the supplied distractor pool — do not invent.",
    },
    explanation: {
      type: "string",
      description:
        "One to two sentences explaining why the correct answer is correct. No markdown.",
    },
    source: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ALLOWED_SOURCE_KINDS as unknown as string[],
        },
        id: {
          type: "string",
          description:
            "Stable id of the candidate study item. MUST equal the candidate id supplied in the prompt.",
        },
        surface: { type: "string" },
        songTitle: { type: "string" },
        artistName: { type: "string" },
      },
      required: ["kind", "id"],
    },
  },
  required: ["kind", "prompt", "options", "explanation", "source"],
} as const;

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

type DictionaryCandidate = {
  kind: "dictionaryEntry";
  entry: DictionaryEntry;
  reason: StudyDictionaryPick["reason"];
};

type LineCandidate = {
  kind: "lineAnalysis";
  pick: StudyLinePick;
  /** Stable id for this candidate — `${songId}:${stanza}:${line}`. */
  id: string;
};

type Candidate = DictionaryCandidate | LineCandidate;

function lineCandidateId(pick: StudyLinePick): string {
  return `${pick.songId}:${pick.analysis.stanzaNumber}:${pick.analysis.lineNumber}`;
}

/**
 * Order of preference:
 *   1. Recently updated dictionary entries
 *   2. Recently translated lyric lines
 *   3. Frequently encountered dictionary entries
 * Items whose stable id is in `exclude` are skipped so anti-repeat
 * behaves correctly across consecutive requests.
 */
function pickCandidate(
  context: StudyContext,
  exclude: Set<string>
): Candidate | null {
  for (const pick of context.recentDictionary) {
    if (!exclude.has(pick.entry.id)) {
      return { kind: "dictionaryEntry", entry: pick.entry, reason: pick.reason };
    }
  }
  for (const pick of context.recentLines) {
    const id = lineCandidateId(pick);
    if (!exclude.has(id)) {
      return { kind: "lineAnalysis", pick, id };
    }
  }
  for (const pick of context.frequentDictionary) {
    if (!exclude.has(pick.entry.id)) {
      return { kind: "dictionaryEntry", entry: pick.entry, reason: pick.reason };
    }
  }
  return null;
}

/**
 * Distractor pool = every dictionary entry in context that is NOT the
 * candidate. Capped for prompt-size predictability. Falls back to an
 * empty array if the user has nothing else saved — the model is told
 * to emit fewer options in that case rather than invent filler.
 */
function buildDistractorPool(
  context: StudyContext,
  candidate: Candidate
): DictionaryEntry[] {
  const seen = new Set<string>();
  const out: DictionaryEntry[] = [];
  const excludeId =
    candidate.kind === "dictionaryEntry" ? candidate.entry.id : null;
  for (const pick of [
    ...context.recentDictionary,
    ...context.frequentDictionary,
  ]) {
    if (seen.has(pick.entry.id)) continue;
    if (excludeId && pick.entry.id === excludeId) continue;
    seen.add(pick.entry.id);
    out.push(pick.entry);
    if (out.length >= MAX_DISTRACTORS_IN_PROMPT) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function trim(value: string | undefined | null, max: number): string {
  if (typeof value !== "string") return "";
  const t = value.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function describeCandidate(candidate: Candidate): {
  id: string;
  payload: Record<string, unknown>;
  allowedKinds: PopupQuestionKind[];
} {
  if (candidate.kind === "dictionaryEntry") {
    const e = candidate.entry;
    return {
      id: e.id,
      allowedKinds: ["word-meaning", "word-reading", "reverse-meaning"],
      payload: {
        kind: "dictionaryEntry",
        id: e.id,
        surface: e.surface,
        reading: e.reading,
        romaji: e.romaji,
        type: e.type,
        direction: e.direction,
        meaning: e.meaning,
        contextMeanings: (e.contextMeanings ?? [])
          .slice(0, 3)
          .map((c) => ({
            meaning: trim(c.meaning, 120),
            songTitle: c.songTitle,
            line: trim(c.line, 140),
          })),
        kanji: (e.kanjiList ?? [])
          .slice(0, 4)
          .map((k) => ({
            character: k.character,
            meaning: trim(k.meaning, 80),
          })),
        sourceTrack: e.sourceTrackName,
        artist: e.artistName,
        reason: candidate.reason,
      },
    };
  }
  const a = candidate.pick.analysis;
  return {
    id: candidate.id,
    allowedKinds: ["line-meaning", "fill-blank"],
    payload: {
      kind: "lineAnalysis",
      id: candidate.id,
      sourceLine: a.japanese,
      romaji: a.romaji,
      direction: a.direction,
      directTranslation: trim(a.directTranslation, 240),
      culturalTranslation: trim(a.culturalTranslation, 240),
      // Words are often the most useful grounding for fill-blank.
      words: (a.words ?? []).slice(0, 12).map((w) => ({
        surface: w.surface,
        romaji: w.romaji,
        meaningInContext: trim(w.meaningInContext, 100),
      })),
    },
  };
}

function buildPopupQuizPrompt(
  context: StudyContext,
  candidate: Candidate,
  distractors: DictionaryEntry[],
  excludeSourceIds: string[]
): {
  prompt: string;
  candidateId: string;
  allowedKinds: PopupQuestionKind[];
  distractorIds: Set<string>;
} {
  const described = describeCandidate(candidate);
  const distractorPayload = distractors.map((d) => ({
    id: d.id,
    surface: d.surface,
    meaning: trim(d.meaning, 120),
    romaji: d.romaji,
  }));
  const distractorIds = new Set(distractors.map((d) => d.id));
  const directionLine = context.direction
    ? `Study direction: ${context.direction}.\n`
    : "";
  const avoidLine =
    excludeSourceIds.length > 0
      ? `Avoid repeating these recent source ids: ${JSON.stringify(excludeSourceIds.slice(0, 20))}\n`
      : "";

  return {
    prompt:
      `You are generating ONE quiz question for a language learner, strictly grounded in the user's real study data below. Do not invent vocabulary, translations, or song references that are not in the provided payload.\n\n` +
      directionLine +
      `Candidate study item (the question MUST test this):\n${JSON.stringify(described.payload, null, 2)}\n\n` +
      `Allowed question kinds for this candidate: ${described.allowedKinds.join(", ")}. Pick the one that best fits the candidate's data.\n\n` +
      `Distractor pool (use these as wrong-answer options — do NOT invent others):\n${JSON.stringify(distractorPayload, null, 2)}\n\n` +
      avoidLine +
      `Output requirements:\n` +
      `- The JSON "source.id" field MUST equal "${described.id}".\n` +
      `- Provide between ${MIN_OPTIONS} and ${MAX_OPTIONS} options. Exactly one must have isCorrect:true.\n` +
      `- Wrong-answer option texts must come from the distractor pool's meaning/surface/romaji fields (match the question kind). If the pool has fewer than ${MIN_OPTIONS - 1} items, return only 2 options.\n` +
      `- The correct option must come from the candidate's own data (meaning / romaji / surface, depending on kind).\n` +
      `- Keep the prompt short and specific. For fill-blank, the prompt must contain the candidate's line with one word replaced by "___".\n` +
      `- explanation: 1-2 sentences, plain text, no markdown, no quoting, no repeating the question.\n` +
      `- Do NOT reference songs, lines, or vocabulary that are not in the payload above.\n`,
    candidateId: described.id,
    allowedKinds: described.allowedKinds,
    distractorIds,
  };
}

// ---------------------------------------------------------------------------
// Parser / validator
// ---------------------------------------------------------------------------

interface ParserContext {
  candidateId: string;
  allowedKinds: Set<PopupQuestionKind>;
  /** Allow-list for `source.id` — the candidate id is always included. */
  allowedSourceIds: Set<string>;
  /** Allow-list for distractor texts. Enforced loosely because the model
   *  may emit translated variants; we check exact-match then skip. */
  candidate: Candidate;
}

function parseGeneratedPopupQuestion(
  raw: RawPopupQuizResponse,
  pCtx: ParserContext
): PopupQuizQuestion {
  if (!raw || typeof raw !== "object") {
    throw new AnalysisError("popupQuiz: non-object response");
  }

  const kind = raw.kind;
  if (typeof kind !== "string" || !pCtx.allowedKinds.has(kind as PopupQuestionKind)) {
    throw new AnalysisError(
      `popupQuiz: invalid kind "${String(kind)}" — expected one of ${[...pCtx.allowedKinds].join(", ")}`
    );
  }

  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (prompt.length === 0) {
    throw new AnalysisError("popupQuiz: empty prompt");
  }

  const explanationRaw =
    typeof raw.explanation === "string" ? raw.explanation.trim() : "";
  if (explanationRaw.length === 0) {
    throw new AnalysisError("popupQuiz: empty explanation");
  }
  const explanation =
    explanationRaw.length > EXPLANATION_SOFT_CAP
      ? explanationRaw.slice(0, EXPLANATION_SOFT_CAP - 1) + "…"
      : explanationRaw;

  if (!Array.isArray(raw.options)) {
    throw new AnalysisError("popupQuiz: options must be an array");
  }
  if (raw.options.length < MIN_OPTIONS || raw.options.length > MAX_OPTIONS) {
    throw new AnalysisError(
      `popupQuiz: options length ${raw.options.length} outside [${MIN_OPTIONS}, ${MAX_OPTIONS}]`
    );
  }

  const seenTexts = new Set<string>();
  const options: PopupQuizOption[] = [];
  for (let i = 0; i < raw.options.length; i++) {
    const rawOpt = raw.options[i] as { text?: unknown; isCorrect?: unknown } | null;
    if (!rawOpt || typeof rawOpt !== "object") {
      throw new AnalysisError(`popupQuiz: option[${i}] not an object`);
    }
    const text = typeof rawOpt.text === "string" ? rawOpt.text.trim() : "";
    if (text.length === 0) {
      throw new AnalysisError(`popupQuiz: option[${i}] has empty text`);
    }
    const dedupKey = text.toLowerCase();
    if (seenTexts.has(dedupKey)) {
      throw new AnalysisError(
        `popupQuiz: duplicate option text "${text}"`
      );
    }
    seenTexts.add(dedupKey);
    if (typeof rawOpt.isCorrect !== "boolean") {
      throw new AnalysisError(`popupQuiz: option[${i}].isCorrect not a boolean`);
    }
    options.push({ text, isCorrect: rawOpt.isCorrect });
  }

  const correctCount = options.filter((o) => o.isCorrect).length;
  if (correctCount !== 1) {
    throw new AnalysisError(
      `popupQuiz: expected exactly one isCorrect option, got ${correctCount}`
    );
  }
  const correctOptionIndex = options.findIndex((o) => o.isCorrect);

  const rawSource = raw.source as
    | {
        kind?: unknown;
        id?: unknown;
        surface?: unknown;
        songTitle?: unknown;
        artistName?: unknown;
      }
    | null
    | undefined;
  if (!rawSource || typeof rawSource !== "object") {
    throw new AnalysisError("popupQuiz: source missing");
  }
  const sourceKind = rawSource.kind;
  if (
    typeof sourceKind !== "string" ||
    !ALLOWED_SOURCE_KINDS.includes(sourceKind as PopupQuizSourceRef["kind"])
  ) {
    throw new AnalysisError(
      `popupQuiz: invalid source.kind "${String(sourceKind)}"`
    );
  }
  const sourceId = typeof rawSource.id === "string" ? rawSource.id : "";
  if (sourceId.length === 0) {
    throw new AnalysisError("popupQuiz: source.id empty");
  }
  if (!pCtx.allowedSourceIds.has(sourceId)) {
    // Strict: prevents the model from referencing material the user
    // hasn't actually studied. The candidate's own id is always in the
    // allow-list, so a valid answer can always be formed.
    throw new AnalysisError(
      `popupQuiz: source.id "${sourceId}" not in allowed set`
    );
  }

  const source: PopupQuizSourceRef = {
    kind: sourceKind as PopupQuizSourceRef["kind"],
    id: sourceId,
    surface:
      typeof rawSource.surface === "string" && rawSource.surface.length > 0
        ? rawSource.surface
        : pCtx.candidate.kind === "dictionaryEntry"
          ? pCtx.candidate.entry.surface
          : undefined,
    songTitle:
      typeof rawSource.songTitle === "string" && rawSource.songTitle.length > 0
        ? rawSource.songTitle
        : pCtx.candidate.kind === "dictionaryEntry"
          ? pCtx.candidate.entry.sourceTrackName
          : undefined,
    artistName:
      typeof rawSource.artistName === "string" && rawSource.artistName.length > 0
        ? rawSource.artistName
        : pCtx.candidate.kind === "dictionaryEntry"
          ? pCtx.candidate.entry.artistName
          : undefined,
  };

  return finalizePopupQuestion({
    kind: kind as PopupQuestionKind,
    prompt,
    options,
    correctOptionIndex,
    explanation,
    source,
  });
}

// ---------------------------------------------------------------------------
// Fallback — local dictionary-driven generator, reused from the existing
// quiz module. Shape-compatible with the popup question type.
// ---------------------------------------------------------------------------

function fallbackFromDictionary(
  context: StudyContext,
  exclude: Set<string>
): PopupQuizQuestion | null {
  const pool = new Map<string, DictionaryEntry>();
  for (const pick of context.recentDictionary) pool.set(pick.entry.id, pick.entry);
  for (const pick of context.frequentDictionary) {
    if (!pool.has(pick.entry.id)) pool.set(pick.entry.id, pick.entry);
  }
  const entries = [...pool.values()].filter((e) => !exclude.has(e.id));
  const [q] = generateQuestions(entries, 1);
  if (!q) return null;

  const correctOptionIndex = q.options.findIndex((o) => o.isCorrect);
  if (correctOptionIndex < 0) return null;
  const sourceEntry = entries.find((e) => e.id === q.dictionaryEntryId);

  return finalizePopupQuestion({
    kind:
      q.questionType === "meaning"
        ? "word-meaning"
        : q.questionType === "reading"
          ? "word-reading"
          : "reverse-meaning",
    prompt: q.prompt,
    options: q.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
    correctOptionIndex,
    explanation: "",
    source: {
      kind: "dictionaryEntry",
      id: q.dictionaryEntryId,
      surface: sourceEntry?.surface,
      songTitle: sourceEntry?.sourceTrackName,
      artistName: sourceEntry?.artistName,
    },
  });
}

// ---------------------------------------------------------------------------
// Orchestrator (PopupQuizGenerator implementation)
// ---------------------------------------------------------------------------

async function callOnce(
  promptText: string,
  pCtx: ParserContext
): Promise<PopupQuizQuestion> {
  const raw = await callNvidiaStructured<RawPopupQuizResponse>({
    prompt: promptText,
    responseSchema: POPUP_QUIZ_CONTRACT as unknown as Record<string, unknown>,
  });
  return parseGeneratedPopupQuestion(raw, pCtx);
}

export const popupQuizNvidiaGenerator: PopupQuizGenerator = {
  async generate(
    context: StudyContext,
    options: PopupQuizGeneratorOptions = {}
  ): Promise<PopupQuizQuestion | null> {
    const exclude = new Set(options.excludeSourceIds ?? []);

    const candidate = pickCandidate(context, exclude);
    if (!candidate) {
      // No study data at all — let the popup UI show its empty state.
      return null;
    }

    const distractors = buildDistractorPool(context, candidate);
    const { prompt, candidateId, allowedKinds, distractorIds } =
      buildPopupQuizPrompt(
        context,
        candidate,
        distractors,
        options.excludeSourceIds ?? []
      );

    const allowedSourceIds = new Set<string>([candidateId, ...distractorIds]);
    const pCtx: ParserContext = {
      candidateId,
      allowedKinds: new Set<PopupQuestionKind>(allowedKinds),
      allowedSourceIds,
      candidate,
    };

    // Attempt 1 + one retry on malformed output. Network / auth
    // errors are not retried — the fallback catches them.
    try {
      return await callOnce(prompt, pCtx);
    } catch (err) {
      if (err instanceof AnalysisError) {
        // Retry with the same prompt — transient model lapses often
        // recover on a second attempt. Parser errors are thrown as
        // AnalysisError, so this branch covers every malformed-output
        // case without swallowing genuine upstream failures.
        try {
          return await callOnce(prompt, pCtx);
        } catch (err2) {
          console.warn(
            "[popupQuiz] NVIDIA generation failed after retry:",
            err2 instanceof Error ? err2.message : String(err2)
          );
        }
      } else {
        console.warn(
          "[popupQuiz] NVIDIA generation failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Fallback: local dictionary-driven question. Same exclude set so
    // anti-repeat is preserved. Returns null only when the user doesn't
    // have enough saved words for a local question either.
    return fallbackFromDictionary(context, exclude);
  },
};
