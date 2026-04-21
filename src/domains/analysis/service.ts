/**
 * Analysis service — public API for the analysis domain.
 *
 * Orchestrates: check cache → build prompt → call LLM (NVIDIA or Azure) → parse → cache → return.
 * Three entry points: analyzeLine, analyzeStanza, analyzeSong.
 */

import type {
  AnalysisDirection,
  AnalysisLine,
  AnalysisStanza,
  SongAnalysis,
  WordDetail,
} from "./types";
import type {
  AskAboutSelectionRequest,
  AskAboutSelectionResponse,
  LineAnalysisRequest,
  StanzaAnalysisRequest,
  SongAnalysisRequest,
  LineAnalysisResponse,
  StanzaAnalysisResponse,
  SongAnalysisResponse,
  StanzaOverviewFromLinesResponse,
  SongOverviewFromStanzasResponse,
  WordDetailRequest,
  WordDetailResponse,
} from "./schemas";
import {
  buildAskAboutSelectionPrompt,
  buildLinePrompt,
  buildStanzaPrompt,
  buildSongPrompt,
  buildStanzaOverviewFromLinesPrompt,
  buildSongOverviewFromStanzasPrompt,
  buildWordDetailPrompt,
} from "./prompts";
import {
  ASK_ABOUT_SELECTION_CONTRACT,
  LINE_ANALYSIS_CONTRACT,
  STANZA_ANALYSIS_CONTRACT,
  SONG_ANALYSIS_CONTRACT,
  STANZA_OVERVIEW_FROM_LINES_CONTRACT,
  SONG_OVERVIEW_FROM_STANZAS_CONTRACT,
  WORD_DETAIL_CONTRACT,
} from "./contracts";
import {
  parseAskAnswer,
  parseLine,
  parseStanza,
  parseSong,
  parseWordDetail,
} from "./parsers";
import {
  getCachedLine,
  cacheLine,
  getCachedStanza,
  cacheStanza,
  cacheStanzaLines,
  getCachedSong,
  cacheSongAnalysis,
  cacheSongStanzas,
} from "./cache";
import { callLlmStructured } from "../../lib/llm";
import {
  LLM_MAX_ASK_SELECTION,
  LLM_MAX_LINE,
  LLM_MAX_SONG,
  LLM_MAX_SONG_OVERVIEW_FROM_STANZAS,
  LLM_MAX_STANZA,
  LLM_MAX_STANZA_OVERVIEW_FROM_LINES,
  LLM_MAX_WORD_DETAIL,
} from "./llm-limits";
import { mapWithConcurrency } from "../../lib/concurrency";
import { splitPastedLyricsIntoStanzas } from "./lyricsSplit";
import { AnalysisError } from "../../lib/errors";

// ---------------------------------------------------------------------------
// Options shared across all analysis calls
// ---------------------------------------------------------------------------

export interface AnalysisOptions {
  /** Skip cache and re-analyze. Default: false. */
  forceRefresh?: boolean;
  /**
   * Skip reading AND writing the line cache for this call. Used for
   * one-off analyses that don't map to a stable (stanzaNumber, lineNumber)
   * — e.g. the lyric UI's "analyze selection" / ✎ path, which passes
   * sentinel positions (0, 0) that would otherwise pollute the cache.
   * Default: false.
   */
  skipCache?: boolean;
  /**
   * Max parallel LLM requests for bottom-up line batches.
   * Lower this if you hit rate limits. Default: 4.
   */
  maxConcurrentLlm?: number;
}

function resolveDirection(
  direction: AnalysisDirection | undefined
): AnalysisDirection {
  return direction === "en-ja" ? "en-ja" : "ja-en";
}

// ---------------------------------------------------------------------------
// Line analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a single line of lyrics.
 * This is the primary, most production-ready path.
 */
export async function analyzeLine(
  req: LineAnalysisRequest,
  songId: string,
  options: AnalysisOptions = {}
): Promise<AnalysisLine> {
  const direction = resolveDirection(req.direction);

  // User-facing guard: a blank line is a structural bug upstream
  // (splitLyrics should filter those) — reject with an actionable
  // message instead of letting the model burn a token budget and then
  // surfacing a schema error.
  const trimmedLine = typeof req.line === "string" ? req.line.trim() : "";
  if (trimmedLine.length === 0) {
    throw new AnalysisError(
      "Cannot analyze an empty line. Make sure the lyric line contains text before translating."
    );
  }

  if (!options.skipCache && !options.forceRefresh) {
    const cached = await getCachedLine(
      songId,
      req.stanzaNumber,
      req.lineNumber
    );
    // Treat a cached analysis with an empty `words` array on a non-empty
    // source line as a miss. The Llama-70B provider occasionally drops
    // the per-word breakdown on lines with contracted/compound verb
    // forms (e.g. 燃やして, 手放した, 呆れた) — that bad shape used to
    // end up cached and replayed on every re-click, so token cards
    // never showed. Re-running through the fresh path + retry below
    // self-heals those entries without any manual cache wipe.
    // Lines with legit populated words are untouched.
    if (cached && !(cached.words.length === 0 && trimmedLine.length > 0)) {
      return cached;
    }
  }

  const prompt = buildLinePrompt(req);
  const raw = await callLlmStructured<LineAnalysisResponse>({
    prompt,
    responseSchema: LINE_ANALYSIS_CONTRACT as Record<string, unknown>,
    maxCompletionTokens: LLM_MAX_LINE,
  });

  // Pass req.lineNumber AND req.line as authoritative overrides:
  //   - lineNumber: the model often returns its own number (frequently 1)
  //     which would desync cache read/write keys and force every repeat
  //     click to re-fetch.
  //   - line (source): the user's original line text wins over whatever
  //     the model echoes in `raw.japanese`, and rescues the common case
  //     where the model drops that field entirely (especially for
  //     en-ja analyses where the schema field name is `japanese` but
  //     the source is English).
  let result = parseLine(raw, req.stanzaNumber, direction, req.lineNumber, req.line);
  if (result === null) {
    // Normalizer couldn't recover a usable line shape. With the
    // blank-input guard above this is effectively "the model returned
    // no translation" — surface that, not a schema-field error.
    throw new AnalysisError(
      "The analysis provider returned no translation for this line. Try again in a moment."
    );
  }

  // Targeted retry for the "empty words array on a valid Japanese line"
  // quirk. The schema and the system prompt already require `words` to
  // be populated, but the 70B model sometimes cuts the array short on
  // lines with contracted/compound forms. One focused re-ask reliably
  // recovers the breakdown for those lines. Guarded by the empty-words
  // condition so working lines never see a second round-trip.
  if (result.words.length === 0 && trimmedLine.length > 0) {
    try {
      const retryPrompt =
        prompt +
        "\n\nIMPORTANT — the previous response was missing the per-word breakdown. The `words` array in your JSON MUST contain every token in the source line, in order of appearance: particles (の, は, を, が, …), auxiliaries (ない, て, た, だ, …), verb stems and their conjugated endings, adjectives, and nouns. Do NOT return an empty `words` array. Every other field must remain consistent with the schema.";
      const retryRaw = await callNvidiaStructured<LineAnalysisResponse>({
        prompt: retryPrompt,
        responseSchema: LINE_ANALYSIS_CONTRACT as Record<string, unknown>,
      });
      const retryResult = parseLine(
        retryRaw,
        req.stanzaNumber,
        direction,
        req.lineNumber,
        req.line
      );
      if (retryResult !== null && retryResult.words.length > 0) {
        result = retryResult;
      }
    } catch {
      // Retry failed (upstream 4xx/5xx, JSON parse, etc.). Fall back to
      // the original partial result so the user still sees direct and
      // cultural translation — strict no-regression for the working
      // parts of the line. No infinite loops; retry is one-shot.
    }
  }

  if (!options.skipCache) {
    await cacheLine(songId, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stanza analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a full stanza. Caches the stanza and all its lines.
 */
export async function analyzeStanza(
  req: StanzaAnalysisRequest,
  songId: string,
  options: AnalysisOptions = {}
): Promise<AnalysisStanza> {
  const direction = resolveDirection(req.direction);
  if (!options.forceRefresh) {
    const cached = await getCachedStanza(songId, req.stanzaNumber);
    if (cached) return cached;
  }

  const prompt = buildStanzaPrompt(req);
  const raw = await callLlmStructured<StanzaAnalysisResponse>({
    prompt,
    responseSchema: STANZA_ANALYSIS_CONTRACT as Record<string, unknown>,
    maxCompletionTokens: LLM_MAX_STANZA,
  });

  // req.stanza is the authoritative source text — see analyzeLine.
  const result = parseStanza(raw, direction, req.stanza);

  // Cache the stanza and all its individual lines
  await Promise.all([
    cacheStanza(songId, result),
    cacheStanzaLines(songId, result),
  ]);

  return result;
}

// ---------------------------------------------------------------------------
// Full-song analysis
// ---------------------------------------------------------------------------

/**
 * Analyze an entire song. Caches the song, all stanzas, and all lines.
 */
export async function analyzeSong(
  req: SongAnalysisRequest,
  songId: string,
  options: AnalysisOptions = {}
): Promise<SongAnalysis> {
  const direction = resolveDirection(req.direction);
  if (!options.forceRefresh) {
    const cached = await getCachedSong(songId);
    if (cached) return cached;
  }

  const prompt = buildSongPrompt(req);
  const raw = await callLlmStructured<SongAnalysisResponse>({
    prompt,
    responseSchema: SONG_ANALYSIS_CONTRACT as Record<string, unknown>,
    maxCompletionTokens: LLM_MAX_SONG,
  });

  // Derive per-stanza source text from the user's full lyrics so each
  // parseStanza call gets an authoritative override — see analyzeLine.
  const stanzaSourceOverrides = splitPastedLyricsIntoStanzas(req.fullLyrics).map(
    (lines) => lines.join("\n")
  );
  const result = parseSong(raw, req.fullLyrics, direction, stanzaSourceOverrides);

  // Cache everything: song-level, stanza-level, and line-level
  await Promise.all([
    cacheSongAnalysis(songId, result),
    cacheSongStanzas(songId, result),
  ]);

  return result;
}

// ---------------------------------------------------------------------------
// Bottom-up composition helpers
// ---------------------------------------------------------------------------

async function finalizeStanzaFromAnalyzedLines(
  songTitle: string,
  artistName: string,
  stanzaNumber: number,
  lines: string[],
  lineResults: AnalysisLine[],
  direction: AnalysisDirection
): Promise<AnalysisStanza> {
  const raw = await callLlmStructured<StanzaOverviewFromLinesResponse>({
    prompt: buildStanzaOverviewFromLinesPrompt({
      songTitle,
      artistName,
      stanzaNumber,
      stanzaJapanese: lines.join("\n"),
      lines: lineResults,
      direction,
    }),
    responseSchema: STANZA_OVERVIEW_FROM_LINES_CONTRACT as Record<
      string,
      unknown
    >,
    maxCompletionTokens: LLM_MAX_STANZA_OVERVIEW_FROM_LINES,
  });

  return {
    japanese: lines.join("\n"),
    stanzaNumber,
    direction,
    directTranslation: raw.directTranslation,
    culturalTranslation: raw.culturalTranslation,
    summary: raw.summary,
    lines: lineResults,
  };
}

/**
 * Analyze each line in a stanza individually (bounded parallelism), then
 * one stanza-level LLM pass for direct/cultural translation and summary.
 */
export async function analyzeStanzaByLines(
  lines: string[],
  songTitle: string,
  artistName: string,
  stanzaNumber: number,
  songId: string,
  options: AnalysisOptions & { direction?: AnalysisDirection } = {}
): Promise<AnalysisStanza> {
  const concurrency = options.maxConcurrentLlm ?? 4;
  const direction = resolveDirection(options.direction);

  const lineResults = await mapWithConcurrency(
    lines,
    concurrency,
    (line, i) =>
      analyzeLine(
        {
          line,
          songTitle,
          artistName,
          stanzaNumber,
          lineNumber: i + 1,
          surroundingLines: lines,
          direction,
        },
        songId,
        options
      )
  );

  const composed = await finalizeStanzaFromAnalyzedLines(
    songTitle,
    artistName,
    stanzaNumber,
    lines,
    lineResults,
    direction
  );

  await cacheStanza(songId, composed);
  return composed;
}

export interface AnalyzeSongBottomUpParams {
  songId: string;
  songTitle: string;
  artistName: string;
  /** Raw pasted lyrics; blank lines separate stanzas, newlines separate lines. */
  fullLyrics: string;
  /** Analysis direction. Defaults to "ja-en" if omitted. */
  direction?: AnalysisDirection;
}

/**
 * Bottom-up song analysis: lines (parallel LLM calls) → stanza overview per stanza →
 * song-level overview. Caches lines, stanzas, and the full song like {@link analyzeSong}.
 */
export async function analyzeSongBottomUp(
  params: AnalyzeSongBottomUpParams,
  options: AnalysisOptions = {}
): Promise<SongAnalysis> {
  const { songId, songTitle, artistName, fullLyrics } = params;
  const concurrency = options.maxConcurrentLlm ?? 4;
  const direction = resolveDirection(params.direction);

  if (!options.forceRefresh) {
    const cached = await getCachedSong(songId);
    if (cached) return cached;
  }

  const stanzaBlocks = splitPastedLyricsIntoStanzas(fullLyrics);
  if (stanzaBlocks.length === 0) {
    throw new AnalysisError(
      "Lyrics are empty or could not be split into stanzas. Use blank lines between stanzas."
    );
  }

  const stanzas: AnalysisStanza[] = [];

  for (let s = 0; s < stanzaBlocks.length; s++) {
    const lines = stanzaBlocks[s]!;
    const stanzaNumber = s + 1;

    const lineResults = await mapWithConcurrency(
      lines,
      concurrency,
      (line, i) =>
        analyzeLine(
          {
            line,
            songTitle,
            artistName,
            stanzaNumber,
            lineNumber: i + 1,
            surroundingLines: lines,
            direction,
          },
          songId,
          options
        )
    );

    const stanza = await finalizeStanzaFromAnalyzedLines(
      songTitle,
      artistName,
      stanzaNumber,
      lines,
      lineResults,
      direction
    );

    await Promise.all([
      cacheStanza(songId, stanza),
      cacheStanzaLines(songId, stanza),
    ]);

    stanzas.push(stanza);
  }

  const songRaw = await callLlmStructured<SongOverviewFromStanzasResponse>({
    prompt: buildSongOverviewFromStanzasPrompt({
      songTitle,
      artistName,
      fullLyrics,
      stanzas,
      direction,
    }),
    responseSchema: SONG_OVERVIEW_FROM_STANZAS_CONTRACT as Record<
      string,
      unknown
    >,
    maxCompletionTokens: LLM_MAX_SONG_OVERVIEW_FROM_STANZAS,
  });

  const song: SongAnalysis = {
    songTitle,
    artistName,
    fullText: fullLyrics,
    direction,
    culturalTranslation: songRaw.culturalTranslation,
    summary: songRaw.summary,
    stanzas,
  };

  await Promise.all([
    cacheSongAnalysis(songId, song),
    cacheSongStanzas(songId, song),
  ]);

  return song;
}

// ---------------------------------------------------------------------------
// Free-form Q&A about a highlighted selection
//
// No cache table — these questions are one-shot and vary by question text,
// so a key derived from songId alone would be wrong, and building a stable
// (text, question) cache key isn't justified for a hackathon-scope feature.
// Each call hits the configured LLM proxy through the shared client.
// ---------------------------------------------------------------------------

export async function askAboutSelection(
  req: AskAboutSelectionRequest
): Promise<{ answer: string }> {
  const text = (req.text ?? "").trim();
  const question = (req.question ?? "").trim();
  if (text.length === 0) {
    throw new AnalysisError("askAboutSelection: selection text is empty.");
  }
  if (question.length === 0) {
    throw new AnalysisError("askAboutSelection: question is empty.");
  }

  const prompt = buildAskAboutSelectionPrompt(req);
  const raw = await callLlmStructured<AskAboutSelectionResponse>({
    prompt,
    responseSchema: ASK_ABOUT_SELECTION_CONTRACT as Record<string, unknown>,
    maxCompletionTokens: LLM_MAX_ASK_SELECTION,
  });
  return parseAskAnswer(raw);
}

// ---------------------------------------------------------------------------
// Word detail — on-demand deeper analysis for a single word
//
// Hit explicitly by the user via the lyric UI's "fetch conjugations &
// examples" button. No cache table in this domain — the lyric page keeps
// a session-local map keyed by (direction, surface) so repeated opens
// within a session reuse the response, and a real user wanting to
// re-analyze can dismiss the card and reopen. Keeps the Dexie surface
// smaller.
// ---------------------------------------------------------------------------

export async function analyzeWordDetail(
  req: WordDetailRequest
): Promise<WordDetail> {
  const surface = (req.surface ?? "").trim();
  if (surface.length === 0) {
    throw new AnalysisError("analyzeWordDetail: surface is empty.");
  }
  const prompt = buildWordDetailPrompt(req);
  const raw = await callLlmStructured<WordDetailResponse>({
    prompt,
    responseSchema: WORD_DETAIL_CONTRACT as Record<string, unknown>,
    maxCompletionTokens: LLM_MAX_WORD_DETAIL,
  });
  return parseWordDetail(raw, surface);
}
