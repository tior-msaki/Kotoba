/**
 * Gemini request/response schema types.
 *
 * These types define the exact JSON shapes we send to and expect from Gemini.
 * They mirror the domain types but are intentionally separate — domain types
 * are what the app uses internally, these are what the API boundary looks like.
 * Parsers (built later) will map between the two.
 */

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
