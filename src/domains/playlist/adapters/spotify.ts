/**
 * Spotify adapter.
 *
 * Normalizes Spotify Web API responses into the internal Playlist/SongMeta shapes.
 * The actual fetch calls use the Spotify Web API JSON format.
 * Auth token must be provided externally — this adapter does not handle OAuth.
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
// Spotify API response shapes (subset we actually use)
// ---------------------------------------------------------------------------

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyArtist {
  id: string;
  name: string;
  external_urls: { spotify: string };
}

interface SpotifyAlbum {
  id: string;
  name: string;
  images: SpotifyImage[];
  external_urls: { spotify: string };
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  duration_ms: number;
  external_urls: { spotify: string };
}

interface SpotifyPlaylistTrackItem {
  added_at: string;
  track: SpotifyTrack | null;
}

interface SpotifyPlaylistResponse {
  id: string;
  name: string;
  description: string | null;
  images: SpotifyImage[];
  external_urls: { spotify: string };
  tracks: {
    items: SpotifyPlaylistTrackItem[];
  };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function spotifySource(id: string, url: string): ProviderSource {
  return { provider: "spotify", externalId: id, externalUrl: url };
}

function normalizeSong(track: SpotifyTrack): SongMeta {
  return {
    title: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
    albumName: track.album.name,
    albumArtUrl: track.album.images[0]?.url,
    durationMs: track.duration_ms,
    source: spotifySource(track.id, track.external_urls.spotify),
  };
}

function normalizeTrack(
  item: SpotifyPlaylistTrackItem,
  position: number
): PlaylistTrack | null {
  if (!item.track) return null;
  return {
    id: generateId(),
    position,
    song: normalizeSong(item.track),
    addedAt: item.added_at ? new Date(item.added_at).getTime() : undefined,
  };
}

function bestImage(images: SpotifyImage[]): string | undefined {
  return images[0]?.url;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Wrapper around fetch that attaches the Bearer token and handles errors.
 * The token must be obtained externally (e.g. client credentials flow).
 */
async function spotifyFetch<T>(
  path: string,
  token: string
): Promise<T> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ProviderError(
      `Spotify API error ${res.status}: ${res.statusText}`,
      "spotify"
    );
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Token holder — set externally before making API calls
// ---------------------------------------------------------------------------

let accessToken: string | null = null;

export function setSpotifyToken(token: string): void {
  accessToken = token;
}

function requireToken(): string {
  if (!accessToken) {
    throw new ProviderError(
      "Spotify access token not set. Call setSpotifyToken() first.",
      "spotify"
    );
  }
  return accessToken;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const spotifyAdapter: PlaylistAdapter = {
  provider: "spotify",

  async fetchPlaylist(playlistId: string): Promise<Playlist> {
    const token = requireToken();
    const raw = await spotifyFetch<SpotifyPlaylistResponse>(
      `/playlists/${playlistId}`,
      token
    );

    const tracks: PlaylistTrack[] = [];
    for (let i = 0; i < raw.tracks.items.length; i++) {
      const normalized = normalizeTrack(raw.tracks.items[i], i);
      if (normalized) tracks.push(normalized);
    }

    return {
      id: generateId(),
      name: raw.name,
      description: raw.description ?? undefined,
      coverImageUrl: bestImage(raw.images),
      source: spotifySource(raw.id, raw.external_urls.spotify),
      tracks,
      fetchedAt: now(),
    };
  },

  async fetchSong(songId: string): Promise<SongMeta> {
    const token = requireToken();
    const raw = await spotifyFetch<SpotifyTrack>(
      `/tracks/${songId}`,
      token
    );
    return normalizeSong(raw);
  },
};
