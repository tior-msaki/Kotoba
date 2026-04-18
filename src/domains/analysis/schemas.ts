/**
 * LLM request/response schema types.
 *
 * These types define the exact JSON shapes we send to and expect from the
 * analysis model (currently NVIDIA's OpenAI-compatible chat-completions).
 * They mirror the domain types but are intentionally separate — domain
 * types are what the app uses internally, these are what the API boundary
 * looks like. Parsers map between the two.
 *
 * Direction support: requests carry an `AnalysisDirection`. Responses stay
 * shape-compatible across directions; empty-strings/empty-arrays are used
 * for Japanese-specific fields (romaji, kanjiList) on en-ja responses.
 */

import type { AnalysisDirection } from "./types";

// ---------------------------------------------------------------------------
// Shared response shapes (reused across line/stanza/song)
// ---------------------------------------------------------------------------

export interface GeminiKanjiResponse {
  character: string;
  romaji: string;
  meanings: string[];
  kunYomi: string[];
  onYomi: string[];
  nanori: string[];
}

export interface GeminiWordResponse {
  surface: string;
  romaji: string;
  type:
    | "noun"
    | "particle"
    | "verb"
    | "ru-verb"
    | "godan-verb"
    | "verb-exception"
    | "adjective"
    | "adverb"
    | "conjunction"
    | "interjection"
    | "pronoun"
    | "counter"
    | "prefix"
    | "suffix"
    | "auxiliary"
    | "expression";
  transitivity: "transitive" | "intransitive" | "both" | null;
  meaningInContext: string;
  kanjiList: GeminiKanjiResponse[];
}

export interface GeminiLineResponse {
  japanese: string;
  lineNumber: number;
  directTranslation: string;
  culturalTranslation: string;
  romaji: string;
  words: GeminiWordResponse[];
}

// ---------------------------------------------------------------------------
// Line analysis
// ---------------------------------------------------------------------------

export interface LineAnalysisRequest {
  line: string;
  songTitle: string;
  artistName: string;
  stanzaNumber: number;
  lineNumber: number;
  /** Optional surrounding lines for better context. */
  surroundingLines?: string[];
  /** Analysis direction. Defaults to "ja-en" if omitted. */
  direction?: AnalysisDirection;
}

export interface LineAnalysisResponse {
  japanese: string;
  lineNumber: number;
  directTranslation: string;
  culturalTranslation: string;
  romaji: string;
  words: GeminiWordResponse[];
}

// ---------------------------------------------------------------------------
// Stanza analysis
// ---------------------------------------------------------------------------

export interface StanzaAnalysisRequest {
  stanza: string;
  songTitle: string;
  artistName: string;
  stanzaNumber: number;
  /** Analysis direction. Defaults to "ja-en" if omitted. */
  direction?: AnalysisDirection;
}

export interface StanzaAnalysisResponse {
  japanese: string;
  stanzaNumber: number;
  directTranslation: string;
  culturalTranslation: string;
  summary: string;
  lines: GeminiLineResponse[];
}

// ---------------------------------------------------------------------------
// Full-song analysis
// ---------------------------------------------------------------------------

export interface SongAnalysisRequest {
  fullLyrics: string;
  songTitle: string;
  artistName: string;
  /** Analysis direction. Defaults to "ja-en" if omitted. */
  direction?: AnalysisDirection;
}

export interface SongAnalysisResponse {
  songTitle: string;
  artistName: string;
  culturalTranslation: string;
  summary: string;
  stanzas: GeminiStanzaResponse[];
}

/** Stanza shape within a full-song response. */
export interface GeminiStanzaResponse {
  japanese: string;
  stanzaNumber: number;
  directTranslation: string;
  culturalTranslation: string;
  summary: string;
  lines: GeminiLineResponse[];
}

/** Stanza-level fields derived from already-analyzed lines (bottom-up). */
export interface StanzaOverviewFromLinesResponse {
  directTranslation: string;
  culturalTranslation: string;
  summary: string;
}

/** Song-level fields derived from already-analyzed stanzas (bottom-up). */
export interface SongOverviewFromStanzasResponse {
  culturalTranslation: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Ask-about-selection (free-form Q&A) — not a structured analysis, just a
// short educational answer about an arbitrary highlighted span.
// ---------------------------------------------------------------------------

export interface AskAboutSelectionRequest {
  /** Text the user highlighted in the lyrics pane. */
  text: string;
  /** Free-form question the user typed. */
  question: string;
  songTitle?: string;
  artistName?: string;
  /** Analysis direction. Defaults to "ja-en" if omitted. */
  direction?: AnalysisDirection;
}

export interface AskAboutSelectionResponse {
  /** Short educational answer in the TARGET language. */
  answer: string;
}

// ---------------------------------------------------------------------------
// Word detail (on-demand deeper word analysis)
// ---------------------------------------------------------------------------

export interface WordDetailRequest {
  /** Surface form of the word to analyze. */
  surface: string;
  /** Romaji if the caller already has it (helps the prompt). */
  romaji?: string;
  /** POS if the caller already has it (hints conjugation behavior). */
  type?: string;
  songTitle?: string;
  artistName?: string;
  /** Analysis direction. Defaults to "ja-en" if omitted. */
  direction?: AnalysisDirection;
}

export interface WordDetailResponse {
  conjugations: Array<{
    form: string;
    surface: string;
    reading: string;
    romaji: string;
    description: string;
  }>;
  alternatives: Array<{
    register: string;
    surface: string;
    romaji: string;
    meaning: string;
    note: string;
  }>;
  exampleSentences: Array<{
    source: string;
    translation: string;
  }>;
}
