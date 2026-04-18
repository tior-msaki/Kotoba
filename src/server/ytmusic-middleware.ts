/**
 * YouTube Music middleware for the Vite dev / preview server.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ytmusic-api` is a Node-only package. It imports `axios` in Node mode
 * (no `fetch` polyfill, uses the `http` module), and the YouTube Music
 * internal endpoints it hits set CORS headers that block direct browser
 * access. Therefore we cannot call `new YTMusic()` from browser code.
 *
 * This Node-side middleware exposes:
 *
 *   GET /api/ytmusic/search?q=<query>            — song search (legacy helper)
 *   GET /api/ytmusic/playlist?id=<playlistId>    — playlist metadata + tracks
 *   GET /api/ytmusic/song?videoId=<videoId>      — single-track metadata
 *   GET /api/ytmusic/lyrics?videoId=<videoId>    — lyrics lines (string[] | null)
 *
 * It normalizes the raw ytmusic-api response into small frontend-friendly
 * shapes so the UI never depends on YTMusic's zod-shaped internal types.
 * Every field that can be null/undefined is defensively coerced so the UI
 * doesn't need to guard every access.
 *
 * INTEGRATION
 * -----------
 * `vite.config.ts` wires this as a `configureServer` + `configurePreview`
 * plugin hook. It is only active when the Vite dev server or
 * `vite preview` is running. In a production deployment without a real
 * server you will need to host the equivalent endpoint separately — see
 * the README / ARCHITECTURE notes. For the current app this is fine
 * because we already run a Node-backed dev/preview server.
 *
 * MODULE FORMAT
 * -------------
 * `ytmusic-api` ships dual CJS + ESM via the `exports` field. In this
 * ESM project (`"type": "module"` in package.json) Vite's Node import
 * resolves `dist/index.mjs` and the default export IS the YTMusic class,
 * so `import YTMusic from "ytmusic-api"` (below) works verbatim.
 */

import type { Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import YTMusic from "ytmusic-api";

// ---------------------------------------------------------------------------
// Normalized frontend-friendly shape — the browser never sees ytmusic-api
// zod types directly. Keep this stable; the client service imports a type
// with the same structure.
// ---------------------------------------------------------------------------

export interface MusicSearchResult {
  /** "song" today; we add albums/artists later if the UI needs them. */
  kind: "song";
  /** YouTube video id — identifies the track across the YouTube ecosystem. */
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
  /** Track length in milliseconds, or null if the source didn't report one. */
  durationMs: number | null;
  /** Best-guess thumbnail URL, or null. */
  thumbnailUrl: string | null;
}

export interface MusicSearchResponse {
  query: string;
  results: MusicSearchResult[];
  /** Non-null when the server-side call failed. */
  error?: string;
}

/** Playlist metadata + normalized tracks. */
export interface MusicPlaylist {
  playlistId: string;
  name: string;
  artist: string | null;
  trackCount: number;
  thumbnailUrl: string | null;
  tracks: MusicSearchResult[];
}

export interface MusicPlaylistResponse {
  playlistId: string;
  playlist: MusicPlaylist | null;
  error?: string;
}

export interface MusicSongResponse {
  videoId: string;
  track: MusicSearchResult | null;
  error?: string;
}

export interface MusicLyricsResult {
  videoId: string;
  /** Newline-joined lyrics. Null when the source has no lyrics. */
  text: string | null;
  /** Number of non-empty lines we received (useful for empty-detection). */
  lineCount: number;
}

export interface MusicLyricsResponse {
  videoId: string;
  lyrics: MusicLyricsResult;
  error?: string;
}

// ---------------------------------------------------------------------------
// Lazy singleton — ytmusic-api's `initialize()` does a cold network warmup
// we only want to do once per server lifetime.
// ---------------------------------------------------------------------------

let ytmusicPromise: Promise<YTMusic> | null = null;

function getYTMusic(): Promise<YTMusic> {
  if (ytmusicPromise) return ytmusicPromise;
  ytmusicPromise = (async () => {
    const instance = new YTMusic();
    await instance.initialize();
    return instance;
  })().catch((err) => {
    // Drop the cached promise so the next call re-tries instead of
    // returning the same rejection forever.
    ytmusicPromise = null;
    throw err;
  });
  return ytmusicPromise;
}

// ---------------------------------------------------------------------------
// Normalization — defensive against missing / nullable fields.
// ---------------------------------------------------------------------------

/**
 * Superset shape covering ytmusic-api's SongDetailed, VideoDetailed, and
 * SongFull. We deliberately accept a permissive input and defend every
 * access so a schema tweak upstream doesn't crash the server.
 */
interface RawSong {
  videoId?: unknown;
  name?: unknown;
  artist?: { name?: unknown } | { name?: unknown }[] | null;
  album?: { name?: unknown } | null;
  duration?: unknown;
  thumbnails?: Array<{ url?: unknown; width?: unknown; height?: unknown }> | null;
}

interface RawPlaylist {
  playlistId?: unknown;
  name?: unknown;
  artist?: { name?: unknown } | null;
  videoCount?: unknown;
  thumbnails?: Array<{ url?: unknown; width?: unknown; height?: unknown }> | null;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function pickBestThumbnail(
  thumbnails: Array<{ url?: unknown; width?: unknown; height?: unknown }> | null | undefined
): string | null {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  // Prefer the largest by width. Fall back to the last entry.
  let best: { url?: unknown; width?: unknown } | undefined;
  let bestW = -1;
  for (const t of thumbnails) {
    const w = typeof t.width === "number" ? t.width : -1;
    if (w > bestW) { bestW = w; best = t; }
  }
  const url = best?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function normalizeSong(raw: RawSong): MusicSearchResult | null {
  const videoId = asString(raw.videoId);
  const title = asString(raw.name);
  if (!videoId || !title) return null;
  // ytmusic-api returns duration in seconds (or null).
  const durationSec =
    typeof raw.duration === "number" && Number.isFinite(raw.duration)
      ? raw.duration
      : null;
  // `artist` is `{ name }` on SongDetailed, `{ name }[]` on VideoDetailed.
  let artistName = "Unknown artist";
  if (Array.isArray(raw.artist)) {
    const joined = raw.artist
      .map((a) => (typeof a?.name === "string" ? a.name : ""))
      .filter((s) => s.length > 0)
      .join(", ");
    if (joined.length > 0) artistName = joined;
  } else if (raw.artist && typeof raw.artist.name === "string" && raw.artist.name.length > 0) {
    artistName = raw.artist.name;
  }
  return {
    kind: "song",
    videoId,
    title,
    artist: artistName,
    album: raw.album && typeof raw.album.name === "string" ? raw.album.name : null,
    durationMs: durationSec !== null ? Math.round(durationSec * 1000) : null,
    thumbnailUrl: pickBestThumbnail(raw.thumbnails),
  };
}

function normalizePlaylist(
  meta: RawPlaylist,
  rawTracks: RawSong[]
): MusicPlaylist {
  const videoCount =
    typeof meta.videoCount === "number" && Number.isFinite(meta.videoCount)
      ? meta.videoCount
      : rawTracks.length;
  const tracks = rawTracks
    .map(normalizeSong)
    .filter((t): t is MusicSearchResult => t !== null);
  return {
    playlistId: asString(meta.playlistId),
    name: asString(meta.name, "Untitled playlist"),
    artist:
      meta.artist && typeof meta.artist.name === "string" && meta.artist.name.length > 0
        ? meta.artist.name
        : null,
    trackCount: videoCount,
    thumbnailUrl: pickBestThumbnail(meta.thumbnails),
    tracks,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function requestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? "localhost";
  return new URL(req.url ?? "/", `http://${host}`);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = requestUrl(req);
  const query = (url.searchParams.get("q") ?? "").trim();
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(50, Number(limitRaw) || 20)) : 20;

  if (query.length === 0) {
    return sendJson(res, 400, {
      query,
      results: [],
      error: "Missing required ?q=<query>",
    } satisfies MusicSearchResponse);
  }

  try {
    const ytmusic = await getYTMusic();
    const raw = (await ytmusic.searchSongs(query)) as unknown as RawSong[];
    const normalized = Array.isArray(raw)
      ? raw
          .map(normalizeSong)
          .filter((r): r is MusicSearchResult => r !== null)
          .slice(0, limit)
      : [];
    sendJson(res, 200, { query, results: normalized } satisfies MusicSearchResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 502, {
      query,
      results: [],
      error: `YouTube Music search failed: ${message}`,
    } satisfies MusicSearchResponse);
  }
}

async function handlePlaylist(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = requestUrl(req);
  const id = (url.searchParams.get("id") ?? "").trim();

  if (id.length === 0) {
    return sendJson(res, 400, {
      playlistId: "",
      playlist: null,
      error: "Missing required ?id=<playlistId>",
    } satisfies MusicPlaylistResponse);
  }

  try {
    const ytmusic = await getYTMusic();
    // Fetch metadata + tracks in parallel. getPlaylist returns PlaylistFull
    // (metadata only); the tracks live in getPlaylistVideos.
    const [metaRaw, videosRaw] = await Promise.all([
      ytmusic.getPlaylist(id) as unknown as Promise<RawPlaylist>,
      ytmusic.getPlaylistVideos(id) as unknown as Promise<RawSong[]>,
    ]);
    const playlist = normalizePlaylist(
      metaRaw ?? {},
      Array.isArray(videosRaw) ? videosRaw : []
    );
    sendJson(res, 200, {
      playlistId: id,
      playlist,
    } satisfies MusicPlaylistResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 502, {
      playlistId: id,
      playlist: null,
      error: `YouTube Music playlist fetch failed: ${message}`,
    } satisfies MusicPlaylistResponse);
  }
}

async function handleSong(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = requestUrl(req);
  const videoId = (url.searchParams.get("videoId") ?? "").trim();

  if (videoId.length === 0) {
    return sendJson(res, 400, {
      videoId: "",
      track: null,
      error: "Missing required ?videoId=<videoId>",
    } satisfies MusicSongResponse);
  }

  try {
    const ytmusic = await getYTMusic();
    const raw = (await ytmusic.getSong(videoId)) as unknown as RawSong;
    const track = raw ? normalizeSong(raw) : null;
    sendJson(res, 200, {
      videoId,
      track,
    } satisfies MusicSongResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 502, {
      videoId,
      track: null,
      error: `YouTube Music song fetch failed: ${message}`,
    } satisfies MusicSongResponse);
  }
}

async function handleLyrics(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = requestUrl(req);
  const videoId = (url.searchParams.get("videoId") ?? "").trim();

  if (videoId.length === 0) {
    return sendJson(res, 400, {
      videoId: "",
      lyrics: { videoId: "", text: null, lineCount: 0 },
      error: "Missing required ?videoId=<videoId>",
    } satisfies MusicLyricsResponse);
  }

  try {
    const ytmusic = await getYTMusic();
    // getLyrics returns string[] | null — null when YouTube Music has no
    // lyrics entry for the track. We never invent lyrics.
    const raw = (await ytmusic.getLyrics(videoId)) as unknown as string[] | null;
    if (!Array.isArray(raw) || raw.length === 0) {
      return sendJson(res, 200, {
        videoId,
        lyrics: { videoId, text: null, lineCount: 0 },
      } satisfies MusicLyricsResponse);
    }
    const lines = raw
      .map((line) => (typeof line === "string" ? line : ""))
      .map((line) => line.replace(/\r\n?/g, "\n"));
    const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
    sendJson(res, 200, {
      videoId,
      lyrics: {
        videoId,
        text: lines.join("\n"),
        lineCount: nonEmpty,
      },
    } satisfies MusicLyricsResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 502, {
      videoId,
      lyrics: { videoId, text: null, lineCount: 0 },
      error: `YouTube Music lyrics fetch failed: ${message}`,
    } satisfies MusicLyricsResponse);
  }
}

// ---------------------------------------------------------------------------
// Middleware dispatcher
// ---------------------------------------------------------------------------

export function ytmusicSearchMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!req.url) return next();
    if (!req.url.startsWith("/api/ytmusic/")) return next();

    // Strip the query string for prefix matching.
    const path = req.url.split("?")[0] ?? "";
    if (path === "/api/ytmusic/search") return void handleSearch(req, res);
    if (path === "/api/ytmusic/playlist") return void handlePlaylist(req, res);
    if (path === "/api/ytmusic/song") return void handleSong(req, res);
    if (path === "/api/ytmusic/lyrics") return void handleLyrics(req, res);
    return next();
  };
}
