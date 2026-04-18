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
import {
  getCachedPlaylist,
  cachePlaylist,
  getCachedSong,
  cacheSong,
} from "./cache";

// ---------------------------------------------------------------------------
// Auto-register adapters on import.
//
// - Spotify uses a user-supplied Bearer token and hits api.spotify.com
//   directly from the browser.
// - YouTube Music talks to /api/ytmusic/… (Vite-mounted Node middleware
//   backed by ytmusic-api), so it works in dev + preview. A production
//   deployment without that middleware would need the equivalent endpoint
//   hosted elsewhere.
// - Deezer remains a stub; not registered. Callers that ask for "deezer"
//   still get a clean "Provider not registered" from getAdapter() rather
//   than a fake "adapter not implemented" error.
// ---------------------------------------------------------------------------

registerAdapter(spotifyAdapter);
registerAdapter(youtubeAdapter);

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
