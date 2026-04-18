/**
 * JSON schema contracts for the LLM's structured output.
 *
 * These objects describe the exact JSON shape we want the analysis model
 * to return. The NVIDIA client (src/lib/nvidia.ts) stringifies the schema
 * and embeds it into the user message, then forces JSON-only output via
 * `response_format: { type: "json_object" }`. (Previously these were
 * passed as `response_schema` to Gemini; the schemas themselves are still
 * an OpenAPI-3.0 subset so they remain portable.)
 *
 * The schemas are direction-neutral (work for both ja-en and en-ja). The
 * direction-specific details (what language "directTranslation" is in,
 * whether to emit kanji, etc.) are controlled by the PROMPT, not the
 * schema. That means one schema per level can serve both directions and
 * the model still gets clear instructions.
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
      description: "Meanings of this kanji in the TARGET language",
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
      description: "The word as it appears in the source-language lyric line",
    },
    romaji: {
      type: "string",
      description:
        "Romaji reading of this word. Japanese source only — return an empty string for English source.",
    },
    type: {
      type: "string",
      enum: [
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
      ],
      description:
        "Part of speech. For Japanese verbs use ru-verb / godan-verb / verb-exception. For English verbs use the neutral \"verb\". \"particle\" applies to Japanese only.",
    },
    transitivity: {
      // Kept Proto-safe (no `type: ["string","null"]` unions, no `null`
      // inside `enum`, use `nullable: true` instead) so the schema stays
      // portable to Gemini-style OpenAPI-3.0-subset surfaces. NVIDIA
      // itself is more permissive, but there's no cost to keeping the
      // stricter form.
      type: "string",
      nullable: true,
      enum: ["transitive", "intransitive", "both"],
      description:
        "Verb transitivity. transitive/intransitive/both for verbs, null for non-verbs",
    },
    meaningInContext: {
      type: "string",
      description:
        "What this word means in the context of this specific line, expressed in the TARGET language",
    },
    kanjiList: {
      type: "array",
      items: kanjiSchema,
      description:
        "Kanji characters in this word. Japanese source only — return an empty array for English source or for Japanese words with no kanji.",
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
    japanese: {
      type: "string",
      description:
        "The original source line. Field name kept as \"japanese\" for backward compatibility; it holds the English source line for en-ja analyses.",
    },
    lineNumber: {
      type: "integer",
      description: "1-based line number within the stanza",
    },
    directTranslation: {
      type: "string",
      description:
        "Literal word-for-word translation of the line in the TARGET language",
    },
    culturalTranslation: {
      type: "string",
      description:
        "Natural translation in the TARGET language that preserves the source's cultural nuance, emotion, and poetic intent",
    },
    romaji: {
      type: "string",
      description:
        "Full romaji transliteration of the line. Empty string for English source.",
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
      description:
        "The full stanza text in the source language (field name kept as \"japanese\" for backward compatibility).",
    },
    stanzaNumber: {
      type: "integer",
      description: "1-based stanza number within the song",
    },
    directTranslation: {
      type: "string",
      description:
        "Literal translation of the entire stanza in the TARGET language",
    },
    culturalTranslation: {
      type: "string",
      description:
        "Natural translation of the stanza in the TARGET language preserving the source's cultural nuance",
    },
    summary: {
      type: "string",
      description:
        "1-2 sentence summary of what this stanza expresses, in the TARGET language",
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
        "Natural translation of the entire song in the TARGET language preserving the source's cultural nuance and poetic intent",
    },
    summary: {
      type: "string",
      description:
        "2-4 sentence summary of the song's themes, emotions, and cultural context, in the TARGET language",
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
        "Literal translation of the entire stanza in the TARGET language (straight-to-the-point list style sentences allowed)",
    },
    culturalTranslation: {
      type: "string",
      description:
        "Natural translation of the whole stanza in the TARGET language preserving the source's cultural nuance",
    },
    summary: {
      type: "string",
      description:
        "1-2 sentence summary of what this stanza expresses, in the TARGET language",
    },
  },
  required: ["directTranslation", "culturalTranslation", "summary"],
} as const;

/**
 * On-demand deeper analysis for a single word. Structured so the lyric
 * UI can render conjugations / alternatives / example sentences as three
 * compact sections — no free-form prose. All three arrays are required;
 * the model returns [] when a section doesn't apply (e.g. conjugations
 * for particles or nouns).
 */
export const WORD_DETAIL_CONTRACT = {
  type: "object",
  properties: {
    conjugations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          form: {
            type: "string",
            description:
              "Name of the form — e.g. 'plain', 'polite', 'past', 'negative', 'te-form' / '-ing', 'conditional'.",
          },
          surface: {
            type: "string",
            description: "The conjugated word as written.",
          },
          reading: {
            type: "string",
            description:
              "Hiragana reading (Japanese only — empty string for English).",
          },
          romaji: {
            type: "string",
            description:
              "Romaji reading (Japanese only — empty string for English).",
          },
          description: {
            type: "string",
            description:
              "One-line note on when this form is used. Empty string if none.",
          },
        },
        required: ["form", "surface", "reading", "romaji", "description"],
      },
      description:
        "Core conjugations. 4-8 entries for verbs/adjectives, empty array otherwise.",
    },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          register: {
            type: "string",
            enum: ["casual", "formal", "same"],
            description:
              "Politeness / formality relative to the input word — more casual, more formal, or same-register synonym.",
          },
          surface: { type: "string" },
          romaji: {
            type: "string",
            description: "Romaji (Japanese only — empty string for English).",
          },
          meaning: {
            type: "string",
            description: "Short gloss in the TARGET language.",
          },
          note: {
            type: "string",
            description: "Usage note. Empty string if none.",
          },
        },
        required: ["register", "surface", "romaji", "meaning", "note"],
      },
      description:
        "Up to 3 alternative phrasings at different politeness levels. Empty array when there is no natural alternative (e.g. particles).",
    },
    exampleSentences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Short sentence using the word, in the source language.",
          },
          translation: {
            type: "string",
            description: "Natural translation in the target language.",
          },
        },
        required: ["source", "translation"],
      },
      description:
        "1-3 short example sentences. Do not reuse the song line the word came from.",
    },
  },
  required: ["conjugations", "alternatives", "exampleSentences"],
} as const;

/**
 * Free-form Q&A about a highlighted selection. Deliberately single-field
 * — the UI renders this as a short note-like block, not a structured
 * breakdown. The language of `answer` is controlled by the prompt, not
 * the schema (so one contract serves both directions).
 */
export const ASK_ABOUT_SELECTION_CONTRACT = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "Short educational answer to the user's question about the highlighted text, in the TARGET language. 1-4 sentences. Straight to the point. Bullet-style lines inside the string are OK (use \"- \" prefixes).",
    },
  },
  required: ["answer"],
} as const;

/** Song-level overview when stanzas were built bottom-up from lines. */
export const SONG_OVERVIEW_FROM_STANZAS_CONTRACT = {
  type: "object",
  properties: {
    culturalTranslation: {
      type: "string",
      description:
        "Natural translation of the entire song in the TARGET language preserving the source's cultural nuance and poetic intent",
    },
    summary: {
      type: "string",
      description:
        "2-4 sentence summary of themes, emotion, and cultural context for the whole song, in the TARGET language",
    },
  },
  required: ["culturalTranslation", "summary"],
} as const;
