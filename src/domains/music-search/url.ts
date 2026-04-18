/**
 * YouTube / YouTube Music URL parser.
 *
 * Pure — no network, no DOM. Used by both the browser (to decide what to
 * fetch) and any future Node-side consumer. Accepts a broad set of hosts
 * because users paste whatever is in the share sheet.
 */

export type ParsedMusicUrl =
  | { kind: "playlist"; playlistId: string }
  | { kind: "song"; videoId: string }
  | { kind: "watch-with-playlist"; videoId: string; playlistId: string }
  | { kind: "unsupported"; reason: string };

const ACCEPTED_HOSTS: ReadonlySet<string> = new Set([
  "music.youtube.com",
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

/**
 * Parse a pasted URL into a discriminated union describing what to fetch.
 *
 *   - `playlist`              — .../playlist?list=PLxxx
 *   - `song`                  — .../watch?v=xxx (no `list` param)
 *   - `watch-with-playlist`   — .../watch?v=xxx&list=PLxxx
 *   - `unsupported`           — anything else (with a human-readable reason)
 *
 * Unsupported "reasons" are user-facing strings, so keep them short and
 * free of implementation jargon.
 */
export function parseYouTubeMusicUrl(input: string): ParsedMusicUrl {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) {
    return { kind: "unsupported", reason: "Paste a YouTube Music URL." };
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return {
      kind: "unsupported",
      reason: "That doesn't look like a URL. Paste the full link starting with https://.",
    };
  }

  const host = u.hostname.toLowerCase();
  if (!ACCEPTED_HOSTS.has(host)) {
    return {
      kind: "unsupported",
      reason: "Only YouTube Music and YouTube URLs are supported.",
    };
  }

  // youtu.be short links: https://youtu.be/<videoId>[?list=PLxxx]
  if (host === "youtu.be") {
    const videoId = u.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    if (!videoId) {
      return {
        kind: "unsupported",
        reason: "The short link didn't include a video id.",
      };
    }
    const list = u.searchParams.get("list");
    if (list && list.length > 0) {
      return { kind: "watch-with-playlist", videoId, playlistId: list };
    }
    return { kind: "song", videoId };
  }

  const path = u.pathname.toLowerCase();
  const listId = u.searchParams.get("list");
  const videoId = u.searchParams.get("v");

  if (path === "/playlist" || path === "/playlist/") {
    if (!listId) {
      return {
        kind: "unsupported",
        reason: "Playlist URL is missing the `list` parameter.",
      };
    }
    return { kind: "playlist", playlistId: listId };
  }

  if (path === "/watch" || path === "/watch/") {
    if (!videoId) {
      return {
        kind: "unsupported",
        reason: "Watch URL is missing the `v` parameter.",
      };
    }
    if (listId && listId.length > 0) {
      return { kind: "watch-with-playlist", videoId, playlistId: listId };
    }
    return { kind: "song", videoId };
  }

  // Album / artist / browse paths are structurally different (no ?list),
  // and supporting them requires a separate middleware route. Out of
  // scope for this iteration — surface a clean error instead of guessing.
  if (path.startsWith("/browse/") || path.startsWith("/channel/")) {
    return {
      kind: "unsupported",
      reason: "Album and artist pages aren't supported yet — paste a playlist or song URL instead.",
    };
  }

  return {
    kind: "unsupported",
    reason: "URL path isn't a playlist or watch link.",
  };
}
