/**
 * Unified app service façade.
 *
 * Single import point for the frontend. Every backend capability is
 * accessible through one of five namespaces matching the desk metaphor:
 *
 *   import { cd, dictionary, notes, rewards, setup } from "@/services/app";
 *
 * Each namespace re-exports from the corresponding domain service.
 * No logic lives here — if you're adding business logic, it belongs
 * in the domain service instead.
 */

// ---------------------------------------------------------------------------
// Setup / configuration
// ---------------------------------------------------------------------------

import { setNvidiaApiKey, setNvidiaModel } from "../lib/nvidia";
import { setSpotifyToken } from "../domains/playlist/adapters/spotify";
import { setYouTubeApiKey } from "../domains/playlist/adapters/youtube";

// ---------------------------------------------------------------------------
// Env loader — reads Vite's import.meta.env in the browser and process.env
// in Node (smoke tests, tooling). Applies any values that are present to the
// matching runtime setters. Runtime setters still work afterwards; callers
// can always override by calling setNvidiaApiKey / setSpotifyToken directly.
// ---------------------------------------------------------------------------

interface EnvValues {
  nvidiaApiKey?: string;
  nvidiaModel?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  youTubeApiKey?: string;
}

function readEnvValue(key: string): string | undefined {
  // Vite / browser
  try {
    // Wrapped: accessing import.meta in non-ESM contexts throws.
    const viteEnv = (import.meta as unknown as { env?: Record<string, string> })
      .env;
    const v = viteEnv?.[key];
    if (typeof v === "string" && v.length > 0) return v;
  } catch {
    // fall through to process.env
  }
  // Node (tsx scripts, tests)
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  const nodeVal = g.process?.env?.[key];
  if (typeof nodeVal === "string" && nodeVal.length > 0) return nodeVal;
  return undefined;
}

function readEnv(): EnvValues {
  return {
    nvidiaApiKey: readEnvValue("NVIDIA_API_KEY"),
    nvidiaModel: readEnvValue("NVIDIA_MODEL"),
    spotifyClientId: readEnvValue("SPOTIFY_CLIENT_ID"),
    spotifyClientSecret: readEnvValue("SPOTIFY_CLIENT_SECRET"),
    youTubeApiKey: readEnvValue("YOUTUBE_API_KEY"),
  };
}

/**
 * Apply any env values present in import.meta.env / process.env to the
 * matching runtime setters. Returns the raw values so callers can decide
 * what to do with Spotify client credentials (which require an async token
 * exchange before setSpotifyToken becomes useful).
 *
 * Safe to call multiple times; missing keys are left untouched.
 */
export function initFromEnv(): EnvValues {
  const env = readEnv();
  if (env.nvidiaApiKey) setNvidiaApiKey(env.nvidiaApiKey);
  if (env.nvidiaModel) setNvidiaModel(env.nvidiaModel);
  if (env.youTubeApiKey) setYouTubeApiKey(env.youTubeApiKey);
  // Spotify: we only have clientId/secret here. Token exchange is async and
  // network-bound; leave that to the caller (e.g. a burn-CD flow).
  return env;
}

export const setup = {
  setNvidiaApiKey,
  setNvidiaModel,
  setSpotifyToken,
  setYouTubeApiKey,
  initFromEnv,
} as const;

// ---------------------------------------------------------------------------
// CD / Playlist — "enter CD", load playlist, select song
// ---------------------------------------------------------------------------

import {
  fetchPlaylist,
  fetchSong,
  getTrackByPosition,
} from "../domains/playlist/service";
import type { FetchPlaylistOptions } from "../domains/playlist/service";

import {
  analyzeLine,
  analyzeStanza,
  analyzeSong,
  analyzeStanzaByLines,
  analyzeSongBottomUp,
  analyzeWordDetail,
  askAboutSelection,
} from "../domains/analysis/service";
import { getCachedLinesForSong } from "../domains/analysis/cache";
import type {
  AnalysisOptions,
  AnalyzeSongBottomUpParams,
} from "../domains/analysis/service";
import type {
  AskAboutSelectionRequest,
  AskAboutSelectionResponse,
  WordDetailRequest,
  WordDetailResponse,
} from "../domains/analysis/schemas";

import {
  exportLine,
  exportSong,
  exportWord,
} from "../domains/dictionary/service";

export const cd = {
  fetchPlaylist,
  fetchSong,
  getTrackByPosition,
  analyzeLine,
  analyzeStanza,
  analyzeSong,
  analyzeStanzaByLines,
  analyzeSongBottomUp,
  analyzeWordDetail,
  askAboutSelection,
  saveLineToDictionary: exportLine,
  saveSongToDictionary: exportSong,
  saveWordToDictionary: exportWord,
  getCachedLines: getCachedLinesForSong,
} as const;

// ---------------------------------------------------------------------------
// Music search — YouTube Music via the server-side middleware
// ---------------------------------------------------------------------------

import {
  searchSongs as ytmusicSearchSongs,
  getPlaylist as ytmusicGetPlaylist,
  getSong as ytmusicGetSong,
  getLyrics as ytmusicGetLyrics,
} from "../domains/music-search/service";
import { parseYouTubeMusicUrl } from "../domains/music-search/url";

export const search = {
  songs: ytmusicSearchSongs,
  playlist: ytmusicGetPlaylist,
  song: ytmusicGetSong,
  lyrics: ytmusicGetLyrics,
  parseUrl: parseYouTubeMusicUrl,
} as const;

// ---------------------------------------------------------------------------
// Dictionary — search, browse, CRUD
// ---------------------------------------------------------------------------

import {
  createEntry,
  updateEntry,
  getEntry,
  getAllEntries,
  getEntriesByLetter,
  getEntryCount,
  deleteEntry,
  deleteAllEntries,
  searchEntries,
  searchByLetter,
  getAvailableLetters,
  exportDictionary,
} from "../domains/dictionary/service";

export const dictionary = {
  add: createEntry,
  edit: updateEntry,
  get: getEntry,
  getAll: getAllEntries,
  getByLetter: getEntriesByLetter,
  getCount: getEntryCount,
  delete: deleteEntry,
  deleteAll: deleteAllEntries,
  search: searchEntries,
  searchByLetter,
  getAvailableLetters,
  export: exportDictionary,
} as const;

// ---------------------------------------------------------------------------
// Notes — create, edit, search
// ---------------------------------------------------------------------------

import {
  addNote,
  editNote,
  getNote,
  listNotes,
  getNoteCount,
  deleteNote,
  deleteAllNotes,
  searchNotes,
} from "../domains/notes/service";

export const notes = {
  add: addNote,
  edit: editNote,
  get: getNote,
  list: listNotes,
  getCount: getNoteCount,
  delete: deleteNote,
  deleteAll: deleteAllNotes,
  search: searchNotes,
} as const;

// ---------------------------------------------------------------------------
// Rewards — quiz, currency, gacha, photocards
// ---------------------------------------------------------------------------

import {
  startQuiz,
  submitQuizAnswer,
  submitQuizAnswerAndContinue,
  getSession,
  getCurrentQuestion,
  getActiveSessions,
  getCompletedSessions,
  deleteSession,
  getBalance,
  getHistory,
  earn,
  GACHA_PULL_COST,
  gachaPull,
  gachaPullMulti,
  getInventory,
  getInventoryByRarity,
  getCollectionProgress,
  getRewardsSummary,
} from "../domains/rewards/service";

export const rewards = {
  // Quiz
  startQuiz,
  submitQuizAnswer,
  submitQuizAnswerAndContinue,
  getSession,
  getCurrentQuestion,
  getActiveSessions,
  getCompletedSessions,
  deleteSession,

  // Currency
  getBalance,
  getHistory,
  earn,
  GACHA_PULL_COST,

  // Gacha
  gachaPull,
  gachaPullMulti,

  // Photocards
  getInventory,
  getInventoryByRarity,
  getCollectionProgress,

  // Dashboard
  getRewardsSummary,
} as const;

// ---------------------------------------------------------------------------
// Type re-exports for frontend convenience
// ---------------------------------------------------------------------------

export type { FetchPlaylistOptions };
export type { AnalysisOptions, AnalyzeSongBottomUpParams };
export type {
  MusicSearchResult,
  MusicSearchResponse,
  MusicPlaylist,
  LyricsResult,
} from "../domains/music-search/types";
export type { ParsedMusicUrl } from "../domains/music-search/url";
export type { AskAboutSelectionRequest, AskAboutSelectionResponse };
export type { WordDetailRequest, WordDetailResponse };
export type {
  ExportContext,
  ExportResult,
  WordExportOutcome,
} from "../domains/dictionary/export";
export type { AnswerResult } from "../domains/rewards/quiz/service";
export type { RewardsSummary } from "../domains/rewards/service";
export type { NoteSearchResult } from "../domains/notes/service";

// Domain types the frontend will need
export type {
  PlaylistProvider,
  Playlist,
  PlaylistTrack,
  SongMeta,
  ProviderSource,
} from "../domains/playlist/types";

export type {
  AlternativeRegister,
  AnalysisDirection,
  AnalysisLine,
  AnalysisStanza,
  AnalysisWord,
  AnalysisKanji,
  SongAnalysis,
  WordType,
  Transitivity,
  TextLocation,
  WordConjugation,
  WordAlternative,
  WordExampleSentence,
  WordDetail,
} from "../domains/analysis/types";

export type {
  DictionaryEntry,
  DictionaryLanguage,
  DictionarySearchResult,
  DictionaryExport,
  DictionaryDirection,
  ContextMeaning,
  CreateDictionaryEntryInput,
  UpdateDictionaryEntryInput,
  SearchFilter,
} from "../domains/dictionary/types";

export type {
  Note,
  CreateNoteInput,
  UpdateNoteInput,
} from "../domains/notes/types";

export type {
  QuizSession,
  QuizQuestion,
  QuizOption,
  QuizQuestionType,
  QuizSessionStatus,
  CurrencyBalance,
  CurrencyTransaction,
  CurrencyTransactionType,
  GachaRarity,
  GachaPullResult,
  Photocard,
  PhotocardInventoryItem,
} from "../domains/rewards/types";
