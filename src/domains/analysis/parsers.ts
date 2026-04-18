/**
 * Response parsers.
 *
 * Maps raw LLM response shapes (schemas.ts) to domain types (types.ts).
 * Key transformations:
 *   - GeminiKanjiResponse.meanings: string[] → AnalysisKanji.meaning: string (joined)
 *   - Adds TextLocation to words and kanji (computed from context, not from the LLM)
 *   - Validates required fields, throws AnalysisError on malformed data
 *   - Stamps each analysis object with its AnalysisDirection
 *
 * Note: response-shape interfaces are still prefixed `Gemini*` for historical
 * reasons — the JSON shape itself is provider-agnostic and the NVIDIA client
 * returns the same structure.
 *
 * Direction handling:
 *   - Japanese-specific fields (word.romaji, line.romaji, word.kanjiList) are
 *     accepted as empty for en-ja inputs.
 *   - The word-type "verb" is accepted (neutral; used by en-ja).
 */

import type {
  AlternativeRegister,
  AnalysisDirection,
  AnalysisKanji,
  AnalysisWord,
  AnalysisLine,
  AnalysisStanza,
  SongAnalysis,
  TextLocation,
  WordType,
  Transitivity,
  WordDetail,
} from "./types";
import type {
  AskAboutSelectionResponse,
  GeminiKanjiResponse,
  GeminiWordResponse,
  GeminiLineResponse,
  LineAnalysisResponse,
  StanzaAnalysisResponse,
  SongAnalysisResponse,
  GeminiStanzaResponse,
  WordDetailResponse,
} from "./schemas";
import { AnalysisError } from "../../lib/errors";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_WORD_TYPES: ReadonlySet<string> = new Set<WordType>([
  "noun",
  "particle",
  "verb",
  "ru-verb",
  "godan-verb",
  "verb-exception",
  "adjective",
  "adverb",
  "conjunction",
  "interjection",
  "pronoun",
  "counter",
  "prefix",
  "suffix",
  "auxiliary",
  "expression",
]);

const VERB_TYPES: ReadonlySet<string> = new Set([
  "verb",
  "ru-verb",
  "godan-verb",
  "verb-exception",
]);

const VALID_TRANSITIVITY: ReadonlySet<string> = new Set([
  "transitive",
  "intransitive",
  "both",
]);

function requireString(val: unknown, field: string): string {
  if (typeof val !== "string" || val.length === 0) {
    throw new AnalysisError(`Missing or empty field: ${field}`);
  }
  return val;
}

/**
 * Like requireString, but tolerates empty strings. Used for
 * Japanese-specific fields (romaji, etc.) on en-ja analyses where the
 * model is instructed to emit "".
 */
function requireOptionalString(val: unknown, field: string): string {
  if (typeof val !== "string") {
    throw new AnalysisError(`Missing or non-string field: ${field}`);
  }
  return val;
}

/**
 * Returns the string `val` if it's a non-empty string, otherwise the
 * first non-empty fallback. Used to absorb missing/empty fields the
 * model sometimes drops (source lines, translations) without the
 * pipeline throwing — the caller always knows an authoritative value
 * for these (the request payload).
 */
function pickNonEmpty(val: unknown, ...fallbacks: Array<string | undefined>): string {
  if (typeof val === "string" && val.length > 0) return val;
  for (const f of fallbacks) {
    if (typeof f === "string" && f.length > 0) return f;
  }
  return "";
}

function requireNumber(val: unknown, field: string): number {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new AnalysisError(`Missing or invalid number field: ${field}`);
  }
  return val;
}

function requireArray<T>(val: unknown, field: string): T[] {
  if (!Array.isArray(val)) {
    throw new AnalysisError(`Missing or non-array field: ${field}`);
  }
  return val as T[];
}

function validateWordType(raw: string): WordType {
  if (!VALID_WORD_TYPES.has(raw)) {
    throw new AnalysisError(`Invalid word type: "${raw}"`);
  }
  return raw as WordType;
}

function validateTransitivity(raw: unknown, wordType: WordType): Transitivity {
  if (!VERB_TYPES.has(wordType)) {
    return null;
  }
  if (typeof raw === "string" && VALID_TRANSITIVITY.has(raw)) {
    return raw as Transitivity;
  }
  // Default to null if the model omits transitivity for a verb — don't crash
  return null;
}

// ---------------------------------------------------------------------------
// Kanji parser
// ---------------------------------------------------------------------------

/**
 * Kanji annotation is enhancement data — translation must still work
 * when it is partial or missing. `character` is the only field we
 * genuinely need (without it the item cannot be rendered); everything
 * else is defaulted when absent. Returns `null` on an unparseable item
 * so the caller can filter it out without failing the whole line.
 */
export function parseKanji(
  raw: GeminiKanjiResponse | null | undefined,
  location: TextLocation
): AnalysisKanji | null {
  if (!raw || typeof raw !== "object") return null;
  const character = typeof raw.character === "string" ? raw.character : "";
  if (character.length === 0) return null;

  const asStringArray = (val: unknown): string[] =>
    Array.isArray(val)
      ? (val as unknown[]).filter(
          (s): s is string => typeof s === "string" && s.length > 0
        )
      : [];

  const meanings = asStringArray(raw.meanings);

  return {
    character,
    romaji: typeof raw.romaji === "string" ? raw.romaji : "",
    kunYomi: asStringArray(raw.kunYomi),
    onYomi: asStringArray(raw.onYomi),
    nanori: asStringArray(raw.nanori),
    meaning: meanings.join("; "),
    location,
  };
}

// ---------------------------------------------------------------------------
// Word parser
// ---------------------------------------------------------------------------

export function parseWord(
  raw: GeminiWordResponse,
  location: TextLocation
): AnalysisWord | null {
  // `surface` is the only strictly-required word field — without it the
  // card cannot be rendered. Other annotation fields degrade gracefully:
  //   - `type`: unknown values fall back to "expression" (valid catch-all)
  //   - `kanjiList`: missing / non-array becomes [] rather than throwing
  //   - individual kanji items are filtered via parseKanji returning null
  //   - `meaningInContext`: empty becomes "" rather than throwing
  // Returns `null` when `surface` is missing so the caller can filter
  // the bad word instead of failing the whole line.
  const surface = typeof raw?.surface === "string" ? raw.surface : "";
  if (surface.length === 0) return null;
  const rawType = typeof raw.type === "string" ? raw.type : "";
  const wordType: WordType = VALID_WORD_TYPES.has(rawType)
    ? (rawType as WordType)
    : "expression";

  const rawKanjiList: unknown[] = Array.isArray(raw.kanjiList)
    ? (raw.kanjiList as unknown[])
    : [];
  const kanjiList = rawKanjiList
    .map((k): AnalysisKanji | null => {
      // Defensive: parseKanji already returns null for empty/missing
      // character, but some exotic provider shapes (e.g. nested arrays,
      // Proxy-like objects, BigInt in a reading field) can still throw
      // during property access. Kanji annotation is enhancement data —
      // a single malformed item must not fail the whole line.
      try {
        return parseKanji(k as GeminiKanjiResponse | null, location);
      } catch {
        return null;
      }
    })
    .filter((k): k is AnalysisKanji => k !== null);

  return {
    surface,
    // romaji is JA-only; tolerated empty for en-ja analyses.
    romaji: typeof raw.romaji === "string" ? raw.romaji : "",
    type: wordType,
    transitivity: validateTransitivity(raw.transitivity, wordType),
    kanjiList,
    meaningInContext:
      typeof raw.meaningInContext === "string" ? raw.meaningInContext : "",
    location,
  };
}

// ---------------------------------------------------------------------------
// Line parser
// ---------------------------------------------------------------------------

export function parseLine(
  raw: GeminiLineResponse | LineAnalysisResponse,
  stanzaNumber: number,
  direction: AnalysisDirection = "ja-en",
  lineNumberOverride?: number,
  sourceLineOverride?: string
): AnalysisLine | null {
  // Line-level callers already know what line they requested; respect that
  // so the returned `lineNumber` matches the request and the Dexie cache
  // key is stable on repeat clicks. Stanza-level callers pass no override
  // and fall back to the model's per-line numbering. If the model also
  // dropped `lineNumber`, default to 1 rather than throwing — the caller
  // will assign positions via array index if needed.
  let lineNumber: number;
  if (
    typeof lineNumberOverride === "number" &&
    Number.isFinite(lineNumberOverride)
  ) {
    lineNumber = lineNumberOverride;
  } else if (typeof raw.lineNumber === "number" && Number.isFinite(raw.lineNumber)) {
    lineNumber = raw.lineNumber;
  } else {
    lineNumber = 1;
  }
  // `japanese` holds the source-language line (schema field name kept
  // for back-compat — on en-ja analyses it carries the English source).
  // The caller's override is the authoritative source (what the user
  // actually clicked translate on); it wins over whatever the model
  // echoes, and also rescues the common case where LLMs drop or empty
  // this field because the field name conflicts with the direction.
  //
  // If BOTH are missing/empty (the model emitted an extra unmapped
  // line, etc.), we cannot normalize this line. Return null so the
  // caller filters it out — fail soft for an individual line rather
  // than poisoning the whole stanza/song batch.
  const sourceLine = pickNonEmpty(sourceLineOverride, raw.japanese);
  if (sourceLine.length === 0) {
    return null;
  }

  // Compute per-word startOffset by locating each surface in the remaining
  // source-line text. This handles both kanji-dense JA lines (no spaces) and
  // EN lines (space-separated) without any direction-specific logic.
  // `words` is tolerated missing / non-array → treated as []. Individual
  // words with no `surface` are filtered via parseWord returning null.
  let cursor = 0;
  const rawWords: GeminiWordResponse[] = Array.isArray(raw.words)
    ? (raw.words as GeminiWordResponse[])
    : [];
  const words = rawWords
    .map((w): AnalysisWord | null => {
      const surface = typeof w?.surface === "string" ? w.surface : "";
      const idx = surface.length > 0 ? sourceLine.indexOf(surface, cursor) : -1;
      const startOffset = idx >= 0 ? idx : cursor;
      const wordLocation: TextLocation = {
        stanzaNumber,
        lineNumber,
        startOffset,
      };
      cursor = startOffset + surface.length;
      // Defensive: parseWord already handles missing surface / invalid
      // type / malformed kanji list, but a downstream throw (e.g. from
      // an exotic kanji item) must not poison the entire line. Skip
      // the bad word instead of failing translation.
      try {
        return parseWord(w, wordLocation);
      } catch {
        return null;
      }
    })
    .filter((w): w is AnalysisWord => w !== null);

  // Translation fields: if the model returns only one of the two,
  // mirror it into the other so the UI always has something to render.
  // When BOTH are empty the model produced no translation for this
  // line — return null (same pattern as the missing-source case) so
  // the caller filters it rather than blowing up the whole batch.
  const rawDirect = typeof raw.directTranslation === "string" ? raw.directTranslation : "";
  const rawCultural = typeof raw.culturalTranslation === "string" ? raw.culturalTranslation : "";
  if (rawDirect.length === 0 && rawCultural.length === 0) {
    return null;
  }
  const directTranslation = rawDirect.length > 0 ? rawDirect : rawCultural;
  const culturalTranslation = rawCultural.length > 0 ? rawCultural : rawDirect;

  return {
    japanese: sourceLine,
    stanzaNumber,
    lineNumber,
    direction,
    directTranslation,
    culturalTranslation,
    // line.romaji is JA-only; tolerated empty for en-ja analyses and
    // tolerated missing entirely (the model occasionally drops it).
    romaji: typeof raw.romaji === "string" ? raw.romaji : "",
    words,
    // Direction-neutral aliases — always populated by the normalizer so
    // UI / dictionary / export code can read a stable shape without
    // caring about the back-compat `japanese` field name.
    original: sourceLine,
    translated: culturalTranslation,
  };
}

// ---------------------------------------------------------------------------
// Stanza parser
// ---------------------------------------------------------------------------

export function parseStanza(
  raw: StanzaAnalysisResponse | GeminiStanzaResponse,
  direction: AnalysisDirection = "ja-en",
  stanzaSourceOverride?: string
): AnalysisStanza {
  const stanzaNumber = requireNumber(raw.stanzaNumber, "stanza.stanzaNumber");

  const summary =
    typeof (raw as { summary?: unknown }).summary === "string"
      ? (raw as { summary: string }).summary
      : "";

  // Caller's override wins over the model's echo for the same reasons
  // as in parseLine (see comment there).
  const stanzaSource = pickNonEmpty(stanzaSourceOverride, raw.japanese);
  if (stanzaSource.length === 0) {
    throw new AnalysisError(
      "Missing or empty field: stanza.japanese (and no source override provided)"
    );
  }

  // Derive per-line source-line overrides by splitting the stanza source
  // on newlines (same canonicalisation as splitPastedLyricsIntoStanzas).
  // The model's line ordering is expected to match the input ordering.
  const stanzaSourceLines = stanzaSource.split(/\r\n|\r|\n/).filter((l) => l.length > 0);

  const rawDirect = typeof raw.directTranslation === "string" ? raw.directTranslation : "";
  const rawCultural = typeof raw.culturalTranslation === "string" ? raw.culturalTranslation : "";
  if (rawDirect.length === 0 && rawCultural.length === 0) {
    throw new AnalysisError(
      "Missing translation: neither stanza.directTranslation nor stanza.culturalTranslation was provided"
    );
  }
  const directTranslation = rawDirect.length > 0 ? rawDirect : rawCultural;
  const culturalTranslation = rawCultural.length > 0 ? rawCultural : rawDirect;

  // Parse each line, filtering out those the normalizer couldn't
  // recover (model emitted extra unmapped lines, or returned a line
  // with no translation). Falling back from the source-line override
  // to `raw.japanese` handles the common case where the model splits
  // one long lyric into two analysed entries — the first matches
  // `stanzaSourceLines[i]`, the second carries its own text in
  // `raw.japanese`.
  const lines = requireArray<GeminiLineResponse>(raw.lines, "stanza.lines")
    .map((l, i) => {
      const override =
        typeof stanzaSourceLines[i] === "string" && stanzaSourceLines[i]!.length > 0
          ? stanzaSourceLines[i]
          : undefined;
      return parseLine(l, stanzaNumber, direction, undefined, override);
    })
    .filter((l): l is AnalysisLine => l !== null);

  return {
    japanese: stanzaSource,
    stanzaNumber,
    direction,
    directTranslation,
    culturalTranslation,
    summary,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Full-song parser
// ---------------------------------------------------------------------------

export function parseSong(
  raw: SongAnalysisResponse,
  fullText: string,
  direction: AnalysisDirection = "ja-en",
  stanzaSourceOverrides?: readonly string[]
): SongAnalysis {
  const stanzasRaw = requireArray<GeminiStanzaResponse>(raw.stanzas, "song.stanzas");
  const summary =
    typeof raw.summary === "string" && raw.summary.length > 0 ? raw.summary : "";
  const rawCulturalSong = typeof raw.culturalTranslation === "string" ? raw.culturalTranslation : "";
  return {
    songTitle: requireString(raw.songTitle, "song.songTitle"),
    artistName: requireString(raw.artistName, "song.artistName"),
    fullText,
    direction,
    // Fall back to an empty string rather than throwing — some models
    // skip the song-level overview when full-stanza content is already
    // present. The UI treats empty as "no overview yet".
    culturalTranslation: rawCulturalSong,
    summary,
    stanzas: stanzasRaw.map((s, i) =>
      parseStanza(s, direction, stanzaSourceOverrides?.[i])
    ),
  };
}

// ---------------------------------------------------------------------------
// Ask-about-selection parser — single-field validation.
// ---------------------------------------------------------------------------

export function parseAskAnswer(
  raw: AskAboutSelectionResponse
): { answer: string } {
  return { answer: requireString(raw.answer, "ask.answer") };
}

// ---------------------------------------------------------------------------
// Word-detail parser — on-demand deeper word analysis
// ---------------------------------------------------------------------------

function validateRegister(raw: unknown): AlternativeRegister {
  if (raw === "casual" || raw === "formal" || raw === "same") return raw;
  // Graceful fallback — "if available, degrade gracefully" per spec.
  return "same";
}

export function parseWordDetail(
  raw: WordDetailResponse,
  surface: string
): WordDetail {
  const conjugations = requireArray<WordDetailResponse["conjugations"][number]>(
    raw.conjugations,
    "wordDetail.conjugations"
  ).map((c) => ({
    form: requireString(c.form, "conjugation.form"),
    surface: requireString(c.surface, "conjugation.surface"),
    reading: requireOptionalString(c.reading, "conjugation.reading"),
    romaji: requireOptionalString(c.romaji, "conjugation.romaji"),
    description: requireOptionalString(c.description, "conjugation.description"),
  }));

  const alternatives = requireArray<WordDetailResponse["alternatives"][number]>(
    raw.alternatives,
    "wordDetail.alternatives"
  ).map((a) => ({
    register: validateRegister(a.register),
    surface: requireString(a.surface, "alternative.surface"),
    romaji: requireOptionalString(a.romaji, "alternative.romaji"),
    meaning: requireString(a.meaning, "alternative.meaning"),
    note: requireOptionalString(a.note, "alternative.note"),
  }));

  const exampleSentences = requireArray<
    WordDetailResponse["exampleSentences"][number]
  >(raw.exampleSentences, "wordDetail.exampleSentences").map((e) => ({
    source: requireString(e.source, "example.source"),
    translation: requireString(e.translation, "example.translation"),
  }));

  return {
    surface,
    conjugations,
    alternatives,
    exampleSentences,
  };
}
