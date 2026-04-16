/**
 * Playlist cache layer.
 *
 * Thin read/write against playlistsCache and songsCache tables.
 * Keeps fetched playlists and songs in IndexedDB so repeat visits
 * don't re-hit provider APIs.
 */

import { db } from "../../db";
import { now } from "../../lib/utils";
import type { Playlist, SongMeta } from "./types";
import type { StoredSong } from "../../db/schema";

/** Build the deterministic song cache key: `provider:externalId`. */
export function songCacheKey(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

// ---------------------------------------------------------------------------
// Playlist cache
// ---------------------------------------------------------------------------

export async function getCachedPlaylist(
  id: string
): Promise<Playlist | undefined> {
  return db.playlistsCache.get(id);
}

export async function cachePlaylist(playlist: Playlist): Promise<void> {
  await db.playlistsCache.put(playlist);
}

// ---------------------------------------------------------------------------
// Song cache
// ---------------------------------------------------------------------------

export async function getCachedSong(
  provider: string,
  externalId: string
): Promise<SongMeta | undefined> {
  const key = songCacheKey(provider, externalId);
  const stored = await db.songsCache.get(key);
  return stored?.song;
}

export async function cacheSong(song: SongMeta): Promise<void> {
  const key = songCacheKey(song.source.provider, song.source.externalId);
  const record: StoredSong = { id: key, song, cachedAt: now() };
  await db.songsCache.put(record);
}

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

/** Remove a cached playlist by ID. */
export async function evictPlaylist(id: string): Promise<void> {
  await db.playlistsCache.delete(id);
}

/** Remove all cached playlists older than `maxAgeMs`. */
export async function evictStalePlaylists(maxAgeMs: number): Promise<number> {
  const cutoff = now() - maxAgeMs;
  const stale = await db.playlistsCache
    .where("fetchedAt")
    .below(cutoff)
    .primaryKeys();
  await db.playlistsCache.bulkDelete(stale);
  return stale.length;
}
