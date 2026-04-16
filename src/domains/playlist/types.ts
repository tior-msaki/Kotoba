/**
 * Playlist/provider domain types.
 *
 * All provider-specific data is normalized into these shapes
 * so the rest of the app never touches Spotify/YouTube/Deezer APIs directly.
 */

export type PlaylistProvider = "spotify" | "youtube" | "deezer";

/** Provider-specific identifiers attached to a track or playlist. */
export interface ProviderSource {
  provider: PlaylistProvider;
  externalId: string;
  externalUrl: string;
}

/** Normalized song metadata independent of provider. */
export interface SongMeta {
  title: string;
  artist: string;
  albumName?: string;
  albumArtUrl?: string;
  durationMs?: number;
  source: ProviderSource;
}

/** A single track within a normalized playlist. */
export interface PlaylistTrack {
  id: string;
  position: number;
  song: SongMeta;
  addedAt?: number;
}

/** A normalized playlist from any provider. */
export interface Playlist {
  id: string;
  name: string;
  description?: string;
  coverImageUrl?: string;
  source: ProviderSource;
  tracks: PlaylistTrack[];
  fetchedAt: number;
}
