/**
 * JSON schema contracts for Gemini structured output.
 *
 * These objects are passed as the `response_schema` in Gemini's
 * structured output mode. They tell Gemini exactly what JSON shape
 * to return — no prose, no markdown, just the schema.
 *
 * Each contract matches its corresponding type in schemas.ts.
 */

// ---------------------------------------------------------------------------
// Reusable sub-schemas
// ---------------------------------------------------------------------------

const kanjiSchema = {
  type: "object",
  properties: {
    character: { type: "string", description: "The kanji character" },
    romaji: { type: "string", description: "Romaji reading of this kanji" },
    meanings: {
      type: "array",
      items: { type: "string" },
      description: "English meanings of this kanji",
    },
    kunYomi: {
      type: "array",
      items: { type: "string" },
      description: "Kun-yomi readings in hiragana",
    },
    onYomi: {
      type: "array",
      items: { type: "string" },
      description: "On-yomi readings in katakana",
    },
    nanori: {
      type: "array",
      items: { type: "string" },
      description: "Nanori (name) readings. Empty array if none",
    },
  },
  required: ["character", "romaji", "meanings", "kunYomi", "onYomi", "nanori"],
} as const;

const wordSchema = {
  type: "object",
  properties: {
    surface: {
      type: "string",
      description: "The word as it appears in the lyrics (Japanese)",
    },
    romaji: { type: "string", description: "Romaji reading of this word" },
    type: {
      type: "string",
      enum: [
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
      ],
      description: "Part of speech. Use ru-verb, godan-verb, or verb-exception for verbs",
    },
    transitivity: {
      type: ["string", "null"],
      enum: ["transitive", "intransitive", "both", null],
      description:
        "Verb transitivity. transitive/intransitive/both for verbs, null for non-verbs",
    },
    meaningInContext: {
      type: "string",
      description: "What this word means in the context of this specific line",
    },
    kanjiList: {
      type: "array",
      items: kanjiSchema,
      description:
        "Kanji characters in this word. Empty array if the word has no kanji",
    },
  },
  required: [
    "surface",
    "romaji",
    "type",
    "transitivity",
    "meaningInContext",
    "kanjiList",
  ],
} as const;

const lineSchema = {
  type: "object",
  properties: {
    japanese: { type: "string", description: "The original Japanese line" },
    lineNumber: {
      type: "integer",
      description: "1-based line number within the stanza",
    },
    directTranslation: {
      type: "string",
      description: "Literal word-for-word English translation",
    },
    culturalTranslation: {
      type: "string",
      description:
        "Natural English translation that preserves Japanese cultural nuance and intent",
    },
    romaji: {
      type: "string",
      description: "Full romaji transliteration of the line",
    },
    words: {
      type: "array",
      items: wordSchema,
      description: "Every word in this line, in order of appearance",
    },
  },
  required: [
    "japanese",
    "lineNumber",
    "directTranslation",
    "culturalTranslation",
    "romaji",
    "words",
  ],
} as const;

const stanzaSchema = {
  type: "object",
  properties: {
    japanese: {
      type: "string",
      description: "The full stanza text in Japanese",
    },
    stanzaNumber: {
      type: "integer",
      description: "1-based stanza number within the song",
    },
    directTranslation: {
      type: "string",
      description: "Literal English translation of the entire stanza",
    },
    culturalTranslation: {
      type: "string",
      description:
        "Natural English translation of the stanza preserving Japanese cultural nuance",
    },
    summary: {
      type: "string",
      description: "1-2 sentence summary of what this stanza expresses",
    },
    lines: {
      type: "array",
      items: lineSchema,
      description: "Each line in this stanza, in order",
    },
  },
  required: [
    "japanese",
    "stanzaNumber",
    "directTranslation",
    "culturalTranslation",
    "summary",
    "lines",
  ],
} as const;

// ---------------------------------------------------------------------------
// Exported top-level contracts
// ---------------------------------------------------------------------------

/** JSON schema for a single line analysis response. */
export const LINE_ANALYSIS_CONTRACT = lineSchema;

/** JSON schema for a stanza analysis response. */
export const STANZA_ANALYSIS_CONTRACT = stanzaSchema;

/** JSON schema for a full-song analysis response. */
export const SONG_ANALYSIS_CONTRACT = {
  type: "object",
  properties: {
    songTitle: { type: "string", description: "Title of the song" },
    artistName: { type: "string", description: "Artist or band name" },
    culturalTranslation: {
      type: "string",
      description:
        "Natural English translation of the entire song preserving Japanese cultural nuance and poetic intent",
    },
    summary: {
      type: "string",
      description:
        "2-4 sentence summary of the song's themes, emotions, and cultural context",
    },
    stanzas: {
      type: "array",
      items: stanzaSchema,
      description: "Every stanza in the song, in order",
    },
  },
  required: [
    "songTitle",
    "artistName",
    "culturalTranslation",
    "summary",
    "stanzas",
  ],
} as const;

/** Stanza-level overview when line analyses were produced separately (bottom-up). */
export const STANZA_OVERVIEW_FROM_LINES_CONTRACT = {
  type: "object",
  properties: {
    directTranslation: {
      type: "string",
      description:
        "Literal English translation of the entire stanza (straight-to-the-point list style sentences allowed)",
    },
    culturalTranslation: {
      type: "string",
      description:
        "Natural English for the whole stanza preserving Japanese cultural nuance",
    },
    summary: {
      type: "string",
      description: "1-2 sentence summary of what this stanza expresses",
    },
  },
  required: ["directTranslation", "culturalTranslation", "summary"],
} as const;

/** Song-level overview when stanzas were built bottom-up from lines. */
export const SONG_OVERVIEW_FROM_STANZAS_CONTRACT = {
  type: "object",
  properties: {
    culturalTranslation: {
      type: "string",
      description:
        "Natural English for the entire song preserving Japanese cultural nuance and poetic intent",
    },
    summary: {
      type: "string",
      description:
        "2-4 sentence summary of themes, emotion, and cultural context of the whole song",
    },
  },
  required: ["culturalTranslation", "summary"],
} as const;
