/**
 * Provider adapter contract.
 *
 * Every provider (Spotify, YouTube, Deezer) implements this interface.
 * The service layer dispatches to the correct adapter by provider name
 * without knowing anything about the provider's API.
 */

import type { PlaylistProvider, Playlist, SongMeta } from "./types";

export interface PlaylistAdapter {
  readonly provider: PlaylistProvider;

  /** Fetch and normalize a playlist by its provider-specific ID. */
  fetchPlaylist(playlistId: string): Promise<Playlist>;

  /** Fetch and normalize a single track/song by its provider-specific ID. */
  fetchSong(songId: string): Promise<SongMeta>;
}

/**
 * Registry of available adapters keyed by provider name.
 * Populated at startup by each adapter module.
 */
const adapters = new Map<PlaylistProvider, PlaylistAdapter>();

export function registerAdapter(adapter: PlaylistAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getAdapter(provider: PlaylistProvider): PlaylistAdapter {
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw new Error(`No adapter registered for provider: ${provider}`);
  }
  return adapter;
}

export function getRegisteredProviders(): PlaylistProvider[] {
  return [...adapters.keys()];
}
