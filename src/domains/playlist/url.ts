/**
 * Playlist-URL parser — detects Spotify vs YouTube from pasted text.
 *
 * Pure (no network). Used by the burn-CD popup so the user can paste
 * either a Spotify or a YouTube Music URL and we route to the correct
 * adapter.
 *
 * Order matters: URL-shape checks first so a bare "PLxxx" id isn't
 * mistaken for a Spotify id (Spotify ids are also alphanumeric).
 */

import { parseYouTubeMusicUrl } from "../music-search/url";
import type { PlaylistProvider } from "./types";

export type ParsedPlaylistUrl =
  | {
      provider: PlaylistProvider;
      playlistId: string;
      /** Optional deep-link to the source, ready to put in ProviderSource.externalUrl. */
      externalUrl: string;
      /** Only set when the URL was a watch-URL carrying a ?list= param. */
      focusVideoId?: string;
    }
  | { error: string };

/**
 * Parse a pasted URL / bare id into a provider + playlistId.
 *
 * Accepted shapes:
 *   - https://open.spotify.com/playlist/<id>[?si=…]
 *   - https://open.spotify.com/embed/playlist/<id>
 *   - spotify:playlist:<id>
 *   - 22-char alphanumeric Spotify id (bare)
 *   - https://music.youtube.com/playlist?list=<PLxxx>[&si=…]
 *   - https://music.youtube.com/watch?v=<vid>&list=<PLxxx>
 *   - https://www.youtube.com/playlist?list=<PLxxx>
 *   - https://youtu.be/<vid>?list=<PLxxx>
 *   - A bare YouTube playlist id with a known prefix (PL/OL/RD/UU/FL/LP…)
 *
 * Any other input returns `{ error: … }` with a short, user-facing reason.
 */
export function parsePlaylistUrl(input: string): ParsedPlaylistUrl {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) {
    return { error: "Paste a Spotify or YouTube playlist URL." };
  }

  // ── 1. YouTube (URL-shape) ────────────────────────────────────────────
  const yt = parseYouTubeMusicUrl(trimmed);
  if (yt.kind === "playlist") {
    return {
      provider: "youtube",
      playlistId: yt.playlistId,
      externalUrl: `https://music.youtube.com/playlist?list=${yt.playlistId}`,
    };
  }
  if (yt.kind === "watch-with-playlist") {
    return {
      provider: "youtube",
      playlistId: yt.playlistId,
      externalUrl: `https://music.youtube.com/playlist?list=${yt.playlistId}`,
      focusVideoId: yt.videoId,
    };
  }
  if (yt.kind === "song") {
    // A single song URL on its own isn't a playlist — we reject here so
    // the burn flow stays about playlists only. The user can paste a
    // playlist or a watch-URL that includes ?list=.
    return {
      error: "That looks like a single-track URL. Paste a playlist URL instead.",
    };
  }

  // ── 2. Spotify (URL-shape) ────────────────────────────────────────────
  // Covers open.spotify.com/playlist/<id>, .../embed/playlist/<id>, and
  // spotify:playlist:<id> URI form. Trailing /?si=… / locale paths OK.
  const spotifyPatterns: RegExp[] = [
    /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:embed\/)?playlist\/)([a-zA-Z0-9]+)/,
    /(?:spotify:playlist:)([a-zA-Z0-9]+)/,
  ];
  for (const re of spotifyPatterns) {
    const m = trimmed.match(re);
    if (m?.[1]) {
      return {
        provider: "spotify",
        playlistId: m[1],
        externalUrl: `https://open.spotify.com/playlist/${m[1]}`,
      };
    }
  }

  // ── 3. Bare ids (heuristics) ─────────────────────────────────────────
  // YouTube playlist ids start with a known two-letter prefix + a long
  // [A-Za-z0-9_-] body. (Public: PL, OL; radio: RD; auto-mix: RDMM, RDCL;
  // channel: UU, UULF; liked: LM / LL; "later": WL; saved: FL; looped
  // playlists: LP.) Keep the prefix list conservative.
  if (/^(?:PL|OL|RD|RDMM|UU[A-Z]*|FL|LP)[A-Za-z0-9_-]{10,}$/.test(trimmed)) {
    return {
      provider: "youtube",
      playlistId: trimmed,
      externalUrl: `https://music.youtube.com/playlist?list=${trimmed}`,
    };
  }
  // Spotify playlist ids are 22 base62 characters.
  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) {
    return {
      provider: "spotify",
      playlistId: trimmed,
      externalUrl: `https://open.spotify.com/playlist/${trimmed}`,
    };
  }

  // ── 4. Known-unsupported hosts get a friendly reason ─────────────────
  if (/^https?:\/\//i.test(trimmed)) {
    return {
      error: "Only Spotify and YouTube Music playlist URLs are supported.",
    };
  }

  return {
    error: "That doesn't look like a Spotify or YouTube playlist URL.",
  };
}
