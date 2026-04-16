/**
 * YouTube adapter — STUB.
 *
 * Returns placeholder data so the rest of the system can be tested
 * against the YouTube provider path. Replace the fetch bodies with
 * real YouTube Data API v3 calls when ready.
 */

import type { PlaylistAdapter } from "../adapter";
import type { Playlist, SongMeta } from "../types";
import { ProviderError } from "../../../lib/errors";

// ---------------------------------------------------------------------------
// API key holder — set externally before making real API calls
// ---------------------------------------------------------------------------

const config = { apiKey: null as string | null };

export function setYouTubeApiKey(key: string): void {
  config.apiKey = key;
}

// ---------------------------------------------------------------------------
// Stub adapter
// ---------------------------------------------------------------------------

export const youtubeAdapter: PlaylistAdapter = {
  provider: "youtube",

  async fetchPlaylist(playlistId: string): Promise<Playlist> {
    // TODO: Replace with YouTube Data API v3 playlistItems.list call
    throw new ProviderError(
      `YouTube adapter not implemented. Playlist ID: ${playlistId}`,
      "youtube"
    );
  },

  async fetchSong(videoId: string): Promise<SongMeta> {
    // TODO: Replace with YouTube Data API v3 videos.list call
    throw new ProviderError(
      `YouTube adapter not implemented. Video ID: ${videoId}`,
      "youtube"
    );
  },
};
