/**
 * YouTube Music playlist adapter.
 *
 * Fetches playlist / track data through the Node-side ytmusic-api
 * middleware mounted by vite.config.ts. Browser code NEVER imports
 * ytmusic-api directly (the package is Node-only); it always goes
 * through `/api/ytmusic/…`. This adapter normalizes the middleware's
 * response shape into the shared Playlist / SongMeta / ProviderSource
 * types so the rest of the app treats YouTube playlists identically to
 * Spotify ones.
 *
 * The setYouTubeApiKey / config.apiKey hook is kept for future compat
 * with a real Google Data API v3 backend — it's currently unused
 * because the middleware needs no key.
 */

import type { PlaylistAdapter } from "../adapter";
import type {
  Playlist,
  PlaylistTrack,
  SongMeta,
  ProviderSource,
} from "../types";
import { ProviderError } from "../../../lib/errors";
import { generateId, now } from "../../../lib/utils";

// ---------------------------------------------------------------------------
// API key holder — set externally if a future Google Data API v3 path needs it.
// ---------------------------------------------------------------------------

const config = { apiKey: null as string | null };

export function setYouTubeApiKey(key: string): void {
  config.apiKey = key;
}

// ---------------------------------------------------------------------------
// Shape of the middleware response — keep in sync with
// src/server/ytmusic-middleware.ts. We keep a minimal local copy instead
// of importing so the adapter never pulls server code into the client bundle.
// ---------------------------------------------------------------------------

interface MiddlewareTrack {
  kind?: "song";
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
}

interface MiddlewarePlaylist {
  playlistId: string;
  name: string;
  artist: string | null;
  trackCount: number;
  thumbnailUrl: string | null;
  tracks: MiddlewareTrack[];
}

interface MiddlewarePlaylistResponse {
  playlistId: string;
  playlist: MiddlewarePlaylist | null;
  error?: string;
}

interface MiddlewareSongResponse {
  videoId: string;
  track: MiddlewareTrack | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function youtubeSource(
  externalId: string,
  externalUrl: string
): ProviderSource {
  return { provider: "youtube", externalId, externalUrl };
}

function trackUrl(videoId: string): string {
  return `https://music.youtube.com/watch?v=${videoId}`;
}

function playlistUrl(playlistId: string): string {
  return `https://music.youtube.com/playlist?list=${playlistId}`;
}

function normalizeTrackToSong(t: MiddlewareTrack): SongMeta {
  return {
    title: t.title,
    artist: t.artist,
    albumName: t.album ?? undefined,
    albumArtUrl: t.thumbnailUrl ?? undefined,
    durationMs: t.durationMs ?? undefined,
    source: youtubeSource(t.videoId, trackUrl(t.videoId)),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    throw new ProviderError(
      `YouTube Music middleware unreachable: ${message}`,
      "youtube"
    );
  }
  let body: T & { error?: string };
  try {
    body = (await res.json()) as T & { error?: string };
  } catch {
    throw new ProviderError(
      `YouTube Music middleware returned a non-JSON response (status ${res.status})`,
      "youtube"
    );
  }
  if (!res.ok || body.error) {
    throw new ProviderError(
      body.error ?? `YouTube Music middleware failed with status ${res.status}`,
      "youtube"
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const youtubeAdapter: PlaylistAdapter = {
  provider: "youtube",

  async fetchPlaylist(playlistId: string): Promise<Playlist> {
    if (!playlistId || playlistId.trim().length === 0) {
      throw new ProviderError("YouTube playlist id is empty.", "youtube");
    }
    const body = await fetchJson<MiddlewarePlaylistResponse>(
      `/api/ytmusic/playlist?id=${encodeURIComponent(playlistId)}`
    );
    if (!body.playlist) {
      throw new ProviderError(
        "YouTube Music playlist came back empty.",
        "youtube"
      );
    }
    const pl = body.playlist;
    const tracks: PlaylistTrack[] = pl.tracks.map((t, i) => ({
      id: generateId(),
      position: i,
      song: normalizeTrackToSong(t),
    }));
    return {
      id: generateId(),
      name: pl.name,
      description: undefined,
      coverImageUrl: pl.thumbnailUrl ?? undefined,
      source: youtubeSource(pl.playlistId, playlistUrl(pl.playlistId)),
      tracks,
      fetchedAt: now(),
    };
  },

  async fetchSong(videoId: string): Promise<SongMeta> {
    if (!videoId || videoId.trim().length === 0) {
      throw new ProviderError("YouTube videoId is empty.", "youtube");
    }
    const body = await fetchJson<MiddlewareSongResponse>(
      `/api/ytmusic/song?videoId=${encodeURIComponent(videoId)}`
    );
    if (!body.track) {
      throw new ProviderError("YouTube Music song not found.", "youtube");
    }
    return normalizeTrackToSong(body.track);
  },
};
