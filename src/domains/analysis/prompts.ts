/**
 * Prompt builders for Gemini analysis requests.
 *
 * Each builder returns a plain string prompt. The caller pairs the prompt
 * with the matching JSON schema contract from contracts.ts and sends
 * both to Gemini's structured output mode.
 */

import type {
  LineAnalysisRequest,
  StanzaAnalysisRequest,
  SongAnalysisRequest,
} from "./schemas";

// ---------------------------------------------------------------------------
// Shared instructions injected into every prompt
// ---------------------------------------------------------------------------

const SYSTEM_CONTEXT = `You are a Japanese language expert specializing in song lyrics analysis for language learners.
Your analysis must be precise, structured, and educational.

Rules:
- All output must be valid JSON matching the provided schema exactly.
- Do not include markdown, commentary, or any text outside the JSON.
- Translations labeled "directTranslation" must be literal word-for-word.
- Translations labeled "culturalTranslation" must sound natural in English while preserving the Japanese cultural nuance, emotion, and poetic intent.
- For verb classification: use "ru-verb" for ichidan verbs, "godan-verb" for godan verbs, "verb-exception" for irregular verbs (する, 来る, and their compounds).
- Set "transitivity" to "transitive", "intransitive", or "both" for all verb types. Set it to null for non-verbs.
- Every word in the line must appear in the words array, in order of appearance. Do not skip particles or repeated words.
- For each kanji in a word, list all standard meanings, kun-yomi (hiragana), on-yomi (katakana), and nanori readings. Use an empty array if a category has no entries.`;

// ---------------------------------------------------------------------------
// Line prompt
// ---------------------------------------------------------------------------

export function buildLinePrompt(req: LineAnalysisRequest): string {
  const context = req.surroundingLines?.length
    ? `\nSurrounding lines for context:\n${req.surroundingLines.join("\n")}`
    : "";

  return `${SYSTEM_CONTEXT}

Analyze this single line from the song "${req.songTitle}" by ${req.artistName}.
This is line ${req.lineNumber} of stanza ${req.stanzaNumber}.
${context}
Line to analyze:
${req.line}

Return the analysis as JSON matching the provided schema.`;
}

// ---------------------------------------------------------------------------
// Stanza prompt
// ---------------------------------------------------------------------------

export function buildStanzaPrompt(req: StanzaAnalysisRequest): string {
  return `${SYSTEM_CONTEXT}

Analyze this stanza from the song "${req.songTitle}" by ${req.artistName}.
This is stanza ${req.stanzaNumber}.

Stanza to analyze:
${req.stanza}

Split the stanza into individual lines. For each line, provide the full line-level analysis including all words and kanji breakdowns.
Also provide a direct translation, cultural translation, and a 1-2 sentence summary for the stanza as a whole.

Return the analysis as JSON matching the provided schema.`;
}

// ---------------------------------------------------------------------------
// Full-song prompt
// ---------------------------------------------------------------------------

export function buildSongPrompt(req: SongAnalysisRequest): string {
  return `${SYSTEM_CONTEXT}

Analyze the complete lyrics of "${req.songTitle}" by ${req.artistName}.

Full lyrics:
${req.fullLyrics}

Split the lyrics into stanzas (separated by blank lines or logical breaks).
For each stanza, split into lines. For each line, provide the full word-by-word and kanji breakdown.
Provide a cultural translation and a 2-4 sentence summary for the entire song.

Return the analysis as JSON matching the provided schema.`;
}
