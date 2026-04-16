/**
 * Response parsers.
 *
 * Maps raw Gemini response shapes (schemas.ts) to domain types (types.ts).
 * Key transformations:
 *   - GeminiKanjiResponse.meanings: string[] → AnalysisKanji.meaning: string (joined)
 *   - Adds TextLocation to words and kanji (computed from context, not from Gemini)
 *   - Validates required fields, throws AnalysisError on malformed data
 */

import type {
  AnalysisKanji,
  AnalysisWord,
  AnalysisLine,
  AnalysisStanza,
  SongAnalysis,
  TextLocation,
  WordType,
  Transitivity,
} from "./types";
import type {
  GeminiKanjiResponse,
  GeminiWordResponse,
  GeminiLineResponse,
  LineAnalysisResponse,
  StanzaAnalysisResponse,
  SongAnalysisResponse,
  GeminiStanzaResponse,
} from "./schemas";
import { AnalysisError } from "../../lib/errors";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_WORD_TYPES: ReadonlySet<string> = new Set<WordType>([
  "noun",
  "particle",
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
  // Default to null if Gemini omits transitivity for a verb — don't crash
  return null;
}

// ---------------------------------------------------------------------------
// Kanji parser
// ---------------------------------------------------------------------------

export function parseKanji(
  raw: GeminiKanjiResponse,
  location: TextLocation
): AnalysisKanji {
  return {
    character: requireString(raw.character, "kanji.character"),
    romaji: requireString(raw.romaji, "kanji.romaji"),
    kunYomi: requireArray<string>(raw.kunYomi, "kanji.kunYomi"),
    onYomi: requireArray<string>(raw.onYomi, "kanji.onYomi"),
    nanori: requireArray<string>(raw.nanori, "kanji.nanori"),
    meaning: requireArray<string>(raw.meanings, "kanji.meanings").join("; "),
    location,
  };
}

// ---------------------------------------------------------------------------
// Word parser
// ---------------------------------------------------------------------------

export function parseWord(
  raw: GeminiWordResponse,
  location: TextLocation
): AnalysisWord {
  const wordType = validateWordType(requireString(raw.type, "word.type"));

  return {
    surface: requireString(raw.surface, "word.surface"),
    romaji: requireString(raw.romaji, "word.romaji"),
    type: wordType,
    transitivity: validateTransitivity(raw.transitivity, wordType),
    kanjiList: requireArray<GeminiKanjiResponse>(
      raw.kanjiList,
      "word.kanjiList"
    ).map((k) => parseKanji(k, location)),
    meaningInContext: requireString(
      raw.meaningInContext,
      "word.meaningInContext"
    ),
    location,
  };
}

// ---------------------------------------------------------------------------
// Line parser
// ---------------------------------------------------------------------------

export function parseLine(
  raw: GeminiLineResponse | LineAnalysisResponse,
  stanzaNumber: number
): AnalysisLine {
  const lineNumber = requireNumber(raw.lineNumber, "line.lineNumber");

  // Compute per-word startOffset by walking the surface forms
  let offset = 0;
  const japanese = requireString(raw.japanese, "line.japanese");
  const words = requireArray<GeminiWordResponse>(raw.words, "line.words").map(
    (w) => {
      const wordLocation: TextLocation = {
        stanzaNumber,
        lineNumber,
        startOffset: offset,
      };
      // Advance offset by surface length for the next word
      offset += (w.surface?.length ?? 0);
      return parseWord(w, wordLocation);
    }
  );

  return {
    japanese,
    stanzaNumber,
    lineNumber,
    directTranslation: requireString(
      raw.directTranslation,
      "line.directTranslation"
    ),
    culturalTranslation: requireString(
      raw.culturalTranslation,
      "line.culturalTranslation"
    ),
    romaji: requireString(raw.romaji, "line.romaji"),
    words,
  };
}

// ---------------------------------------------------------------------------
// Stanza parser
// ---------------------------------------------------------------------------

export function parseStanza(
  raw: StanzaAnalysisResponse | GeminiStanzaResponse
): AnalysisStanza {
  const stanzaNumber = requireNumber(raw.stanzaNumber, "stanza.stanzaNumber");

  return {
    japanese: requireString(raw.japanese, "stanza.japanese"),
    stanzaNumber,
    directTranslation: requireString(
      raw.directTranslation,
      "stanza.directTranslation"
    ),
    culturalTranslation: requireString(
      raw.culturalTranslation,
      "stanza.culturalTranslation"
    ),
    lines: requireArray<GeminiLineResponse>(raw.lines, "stanza.lines").map(
      (l) => parseLine(l, stanzaNumber)
    ),
  };
}

// ---------------------------------------------------------------------------
// Full-song parser
// ---------------------------------------------------------------------------

export function parseSong(
  raw: SongAnalysisResponse,
  fullText: string
): SongAnalysis {
  return {
    songTitle: requireString(raw.songTitle, "song.songTitle"),
    artistName: requireString(raw.artistName, "song.artistName"),
    fullText,
    culturalTranslation: requireString(
      raw.culturalTranslation,
      "song.culturalTranslation"
    ),
    summary: requireString(raw.summary, "song.summary"),
    stanzas: requireArray<GeminiStanzaResponse>(
      raw.stanzas,
      "song.stanzas"
    ).map((s) => parseStanza(s)),
  };
}
