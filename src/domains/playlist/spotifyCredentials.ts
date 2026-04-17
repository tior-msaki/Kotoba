/**
 * Spotify app credentials → access token, then playlist fetch.
 *
 * Uses the Client Credentials flow (POST /api/token with client_id + client_secret).
 * This works for public catalog data (e.g. public playlist IDs). It does not grant
 * access to a user's private playlists; those need Authorization Code / PKCE.
 *
 * Typical env vars (e.g. in a build or server): SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET.
 */

import type { Playlist } from "./types";
import { ProviderError } from "../../lib/errors";
import { spotifyAdapter, setSpotifyToken } from "./adapters/spotify";

export interface SpotifyAppCredentials {
  clientId: string;
  clientSecret: string;
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SpotifyTokenErrorBody {
  error: string;
  error_description?: string;
}

function basicAuthorizationHeader(
  clientId: string,
  clientSecret: string
): string {
  const raw = `${clientId}:${clientSecret}`;
  return `Basic ${btoa(raw)}`;
}

/**
 * Request a Bearer access token from Spotify Accounts using the app client id/secret.
 */
export async function getSpotifyAccessToken(
  credentials: SpotifyAppCredentials
): Promise<string> {
  const { clientId, clientSecret } = credentials;
  if (!clientId?.trim() || !clientSecret?.trim()) {
    throw new ProviderError(
      "Spotify client id and client secret are required.",
      "spotify"
    );
  }

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: basicAuthorizationHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const err = (await res.json()) as SpotifyTokenErrorBody;
      if (err.error_description) detail = err.error_description;
      else if (err.error) detail = err.error;
    } catch {
      /* ignore */
    }
    throw new ProviderError(
      `Spotify token request failed (${res.status}): ${detail}`,
      "spotify"
    );
  }

  const data = (await res.json()) as SpotifyTokenResponse;
  if (!data.access_token) {
    throw new ProviderError(
      "Spotify token response missing access_token.",
      "spotify"
    );
  }
  return data.access_token;
}

/**
 * Fetches a token and installs it for {@link spotifyAdapter} calls in this JS realm.
 */
export async function authenticateSpotify(
  credentials: SpotifyAppCredentials
): Promise<void> {
  const token = await getSpotifyAccessToken(credentials);
  setSpotifyToken(token);
}

function readProcessEnv(): Record<string, string | undefined> | undefined {
  const g = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  };
  return g.process?.env;
}

/**
 * Read credentials from process.env when available (Node / bundled server code).
 * Returns null if either variable is missing.
 */
export function getSpotifyCredentialsFromEnv(): SpotifyAppCredentials | null {
  const env = readProcessEnv();
  if (!env) return null;
  const clientId = env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Authenticate using SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET from the environment.
 * @throws ProviderError if env vars are not set or token request fails.
 */
export async function authenticateSpotifyFromEnv(): Promise<void> {
  const creds = getSpotifyCredentialsFromEnv();
  if (!creds) {
    throw new ProviderError(
      "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (or call authenticateSpotify with explicit credentials).",
      "spotify"
    );
  }
  await authenticateSpotify(creds);
}

/**
 * Full flow: obtain access token from app credentials, then fetch and normalize a playlist.
 * The Spotify playlist id is the id segment from a URL like
 * https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M → 37i9dQZF1DXcBWIGoYBM5M
 */
export async function fetchSpotifyPlaylistWithCredentials(
  playlistId: string,
  credentials: SpotifyAppCredentials
): Promise<Playlist> {
  await authenticateSpotify(credentials);
  return spotifyAdapter.fetchPlaylist(playlistId);
}

/**
 * Same as {@link fetchSpotifyPlaylistWithCredentials} but reads credentials from env.
 */
export async function fetchSpotifyPlaylistFromEnv(
  playlistId: string
): Promise<Playlist> {
  await authenticateSpotifyFromEnv();
  return spotifyAdapter.fetchPlaylist(playlistId);
}
