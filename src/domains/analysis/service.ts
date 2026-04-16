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
} from "./schemas";
import { buildLinePrompt, buildStanzaPrompt, buildSongPrompt } from "./prompts";
import {
  LINE_ANALYSIS_CONTRACT,
  STANZA_ANALYSIS_CONTRACT,
  SONG_ANALYSIS_CONTRACT,
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

// ---------------------------------------------------------------------------
// Options shared across all analysis calls
// ---------------------------------------------------------------------------

export interface AnalysisOptions {
  /** Skip cache and re-analyze. Default: false. */
  forceRefresh?: boolean;
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

/**
 * Analyze each line in a stanza individually, then compose into a stanza.
 * Useful when you want line-by-line progress feedback or already have
 * some lines cached.
 */
export async function analyzeStanzaByLines(
  lines: string[],
  songTitle: string,
  artistName: string,
  stanzaNumber: number,
  songId: string,
  options: AnalysisOptions = {}
): Promise<AnalysisStanza> {
  const lineResults = await Promise.all(
    lines.map((line, i) =>
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
    )
  );

  const composed: AnalysisStanza = {
    japanese: lines.join("\n"),
    stanzaNumber,
    directTranslation: lineResults
      .map((l) => l.directTranslation)
      .join("\n"),
    culturalTranslation: lineResults
      .map((l) => l.culturalTranslation)
      .join("\n"),
    lines: lineResults,
  };

  await cacheStanza(songId, composed);
  return composed;
}
