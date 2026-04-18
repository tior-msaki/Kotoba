/**
 * Music-search domain types.
 *
 * These are the types the UI consumes. The server-side middleware
 * (src/server/ytmusic-middleware.ts) hands back data already shaped like
 * this, so the browser never touches `ytmusic-api`'s zod types directly.
 */

export interface MusicSearchResult {
  /** Today always "song"; room to add "album" / "artist" later. */
  kind: "song";
  /** YouTube video id. Identifies the track across the YouTube ecosystem. */
  videoId: string;
  title: string;
  artist: string;
  /** Album name if the source reported one; null otherwise. */
  album: string | null;
  /** Track length in ms; null when unknown. */
  durationMs: number | null;
  /** Best-available thumbnail URL; null when the source returned no art. */
  thumbnailUrl: string | null;
}

export interface MusicSearchResponse {
  query: string;
  results: MusicSearchResult[];
  /** Populated only on server-side failure. */
  error?: string;
}

export interface MusicPlaylist {
  playlistId: string;
  name: string;
  artist: string | null;
  trackCount: number;
  thumbnailUrl: string | null;
  tracks: MusicSearchResult[];
}

export interface LyricsResult {
  videoId: string;
  /** Newline-joined lyrics text, or null when YouTube Music has none. */
  text: string | null;
  /** Non-empty line count from the source. 0 when lyrics unavailable. */
  lineCount: number;
}
