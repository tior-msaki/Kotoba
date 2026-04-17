/**
 * Analysis service — public API for the analysis domain.
 *
 * Orchestrates: check cache → build prompt → call Gemini → parse → cache → return.
 * Three entry points: analyzeLine, analyzeStanza, analyzeSong.
 */

import type { AnalysisLine, AnalysisStanza, SongAnalysis } from "./types";
import type {
  LineAnalysisRequest,
  StanzaAnalysisRequest,
  SongAnalysisRequest,
  LineAnalysisResponse,
  StanzaAnalysisResponse,
  SongAnalysisResponse,
  StanzaOverviewFromLinesResponse,
  SongOverviewFromStanzasResponse,
} from "./schemas";
import {
  buildLinePrompt,
  buildStanzaPrompt,
  buildSongPrompt,
  buildStanzaOverviewFromLinesPrompt,
  buildSongOverviewFromStanzasPrompt,
} from "./prompts";
import {
  LINE_ANALYSIS_CONTRACT,
  STANZA_ANALYSIS_CONTRACT,
  SONG_ANALYSIS_CONTRACT,
  STANZA_OVERVIEW_FROM_LINES_CONTRACT,
  SONG_OVERVIEW_FROM_STANZAS_CONTRACT,
} from "./contracts";
import { parseLine, parseStanza, parseSong } from "./parsers";
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
import { callGeminiStructured } from "../../lib/gemini";
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
   * Max parallel Gemini requests for bottom-up line batches.
   * Lower this if you hit rate limits. Default: 4.
   */
  maxConcurrentGemini?: number;
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
  if (!options.forceRefresh) {
    const cached = await getCachedLine(
      songId,
      req.stanzaNumber,
      req.lineNumber
    );
    if (cached) return cached;
  }

  const prompt = buildLinePrompt(req);
  const raw = await callGeminiStructured<LineAnalysisResponse>({
    prompt,
    responseSchema: LINE_ANALYSIS_CONTRACT as Record<string, unknown>,
  });

  const result = parseLine(raw, req.stanzaNumber);
  await cacheLine(songId, result);

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
  if (!options.forceRefresh) {
    const cached = await getCachedStanza(songId, req.stanzaNumber);
    if (cached) return cached;
  }

  const prompt = buildStanzaPrompt(req);
  const raw = await callGeminiStructured<StanzaAnalysisResponse>({
    prompt,
    responseSchema: STANZA_ANALYSIS_CONTRACT as Record<string, unknown>,
  });

  const result = parseStanza(raw);

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
  if (!options.forceRefresh) {
    const cached = await getCachedSong(songId);
    if (cached) return cached;
  }

  const prompt = buildSongPrompt(req);
  const raw = await callGeminiStructured<SongAnalysisResponse>({
    prompt,
    responseSchema: SONG_ANALYSIS_CONTRACT as Record<string, unknown>,
  });

  const result = parseSong(raw, req.fullLyrics);

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
  lineResults: AnalysisLine[]
): Promise<AnalysisStanza> {
  const raw = await callGeminiStructured<StanzaOverviewFromLinesResponse>({
    prompt: buildStanzaOverviewFromLinesPrompt({
      songTitle,
      artistName,
      stanzaNumber,
      stanzaJapanese: lines.join("\n"),
      lines: lineResults,
    }),
    responseSchema: STANZA_OVERVIEW_FROM_LINES_CONTRACT as Record<
      string,
      unknown
    >,
  });

  return {
    japanese: lines.join("\n"),
    stanzaNumber,
    directTranslation: raw.directTranslation,
    culturalTranslation: raw.culturalTranslation,
    summary: raw.summary,
    lines: lineResults,
  };
}

/**
 * Analyze each line in a stanza individually (bounded parallelism), then
 * one stanza-level Gemini pass for direct/cultural translation and summary.
 */
export async function analyzeStanzaByLines(
  lines: string[],
  songTitle: string,
  artistName: string,
  stanzaNumber: number,
  songId: string,
  options: AnalysisOptions = {}
): Promise<AnalysisStanza> {
  const concurrency = options.maxConcurrentGemini ?? 4;

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
    lineResults
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
}

/**
 * Bottom-up song analysis: lines (parallel Gemini) → stanza overview per stanza →
 * song-level overview. Caches lines, stanzas, and the full song like {@link analyzeSong}.
 */
export async function analyzeSongBottomUp(
  params: AnalyzeSongBottomUpParams,
  options: AnalysisOptions = {}
): Promise<SongAnalysis> {
  const { songId, songTitle, artistName, fullLyrics } = params;
  const concurrency = options.maxConcurrentGemini ?? 4;

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
      lineResults
    );

    await Promise.all([
      cacheStanza(songId, stanza),
      cacheStanzaLines(songId, stanza),
    ]);

    stanzas.push(stanza);
  }

  const songRaw = await callGeminiStructured<SongOverviewFromStanzasResponse>({
    prompt: buildSongOverviewFromStanzasPrompt({
      songTitle,
      artistName,
      fullLyrics,
      stanzas,
    }),
    responseSchema: SONG_OVERVIEW_FROM_STANZAS_CONTRACT as Record<
      string,
      unknown
    >,
  });

  const song: SongAnalysis = {
    songTitle,
    artistName,
    fullText: fullLyrics,
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
