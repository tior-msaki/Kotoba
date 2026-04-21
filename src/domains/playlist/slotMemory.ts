/**
 * Slot memory — per (playlistSlot, cdSlot) session persistence.
 *
 * Each unique (playlistSlotId, cdSlotId) pair gets its own independent
 * localStorage record holding the user-facing session state needed to
 * rehydrate that slot after navigation: the burned playlist source, the
 * active lyric track's text + direction + view, and the CD's FSM state
 * at save time.
 *
 * Heavy analysis data (per-line / per-stanza / per-song translations)
 * already lives in Dexie (`lineAnalysesCache`, `stanzaAnalysesCache`,
 * `songAnalysesCache`) keyed by `songId`. This module stores only the
 * *reference* (songId) plus the lightweight lyric text, so the existing
 * Dexie caches stay the single source of truth for analyses.
 *
 * Scope of this module: storage layer only. No hydration wiring, no
 * autosave, no UI changes. Designed to be imported directly by the
 * React bridge (`src/frontend/LegacyDesignFrame.tsx`) when that work
 * lands.
 */

import { now } from "../../lib/utils";
import type { AnalysisDirection } from "../analysis/types";

// ---------------------------------------------------------------------------
// Versioning + key format
// ---------------------------------------------------------------------------

export const SLOT_MEMORY_VERSION = 1 as const;

/**
 * Prefix for every slot-memory localStorage key. Versioned so a future
 * schema change can coexist with v1 records during migration.
 */
export const SLOT_KEY_PREFIX = "kotoba-slot-v1:";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type CdStatus = "none" | "ejected" | "inserted" | "burned";
export type LyricView = "all" | "stanza" | "line" | "word";
export type SlotProvider = "spotify" | "youtube" | "manual";

export interface SlotPlaylistSource {
  provider: SlotProvider;
  /** Original URL the user pasted into the burn popup (if any). */
  playlistUrl?: string;
  /** Provider's own playlist id, used to re-fetch via `cd.fetchPlaylist`. */
  playlistId?: string;
  playlistName?: string;
  tracks?: Array<{ id: string; title: string; artist: string }>;
}

export interface SlotLyricSession {
  /**
   * Joins to the Dexie analysis caches. Same value the bridge computes
   * via `stableSongId` — either `track:<externalId>` or
   * `lyric:<direction>:<title>:<artist>`.
   */
  songId: string;
  /** Provider track id for a burned-playlist track, when available. */
  sourceTrackId?: string;
  songTitle: string;
  artistName: string;
  direction: AnalysisDirection;
  /** Raw lyric text as pasted / fetched. Nothing else in the codebase
   *  persists this today, so the slot owns the lyric text for rehydration. */
  lyrics: string | null;
  view: LyricView;
  activeLineRef: { stanzaIndex: number; lineIndex: number } | null;
  activeStanzaIndex: number | null;
  isDemo: boolean;
  updatedAt: number;
}

export interface SlotCdState {
  status: CdStatus;
  lastUpdatedAt: number;
}

export interface SlotMemory {
  version: typeof SLOT_MEMORY_VERSION;
  playlistSlotId: string;
  cdSlotId: string;
  savedAt: number;
  source: SlotPlaylistSource | null;
  lyricSession: SlotLyricSession | null;
  cdState: SlotCdState | null;
}

export interface SlotKey {
  playlistSlotId: string;
  cdSlotId: string;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function normalizeIdComponent(id: string, label: string): string {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (trimmed.length === 0) {
    throw new Error(`slotMemory: ${label} must be a non-empty string`);
  }
  // encodeURIComponent keeps the key safe against ':' / '/' in ids and
  // keeps the parsed roundtrip lossless.
  return encodeURIComponent(trimmed);
}

export function slotStorageKey(
  playlistSlotId: string,
  cdSlotId: string
): string {
  return (
    SLOT_KEY_PREFIX +
    normalizeIdComponent(playlistSlotId, "playlistSlotId") +
    "/" +
    normalizeIdComponent(cdSlotId, "cdSlotId")
  );
}

/** Inverse of {@link slotStorageKey}. Returns null for keys that aren't ours. */
export function parseSlotStorageKey(key: string): SlotKey | null {
  if (typeof key !== "string" || !key.startsWith(SLOT_KEY_PREFIX)) return null;
  const body = key.slice(SLOT_KEY_PREFIX.length);
  const slash = body.indexOf("/");
  if (slash <= 0 || slash === body.length - 1) return null;
  try {
    return {
      playlistSlotId: decodeURIComponent(body.slice(0, slash)),
      cdSlotId: decodeURIComponent(body.slice(slash + 1)),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage backend
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  // Guarded for Node (smoke tests, tooling) and for browsers that throw
  // on `localStorage` access in private mode.
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deserialization helpers — accept partial / unknown shapes safely
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asDirection(v: unknown): AnalysisDirection {
  return v === "en-ja" ? "en-ja" : "ja-en";
}

function asView(v: unknown): LyricView {
  return v === "stanza" || v === "line" || v === "word" ? v : "all";
}

function asCdStatus(v: unknown): CdStatus {
  return v === "ejected" || v === "inserted" || v === "burned" ? v : "none";
}

function asProvider(v: unknown): SlotProvider {
  return v === "spotify" || v === "youtube" ? v : "manual";
}

function asFiniteNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asTracks(v: unknown): SlotPlaylistSource["tracks"] {
  if (!Array.isArray(v)) return undefined;
  const out: Array<{ id: string; title: string; artist: string }> = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    if (
      typeof raw.id === "string" &&
      typeof raw.title === "string" &&
      typeof raw.artist === "string"
    ) {
      out.push({ id: raw.id, title: raw.title, artist: raw.artist });
    }
  }
  return out;
}

function asSource(v: unknown): SlotPlaylistSource | null {
  if (v === null) return null;
  if (!isRecord(v)) return null;
  const source: SlotPlaylistSource = {
    provider: asProvider(v.provider),
  };
  const url = asOptionalString(v.playlistUrl);
  if (url) source.playlistUrl = url;
  const pid = asOptionalString(v.playlistId);
  if (pid) source.playlistId = pid;
  const name = asOptionalString(v.playlistName);
  if (name) source.playlistName = name;
  const tracks = asTracks(v.tracks);
  if (tracks) source.tracks = tracks;
  return source;
}

function asLyricSession(v: unknown): SlotLyricSession | null {
  if (v === null) return null;
  if (!isRecord(v)) return null;
  const songId = asOptionalString(v.songId);
  if (!songId) return null;
  const activeLine = isRecord(v.activeLineRef)
    ? {
        stanzaIndex: asFiniteNumber(v.activeLineRef.stanzaIndex, 0),
        lineIndex: asFiniteNumber(v.activeLineRef.lineIndex, 0),
      }
    : null;
  return {
    songId,
    sourceTrackId: asOptionalString(v.sourceTrackId),
    songTitle: asString(v.songTitle, "Unknown"),
    artistName: asString(v.artistName, "Unknown"),
    direction: asDirection(v.direction),
    lyrics: typeof v.lyrics === "string" ? v.lyrics : null,
    view: asView(v.view),
    activeLineRef: activeLine,
    activeStanzaIndex:
      typeof v.activeStanzaIndex === "number" &&
      Number.isFinite(v.activeStanzaIndex)
        ? v.activeStanzaIndex
        : null,
    isDemo: v.isDemo === true,
    updatedAt: asFiniteNumber(v.updatedAt, 0),
  };
}

function asCdStateBlock(v: unknown): SlotCdState | null {
  if (v === null) return null;
  if (!isRecord(v)) return null;
  return {
    status: asCdStatus(v.status),
    lastUpdatedAt: asFiniteNumber(v.lastUpdatedAt, 0),
  };
}

function reviveSlotMemory(raw: unknown, key: SlotKey): SlotMemory | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== SLOT_MEMORY_VERSION) return null;
  return {
    version: SLOT_MEMORY_VERSION,
    playlistSlotId: asString(raw.playlistSlotId, key.playlistSlotId),
    cdSlotId: asString(raw.cdSlotId, key.cdSlotId),
    savedAt: asFiniteNumber(raw.savedAt, 0),
    source: asSource(raw.source),
    lyricSession: asLyricSession(raw.lyricSession),
    cdState: asCdStateBlock(raw.cdState),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function hasSlotMemory(
  playlistSlotId: string,
  cdSlotId: string
): boolean {
  const s = storage();
  if (!s) return false;
  try {
    return s.getItem(slotStorageKey(playlistSlotId, cdSlotId)) !== null;
  } catch {
    return false;
  }
}

export function loadSlotMemory(
  playlistSlotId: string,
  cdSlotId: string
): SlotMemory | null {
  const s = storage();
  if (!s) return null;

  let raw: string | null;
  try {
    raw = s.getItem(slotStorageKey(playlistSlotId, cdSlotId));
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return reviveSlotMemory(parsed, { playlistSlotId, cdSlotId });
}

export interface SaveSlotMemoryInput {
  playlistSlotId: string;
  cdSlotId: string;
  source?: SlotPlaylistSource | null;
  lyricSession?: SlotLyricSession | null;
  cdState?: SlotCdState | null;
}

/**
 * Overwrite the slot's record with the supplied fields. Fields omitted
 * from `input` are written as `null` — use {@link updateSlotMemory} if
 * you want to preserve existing fields.
 */
export function saveSlotMemory(input: SaveSlotMemoryInput): SlotMemory {
  const record: SlotMemory = {
    version: SLOT_MEMORY_VERSION,
    playlistSlotId: input.playlistSlotId,
    cdSlotId: input.cdSlotId,
    savedAt: now(),
    source: input.source ?? null,
    lyricSession: input.lyricSession ?? null,
    cdState: input.cdState ?? null,
  };

  const s = storage();
  if (s) {
    try {
      s.setItem(
        slotStorageKey(input.playlistSlotId, input.cdSlotId),
        JSON.stringify(record)
      );
    } catch {
      // Storage quota / private mode. We intentionally swallow here so
      // future autosave callers never tear down the UI on a write fail.
      // Callers that must know can follow up with `hasSlotMemory`.
    }
  }
  return record;
}

/**
 * Partial save — merges the supplied fields into the existing record,
 * preserving any fields the caller didn't mention. Creates the slot if
 * it doesn't exist yet. Passing an explicit `null` clears that field.
 */
export function updateSlotMemory(input: SaveSlotMemoryInput): SlotMemory {
  const existing = loadSlotMemory(input.playlistSlotId, input.cdSlotId);
  return saveSlotMemory({
    playlistSlotId: input.playlistSlotId,
    cdSlotId: input.cdSlotId,
    source:
      "source" in input ? (input.source ?? null) : (existing?.source ?? null),
    lyricSession:
      "lyricSession" in input
        ? (input.lyricSession ?? null)
        : (existing?.lyricSession ?? null),
    cdState:
      "cdState" in input
        ? (input.cdState ?? null)
        : (existing?.cdState ?? null),
  });
}

/** Remove a single slot's record. No-op if the slot doesn't exist. */
export function clearSlotMemory(
  playlistSlotId: string,
  cdSlotId: string
): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(slotStorageKey(playlistSlotId, cdSlotId));
  } catch {
    // ignore
  }
}

/**
 * Pick the most-recently-saved slot for a given playlist slot id. Used
 * at home-bridge attach time to decide which CD (if any) should be
 * rehydrated onto the carousel position the user just entered.
 * Returns null when the playlist slot has no saved records.
 *
 * The optional `predicate` filters which slots are considered. Use it
 * to avoid picking a sub-slot that doesn't satisfy the caller's needs
 * — e.g. the home-bridge wants the latest slot with a real burned
 * source, not the latest manual lyric session, since a manual session
 * shouldn't be what paints the CD visuals.
 */
export function findLatestSlotForPlaylist(
  playlistSlotId: string,
  predicate?: (slot: SlotMemory) => boolean
): SlotMemory | null {
  let best: SlotMemory | null = null;
  for (const key of listSlotMemoryKeys()) {
    if (key.playlistSlotId !== playlistSlotId) continue;
    const slot = loadSlotMemory(key.playlistSlotId, key.cdSlotId);
    if (!slot) continue;
    if (predicate && !predicate(slot)) continue;
    if (!best || slot.savedAt > best.savedAt) best = slot;
  }
  return best;
}

/**
 * Enumerate every slot currently in localStorage. Does not touch any
 * non-slot keys. Intended for debug tooling and a future "reset all
 * slots" affordance — not part of the normal save/load path.
 */
export function listSlotMemoryKeys(): SlotKey[] {
  const s = storage();
  if (!s) return [];
  const out: SlotKey[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (!k) continue;
    const parsed = parseSlotStorageKey(k);
    if (parsed) out.push(parsed);
  }
  return out;
}
