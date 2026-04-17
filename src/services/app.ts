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

import { setGeminiApiKey, setGeminiModel } from "../lib/gemini";
import { setSpotifyToken } from "../domains/playlist/adapters/spotify";
import { setYouTubeApiKey } from "../domains/playlist/adapters/youtube";

export const setup = {
  setGeminiApiKey,
  setGeminiModel,
  setSpotifyToken,
  setYouTubeApiKey,
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
} from "../domains/analysis/service";
import type {
  AnalysisOptions,
  AnalyzeSongBottomUpParams,
} from "../domains/analysis/service";

import { exportLine, exportSong } from "../domains/dictionary/service";

export const cd = {
  fetchPlaylist,
  fetchSong,
  getTrackByPosition,
  analyzeLine,
  analyzeStanza,
  analyzeSong,
  analyzeStanzaByLines,
  analyzeSongBottomUp,
  saveLineToDictionary: exportLine,
  saveSongToDictionary: exportSong,
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
export type { ExportContext, ExportResult } from "../domains/dictionary/export";
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
  AnalysisLine,
  AnalysisStanza,
  AnalysisWord,
  AnalysisKanji,
  SongAnalysis,
  WordType,
  Transitivity,
  TextLocation,
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
