/**
 * Deezer adapter — STUB.
 *
 * Returns placeholder data so the rest of the system can be tested
 * against the Deezer provider path. Replace the fetch bodies with
 * real Deezer API calls when ready.
 */

import type { PlaylistAdapter } from "../adapter";
import type { Playlist, SongMeta } from "../types";
import { ProviderError } from "../../../lib/errors";

// ---------------------------------------------------------------------------
// Stub adapter
// ---------------------------------------------------------------------------

export const deezerAdapter: PlaylistAdapter = {
  provider: "deezer",

  async fetchPlaylist(playlistId: string): Promise<Playlist> {
    // TODO: Replace with Deezer /playlist/{id} API call
    throw new ProviderError(
      `Deezer adapter not implemented. Playlist ID: ${playlistId}`,
      "deezer"
    );
  },

  async fetchSong(trackId: string): Promise<SongMeta> {
    // TODO: Replace with Deezer /track/{id} API call
    throw new ProviderError(
      `Deezer adapter not implemented. Track ID: ${trackId}`,
      "deezer"
    );
  },
};
