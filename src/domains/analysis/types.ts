/**
 * Analysis domain types.
 *
 * Models the bottom-up analysis pipeline: Word/Kanji -> Line -> Stanza -> SongAnalysis.
 * Produced by the LLM-driven analysis service, consumed by dictionary and UI.
 *
 * Bilingual posture: the same pipeline handles both
 *   - ja-en: Japanese lyrics, explanations in English
 *   - en-ja: English lyrics, explanations in Japanese
 * The `japanese` field names on AnalysisLine / AnalysisStanza are kept for
 * backward compatibility but semantically mean "the source-language line /
 * stanza text". Japanese-specific enrichment (`romaji`, `kanjiList`) is
 * empty when the source is English.
 */

/**
 * Direction of analysis. Matches DictionaryDirection one-to-one so analysis
 * output can flow straight into the dictionary export pipeline.
 */
export type AnalysisDirection = "ja-en" | "en-ja";

/**
 * Part of speech or grammatical role of a word.
 *
 * The Japanese verb variants (ru-verb / godan-verb / verb-exception) are
 * kept for ja-en analyses. For en-ja analyses the neutral "verb" is used
 * instead — English has no ichidan/godan distinction. "particle" is
 * effectively JA-only; English rarely emits it.
 */
export type WordType =
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
  /** The word as it appears in the source-language lyric line. */
  surface: string;
  /** Romaji reading. Empty string for en-ja analyses. */
  romaji: string;
  type: WordType;
  /** Transitive/intransitive for verbs. null for non-verbs. */
  transitivity: Transitivity;
  /** Kanji characters contained in this word. Empty for en-ja analyses. */
  kanjiList: AnalysisKanji[];
  /** What this word means in the context of this line, in the TARGET language. */
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
  /**
   * The original source-language line. Field name is kept as `japanese`
   * for backward compatibility with older cached data; for `en-ja` analyses
   * this holds the English source line. See `original` for a
   * direction-neutral alias.
   */
  japanese: string;
  stanzaNumber: number;
  lineNumber: number;
  /** Which direction produced this analysis. */
  direction: AnalysisDirection;
  directTranslation: string;
  culturalTranslation: string;
  /** Romaji for the whole line. Empty string for en-ja analyses. */
  romaji: string;
  words: AnalysisWord[];
  /**
   * Direction-neutral alias for the source-language line. Always populated
   * by the normalizer regardless of what the provider returns. For ja-en
   * this is the Japanese line; for en-ja this is the English line.
   * Equivalent to `japanese`; provided so downstream code can read a
   * stable shape without caring about the back-compat field name.
   */
  original: string;
  /**
   * Direction-neutral alias for the natural translation in the target
   * language. Always populated by the normalizer. Equivalent to
   * `culturalTranslation`.
   */
  translated: string;
}

export interface AnalysisStanza {
  /** Full stanza text in the source language (see AnalysisLine.japanese). */
  japanese: string;
  stanzaNumber: number;
  /** Which direction produced this analysis. */
  direction: AnalysisDirection;
  directTranslation: string;
  culturalTranslation: string;
  /** Short stanza-level summary (1–2 sentences). */
  summary: string;
  lines: AnalysisLine[];
}

export interface SongAnalysis {
  songTitle: string;
  artistName: string;
  /** Full lyrics in the source language. */
  fullText: string;
  /** Which direction produced this analysis. */
  direction: AnalysisDirection;
  culturalTranslation: string;
  summary: string;
  stanzas: AnalysisStanza[];
}

// ---------------------------------------------------------------------------
// Word detail — on-demand deeper analysis for a single word.
// Fetched explicitly by the user via cd.analyzeWordDetail; not part of a
// normal line analysis response.
// ---------------------------------------------------------------------------

/** Politeness / formality register of an alternative phrasing. */
export type AlternativeRegister = "casual" | "formal" | "same";

export interface WordConjugation {
  /** Name of the form, e.g. "plain", "polite", "past", "te-form". */
  form: string;
  /** The conjugated word as written. */
  surface: string;
  /** Hiragana reading. Empty string for English. */
  reading: string;
  /** Romaji reading. Empty string for English. */
  romaji: string;
  /** One-line note on when this form is used. Empty if none. */
  description: string;
}

export interface WordAlternative {
  register: AlternativeRegister;
  surface: string;
  /** Romaji. Empty string for English. */
  romaji: string;
  meaning: string;
  /** Short usage note. Empty if none. */
  note: string;
}

export interface WordExampleSentence {
  /** Sentence in the source language. */
  source: string;
  /** Natural translation in the target language. */
  translation: string;
}

export interface WordDetail {
  surface: string;
  conjugations: WordConjugation[];
  alternatives: WordAlternative[];
  exampleSentences: WordExampleSentence[];
}
