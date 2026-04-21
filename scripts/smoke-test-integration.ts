/**
 * Integration smoke test — end-to-end product-flow sanity.
 *
 * Exercises the connections the audit flagged as missing or inconsistent:
 *   - Playlist provider registration posture (Spotify only).
 *   - Notes CRUD via the real facade.
 *   - home.html + LegacyDesignFrame.tsx source-level wiring for the
 *     cleaned-up reset buttons and the newly-wired .notes icon.
 *
 * Run with: npm run smoke:integration
 */

import "fake-indexeddb/auto";

import { cd, notes, search, setup } from "../src/services/app";
import { ProviderError, AppError } from "../src/lib/errors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

async function run(): Promise<void> {
  console.log("\n=== Integration smoke test ===\n");

  // -----------------------------------------------------------------------
  console.log("1. Provider registration posture");

  // YouTube: now registered and backed by the ytmusic-api middleware.
  // Without a dev server in this test process the fetch itself will fail,
  // but what matters is that the adapter ran (so the error is YouTube's
  // own ProviderError, NOT the registry's "Provider not registered").
  let youtubeErr: unknown = null;
  try {
    await cd.fetchPlaylist("youtube", "PLxxx-test");
  } catch (e) { youtubeErr = e; }
  assert(youtubeErr instanceof ProviderError, "YouTube fetchPlaylist throws ProviderError");
  assert(
    youtubeErr instanceof Error &&
      !/not registered/i.test(youtubeErr.message),
    "YouTube adapter IS registered (error is not 'Provider not registered')"
  );
  assert(
    !(youtubeErr instanceof Error &&
      /YouTube adapter not implemented/.test(youtubeErr.message)),
    "Old stub 'YouTube adapter not implemented' never reaches the caller"
  );

  // Deezer: same story.
  let deezerErr: unknown = null;
  try {
    await cd.fetchPlaylist("deezer", "anything");
  } catch (e) { deezerErr = e; }
  assert(deezerErr instanceof ProviderError, "Deezer fetchPlaylist throws ProviderError");
  assert(
    deezerErr instanceof Error && /not registered/i.test(deezerErr.message),
    "Deezer error says 'not registered'"
  );

  // Spotify: IS registered, but without a token it throws the
  // Spotify-specific "access token not set" — proving the adapter ran.
  setup.setNvidiaApiKey("unused-for-this-test");
  let spotifyErr: unknown = null;
  try {
    await cd.fetchPlaylist("spotify", "37i9dQZF1DXcBWIGoYBM5M");
  } catch (e) { spotifyErr = e; }
  assert(spotifyErr instanceof ProviderError, "Spotify fetchPlaylist throws ProviderError");
  assert(
    spotifyErr instanceof Error &&
      /access token not set/i.test(spotifyErr.message),
    "Spotify error is the token-missing error (adapter IS registered)"
  );

  // -----------------------------------------------------------------------
  console.log("\n2. Notes CRUD via the real facade");

  const first = await notes.add({
    title: "Hikaru Nara",
    body: "Goose House opener — warm and hopeful",
  });
  assert(first !== null && typeof first?.id === "string", "first note created with id");

  const blank = await notes.add({ title: "", body: "" });
  assert(blank === null, "blank note returns null (no spurious row)");

  await notes.add({ title: "Serendipity notes", body: "BTS · bridge chord" });
  const list1 = await notes.list();
  assert(list1.length === 2, `list returns 2 notes (got ${list1.length})`);
  assert(
    list1[0] !== undefined && list1[1] !== undefined,
    "list items are defined"
  );
  // Ordering: newest first (the service uses reverse(updatedAt)).
  assert(
    list1[0]!.updatedAt >= list1[1]!.updatedAt,
    "list is ordered newest-first"
  );

  await notes.delete(first!.id);
  const list2 = await notes.list();
  assert(list2.length === 1, `after delete: 1 note remains (got ${list2.length})`);
  assert(
    !list2.some((n) => n.id === first!.id),
    "deleted note is gone"
  );

  // -----------------------------------------------------------------------
  console.log("\n3. Source-level wiring (no duplicate stores)");

  const homeHtml = readFileSync(resolve(repoRoot, "public/home.html"), "utf8");
  const bridgeTs = readFileSync(
    resolve(repoRoot, "src/frontend/LegacyDesignFrame.tsx"),
    "utf8"
  );
  const playlistService = readFileSync(
    resolve(repoRoot, "src/domains/playlist/service.ts"),
    "utf8"
  );

  // home.html drift-fix assertions
  assert(
    !/id="pointsReset"/.test(homeHtml),
    "home.html no longer ships #pointsReset button"
  );
  assert(
    !/id="albumReset"/.test(homeHtml),
    "home.html no longer ships #albumReset button"
  );
  assert(
    !/const\s+CARD_POOL\s*=/.test(homeHtml),
    "home.html no longer ships the inline CARD_POOL array"
  );
  assert(
    !/pointsReset.*addEventListener/.test(homeHtml),
    "no inline pointsReset click handler remains"
  );
  assert(
    !/albumReset.*addEventListener/.test(homeHtml),
    "no inline albumReset click handler remains"
  );
  // #pointsIncrement stays (bridge intercepts in capture phase); confirm:
  assert(
    /id="pointsIncrement"/.test(homeHtml),
    "home.html still ships #pointsIncrement (bridge-intercepted)"
  );
  assert(
    /id="albumAddCard"/.test(homeHtml),
    "home.html still ships #albumAddCard (bridge-intercepted)"
  );

  // LegacyDesignFrame wiring assertions
  assert(
    /\bimport \{[^}]*\bnotes\b[^}]*\}\s+from\s+"\.\.\/services\/app"/.test(bridgeTs),
    "LegacyDesignFrame imports the notes facade"
  );
  assert(
    /notesIcon\?\.addEventListener\("click", onNotesClick/.test(bridgeTs),
    "LegacyDesignFrame wires .notes click → onNotesClick"
  );
  assert(
    /notes\.list\(\)/.test(bridgeTs),
    "notes overlay reads via notes.list()"
  );
  assert(
    /notes\.add\(/.test(bridgeTs),
    "notes overlay writes via notes.add()"
  );
  assert(
    /notes\.delete\(/.test(bridgeTs),
    "notes overlay deletes via notes.delete()"
  );
  assert(
    !/localStorage\.setItem\(.*kotoba-notes/.test(bridgeTs),
    "notes overlay does NOT shadow to localStorage"
  );

  // playlist/service.ts registration assertions
  assert(
    /registerAdapter\(spotifyAdapter\)/.test(playlistService),
    "Spotify adapter still auto-registered"
  );
  assert(
    /registerAdapter\(youtubeAdapter\)/.test(playlistService),
    "YouTube adapter IS registered (backed by /api/ytmusic middleware)"
  );
  assert(
    !/registerAdapter\(deezerAdapter\)/.test(playlistService),
    "Deezer adapter NOT registered"
  );

  // -----------------------------------------------------------------------
  console.log("\n4. YouTube Music URL flow (paste → fetch → lyrics)");

  const { parseYouTubeMusicUrl } = await import(
    "../src/domains/music-search/url.js"
  );

  const musicServiceSrc = readFileSync(
    resolve(repoRoot, "src/domains/music-search/service.ts"),
    "utf8"
  );
  const middlewareSrc = readFileSync(
    resolve(repoRoot, "src/server/ytmusic-middleware.ts"),
    "utf8"
  );
  const urlSrc = readFileSync(
    resolve(repoRoot, "src/domains/music-search/url.ts"),
    "utf8"
  );
  const viteConfigSrc = readFileSync(
    resolve(repoRoot, "vite.config.ts"),
    "utf8"
  );
  const searchHtmlSrc = readFileSync(
    resolve(repoRoot, "public/search.html"),
    "utf8"
  );
  const homeHtmlSrc = readFileSync(
    resolve(repoRoot, "public/home.html"),
    "utf8"
  );

  // ─── Facade ─────────────────────────────────────────────────────────
  assert(
    typeof search === "object" &&
      typeof search.songs === "function" &&
      typeof search.playlist === "function" &&
      typeof search.song === "function" &&
      typeof search.lyrics === "function" &&
      typeof search.parseUrl === "function",
    "services/app.ts exposes search.{songs, playlist, song, lyrics, parseUrl}"
  );

  // ─── URL parser ─────────────────────────────────────────────────────
  const cases: Array<{ input: string; expected: string; extra?: Record<string, string> }> = [
    { input: "", expected: "unsupported" },
    { input: "not a url", expected: "unsupported" },
    { input: "https://example.com/playlist?list=PLxxx", expected: "unsupported" },
    {
      input: "https://music.youtube.com/playlist?list=PLQWowEevU_Gq1reNUh6Ux4SXLLV7pC4uX&si=FhwHxVVrNnwiaKEG",
      expected: "playlist",
      extra: { playlistId: "PLQWowEevU_Gq1reNUh6Ux4SXLLV7pC4uX" },
    },
    {
      input: "https://music.youtube.com/watch?v=lYBUbBu4W08",
      expected: "song",
      extra: { videoId: "lYBUbBu4W08" },
    },
    {
      input: "https://music.youtube.com/watch?v=lYBUbBu4W08&list=PLxxx",
      expected: "watch-with-playlist",
      extra: { videoId: "lYBUbBu4W08", playlistId: "PLxxx" },
    },
    {
      input: "https://www.youtube.com/playlist?list=PLxxx",
      expected: "playlist",
      extra: { playlistId: "PLxxx" },
    },
    {
      input: "https://youtu.be/lYBUbBu4W08",
      expected: "song",
      extra: { videoId: "lYBUbBu4W08" },
    },
    {
      input: "https://youtu.be/lYBUbBu4W08?list=PLxxx",
      expected: "watch-with-playlist",
      extra: { videoId: "lYBUbBu4W08", playlistId: "PLxxx" },
    },
    { input: "https://music.youtube.com/playlist", expected: "unsupported" }, // missing ?list
    { input: "https://music.youtube.com/watch", expected: "unsupported" },    // missing ?v
    { input: "https://music.youtube.com/browse/MPREb_xxx", expected: "unsupported" },
  ];
  for (const c of cases) {
    const res = parseYouTubeMusicUrl(c.input);
    assert(
      res.kind === c.expected,
      `parseYouTubeMusicUrl(${JSON.stringify(c.input)}) → kind=${c.expected} (got ${res.kind})`
    );
    if (c.extra) {
      for (const [k, v] of Object.entries(c.extra)) {
        assert(
          (res as Record<string, unknown>)[k] === v,
          `  .${k} === ${v} (got ${String((res as Record<string, unknown>)[k])})`
        );
      }
    }
  }

  // ─── Service clients + middleware + plugin ──────────────────────────
  assert(
    /getPlaylist\s*:\s*/.test(musicServiceSrc) ||
      /export async function getPlaylist/.test(musicServiceSrc),
    "service exports getPlaylist"
  );
  assert(
    /export async function getSong/.test(musicServiceSrc),
    "service exports getSong"
  );
  assert(
    /export async function getLyrics/.test(musicServiceSrc),
    "service exports getLyrics"
  );
  assert(
    /\/api\/ytmusic\/playlist\?id=/.test(musicServiceSrc),
    "client hits /api/ytmusic/playlist?id=…"
  );
  assert(
    /\/api\/ytmusic\/song\?videoId=/.test(musicServiceSrc),
    "client hits /api/ytmusic/song?videoId=…"
  );
  assert(
    /\/api\/ytmusic\/lyrics\?videoId=/.test(musicServiceSrc),
    "client hits /api/ytmusic/lyrics?videoId=…"
  );
  assert(
    /AbortError/.test(musicServiceSrc) && /options\.signal/.test(musicServiceSrc),
    "client honors AbortSignal on every request"
  );

  assert(
    /import YTMusic from "ytmusic-api"/.test(middlewareSrc),
    "middleware imports the default export of ytmusic-api"
  );
  assert(
    /new YTMusic\(\)/.test(middlewareSrc) && /\.initialize\(\)/.test(middlewareSrc),
    "middleware instantiates + initializes YTMusic"
  );
  assert(
    /let ytmusicPromise/.test(middlewareSrc),
    "middleware uses a lazy singleton"
  );
  assert(
    /handlePlaylist/.test(middlewareSrc) &&
      /handleSong/.test(middlewareSrc) &&
      /handleLyrics/.test(middlewareSrc),
    "middleware defines playlist + song + lyrics handlers"
  );
  assert(
    /\/api\/ytmusic\/playlist/.test(middlewareSrc) &&
      /\/api\/ytmusic\/song/.test(middlewareSrc) &&
      /\/api\/ytmusic\/lyrics/.test(middlewareSrc),
    "middleware dispatcher routes all three new paths"
  );
  assert(
    /getPlaylistVideos/.test(middlewareSrc),
    "playlist handler fetches tracks via getPlaylistVideos (not just metadata)"
  );
  assert(
    /null when YouTube Music has no/.test(middlewareSrc) ||
      /raw\) \|\| raw\.length === 0/.test(middlewareSrc),
    "lyrics handler returns null text when YouTube Music has no lyrics (no fabrication)"
  );

  assert(
    /ytmusicSearchMiddleware\(\)/.test(viteConfigSrc) &&
      /configureServer/.test(viteConfigSrc) &&
      /configurePreviewServer/.test(viteConfigSrc),
    "vite.config mounts the middleware in dev AND preview"
  );

  // ─── URL module file-level checks ───────────────────────────────────
  assert(
    /music\.youtube\.com/.test(urlSrc) &&
      /www\.youtube\.com/.test(urlSrc) &&
      /youtu\.be/.test(urlSrc),
    "URL parser accepts music.youtube.com, www.youtube.com, youtu.be"
  );
  assert(
    /\"playlist\"|'playlist'/.test(urlSrc) &&
      /\"song\"|'song'/.test(urlSrc) &&
      /\"watch-with-playlist\"|'watch-with-playlist'/.test(urlSrc) &&
      /\"unsupported\"|'unsupported'/.test(urlSrc),
    "URL parser uses the four-kind discriminated union"
  );

  // ─── search.html UI contract ────────────────────────────────────────
  assert(
    /id="urlInput"/.test(searchHtmlSrc) &&
      /placeholder="https:\/\/music\.youtube\.com/.test(searchHtmlSrc),
    "search.html now uses a URL-paste input (not a query search)"
  );
  assert(
    /id="results"/.test(searchHtmlSrc) &&
      /id="playlistHeader"/.test(searchHtmlSrc),
    "search.html ships a results area + a playlist-header summary"
  );
  assert(
    /setParseUrl:\s*function/.test(searchHtmlSrc) &&
      /setGetPlaylist:\s*function/.test(searchHtmlSrc) &&
      /setGetSong:\s*function/.test(searchHtmlSrc) &&
      /setGetLyrics:\s*function/.test(searchHtmlSrc),
    "search.html exposes parseUrl / getPlaylist / getSong / getLyrics setters"
  );
  assert(
    /width:\s*1440px/.test(searchHtmlSrc) &&
      /background:\s*#ffffff/i.test(searchHtmlSrc),
    "search.html preserves the 1440×1024 white-stage style"
  );
  assert(
    /'Forum'/.test(searchHtmlSrc) &&
      /'Gamja Flower'/.test(searchHtmlSrc) &&
      /'Noto Serif JP'/.test(searchHtmlSrc),
    "search.html uses the existing font palette"
  );
  assert(
    /Playback isn't wired/.test(searchHtmlSrc),
    "search.html surfaces an honest 'no playback' note"
  );
  assert(
    /loading playlist/.test(searchHtmlSrc) &&
      /no tracks in this playlist/.test(searchHtmlSrc) &&
      /couldn.t load/.test(searchHtmlSrc) &&
      /Open from YouTube Music/.test(searchHtmlSrc),
    "search.html covers loading / empty / error / idle states"
  );
  assert(
    /fetching lyrics/.test(searchHtmlSrc) &&
      /lyrics unavailable/.test(searchHtmlSrc) &&
      /no lyrics available/.test(searchHtmlSrc),
    "search.html covers lyrics loading + unavailable states"
  );

  // ─── home.html + bridge wiring ──────────────────────────────────────
  assert(
    /id="searchOverlay"/.test(homeHtmlSrc) &&
      /id="searchFrame"/.test(homeHtmlSrc) &&
      /id="searchClose"/.test(homeHtmlSrc),
    "home.html has the search overlay scrim + iframe + close button"
  );
  assert(
    /\.search-overlay\.open/.test(homeHtmlSrc) &&
      /transition:\s*opacity 0\.35s ease/.test(homeHtmlSrc),
    "home.html search overlay uses the existing overlay pattern"
  );

  assert(
    /__kotobaSearch/.test(bridgeTs) &&
      /search\.playlist\(/.test(bridgeTs) &&
      /search\.song\(/.test(bridgeTs) &&
      /search\.lyrics\(/.test(bridgeTs) &&
      /search\.parseUrl\(/.test(bridgeTs),
    "bridge wires parseUrl + getPlaylist + getSong + getLyrics"
  );
  assert(
    /lyrics: opts\.lyrics/.test(bridgeTs.replace(/\s+/g, " ")) ||
      /lyrics,?\s*\}\s*\);?\s*\}/.test(bridgeTs),
    "bridge forwards fetched lyrics into openLyric({...lyrics})"
  );
  assert(
    /openLyric\(\{\s*songTitle: result\.title/.test(bridgeTs),
    "selecting a track opens the lyric translation interface"
  );
  assert(
    /detectDirection/.test(bridgeTs),
    "bridge auto-detects direction from the fetched lyrics"
  );
  assert(
    /SEARCH_DEMO_HASH|#search/.test(bridgeTs),
    "bridge honors the #search URL hash entry point"
  );

  // ─── Runtime guards ─────────────────────────────────────────────────
  // Empty playlist id throws the typed error.
  let emptyErr: unknown = null;
  try { await search.playlist(""); } catch (e) { emptyErr = e; }
  assert(
    emptyErr instanceof Error && /required/i.test((emptyErr as Error).message),
    "search.playlist('') throws MusicSearchError"
  );

  let emptyLyricsErr: unknown = null;
  try { await search.lyrics(""); } catch (e) { emptyLyricsErr = e; }
  assert(
    emptyLyricsErr instanceof Error && /required/i.test((emptyLyricsErr as Error).message),
    "search.lyrics('') throws MusicSearchError"
  );

  assert(
    AppError !== undefined,
    "MusicSearchError extends the existing AppError hierarchy"
  );

  // -----------------------------------------------------------------------
  console.log("\n5. Burn-CD popup: Spotify + YouTube playlist URL parser");

  const { parsePlaylistUrl } = await import(
    "../src/domains/playlist/url.js"
  );

  type PlaylistProvider = "spotify" | "youtube";
  interface ParsedOk {
    provider: PlaylistProvider;
    playlistId: string;
    externalUrl: string;
    focusVideoId?: string;
  }
  interface ParsedErr { error: string }
  type Parsed = ParsedOk | ParsedErr;
  const isOk = (p: Parsed): p is ParsedOk => "provider" in p;

  const burnCases: Array<{
    input: string;
    want: "spotify" | "youtube" | "error";
    id?: string;
    focusVideoId?: string;
  }> = [
    { input: "", want: "error" },
    { input: "hello world", want: "error" },
    { input: "https://example.com/playlist/xxx", want: "error" },

    // Spotify URL shapes
    { input: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      want: "spotify", id: "37i9dQZF1DXcBWIGoYBM5M" },
    { input: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc",
      want: "spotify", id: "37i9dQZF1DXcBWIGoYBM5M" },
    { input: "https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M",
      want: "spotify", id: "37i9dQZF1DXcBWIGoYBM5M" },
    { input: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
      want: "spotify", id: "37i9dQZF1DXcBWIGoYBM5M" },
    { input: "https://open.spotify.com/intl-ja/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x",
      want: "spotify", id: "37i9dQZF1DXcBWIGoYBM5M" },
    // Bare 22-char base62 id
    { input: "37i9dQZF1DXcBWIGoYBM5M",
      want: "spotify", id: "37i9dQZF1DXcBWIGoYBM5M" },

    // YouTube URL shapes (user-supplied example included)
    { input: "https://music.youtube.com/playlist?list=PLQWowEevU_Gq1reNUh6Ux4SXLLV7pC4uX&si=FhwHxVVrNnwiaKEG",
      want: "youtube", id: "PLQWowEevU_Gq1reNUh6Ux4SXLLV7pC4uX" },
    { input: "https://music.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxx",
      want: "youtube", id: "PLxxxxxxxxxxxxxxxxxxxxxx" },
    { input: "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxx",
      want: "youtube", id: "PLxxxxxxxxxxxxxxxxxxxxxx" },
    { input: "https://music.youtube.com/watch?v=lYBUbBu4W08&list=PLxxxxxxxxxxxxxxxxxxxxxx",
      want: "youtube", id: "PLxxxxxxxxxxxxxxxxxxxxxx", focusVideoId: "lYBUbBu4W08" },
    { input: "https://youtu.be/lYBUbBu4W08?list=PLxxxxxxxxxxxxxxxxxxxxxx",
      want: "youtube", id: "PLxxxxxxxxxxxxxxxxxxxxxx", focusVideoId: "lYBUbBu4W08" },
    // Bare YT playlist id (PL prefix is distinct from Spotify's 22-char shape)
    { input: "PLQWowEevU_Gq1reNUh6Ux4SXLLV7pC4uX",
      want: "youtube", id: "PLQWowEevU_Gq1reNUh6Ux4SXLLV7pC4uX" },

    // Single-song URL should be rejected for the burn flow (not a playlist)
    { input: "https://music.youtube.com/watch?v=lYBUbBu4W08", want: "error" },
  ];
  for (const c of burnCases) {
    const res = parsePlaylistUrl(c.input) as Parsed;
    if (c.want === "error") {
      assert(!isOk(res), `parsePlaylistUrl(${JSON.stringify(c.input)}) rejects (got ${JSON.stringify(res)})`);
      continue;
    }
    if (!isOk(res)) {
      assert(false, `parsePlaylistUrl(${JSON.stringify(c.input)}) should accept — got ${JSON.stringify(res)}`);
      continue;
    }
    assert(res.provider === c.want, `  provider === ${c.want} (got ${res.provider})`);
    if (c.id !== undefined) {
      assert(res.playlistId === c.id, `  playlistId === ${c.id} (got ${res.playlistId})`);
    }
    if (c.focusVideoId !== undefined) {
      assert(res.focusVideoId === c.focusVideoId, `  focusVideoId === ${c.focusVideoId} (got ${res.focusVideoId})`);
    }
    assert(typeof res.externalUrl === "string" && res.externalUrl.length > 0, "  externalUrl is populated");
  }

  // ─── Bridge structural check ────────────────────────────────────────
  assert(
    !/window\.prompt\(\s*["'][Pp]aste Spotify playlist/.test(bridgeTs),
    "bridge no longer uses window.prompt for the playlist URL"
  );
  assert(
    /parsePlaylistUrl/.test(bridgeTs),
    "bridge uses parsePlaylistUrl for provider detection"
  );
  assert(
    /cd\.fetchPlaylist\("spotify"/.test(bridgeTs) &&
      /cd\.fetchPlaylist\("youtube"/.test(bridgeTs),
    "bridge routes to cd.fetchPlaylist for BOTH spotify and youtube"
  );
  assert(
    /openBurnPopup|laptopOverlayEl\?.classList\.add\("open"\)/.test(bridgeTs),
    "bridge opens the styled laptop overlay (not a native prompt)"
  );
  assert(
    /showBurnError/.test(bridgeTs) && /show-error/.test(bridgeTs),
    "bridge surfaces failures via the existing .show-error CSS phase"
  );
  assert(
    /placeholder\s*=\s*["']Spotify or YouTube URL/.test(
      readFileSync(resolve(repoRoot, "public/home.html"), "utf8")
    ),
    "home.html urlInput placeholder reads 'Spotify or YouTube URL'"
  );

  // ─── playlist/service.ts now registers both Spotify AND YouTube ─────
  assert(
    /registerAdapter\(spotifyAdapter\)/.test(playlistService) &&
      /registerAdapter\(youtubeAdapter\)/.test(playlistService),
    "playlist/service.ts registers both spotify and youtube adapters"
  );

  // ─── YouTube adapter actually calls the middleware, not the old stub ─
  const ytAdapterSrc = readFileSync(
    resolve(repoRoot, "src/domains/playlist/adapters/youtube.ts"),
    "utf8"
  );
  assert(
    /\/api\/ytmusic\/playlist/.test(ytAdapterSrc) &&
      /\/api\/ytmusic\/song/.test(ytAdapterSrc),
    "YouTube adapter hits the Vite-middleware endpoints (not ytmusic-api directly)"
  );
  assert(
    !/YouTube adapter not implemented/.test(ytAdapterSrc),
    "Old stub 'not implemented' string is gone from the YouTube adapter"
  );

  // -----------------------------------------------------------------------
  console.log("\n6. Burn-CD accessibility + manual-lyric entry");

  const homeHtmlSrc2 = readFileSync(
    resolve(repoRoot, "public/home.html"),
    "utf8"
  );
  const lyricHtmlSrc = readFileSync(
    resolve(repoRoot, "public/lyric.html"),
    "utf8"
  );

  // Laptop is no longer locked by setLearningUiLocked (Burn-CD entry must
  // be clickable in every CD state).
  assert(
    /Laptop stays clickable always|laptop\.style\.pointerEvents = "auto"/.test(bridgeTs),
    "laptop pointer-events is never set to 'none' — Burn-CD entry always reachable"
  );
  // onLaptopClick auto-promotes CD state so users who haven't discovered
  // the drag-and-drop mechanic still reach the burn flow.
  assert(
    /auto-promote|cdState\.status !== "inserted"/.test(bridgeTs) &&
      /openBurnPopup\(\)/.test(bridgeTs),
    "onLaptopClick auto-promotes CD state to 'inserted' before opening the popup"
  );

  // New URL hashes
  assert(
    /hashRaw === "#burn"/.test(bridgeTs),
    "#burn URL hash opens the Burn-CD popup directly"
  );
  assert(
    /hashRaw === "#lyric"/.test(bridgeTs) &&
      /openLyricManualMode/.test(bridgeTs),
    "#lyric URL hash opens the lyric overlay in blank-manual mode"
  );

  // Manual-lyrics link inside the burn popup
  assert(
    /id="manualLyricsLink"/.test(homeHtmlSrc2) &&
      /or paste lyrics manually/.test(homeHtmlSrc2),
    "home.html ships an 'or paste lyrics manually' link in the burn popup"
  );
  assert(
    /\.manual-lyrics-link\s*\{/.test(homeHtmlSrc2) &&
      /\.laptop-stage\.phase-burn \.manual-lyrics-link/.test(homeHtmlSrc2) &&
      /'Gamja Flower'/.test(homeHtmlSrc2),
    "manual-lyrics link uses the existing Gamja Flower hint language + phase-burn reveal"
  );
  assert(
    /onManualLyricsClick/.test(bridgeTs) &&
      /manualLyricsLink\?\.addEventListener\("click"/.test(bridgeTs),
    "bridge wires the manual-lyrics click handler"
  );
  assert(
    /openLyric\(\{\s*songTitle: "Your lyrics"/.test(bridgeTs),
    "manual mode opens the lyric overlay with no preloaded lyrics"
  );

  // Lyric overlay — translate-all button for whole-song translation
  assert(
    /id="translateAllBtn"/.test(lyricHtmlSrc) &&
      /translate all/.test(lyricHtmlSrc),
    "lyric.html ships a 'translate all' button next to the direction toggle"
  );
  assert(
    /async function translateAllLines/.test(lyricHtmlSrc),
    "lyric.html defines translateAllLines that iterates every line through callbacks.analyzeLine"
  );
  assert(
    /state\.analysisMap\.has\(key\)/.test(lyricHtmlSrc) &&
      /state\.analysisMap\.set\(key, result\)/.test(lyricHtmlSrc),
    "translate-all skips already-analyzed lines and caches results via analysisMap"
  );
  assert(
    /function refreshTranslateAllBtn/.test(lyricHtmlSrc) &&
      /translateAllBtn\.hidden = !hasLyrics/.test(lyricHtmlSrc),
    "translate-all button is hidden until lyrics are loaded"
  );

  // -----------------------------------------------------------------------
  console.log("\n7. Burn-CD submit path (realm-safe Enter + visible button)");

  // The cross-realm `instanceof KeyboardEvent` bug must not come back.
  // The handler is attached from the parent React realm but fires inside
  // the iframe, where the KeyboardEvent constructor is a *different*
  // Function object — `instanceof` is always false across realms.
  // Active code must not perform the cross-realm check. Comments referring
  // to the old bug are fine — strip them before testing.
  const bridgeCode = bridgeTs.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert(
    !/if\s*\(\s*!\s*\(\s*event\s+instanceof\s+KeyboardEvent/.test(bridgeCode) &&
      !/\bevent\s+instanceof\s+KeyboardEvent\b/.test(bridgeCode),
    "active bridge code does NOT use `instanceof KeyboardEvent` (cross-realm check would always be false)"
  );
  assert(
    /\(event as KeyboardEvent\)\.key|event\.key/.test(bridgeTs),
    "bridge duck-types the keydown event via .key instead of instanceof"
  );

  // Empty-input submit shows a clear error, not a silent no-op.
  assert(
    /showBurnError\("Paste a playlist URL\."\)/.test(bridgeTs),
    "empty-input submit surfaces a clear error (no silent failure)"
  );

  // -----------------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
