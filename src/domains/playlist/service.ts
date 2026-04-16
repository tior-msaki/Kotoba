/**
 * Playlist service — public API for the playlist domain.
 *
 * Frontend and other domains call these functions.
 * Handles provider dispatch, caching, and normalization.
 */

import type { PlaylistProvider, Playlist, SongMeta } from "./types";
import { getAdapter, registerAdapter } from "./adapter";
import { spotifyAdapter } from "./adapters/spotify";
import { youtubeAdapter } from "./adapters/youtube";
import { deezerAdapter } from "./adapters/deezer";
import {
  getCachedPlaylist,
  cachePlaylist,
  getCachedSong,
  cacheSong,
} from "./cache";

// ---------------------------------------------------------------------------
// Auto-register all adapters on import
// ---------------------------------------------------------------------------

registerAdapter(spotifyAdapter);
registerAdapter(youtubeAdapter);
registerAdapter(deezerAdapter);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FetchPlaylistOptions {
  /** Skip the cache and re-fetch from the provider. Default: false. */
  forceRefresh?: boolean;
}

/**
 * Fetch a playlist from the given provider.
 * Returns a cached copy if available unless forceRefresh is true.
 */
export async function fetchPlaylist(
  provider: PlaylistProvider,
  playlistId: string,
  options: FetchPlaylistOptions = {}
): Promise<Playlist> {
  if (!options.forceRefresh) {
    const cached = await getCachedPlaylist(playlistId);
    if (cached) return cached;
  }

  const adapter = getAdapter(provider);
  const playlist = await adapter.fetchPlaylist(playlistId);
  await cachePlaylist(playlist);

  // Also cache each individual song for later lookups
  for (const track of playlist.tracks) {
    await cacheSong(track.song);
  }

  return playlist;
}

/**
 * Fetch a single song's metadata from the given provider.
 * Returns a cached copy if available.
 */
export async function fetchSong(
  provider: PlaylistProvider,
  songId: string
): Promise<SongMeta> {
  const cached = await getCachedSong(provider, songId);
  if (cached) return cached;

  const adapter = getAdapter(provider);
  const song = await adapter.fetchSong(songId);
  await cacheSong(song);

  return song;
}

/**
 * Get a track from an already-fetched playlist by position.
 * Returns undefined if the playlist isn't cached or the position is out of range.
 */
export async function getTrackByPosition(
  playlistId: string,
  position: number
): Promise<SongMeta | undefined> {
  const playlist = await getCachedPlaylist(playlistId);
  if (!playlist) return undefined;
  const track = playlist.tracks.find((t) => t.position === position);
  return track?.song;
}
