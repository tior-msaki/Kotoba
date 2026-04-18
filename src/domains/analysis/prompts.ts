/**
 * Prompt builders for LLM analysis requests.
 *
 * Each builder returns a plain string prompt. The caller pairs the prompt
 * with the matching JSON schema contract from contracts.ts; the NVIDIA
 * client embeds the schema into the request body so the model is told
 * exactly what JSON shape to produce.
 *
 * Direction support: every builder derives its system context from the
 * request's `direction` (default "ja-en" when missing). The schema stays
 * the same across directions; only the prompt text and examples change.
 */

import type {
  AskAboutSelectionRequest,
  LineAnalysisRequest,
  StanzaAnalysisRequest,
  SongAnalysisRequest,
  WordDetailRequest,
} from "./schemas";
import type { AnalysisDirection, AnalysisLine, AnalysisStanza } from "./types";

// ---------------------------------------------------------------------------
// Shared instructions injected into every prompt
// ---------------------------------------------------------------------------

const LIST_STYLE = `
Presentation style for any free-text translation fields:
- Be straight to the point.
- Prefer short bullet-style lines inside a single string (use "- " lines) so the UI can show scannable lists.
`;

const JA_EN_SYSTEM_CONTEXT = `You are a Japanese language expert specializing in song lyrics analysis for language learners.
The source lyrics are in Japanese. All explanations, translations, summaries, and word meanings you produce must be in ENGLISH.
Your analysis must be precise, structured, and educational.

Rules:
- All output must be valid JSON matching the provided schema exactly.
- Do not include markdown, commentary, or any text outside the JSON.
- The "japanese" field on line/stanza objects is the SOURCE line text (Japanese for this direction). Keep it as-is.
- Translations labeled "directTranslation" must be literal word-for-word English.
- Translations labeled "culturalTranslation" must sound natural in English while preserving the Japanese cultural nuance, emotion, and poetic intent.
- For verb classification: use "ru-verb" for ichidan verbs, "godan-verb" for godan verbs, "verb-exception" for irregular verbs (する, 来る, and their compounds). Do NOT use the neutral "verb" type in this direction.
- Set "transitivity" to "transitive", "intransitive", or "both" for all verb types. Set it to null for non-verbs.
- Every word in the line must appear in the words array, in order of appearance. Do not skip particles or repeated words.
- For each kanji in a word, list all standard meanings (English), kun-yomi (hiragana), on-yomi (katakana), and nanori readings. Use an empty array if a category has no entries.
- Line level: each word must include type (particle / noun / ru-verb / godan-verb / verb-exception / etc.), transitivity for verbs, meaning in this line, and every kanji in the word with meanings, kun-yomi, on-yomi, nanori (empty array if none).
${LIST_STYLE}`;

const EN_JA_SYSTEM_CONTEXT = `You are a bilingual English/Japanese language expert specializing in song lyrics analysis for language learners.
The source lyrics are in English. All explanations, translations, summaries, and word meanings you produce must be in JAPANESE (natural modern Japanese, not transliteration).
Your analysis must be precise, structured, and educational.

Rules:
- All output must be valid JSON matching the provided schema exactly.
- Do not include markdown, commentary, or any text outside the JSON.
- The "japanese" field on line/stanza objects is actually the SOURCE line text (English for this direction). Keep it verbatim, including punctuation and case.
- Translations labeled "directTranslation" must be literal word-for-word Japanese.
- Translations labeled "culturalTranslation" must sound natural in Japanese while preserving the English source's nuance, emotion, and poetic intent.
- For word "type": use the neutral "verb" for all English verbs. Do NOT use "ru-verb" / "godan-verb" / "verb-exception" — those apply to Japanese only. Do NOT use "particle" — English has no particles; pick the closest fit (e.g. "auxiliary" for helper verbs, "conjunction" for connectors, "preposition words" become "adverb" or "expression" as appropriate).
- "transitivity" applies to English verbs the same way: "transitive", "intransitive", "both", or null for non-verbs.
- The "romaji" fields refer to romaji of the SOURCE word/line. For English source, return an empty string ("") on both line.romaji and word.romaji.
- The "kanjiList" field is Japanese-only. For English source, return an empty array [].
- "meaningInContext" must be the JAPANESE meaning of the word in the context of this line.
- Every word in the line must appear in the words array, in order of appearance. Do not skip repeated words. Punctuation can be omitted.
${LIST_STYLE}`;

function systemContextFor(direction: AnalysisDirection): string {
  return direction === "en-ja" ? EN_JA_SYSTEM_CONTEXT : JA_EN_SYSTEM_CONTEXT;
}

function resolveDirection(direction: AnalysisDirection | undefined): AnalysisDirection {
  return direction === "en-ja" ? "en-ja" : "ja-en";
}

function sourceLanguageLabel(direction: AnalysisDirection): string {
  return direction === "en-ja" ? "English" : "Japanese";
}

// ---------------------------------------------------------------------------
// Line prompt
// ---------------------------------------------------------------------------

export function buildLinePrompt(req: LineAnalysisRequest): string {
  const direction = resolveDirection(req.direction);
  const sysContext = systemContextFor(direction);
  const surrounding = req.surroundingLines?.length
    ? `\nSurrounding lines for context:\n${req.surroundingLines.join("\n")}`
    : "";

  const wordChecklist = direction === "en-ja"
    ? '- words[] in order: surface, romaji="" (English has no romaji), type ("verb" for verbs / noun / adjective / adverb / conjunction / interjection / pronoun / auxiliary / expression), transitivity for verbs, meaningInContext in Japanese\n- kanjiList per word: [] (English has no kanji)'
    : "- words[] in order: surface, romaji, type (particles / nouns / ru-verbs / godan-verb / verb-exception with transitivity where relevant), meaningInContext in English\n- kanjiList per word: meanings, kunYomi, onYomi, nanori";

  return `${sysContext}

Analyze this single line from the song "${req.songTitle}" by ${req.artistName}.
This is line ${req.lineNumber} of stanza ${req.stanzaNumber}.
Source language: ${sourceLanguageLabel(direction)}.
${surrounding}
Line to analyze:
${req.line}

Return the analysis as JSON matching the provided schema.

Line-level checklist (must appear in the JSON fields, not prose outside JSON):
- directTranslation, culturalTranslation${direction === "en-ja" ? "" : ", romaji"} for the line
${wordChecklist}
`;
}

// ---------------------------------------------------------------------------
// Stanza prompt
// ---------------------------------------------------------------------------

export function buildStanzaPrompt(req: StanzaAnalysisRequest): string {
  const direction = resolveDirection(req.direction);
  const sysContext = systemContextFor(direction);

  return `${sysContext}

Analyze this stanza from the song "${req.songTitle}" by ${req.artistName}.
This is stanza ${req.stanzaNumber}.
Source language: ${sourceLanguageLabel(direction)}.

Stanza to analyze:
${req.stanza}

Split the stanza into individual lines. For each line, provide the full line-level analysis including all words${direction === "en-ja" ? "" : " and kanji breakdowns"}.
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
  const direction = resolveDirection(req.direction);
  const sysContext = systemContextFor(direction);
  const perLineBreakdown =
    direction === "en-ja"
      ? "For each stanza, split into lines. For each line, provide the full word-by-word breakdown (kanjiList stays empty for English)."
      : "For each stanza, split into lines. For each line, provide the full word-by-word and kanji breakdown.";

  return `${sysContext}

Analyze the complete lyrics of "${req.songTitle}" by ${req.artistName}.
Source language: ${sourceLanguageLabel(direction)}.

Full lyrics:
${req.fullLyrics}

Split the lyrics into stanzas (separated by blank lines or logical breaks).
${perLineBreakdown}
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
  /** Analysis direction. Defaults to "ja-en" if omitted. */
  direction?: AnalysisDirection;
}

export function buildStanzaOverviewFromLinesPrompt(
  input: StanzaOverviewPromptInput
): string {
  const direction = resolveDirection(input.direction);
  const sysContext = systemContextFor(direction);
  const targetLabel = direction === "en-ja" ? "Japanese" : "English";
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

  return `${sysContext}

You are completing STANZA-level fields for a bottom-up pipeline.
Line-level JSON analyses were already produced with the line contract. Use them as ground truth; do not contradict their readings or word splits.

Song: "${input.songTitle}" by ${input.artistName}
Stanza index: ${input.stanzaNumber}
Source language: ${sourceLanguageLabel(direction)}.

Full stanza (source):
${input.stanzaJapanese}

Line analyses (JSON):
${JSON.stringify(linePayload, null, 2)}

Return ONLY JSON with:
- directTranslation: literal ${targetLabel} for the entire stanza (list-style bullets inside the string are OK)
- culturalTranslation: natural ${targetLabel} for the entire stanza
- summary: 1-2 ${targetLabel} sentences on what this stanza expresses
`;
}

export interface SongOverviewPromptInput {
  songTitle: string;
  artistName: string;
  fullLyrics: string;
  stanzas: AnalysisStanza[];
  /** Analysis direction. Defaults to "ja-en" if omitted. */
  direction?: AnalysisDirection;
}

export function buildSongOverviewFromStanzasPrompt(
  input: SongOverviewPromptInput
): string {
  const direction = resolveDirection(input.direction);
  const sysContext = systemContextFor(direction);
  const targetLabel = direction === "en-ja" ? "Japanese" : "English";
  const stanzaPayload = input.stanzas.map((s) => ({
    stanzaNumber: s.stanzaNumber,
    japanese: s.japanese,
    directTranslation: s.directTranslation,
    culturalTranslation: s.culturalTranslation,
    summary: s.summary,
    lineCount: s.lines.length,
  }));

  return `${sysContext}

You are completing SONG-level fields for a bottom-up pipeline.
Each stanza was built from per-line analyses, then stanza-level overview fields. Use the stanza material as ground truth.

Song: "${input.songTitle}" by ${input.artistName}
Source language: ${sourceLanguageLabel(direction)}.

Full lyrics (source):
${input.fullLyrics}

Stanza overviews (JSON):
${JSON.stringify(stanzaPayload, null, 2)}

Return ONLY JSON with:
- culturalTranslation: natural ${targetLabel} for the entire song (list-style bullets inside the string are OK)
- summary: 2-4 ${targetLabel} sentences on themes, emotion, and cultural context for the whole song
`;
}

// ---------------------------------------------------------------------------
// Ask-about-selection prompt — free-form Q&A over a highlighted region.
// Distinct from line analysis: output is a single concise `answer` string
// in the target language, nothing structured. Same direction-aware system
// context family as the other builders, so behavior stays consistent.
// ---------------------------------------------------------------------------

export function buildAskAboutSelectionPrompt(
  req: AskAboutSelectionRequest
): string {
  const direction = resolveDirection(req.direction);
  const sysContext = systemContextFor(direction);
  const targetLabel = direction === "en-ja" ? "Japanese" : "English";
  const songContext =
    req.songTitle || req.artistName
      ? `Song: "${req.songTitle ?? "Unknown"}" by ${req.artistName ?? "Unknown"}.`
      : "";

  return `${sysContext}

QA task: the user highlighted a span of the ${sourceLanguageLabel(direction)} lyric and asked a question about it.
${songContext}
Source language: ${sourceLanguageLabel(direction)}.

Highlighted selection (verbatim):
${req.text}

User's question (may be in any language — answer in ${targetLabel}):
${req.question}

Return ONLY JSON matching the provided schema. The \`answer\` field must be:
- 1 to 4 short sentences, or a short bullet list inside the string using "- " prefixes.
- In ${targetLabel}. Do not echo the question or the selection.
- Direct, educational, and specific to what the user asked. If the question is unclear or off-topic, say so briefly and redirect.
- No markdown, no headings, no prose outside the JSON.
`;
}

// ---------------------------------------------------------------------------
// Word detail prompt — on-demand deeper analysis for a single word.
// Returns conjugations (verbs/adjectives only), alternatives at different
// politeness/formality levels, and 1-3 fresh example sentences.
// ---------------------------------------------------------------------------

export function buildWordDetailPrompt(req: WordDetailRequest): string {
  const direction = resolveDirection(req.direction);
  const sysContext = systemContextFor(direction);
  const sourceLabel = sourceLanguageLabel(direction);
  const targetLabel = direction === "en-ja" ? "Japanese" : "English";
  const bits: string[] = [];
  bits.push(`Word: ${req.surface}`);
  if (req.romaji) bits.push(`Romaji: ${req.romaji}`);
  if (req.type) bits.push(`POS: ${req.type}`);
  if (req.songTitle) {
    bits.push(
      `Song context: "${req.songTitle}" by ${req.artistName ?? "Unknown"}`
    );
  }

  return `${sysContext}

WORD DETAIL task: produce conjugations (if applicable), alternative phrasings at different politeness levels (if applicable), and a few fresh example sentences for this ${sourceLabel} word. This is separate from line-level analysis — assume the user already knows the word's basic meaning in context.

${bits.join("\n")}

Return ONLY JSON matching the provided schema.

Instructions:
- "conjugations": for verbs/adjectives (Japanese ru/godan/irregular verbs, い/な adjectives, English verbs/adjectives), list 4-8 core forms — at minimum: plain, polite/-masu (or past tense for English), past, negative, te-form or -ing. Each entry has a short "description" (e.g. "dictionary form", "polite non-past"). For non-verb/non-adjective words, return [].
- "alternatives": up to 3 alternative phrasings that preserve the core meaning but differ in register. "register" must be one of "casual", "formal", or "same" (same register, just a synonym). Empty array when no natural alternative exists (e.g. pure particles, proper nouns).
- "exampleSentences": 1-3 short sentences USING the word in realistic contexts. Keep each sentence on one line. "source" is in ${sourceLabel}; "translation" is a natural ${targetLabel} translation. Do not repeat the word's meaning — just show it in use.
- For English source words: set "reading" and "romaji" to empty strings "".
- No markdown, no headings, no prose outside the JSON.
`;
}
