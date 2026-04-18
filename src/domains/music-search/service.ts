/**
 * Music-search service — thin client that calls the server-side
 * ytmusic-api proxy.
 *
 * Data-fetching only. UI and playback logic live elsewhere.
 */

import type {
  LyricsResult,
  MusicPlaylist,
  MusicSearchResponse,
  MusicSearchResult,
} from "./types";
import { AppError } from "../../lib/errors";

export class MusicSearchError extends AppError {
  constructor(message: string) {
    super(message, "MUSIC_SEARCH_ERROR");
    this.name = "MusicSearchError";
  }
}

interface RequestOptions {
  signal?: AbortSignal;
}

async function fetchJson<T>(
  url: string,
  options: RequestOptions = {}
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    const message = err instanceof Error ? err.message : "network error";
    throw new MusicSearchError(`Network error: ${message}`);
  }

  let body: T & { error?: string };
  try {
    body = (await response.json()) as T & { error?: string };
  } catch {
    throw new MusicSearchError(
      `Non-JSON response from ${url} (status ${response.status})`
    );
  }

  if (!response.ok || body.error) {
    throw new MusicSearchError(
      body.error ?? `Request failed with status ${response.status}`
    );
  }

  return body;
}

export interface SearchSongsOptions extends RequestOptions {
  /** Max results; server clamps to [1, 50]. Default: 20. */
  limit?: number;
}

export async function searchSongs(
  query: string,
  options: SearchSongsOptions = {}
): Promise<MusicSearchResult[]> {
  const trimmed = (query ?? "").trim();
  if (trimmed.length === 0) return [];
  const params = new URLSearchParams({ q: trimmed });
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    params.set("limit", String(options.limit));
  }
  const body = await fetchJson<MusicSearchResponse>(
    `/api/ytmusic/search?${params.toString()}`,
    { signal: options.signal }
  );
  return Array.isArray(body.results) ? body.results : [];
}

interface PlaylistResponse {
  playlistId: string;
  playlist: MusicPlaylist | null;
  error?: string;
}

export async function getPlaylist(
  playlistId: string,
  options: RequestOptions = {}
): Promise<MusicPlaylist> {
  const id = (playlistId ?? "").trim();
  if (id.length === 0) {
    throw new MusicSearchError("Playlist id is required.");
  }
  const body = await fetchJson<PlaylistResponse>(
    `/api/ytmusic/playlist?id=${encodeURIComponent(id)}`,
    options
  );
  if (!body.playlist) {
    throw new MusicSearchError("Playlist came back empty.");
  }
  return body.playlist;
}

interface SongResponse {
  videoId: string;
  track: MusicSearchResult | null;
  error?: string;
}

export async function getSong(
  videoId: string,
  options: RequestOptions = {}
): Promise<MusicSearchResult> {
  const id = (videoId ?? "").trim();
  if (id.length === 0) {
    throw new MusicSearchError("Video id is required.");
  }
  const body = await fetchJson<SongResponse>(
    `/api/ytmusic/song?videoId=${encodeURIComponent(id)}`,
    options
  );
  if (!body.track) {
    throw new MusicSearchError("Track metadata not available.");
  }
  return body.track;
}

interface LyricsResponse {
  videoId: string;
  lyrics: LyricsResult;
  error?: string;
}

export async function getLyrics(
  videoId: string,
  options: RequestOptions = {}
): Promise<LyricsResult> {
  const id = (videoId ?? "").trim();
  if (id.length === 0) {
    throw new MusicSearchError("Video id is required.");
  }
  const body = await fetchJson<LyricsResponse>(
    `/api/ytmusic/lyrics?videoId=${encodeURIComponent(id)}`,
    options
  );
  return body.lyrics;
}
