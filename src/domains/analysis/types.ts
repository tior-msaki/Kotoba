/**
 * Analysis domain types.
 *
 * Models the bottom-up analysis pipeline: Word/Kanji -> Line -> Stanza -> SongAnalysis.
 * Produced by the Gemini-driven analysis service, consumed by dictionary and UI.
 */

/** Part of speech or grammatical role of a word. */
export type WordType =
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

/**
 * Transitivity of a verb. Only meaningful when type is a verb variant.
 * null for non-verb word types.
 */
export type Transitivity = "transitive" | "intransitive" | "both" | null;

/** Position of a word or kanji within the song. */
export interface TextLocation {
  stanzaNumber: number;
  lineNumber: number;
  /** Character offset within the line. */
  startOffset: number;
}

export interface AnalysisWord {
  /** The word as it appears in the lyrics (Japanese). */
  surface: string;
  romaji: string;
  type: WordType;
  /** Transitive/intransitive for verbs. null for non-verbs. */
  transitivity: Transitivity;
  /** Kanji characters contained in this word. */
  kanjiList: AnalysisKanji[];
  /** What this word means in the context of this line. */
  meaningInContext: string;
  location: TextLocation;
}

export interface AnalysisKanji {
  /** The kanji character itself. */
  character: string;
  romaji: string;
  kunYomi: string[];
  onYomi: string[];
  nanori: string[];
  meaning: string;
  location: TextLocation;
}

export interface AnalysisLine {
  /** The original Japanese line. */
  japanese: string;
  stanzaNumber: number;
  lineNumber: number;
  directTranslation: string;
  culturalTranslation: string;
  romaji: string;
  words: AnalysisWord[];
}

export interface AnalysisStanza {
  /** The full stanza text in Japanese. */
  japanese: string;
  stanzaNumber: number;
  directTranslation: string;
  culturalTranslation: string;
  lines: AnalysisLine[];
}

export interface SongAnalysis {
  songTitle: string;
  artistName: string;
  /** Full lyrics in Japanese. */
  fullText: string;
  culturalTranslation: string;
  summary: string;
  stanzas: AnalysisStanza[];
}
