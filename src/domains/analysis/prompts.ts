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
import type { AnalysisLine, AnalysisStanza } from "./types";

// ---------------------------------------------------------------------------
// Shared instructions injected into every prompt
// ---------------------------------------------------------------------------

const LIST_STYLE = `
Presentation style for any free-text translation fields:
- Be straight to the point.
- Prefer short bullet-style lines inside a single string (use "- " lines) so the UI can show scannable lists.
`;

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
- For each kanji in a word, list all standard meanings, kun-yomi (hiragana), on-yomi (katakana), and nanori readings. Use an empty array if a category has no entries.
- Line level: each word must include type (particle / noun / ru-verb / godan-verb / verb-exception / etc.), transitivity for verbs, meaning in this line, and every kanji in the word with meanings, kun-yomi, on-yomi, nanori (empty array if none).
${LIST_STYLE}`;

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

Return the analysis as JSON matching the provided schema.

Line-level checklist (must appear in the JSON fields, not prose outside JSON):
- directTranslation, culturalTranslation, romaji for the line
- words[] in order: surface, romaji, type (particles / nouns / ru-verbs / godan-verb / verb-exception with transitivity where relevant), meaningInContext
- kanjiList per word: meanings, kunYomi, onYomi, nanori
`;
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

Stanza-level checklist:
- directTranslation, culturalTranslation, summary for the whole stanza
- lines[] split in order; each line must include the same fields as the line-level checklist above

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

Song-level checklist:
- culturalTranslation and summary for the entire song
- stanzas[] in order; each stanza follows the stanza-level checklist (including nested lines)

Return the analysis as JSON matching the provided schema.`;
}

// ---------------------------------------------------------------------------
// Bottom-up: stanza / song overview from already-computed analyses
// ---------------------------------------------------------------------------

export interface StanzaOverviewPromptInput {
  songTitle: string;
  artistName: string;
  stanzaNumber: number;
  stanzaJapanese: string;
  lines: AnalysisLine[];
}

export function buildStanzaOverviewFromLinesPrompt(
  input: StanzaOverviewPromptInput
): string {
  const linePayload = input.lines.map((l) => ({
    lineNumber: l.lineNumber,
    japanese: l.japanese,
    directTranslation: l.directTranslation,
    culturalTranslation: l.culturalTranslation,
    romaji: l.romaji,
    words: l.words.map((w) => ({
      surface: w.surface,
      romaji: w.romaji,
      type: w.type,
      transitivity: w.transitivity,
      meaningInContext: w.meaningInContext,
      kanjiList: w.kanjiList.map((k) => ({
        character: k.character,
        meaning: k.meaning,
        kunYomi: k.kunYomi,
        onYomi: k.onYomi,
        nanori: k.nanori,
      })),
    })),
  }));

  return `${SYSTEM_CONTEXT}

You are completing STANZA-level fields for a bottom-up pipeline.
Line-level JSON analyses were already produced with the line contract (words, kanji, transitivity, etc.). Use them as ground truth; do not contradict their readings or word splits.

Song: "${input.songTitle}" by ${input.artistName}
Stanza index: ${input.stanzaNumber}

Full stanza (Japanese):
${input.stanzaJapanese}

Line analyses (JSON):
${JSON.stringify(linePayload, null, 2)}

Return ONLY JSON with:
- directTranslation: literal English for the entire stanza (list-style bullets inside the string are OK)
- culturalTranslation: natural English for the entire stanza
- summary: 1-2 sentences on what this stanza expresses
`;
}

export interface SongOverviewPromptInput {
  songTitle: string;
  artistName: string;
  fullLyrics: string;
  stanzas: AnalysisStanza[];
}

export function buildSongOverviewFromStanzasPrompt(
  input: SongOverviewPromptInput
): string {
  const stanzaPayload = input.stanzas.map((s) => ({
    stanzaNumber: s.stanzaNumber,
    japanese: s.japanese,
    directTranslation: s.directTranslation,
    culturalTranslation: s.culturalTranslation,
    summary: s.summary,
    lineCount: s.lines.length,
  }));

  return `${SYSTEM_CONTEXT}

You are completing SONG-level fields for a bottom-up pipeline.
Each stanza was built from per-line Gemini analyses, then stanza-level overview fields. Use the stanza material as ground truth.

Song: "${input.songTitle}" by ${input.artistName}

Full lyrics (Japanese):
${input.fullLyrics}

Stanza overviews (JSON):
${JSON.stringify(stanzaPayload, null, 2)}

Return ONLY JSON with:
- culturalTranslation: natural English for the entire song (list-style bullets inside the string are OK)
- summary: 2-4 sentences on themes, emotion, and cultural context for the whole song
`;
}
