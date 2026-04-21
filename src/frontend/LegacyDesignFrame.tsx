import { useEffect, useRef } from "react";
import { cd, dictionary, notes, popupQuiz, rewards, search, setup } from "../services/app";
import type {
  AnalysisDirection,
  AnalysisLine,
  AnalysisWord,
  ExportContext,
  LyricsResult,
  MusicPlaylist,
  MusicSearchResult,
  ParsedMusicUrl,
  WordDetail,
} from "../services/app";
import { parsePlaylistUrl } from "../domains/playlist/url";
import {
  findLatestSlotForPlaylist,
  loadSlotMemory,
  updateSlotMemory,
  type SlotCdState,
  type SlotLyricSession,
  type SlotPlaylistSource,
} from "../domains/playlist/slotMemory";

const LYRIC_DEMO_HASH = "#lyric-demo";
const SEARCH_DEMO_HASH = "#search";

const ALBUM_STORAGE_KEY = "kotoba-bunny-album";
const POINTS_KEY = "kotoba-points";
const CD_STATE_KEY = "kotoba-cd-state";
const BURNED_PLAYLIST_KEY = "kotoba-burned-playlist";
const SPOTIFY_TOKEN_KEY = "kotoba-spotify-bearer-token";
const VISITED_KEY = "kotoba-visited";
// Written by disk-select.html's CD-click handler. Fallback "default" when
// the user reached home.html without going through the picker (direct
// link, first-time visit, or a browser that blocked the write).
const CURRENT_PLAYLIST_SLOT_KEY = "kotoba-current-playlist-slot";

type CdStatus = "none" | "ejected" | "inserted" | "burned";

interface CdState {
  status: CdStatus;
  lastUpdatedAt: number;
  playlistId?: string;
  playlistName?: string;
}

/** The track list that's been "burned" onto the CD. The CD holds one
 *  playlist from one provider at a time. */
interface BurnedPlaylistState {
  provider: "spotify" | "youtube";
  playlistId: string;
  playlistName: string;
  tracks: Array<{ id: string; title: string; artist: string }>;
}

function readAlbum(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ALBUM_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function writeAlbum(cards: string[]): void {
  localStorage.setItem(ALBUM_STORAGE_KEY, JSON.stringify(cards));
}

function readCdState(): CdState {
  try {
    const parsed = JSON.parse(localStorage.getItem(CD_STATE_KEY) ?? "");
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.status === "string" &&
      typeof parsed.lastUpdatedAt === "number"
    ) {
      return parsed as CdState;
    }
  } catch {
    // no-op
  }
  return { status: "none", lastUpdatedAt: Date.now() };
}

function writeCdState(state: CdState): void {
  localStorage.setItem(CD_STATE_KEY, JSON.stringify(state));
}

function readBurnedPlaylistState(): BurnedPlaylistState | null {
  try {
    const raw = JSON.parse(localStorage.getItem(BURNED_PLAYLIST_KEY) ?? "");
    if (
      raw &&
      (raw.provider === "spotify" || raw.provider === "youtube") &&
      typeof raw.playlistId === "string" &&
      typeof raw.playlistName === "string" &&
      Array.isArray(raw.tracks)
    ) {
      return raw as BurnedPlaylistState;
    }
  } catch {
    // no-op
  }
  return null;
}

function writeBurnedPlaylistState(state: BurnedPlaylistState): void {
  localStorage.setItem(BURNED_PLAYLIST_KEY, JSON.stringify(state));
}

// (Provider detection lives in src/domains/playlist/url.ts — imported at
//  the top of the file. The burn popup asks for Spotify OR YouTube URLs.)

function ensureInitializedUiState(): boolean {
  let changed = false;
  if (!localStorage.getItem(VISITED_KEY)) {
    localStorage.setItem(VISITED_KEY, "1");
    changed = true;
  }
  const cd = readCdState();
  if (cd.status === "none") {
    writeCdState({
      status: "ejected",
      lastUpdatedAt: Date.now(),
    });
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Slot-memory autosave — writes per (playlistSlot, cdSlot) records to
// localStorage via src/domains/playlist/slotMemory.ts. This block owns
// every call site that decides "should the current slot be persisted
// right now, and with what fields?" — no other file reaches into
// slotMemory directly.
//
// Slot identity:
//   playlistSlotId = carousel index persisted by disk-select.html (fallback
//                    "default" — see CURRENT_PLAYLIST_SLOT_KEY above).
//   cdSlotId       = "<provider>:<playlistId>" when a playlist is burned
//                    onto the CD, else "manual:<stableSongId>" when the
//                    user is in the paste-your-own-lyrics flow.
//
// Empty-state protection lives here too: we refuse to write source
// records with no tracks, or lyric records with no songId — so stray
// UI transitions can never land a placeholder slot over a real one.
// ---------------------------------------------------------------------------

function readCurrentPlaylistSlotId(): string {
  try {
    const raw = localStorage.getItem(CURRENT_PLAYLIST_SLOT_KEY);
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  } catch {
    // fall through to default
  }
  return "default";
}

function cdSlotIdFromBurned(burned: BurnedPlaylistState): string {
  return `${burned.provider}:${burned.playlistId}`;
}

function cdSlotIdFromSongId(songId: string): string {
  return `manual:${songId}`;
}

function autosaveSource(burned: BurnedPlaylistState): void {
  if (!burned.tracks || burned.tracks.length === 0) return;
  const source: SlotPlaylistSource = {
    provider: burned.provider,
    playlistId: burned.playlistId,
    playlistName: burned.playlistName,
    tracks: burned.tracks.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
    })),
  };
  updateSlotMemory({
    playlistSlotId: readCurrentPlaylistSlotId(),
    cdSlotId: cdSlotIdFromBurned(burned),
    source,
  });
}

function autosaveBurnedCdState(
  burned: BurnedPlaylistState,
  cdState: CdState
): void {
  const block: SlotCdState = {
    status: cdState.status,
    lastUpdatedAt: cdState.lastUpdatedAt,
  };
  updateSlotMemory({
    playlistSlotId: readCurrentPlaylistSlotId(),
    cdSlotId: cdSlotIdFromBurned(burned),
    cdState: block,
  });
}

interface LyricSessionSnapshot {
  reason: string;
  songTitle: string;
  artistName: string;
  sourceTrackId?: string;
  direction: "ja-en" | "en-ja";
  lyricsText: string | null;
  hasLyrics: boolean;
  view: "all" | "stanza" | "line" | "word";
  activeLineRef: { stanzaIndex: number; lineIndex: number } | null;
  activeStanzaIndex: number | null;
  isDemo: boolean;
  analysisCount: number;
}

function autosaveLyricSession(
  songId: string,
  snapshot: LyricSessionSnapshot
): void {
  // Demo lyrics are an explicit fallback the user loads by hitting the
  // "use demo" button — not real work. Persisting them would clobber a
  // slot's real session on demo inspection, so skip them entirely.
  if (snapshot.isDemo) return;
  // Nothing of value yet: empty blank open. Don't save a placeholder.
  if (!snapshot.hasLyrics && snapshot.analysisCount === 0) return;

  const playlistSlotId = readCurrentPlaylistSlotId();
  const burned = readBurnedPlaylistState();
  const cdSlotId = burned
    ? cdSlotIdFromBurned(burned)
    : cdSlotIdFromSongId(songId);

  const session: SlotLyricSession = {
    songId,
    sourceTrackId: snapshot.sourceTrackId,
    songTitle: snapshot.songTitle,
    artistName: snapshot.artistName,
    direction: snapshot.direction,
    lyrics: snapshot.lyricsText,
    view: snapshot.view,
    activeLineRef: snapshot.activeLineRef,
    activeStanzaIndex: snapshot.activeStanzaIndex,
    isDemo: false,
    updatedAt: Date.now(),
  };

  updateSlotMemory({
    playlistSlotId,
    cdSlotId,
    lyricSession: session,
  });
}

/**
 * Reconcile the global `kotoba-burned-playlist` / `kotoba-cd-state`
 * scalars (which home.html's visuals read through the bridge) with
 * whatever slot the user is now on. Runs once per home-bridge attach,
 * BEFORE `applyCdStateToDesign`, so the desk paints in the restored
 * state on first render — no flicker.
 *
 * Three outcomes:
 *   1. This playlist slot has a saved record → restore its burned CD
 *      + cd-state into the global scalars (overwriting any scalar that
 *      was left behind from a different playlist slot).
 *   2. No saved record for this playlist slot, but stale global
 *      scalars exist → clear them, so the new carousel position shows
 *      empty state instead of the previous slot's CD.
 *   3. No saved record and no global scalars → no-op, leaving whatever
 *      `ensureInitializedUiState` set up (a blank ejected disc).
 *
 * Never touches the per-slot records — hydration is read-only against
 * slot memory, which protects every other saved slot from accidental
 * overwrite during restore.
 */
function hydrateBurnedCdFromSlot(): void {
  const playlistSlotId = readCurrentPlaylistSlotId();
  // Pick the latest slot WITH A BURNED SOURCE. Without this filter, a
  // manual-lyrics sub-slot saved on the same playlistSlotId later than
  // the burned slot would be picked by max(savedAt); it has no source
  // so we'd bail out, leaving the global scalars however the *previous*
  // carousel position left them — which could be "cleared" if the user
  // had just come from an unused slot. That manifests as the burned CD
  // silently vanishing after touching manual mode + switching slots.
  const slot = findLatestSlotForPlaylist(
    playlistSlotId,
    (s) =>
      !!(
        s.source &&
        s.source.tracks &&
        s.source.tracks.length > 0 &&
        (s.source.provider === "spotify" || s.source.provider === "youtube") &&
        s.source.playlistId &&
        s.source.playlistName
      )
  );

  if (slot && slot.source && slot.source.tracks && slot.source.tracks.length > 0) {
    const source = slot.source;
    // Type narrowing: slotMemory accepts "manual" as a provider but the
    // burned-playlist scalar only holds real providers. The predicate
    // above already rejected "manual", so this is a structural guard
    // for the type system only.
    if (source.provider !== "spotify" && source.provider !== "youtube") {
      return;
    }
    if (!source.playlistId || !source.playlistName) return;
    if (!source.tracks || source.tracks.length === 0) return;

    const burned: BurnedPlaylistState = {
      provider: source.provider,
      playlistId: source.playlistId,
      playlistName: source.playlistName,
      tracks: source.tracks,
    };
    writeBurnedPlaylistState(burned);

    const cdState: CdState = {
      status: slot.cdState?.status ?? "burned",
      lastUpdatedAt: slot.cdState?.lastUpdatedAt ?? Date.now(),
      playlistId: source.playlistId,
      playlistName: source.playlistName,
    };
    writeCdState(cdState);
    return;
  }

  // No saved slot for this playlist position. If the global scalars
  // still hold a CD from a different playlist, clear them so the user
  // sees the empty state they expect for a fresh slot.
  const existingBurned = readBurnedPlaylistState();
  if (existingBurned) {
    localStorage.removeItem(BURNED_PLAYLIST_KEY);
  }
  const existingCd = readCdState();
  if (existingCd.status === "burned") {
    writeCdState({ status: "ejected", lastUpdatedAt: Date.now() });
  }
}

interface LyricHydrationPayload {
  view: "all" | "stanza" | "line" | "word";
  activeLineRef: { stanzaIndex: number; lineIndex: number } | null;
  activeStanzaIndex: number | null;
  analyses: AnalysisLine[];
}

/**
 * Resolve lyric-overlay hydration for the currently active slot, if any.
 * Returns null when:
 *   - the slot has no saved lyric session, OR
 *   - the saved session is for a different track than the one the user
 *     just clicked (songId mismatch — don't leak stale state across
 *     tracks).
 *
 * The cached line analyses come from Dexie (`lineAnalysesCache`) keyed
 * by songId — the same rows the live analyze path already writes to.
 */
async function resolveLyricHydration(
  ctx: { sourceTrackId?: string; songTitle: string; artistName: string },
  songId: string
): Promise<{
  session: SlotLyricSession;
  payload: LyricHydrationPayload;
} | null> {
  const playlistSlotId = readCurrentPlaylistSlotId();
  const burned = readBurnedPlaylistState();
  const cdSlotId = burned
    ? cdSlotIdFromBurned(burned)
    : cdSlotIdFromSongId(songId);

  const slot = loadSlotMemory(playlistSlotId, cdSlotId);
  if (!slot || !slot.lyricSession) return null;
  if (slot.lyricSession.songId !== songId) return null;

  let analyses: AnalysisLine[] = [];
  try {
    analyses = await cd.getCachedLines(songId);
  } catch {
    // Dexie can fail in Safari private mode; fall through with no
    // analyses. The lyrics themselves still rehydrate — the user just
    // re-clicks any line to re-analyze.
    analyses = [];
  }

  return {
    session: slot.lyricSession,
    payload: {
      view: slot.lyricSession.view,
      activeLineRef: slot.lyricSession.activeLineRef,
      activeStanzaIndex: slot.lyricSession.activeStanzaIndex,
      analyses,
    },
  };
}

function imagePathFromPull(cardId: string, rarity: string): string {
  if (rarity === "legendary") {
    const n = Number(cardId.replace("ssr-", "")) || 1;
    return `assets/special_pc/special_pc_${n}.JPG`;
  }
  const n = Number(cardId.replace("bunny-", "")) || 1;
  return `assets/bunny_photocards/bunny_${n}.JPG`;
}

/**
 * Thin React shell that hosts the static-HTML pages in an iframe and
 * attaches a bridge of DOM event listeners + backend-service calls.
 *
 * The iframe navigates itself between home.html / diskbox.html /
 * disk-select.html via relative URLs. On every iframe `load`, we inspect
 * the iframe's pathname and attach the matching bridge (or none, for
 * self-contained pages). See ARCHITECTURE.md for the posture.
 */
export function LegacyDesignFrame() {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Apply any env values (NVIDIA key, YouTube key, etc.) once at mount
    // so bridges attached later don't have to repeat this work.
    setup.initFromEnv();
  }, []);

  useEffect(() => {
    let disposed = false;

    const syncPointsFromBackend = async (): Promise<void> => {
      const balance = await rewards.getBalance();
      localStorage.setItem(POINTS_KEY, String(balance.total));
    };

    const reloadFrame = (): void => {
      iframeRef.current?.contentWindow?.location.reload();
    };

    const attachHomeBridge = async (): Promise<(() => void) | void> => {
      await syncPointsFromBackend();

      // Slot-memory hydration happens BEFORE DOM queries so that
      // `applyCdStateToDesign` (called further down) paints the restored
      // CD state on the very first render. No read of home.html's DOM
      // depends on this — the method only touches localStorage scalars.
      hydrateBurnedCdFromSlot();

      const frame = iframeRef.current;
      const doc = frame?.contentDocument;
      if (!doc) return;
      const win = frame?.contentWindow;

      // Force-disable legacy intro state in case localStorage is inconsistent.
      try {
        win?.localStorage.setItem(VISITED_KEY, "1");
      } catch {
        // ignore storage edge cases; we still strip class below
      }
      const homePage = doc.querySelector(".home-page") as HTMLElement | null;
      if (homePage) {
        homePage.classList.remove("first-visit");
      }

      const incrementBtn = doc.getElementById("pointsIncrement");
      const addCardBtn = doc.getElementById("albumAddCard");
      const disk = doc.querySelector(".disk") as HTMLElement | null;
      const cdPlayer = doc.querySelector(".cd-player") as HTMLElement | null;
      const caseEl = doc.querySelector(".case") as HTMLElement | null;
      const playlistBubble = doc.querySelector(
        ".playlist-bubble"
      ) as HTMLElement | null;
      const laptop = doc.querySelector(".laptop") as HTMLElement | null;
      const notesIcon = doc.querySelector(".notes") as HTMLElement | null;
      const dictionaryIcon = doc.querySelector(
        ".dictionary"
      ) as HTMLElement | null;
      const dictionaryFrame = doc.getElementById(
        "dictionaryFrame"
      ) as HTMLIFrameElement | null;
      const lyricOverlay = doc.getElementById(
        "lyricOverlay"
      ) as HTMLElement | null;
      const lyricFrame = doc.getElementById(
        "lyricFrame"
      ) as HTMLIFrameElement | null;
      const lyricClose = doc.getElementById(
        "lyricClose"
      ) as HTMLElement | null;
      const searchOverlay = doc.getElementById(
        "searchOverlay"
      ) as HTMLElement | null;
      const searchFrame = doc.getElementById(
        "searchFrame"
      ) as HTMLIFrameElement | null;
      const searchClose = doc.getElementById(
        "searchClose"
      ) as HTMLElement | null;
      const quizIcon = doc.querySelector(".quiz") as HTMLElement | null;
      const quizOverlayEl = doc.getElementById(
        "quizOverlay"
      ) as HTMLElement | null;
      const quizFrame = doc.getElementById(
        "quizFrame"
      ) as HTMLIFrameElement | null;
      const playlistIntro = doc.querySelector(
        ".playlist-intro"
      ) as HTMLElement | null;

      const setLearningUiLocked = (locked: boolean): void => {
        // Notes + dictionary are "post-listening" affordances — they stay
        // dimmed and pointer-events:none until a CD is inserted.
        const opacity = locked ? "0.55" : "1";
        for (const el of [notesIcon, dictionaryIcon]) {
          if (!el) continue;
          el.style.opacity = opacity;
          el.style.pointerEvents = locked ? "none" : "auto";
        }
        // The laptop is the Burn-CD entry point. It MUST remain clickable
        // in every CD state so users who don't discover the disk-drag
        // mechanic can still reach the burn flow. `onLaptopClick` handles
        // state promotion (none/ejected → inserted) itself.
        if (laptop) {
          laptop.style.opacity = locked ? "0.7" : "1";
          laptop.style.pointerEvents = "auto";
        }
      };

      const applyCdStateToDesign = (): void => {
        const cd = readCdState();
        if (!disk) return;

        // Base visuals.
        disk.style.display = "block";
        disk.style.opacity = "1";
        disk.style.filter = "";
        disk.style.cursor = "pointer";
        disk.draggable = false;
        // Legacy CSS disables drag globally; re-enable specifically for the CD.
        disk.style.setProperty("-webkit-user-drag", "element");
        disk.style.userSelect = "none";
        if (playlistIntro) playlistIntro.style.display = "none";

        if (cd.status === "none") {
          // First-time feel: steer user to diskbox picker.
          setLearningUiLocked(true);
          if (playlistIntro) playlistIntro.style.display = "block";
          return;
        }

        if (cd.status === "ejected") {
          // Flowchart: ejected CD can be dragged to playlist or CD player.
          setLearningUiLocked(true);
          disk.draggable = true;
          disk.style.cursor = "grab";
          return;
        }

        if (cd.status === "inserted") {
          // CD inserted, laptop/desktop path is available.
          setLearningUiLocked(false);
          disk.style.opacity = "0.25";
          return;
        }

        if (cd.status === "burned") {
          // Burned CD appears visually different and details are available on hover.
          setLearningUiLocked(false);
          disk.style.filter = "hue-rotate(145deg) saturate(1.25)";
          disk.title = cd.playlistName
            ? `Burned CD: ${cd.playlistName}`
            : "Burned CD";
        }
      };

      const renderPlaylistOverlay = (playlist: BurnedPlaylistState): void => {
        const old = doc.getElementById("kotoba-playlist-overlay");
        old?.remove();

        const overlay = doc.createElement("div");
        overlay.id = "kotoba-playlist-overlay";
        overlay.style.position = "fixed";
        overlay.style.inset = "0";
        overlay.style.zIndex = "2000";
        overlay.style.background = "rgba(0,0,0,0.55)";
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";

        const panel = doc.createElement("div");
        panel.style.width = "min(860px, 92vw)";
        panel.style.maxHeight = "82vh";
        panel.style.overflow = "auto";
        panel.style.background = "white";
        panel.style.borderRadius = "16px";
        panel.style.padding = "18px 20px";
        panel.style.fontFamily = "Forum, serif";
        panel.style.boxShadow = "0 20px 45px rgba(0,0,0,0.35)";

        const title = doc.createElement("h2");
        title.textContent = `CD Playlist: ${playlist.playlistName}`;
        title.style.margin = "0 0 10px";

        const subtitle = doc.createElement("p");
        subtitle.textContent =
          "Click a song to open its lyrics and start analyzing.";
        subtitle.style.margin = "0 0 14px";

        const list = doc.createElement("ol");
        list.style.margin = "0";
        list.style.paddingLeft = "22px";
        for (const track of playlist.tracks.slice(0, 50)) {
          const li = doc.createElement("li");
          li.style.marginBottom = "5px";

          const trackBtn = doc.createElement("button");
          trackBtn.type = "button";
          trackBtn.textContent = `${track.title} — ${track.artist}`;
          trackBtn.style.cssText =
            "background:none;border:none;padding:0;margin:0;font:inherit;color:#000;text-align:left;cursor:pointer;text-decoration:underline;";
          trackBtn.addEventListener("click", () => {
            overlay.remove();
            openLyric({
              songTitle: track.title,
              artistName: track.artist,
              sourceTrackId: track.id,
            });
          });
          li.appendChild(trackBtn);
          list.appendChild(li);
        }

        const actions = doc.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "10px";
        actions.style.marginTop = "14px";

        const closeBtn = doc.createElement("button");
        closeBtn.textContent = "Close";
        closeBtn.style.cursor = "pointer";

        const ejectBtn = doc.createElement("button");
        ejectBtn.textContent = "Eject CD";
        ejectBtn.style.cursor = "pointer";

        closeBtn.onclick = () => overlay.remove();
        ejectBtn.onclick = () => {
          const ejected: CdState = {
            status: "ejected",
            lastUpdatedAt: Date.now(),
            playlistId: playlist.playlistId,
            playlistName: playlist.playlistName,
          };
          writeCdState(ejected);
          autosaveBurnedCdState(playlist, ejected);
          overlay.remove();
          applyCdStateToDesign();
        };

        actions.append(closeBtn, ejectBtn);
        panel.append(title, subtitle, list, actions);
        overlay.appendChild(panel);
        doc.body.appendChild(overlay);
      };

      // --- Burn-CD popup (styled laptop overlay, provider-aware) ----------
      // Replaces the old window.prompt flow. The styled popup is already
      // part of home.html (#laptopOverlay, #urlInput, .show-error phase),
      // so we just drive it from the React bridge.
      const laptopOverlayEl = doc.getElementById(
        "laptopOverlay"
      ) as HTMLElement | null;
      const laptopStageEl = doc.querySelector(
        ".laptop-stage"
      ) as HTMLElement | null;
      const urlInputEl = doc.getElementById(
        "urlInput"
      ) as HTMLInputElement | null;

      const DEFAULT_URL_PLACEHOLDER = "Spotify or YouTube URL";
      if (urlInputEl) urlInputEl.placeholder = DEFAULT_URL_PLACEHOLDER;

      const closeBurnPopup = (): void => {
        if (!laptopOverlayEl || !laptopStageEl) return;
        laptopStageEl.classList.remove("phase-burn", "phase-music", "show-error");
        laptopOverlayEl.classList.remove("open");
        if (urlInputEl) {
          urlInputEl.blur();
          urlInputEl.placeholder = DEFAULT_URL_PLACEHOLDER;
        }
      };

      let burnPopupTimer: number | undefined;

      const openBurnPopup = (): void => {
        if (!laptopOverlayEl || !laptopStageEl || !urlInputEl) return;
        laptopStageEl.classList.remove(
          "phase-burn",
          "phase-eject",
          "show-error"
        );
        laptopStageEl.classList.add("phase-music");
        urlInputEl.value = "";
        urlInputEl.placeholder = DEFAULT_URL_PLACEHOLDER;
        laptopOverlayEl.classList.add("open");
        if (burnPopupTimer !== undefined) {
          clearTimeout(burnPopupTimer);
        }
        burnPopupTimer = window.setTimeout(() => {
          if (!laptopStageEl) return;
          laptopStageEl.classList.remove("phase-music");
          laptopStageEl.classList.add("phase-burn");
          urlInputEl?.focus();
        }, 1000);
      };

      const showBurnError = (reason: string): void => {
        if (!urlInputEl || !laptopStageEl) return;
        urlInputEl.value = "";
        urlInputEl.placeholder = reason;
        laptopStageEl.classList.add("show-error");
        try { urlInputEl.focus(); } catch { /* ignore */ }
      };

      const clearBurnError = (): void => {
        laptopStageEl?.classList.remove("show-error");
      };

      async function ensureSpotifyToken(): Promise<string | null> {
        const existing = localStorage.getItem(SPOTIFY_TOKEN_KEY) ?? "";
        if (existing.trim().length > 0) return existing.trim();
        // Token is the one piece we can't avoid prompting for with the
        // styled popup (it's a bearer string, not a URL). Fall back to
        // window.prompt here only — the URL input stays clean.
        const typed = window.prompt(
          "Spotify Bearer token (local testing; stored in localStorage)"
        );
        if (!typed || typed.trim().length === 0) return null;
        localStorage.setItem(SPOTIFY_TOKEN_KEY, typed.trim());
        return typed.trim();
      }

      async function finishBurn(
        provider: "spotify" | "youtube",
        playlistId: string,
        playlistName: string,
        tracks: BurnedPlaylistState["tracks"]
      ): Promise<void> {
        const burned: BurnedPlaylistState = {
          provider,
          playlistId,
          playlistName,
          tracks,
        };
        writeBurnedPlaylistState(burned);
        const burnedCd: CdState = {
          status: "burned",
          lastUpdatedAt: Date.now(),
          playlistId,
          playlistName,
        };
        writeCdState(burnedCd);
        // Persist the new slot (playlistSlot x "<provider>:<playlistId>"):
        // source + burned cdState land together so a return visit has
        // everything needed to re-render this CD without refetching.
        autosaveSource(burned);
        autosaveBurnedCdState(burned, burnedCd);
        applyCdStateToDesign();
        closeBurnPopup();
      }

      async function burnFromPastedUrl(rawInput: string): Promise<void> {
        const parsed = parsePlaylistUrl(rawInput);
        if ("error" in parsed) {
          showBurnError(parsed.error);
          return;
        }
        clearBurnError();

        if (parsed.provider === "spotify") {
          const token = await ensureSpotifyToken();
          if (!token) {
            showBurnError("Spotify token required");
            return;
          }
          try {
            setup.setSpotifyToken(token);
            const playlist = await cd.fetchPlaylist("spotify", parsed.playlistId, {
              forceRefresh: true,
            });
            if (!playlist.tracks || playlist.tracks.length === 0) {
              showBurnError("Playlist is empty");
              return;
            }
            await finishBurn(
              "spotify",
              parsed.playlistId,
              playlist.name,
              playlist.tracks.map((t) => ({
                id: t.song.source.externalId,
                title: t.song.title,
                artist: t.song.artist,
              }))
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown Spotify error";
            showBurnError(message);
          }
          return;
        }

        if (parsed.provider === "youtube") {
          try {
            const playlist = await cd.fetchPlaylist("youtube", parsed.playlistId, {
              forceRefresh: true,
            });
            if (!playlist.tracks || playlist.tracks.length === 0) {
              showBurnError("Playlist is empty");
              return;
            }
            await finishBurn(
              "youtube",
              parsed.playlistId,
              playlist.name,
              playlist.tracks.map((t) => ({
                id: t.song.source.externalId,
                title: t.song.title,
                artist: t.song.artist,
              }))
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown YouTube error";
            showBurnError(message);
          }
          return;
        }

        // Parser returned a provider we don't register (e.g. "deezer") —
        // surface a clean error instead of crashing.
        showBurnError("That provider isn't supported.");
      }

      // Capture-phase keydown so home.html's legacy inline handler (which
      // only understands dev test strings "error"/"exit") doesn't hijack
      // real URL submits.
      //
      // Do NOT use `event instanceof KeyboardEvent` here — this handler
      // is registered from the parent React realm but fires inside the
      // iframe, where the KeyboardEvent constructor is a *different*
      // Function object. `instanceof` would always return false across
      // realms and silently swallow every Enter press. Duck-type the
      // `.key` property instead.
      const onUrlInputKeydown = (event: Event): void => {
        const key = (event as KeyboardEvent).key;
        if (key !== "Enter") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const raw = (urlInputEl?.value ?? "").trim();
        if (raw.length === 0) {
          showBurnError("Paste a playlist URL.");
          return;
        }
        void burnFromPastedUrl(raw);
      };

      // Typing after an error should clear the red error sprite.
      const onUrlInputInput = (): void => clearBurnError();

      // "or paste lyrics manually →" link inside the burn popup: closes
      // the popup and opens the lyric overlay in blank-manual mode so
      // users who don't have a provider URL can still translate lyrics.
      const manualLyricsLink = doc.getElementById(
        "manualLyricsLink"
      ) as HTMLElement | null;

      const openLyricManualMode = (): void => {
        // Manual-mode sessions share the same default title/artist
        // ("Your lyrics" / ""), so without a per-open identifier every
        // manual paste would collide on `stableSongId` → Dexie would
        // serve a *previous* manual session's cached line analyses for
        // the *current* paste's line 1/stanza 1, regardless of which
        // playlist slot the user is on. That's a cross-slot cache leak
        // at the analysis layer, not the slot layer. A per-open token
        // gives each manual session its own keyspace in Dexie and its
        // own cdSlotId in slot memory. Trade-off: manual sessions
        // don't survive a full refresh (the token regenerates); bound
        // by product scope, refreshability isn't expected for the
        // paste-your-own-lyrics flow.
        const sessionToken =
          Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        openLyric({
          songTitle: "Your lyrics",
          artistName: "",
          sourceTrackId: `manual:${sessionToken}`,
        });
      };

      const onManualLyricsClick = (event: Event): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeBurnPopup();
        openLyricManualMode();
      };

      const onIncrement = async (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        await rewards.earn(1, "ui_points_increment");
        await syncPointsFromBackend();
        if (!disposed) reloadFrame();
      };

      const onAddCard = async (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const pull = await rewards.gachaPull();
        const album = readAlbum();
        album.push(imagePathFromPull(pull.photocard.id, pull.rarity));
        writeAlbum(album);
        await syncPointsFromBackend();
        if (!disposed) reloadFrame();
      };

      const onDiskClick = (event: Event) => {
        // Keep existing transition behavior but ensure state is explicit.
        writeCdState({
          status: "none",
          lastUpdatedAt: Date.now(),
        });
        // Let legacy handler redirect to diskbox page.
      };

      const onDragStart = (event: DragEvent) => {
        event.dataTransfer?.setData("application/x-kotoba-cd", "1");
        event.dataTransfer?.setData("text/plain", "kotoba-cd");
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        if (disk) disk.style.cursor = "grabbing";
      };

      const onDragEnd = () => {
        if (disk) disk.style.cursor = readCdState().status === "ejected" ? "grab" : "pointer";
      };

      const isCdDrag = (event: DragEvent): boolean =>
        Boolean(
          event.dataTransfer?.types.includes("application/x-kotoba-cd") ||
            event.dataTransfer?.getData("text/plain") === "kotoba-cd"
        );

      const allowDrop = (event: DragEvent) => {
        if (isCdDrag(event)) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        }
      };

      const onDropToCdPlayer = (event: DragEvent) => {
        event.preventDefault();
        if (!isCdDrag(event)) return;
        writeCdState({
          status: "inserted",
          lastUpdatedAt: Date.now(),
        });
        applyCdStateToDesign();
      };

      const onDropToPlaylist = (event: DragEvent) => {
        event.preventDefault();
        if (!isCdDrag(event)) return;
        // Dropping to playlist area means user is preparing it for burn flow.
        writeCdState({
          status: "ejected",
          lastUpdatedAt: Date.now(),
        });
        applyCdStateToDesign();
      };

      const onLaptopClick = async (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();

        const cdState = readCdState();
        // Burned CD → show its track list (existing behavior).
        if (cdState.status === "burned") {
          const burned = readBurnedPlaylistState();
          if (burned) renderPlaylistOverlay(burned);
          return;
        }
        // Any other state (none / ejected / inserted) → open the Burn-CD
        // popup. We auto-promote state to "inserted" so the visual "disk
        // in player" cue matches the flow the user is now in — keeps the
        // drag-and-drop path intact for users who find it, but removes
        // the hard block on users who don't.
        if (cdState.status !== "inserted") {
          writeCdState({ status: "inserted", lastUpdatedAt: Date.now() });
          applyCdStateToDesign();
        }
        openBurnPopup();
      };

      const onPlaylistClick = (event: Event) => {
        if (readCdState().status !== "burned") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const burned = readBurnedPlaylistState();
        if (burned) renderPlaylistOverlay(burned);
      };

      const onCdPlayerClick = (event: Event) => {
        const cdState = readCdState();
        if (cdState.status !== "ejected") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        writeCdState({
          status: "inserted",
          lastUpdatedAt: Date.now(),
        });
        applyCdStateToDesign();
      };

      // --- Dictionary bridge --------------------------------------------------
      // home.html owns the dictionary overlay DOM and lazy-sets the iframe src
      // on first click. Here we piggyback on that click to push the real
      // Dexie-backed entries into the iframe's renderer. Re-runs every open so
      // newly-saved words appear without a reload.
      type DictionaryBridgeApi = {
        renderEntries: (entries: unknown[]) => void;
        showEmpty: (message: string) => void;
        // Word-detail fetcher used by the dictionary's per-entry
        // conjugation section. Mirrors the lyric iframe's identical
        // callback so both iframes hit the same cd.analyzeWordDetail
        // path; the dictionary renders only `conjugations` out of the
        // returned WordDetail, matching the scope of this fix.
        setAnalyzeWordDetail?: (
          fn: (req: {
            surface: string;
            romaji?: string;
            type?: string;
            direction?: AnalysisDirection;
          }) => Promise<WordDetail>
        ) => void;
      };

      const getDictionaryApi = (): DictionaryBridgeApi | undefined => {
        if (!dictionaryFrame) return undefined;
        const win = dictionaryFrame.contentWindow as
          | (Window & { __kotobaDictionary?: DictionaryBridgeApi })
          | null;
        return win?.__kotobaDictionary;
      };

      const renderDictionaryEntries = async (): Promise<void> => {
        const api = getDictionaryApi();
        if (!api) return;
        // Wire the word-detail fetcher (idempotent; safe to call on every
        // overlay open). The iframe stores it in closure until replaced.
        // Kept here so the bridge owns the only call site that reaches
        // into cd.* — dictionary.html never imports the service layer.
        if (typeof api.setAnalyzeWordDetail === "function") {
          api.setAnalyzeWordDetail((req) =>
            cd.analyzeWordDetail({
              surface: req.surface,
              romaji: req.romaji,
              type: req.type,
              direction: req.direction,
            })
          );
        }
        try {
          const entries = await dictionary.getAll();
          api.renderEntries(entries);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Failed to load dictionary";
          api.showEmpty(message);
        }
      };

      const onDictionaryOpen = (): void => {
        if (!dictionaryFrame) return;
        // home.html's own click handler runs first (registered earlier) and
        // sets dictionaryFrame.src on the first open. From this point the
        // nested iframe is either already loaded (api present) or about to
        // fire `load` (api absent).
        if (getDictionaryApi()) {
          void renderDictionaryEntries();
          return;
        }
        const onFrameLoad = () => {
          void renderDictionaryEntries();
        };
        dictionaryFrame.addEventListener("load", onFrameLoad, { once: true });
      };

      // --- Notes bridge ------------------------------------------------------
      // `.notes` previously had no click handler. It now opens a lightweight
      // overlay rendered on demand from notes.list() and mutated through
      // notes.add / notes.delete — no new storage, no localStorage shadow.
      const renderNotesOverlay = async (): Promise<void> => {
        const existing = doc.getElementById("kotoba-notes-overlay");
        existing?.remove();

        const overlay = doc.createElement("div");
        overlay.id = "kotoba-notes-overlay";
        overlay.style.cssText =
          "position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;";

        const panel = doc.createElement("div");
        panel.style.cssText =
          "width:min(640px,92vw);max-height:82vh;overflow:auto;background:#fff;border:1px solid #000;box-shadow:3px 5px 22px rgba(0,0,0,0.55);padding:22px 26px;font-family:'Linux Libertine',serif;color:#000;";

        const headerRow = doc.createElement("div");
        headerRow.style.cssText =
          "display:flex;align-items:baseline;justify-content:space-between;border-bottom:1.5px solid #000;padding-bottom:10px;margin-bottom:12px;";
        const title = doc.createElement("h2");
        title.textContent = "Notes";
        title.style.cssText = "margin:0;font-family:'Forum',serif;font-size:28px;";
        const closeBtn = doc.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "close";
        closeBtn.style.cssText =
          "background:none;border:none;padding:0;cursor:pointer;font-family:'Forum',serif;font-size:18px;text-decoration:underline;color:#000;";
        closeBtn.addEventListener("click", () => overlay.remove());
        headerRow.append(title, closeBtn);

        const form = doc.createElement("form");
        form.style.cssText =
          "display:flex;flex-direction:column;gap:6px;margin-bottom:16px;border:0.75px solid #000;padding:10px 12px;background:#fffdfa;";
        const formLabel = doc.createElement("div");
        formLabel.textContent = "new note";
        formLabel.style.cssText =
          "font-family:'Gamja Flower',cursive;font-size:14px;opacity:0.65;letter-spacing:0.06em;";
        const titleInput = doc.createElement("input");
        titleInput.type = "text";
        titleInput.placeholder = "title";
        titleInput.required = true;
        titleInput.style.cssText =
          "font-family:'Noto Serif JP','Linux Libertine',serif;font-size:15px;padding:4px 6px;border:0;border-bottom:1px solid #000;background:transparent;outline:none;";
        const bodyInput = doc.createElement("textarea");
        bodyInput.placeholder = "body (optional)";
        bodyInput.rows = 3;
        bodyInput.style.cssText =
          "font-family:'Noto Serif JP','Linux Libertine',serif;font-size:14px;padding:4px 6px;border:0;border-top:1px dashed #000;background:transparent;outline:none;resize:vertical;";
        const submit = doc.createElement("button");
        submit.type = "submit";
        submit.textContent = "save";
        submit.style.cssText =
          "align-self:flex-start;margin-top:4px;background:none;border:none;padding:0;cursor:pointer;font-family:'Forum',serif;font-size:16px;text-decoration:underline;color:#000;";
        form.append(formLabel, titleInput, bodyInput, submit);

        const list = doc.createElement("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:10px;";

        const renderList = async (): Promise<void> => {
          list.innerHTML = "";
          const items = await notes.list();
          if (items.length === 0) {
            const empty = doc.createElement("div");
            empty.textContent = "No notes yet. Use the form above to add one.";
            empty.style.cssText =
              "font-family:'Gamja Flower',cursive;font-size:16px;opacity:0.6;padding:14px 2px;";
            list.appendChild(empty);
            return;
          }
          for (const note of items) {
            const card = doc.createElement("div");
            card.style.cssText =
              "border:0.75px solid #000;padding:8px 10px;display:flex;flex-direction:column;gap:4px;background:#fff;";
            const head = doc.createElement("div");
            head.style.cssText =
              "display:flex;align-items:baseline;justify-content:space-between;gap:8px;";
            const noteTitle = doc.createElement("div");
            noteTitle.textContent = note.title || "(untitled)";
            noteTitle.style.cssText =
              "font-family:'Forum',serif;font-size:17px;";
            const delBtn = doc.createElement("button");
            delBtn.type = "button";
            delBtn.textContent = "delete";
            delBtn.style.cssText =
              "background:none;border:none;padding:0;cursor:pointer;font-family:'Gamja Flower',cursive;font-size:14px;text-decoration:underline;color:#000;opacity:0.7;";
            delBtn.addEventListener("click", async () => {
              await notes.delete(note.id);
              await renderList();
            });
            head.append(noteTitle, delBtn);
            card.appendChild(head);
            if (note.body && note.body.trim().length > 0) {
              const body = doc.createElement("div");
              body.textContent = note.body;
              body.style.cssText =
                "font-family:'Linux Libertine',serif;font-size:13px;line-height:1.4;white-space:pre-wrap;";
              card.appendChild(body);
            }
            list.appendChild(card);
          }
        };

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const t = titleInput.value.trim();
          const b = bodyInput.value.trim();
          if (t.length === 0 && b.length === 0) return;
          await notes.add({ title: t, body: b });
          titleInput.value = "";
          bodyInput.value = "";
          await renderList();
        });

        // Close on scrim click.
        overlay.addEventListener("mousedown", (ev) => {
          if (ev.target === overlay) overlay.remove();
        });

        panel.append(headerRow, form, list);
        overlay.appendChild(panel);
        doc.body.appendChild(overlay);
        await renderList();
      };

      const onNotesClick = (event: Event): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
        void renderNotesOverlay();
      };

      // home.html doesn't set cursor:pointer on .notes itself; the bridge
      // marks it clickable now that it actually does something.
      if (notesIcon) notesIcon.style.cursor = "pointer";

      // --- Lyric bridge ------------------------------------------------------
      // Mirrors the dictionary bridge: we own open/close on the parent iframe
      // and push backend callbacks into the nested iframe once it finishes
      // loading /lyric.html. All backend calls go through the existing
      // services/app.ts facade — no duplicate pipeline.
      interface LyricOpenContext {
        songTitle: string;
        artistName: string;
        sourceTrackId?: string;
        direction?: AnalysisDirection;
        lyrics?: string;
        isDemo?: boolean;
        // Slot-memory rehydration data. Populated by openLyric when the
        // bridge finds a saved lyric session whose songId matches this
        // ctx. lyric.html's `open()` applies it atomically with lyrics
        // load so the restored state renders in one paint.
        hydrate?: LyricHydrationPayload;
      }
      interface LyricBridgeApi {
        open: (ctx: LyricOpenContext) => void;
        setAnalyzeLine: (
          fn: (
            line: string,
            lineNumber: number,
            stanzaNumber: number,
            direction: AnalysisDirection
          ) => Promise<AnalysisLine>
        ) => void;
        setSaveLine: (
          fn: (
            analysis: AnalysisLine,
            context: ExportContext
          ) => Promise<unknown>
        ) => void;
        setSaveWord: (
          fn: (
            word: AnalysisWord,
            analysis: AnalysisLine,
            context: ExportContext
          ) => Promise<unknown>
        ) => void;
        setAskQuestion: (
          fn: (
            text: string,
            question: string,
            direction: AnalysisDirection
          ) => Promise<{ answer: string }>
        ) => void;
        setAnalyzeWordDetail: (
          fn: (
            word: AnalysisWord,
            direction: AnalysisDirection
          ) => Promise<WordDetail>
        ) => void;
        setClose: (fn: () => void) => void;
        setOnSessionChange: (fn: (snapshot: LyricSessionSnapshot) => void) => void;
      }

      const getLyricApi = (): LyricBridgeApi | undefined => {
        if (!lyricFrame) return undefined;
        const lwin = lyricFrame.contentWindow as
          | (Window & { __kotobaLyric?: LyricBridgeApi })
          | null;
        return lwin?.__kotobaLyric;
      };

      const closeLyricOverlay = (): void => {
        lyricOverlay?.classList.remove("open");
      };

      const stableSongId = (ctx: LyricOpenContext): string => {
        if (ctx.sourceTrackId && ctx.sourceTrackId.length > 0) {
          return `track:${ctx.sourceTrackId}`;
        }
        const direction = ctx.direction ?? "ja-en";
        return `lyric:${direction}:${ctx.songTitle}:${ctx.artistName}`;
      };

      const wireLyricCallbacks = (
        api: LyricBridgeApi,
        ctx: LyricOpenContext
      ): void => {
        const songId = stableSongId(ctx);

        api.setAnalyzeLine(async (line, lineNumber, stanzaNumber, direction) => {
          // stanzaNumber=0 or lineNumber=0 is the lyric UI's sentinel for
          // "not a real line position" — used by the ✎ analyze-selection
          // flow. Skip the Dexie cache for those so sentinel rows don't
          // accumulate. Real line analyses (stanza/line ≥ 1) keep caching.
          const isSelection = stanzaNumber === 0 || lineNumber === 0;
          return cd.analyzeLine(
            {
              line,
              songTitle: ctx.songTitle,
              artistName: ctx.artistName,
              stanzaNumber,
              lineNumber,
              direction,
            },
            songId,
            isSelection ? { skipCache: true } : {}
          );
        });

        api.setSaveLine(async (analysis, context) => {
          return cd.saveLineToDictionary(analysis, {
            songTitle: context.songTitle ?? ctx.songTitle,
            artistName: context.artistName ?? ctx.artistName,
            sourceTrackId: context.sourceTrackId ?? ctx.sourceTrackId,
            direction: context.direction ?? analysis.direction,
          });
        });

        api.setSaveWord(async (word, analysis, context) => {
          return cd.saveWordToDictionary(
            word,
            analysis.japanese,
            analysis.culturalTranslation,
            {
              songTitle: context.songTitle ?? ctx.songTitle,
              artistName: context.artistName ?? ctx.artistName,
              sourceTrackId: context.sourceTrackId ?? ctx.sourceTrackId,
              direction: context.direction ?? analysis.direction,
            }
          );
        });

        api.setAskQuestion(async (text, question, direction) => {
          return cd.askAboutSelection({
            text,
            question,
            songTitle: ctx.songTitle,
            artistName: ctx.artistName,
            direction,
          });
        });

        api.setAnalyzeWordDetail(async (word, direction) => {
          return cd.analyzeWordDetail({
            surface: word.surface,
            romaji: word.romaji,
            type: word.type,
            songTitle: ctx.songTitle,
            artistName: ctx.artistName,
            direction,
          });
        });

        api.setClose(() => closeLyricOverlay());

        // Autosave the lyric session on every lyric-UI state change that
        // matters (lyrics loaded, line analyzed, view/direction/active-line
        // updated). songId is computed once per open and stays stable for
        // the session — switching tracks re-enters wireLyricCallbacks with
        // a fresh ctx and a new songId, so each track's saves target the
        // right record.
        api.setOnSessionChange((snapshot) => {
          autosaveLyricSession(songId, snapshot);
        });
      };

      const whenLyricApiReady = (): Promise<void> => {
        if (getLyricApi()) return Promise.resolve();
        return new Promise<void>((resolve) => {
          // `once: true` cleans the listener up once the iframe loads.
          lyricFrame?.addEventListener("load", () => resolve(), { once: true });
        });
      };

      // Rapid-click protection: if the user opens track A then
      // immediately opens track B, A's hydration IIFE might still be
      // pending. Each call bumps the token; late IIFEs bail if the
      // token moved on.
      let lyricOpenToken = 0;

      const openLyric = (ctx: LyricOpenContext): void => {
        if (!lyricOverlay || !lyricFrame) return;
        // First-open: set src so the nested iframe actually loads /lyric.html.
        if (!lyricFrame.getAttribute("src")) {
          lyricFrame.setAttribute("src", "lyric.html");
        }
        lyricOverlay.classList.add("open");

        // Kick off the slot lookup and the iframe-ready wait in parallel.
        // Single paint happens once both resolve — no blank-then-populate
        // flicker. The lookup is localStorage + one Dexie query; its cost
        // is well under the iframe load time on first open and trivial
        // on re-open.
        const myToken = ++lyricOpenToken;
        const hydrationPromise = resolveLyricHydration(
          {
            sourceTrackId: ctx.sourceTrackId,
            songTitle: ctx.songTitle,
            artistName: ctx.artistName,
          },
          stableSongId(ctx)
        );

        void (async () => {
          const [hit] = await Promise.all([
            hydrationPromise,
            whenLyricApiReady(),
          ]);
          // Another openLyric call arrived while we were waiting — the
          // newer call owns the overlay now, so drop this result.
          if (myToken !== lyricOpenToken) return;
          const api = getLyricApi();
          if (!api) return;

          // Merge saved fields the caller didn't supply — don't stomp on
          // freshly-fetched lyrics/direction (e.g. YouTube Music). That
          // also lines up with the guardrail: hydration never overwrites
          // an explicit caller-provided value.
          const finalCtx: LyricOpenContext = hit
            ? {
                ...ctx,
                direction: ctx.direction ?? hit.session.direction,
                lyrics:
                  typeof ctx.lyrics === "string" && ctx.lyrics.trim().length > 0
                    ? ctx.lyrics
                    : (hit.session.lyrics ?? undefined),
                hydrate: hit.payload,
              }
            : ctx;

          wireLyricCallbacks(api, finalCtx);
          api.open(finalCtx);
        })();
      };

      const onLyricCloseClick = (): void => closeLyricOverlay();

      // Clicking outside the iframe (on the scrim) also closes.
      const onLyricOverlayMousedown = (event: Event): void => {
        if (event.target === lyricOverlay) closeLyricOverlay();
      };
      // ------------------------------------------------------------------

      // --- Search bridge (YouTube Music via Node middleware) ---------------
      // Mirrors the dictionary / lyric bridges. ytmusic-api is Node-only, so
      // the browser hits a Vite-server middleware at /api/ytmusic/* — it
      // never imports ytmusic-api directly. The overlay drives a
      // paste-a-URL → pick-a-track → fetch-lyrics → open-in-lyric flow.
      interface SearchBridgeApi {
        open: () => void;
        reset: () => void;
        setParseUrl: (fn: (raw: string) => ParsedMusicUrl) => void;
        setGetPlaylist: (
          fn: (
            playlistId: string,
            options?: { signal?: AbortSignal }
          ) => Promise<MusicPlaylist>
        ) => void;
        setGetSong: (
          fn: (
            videoId: string,
            options?: { signal?: AbortSignal }
          ) => Promise<MusicSearchResult>
        ) => void;
        setGetLyrics: (
          fn: (
            videoId: string,
            options?: { signal?: AbortSignal }
          ) => Promise<LyricsResult>
        ) => void;
        setOnSelect: (
          fn: (
            result: MusicSearchResult,
            opts: { lyrics: string | null; lyricsError: string | null }
          ) => void
        ) => void;
        setClose: (fn: () => void) => void;
      }

      const getSearchApi = (): SearchBridgeApi | undefined => {
        if (!searchFrame) return undefined;
        const swin = searchFrame.contentWindow as
          | (Window & { __kotobaSearch?: SearchBridgeApi })
          | null;
        return swin?.__kotobaSearch;
      };

      const closeSearchOverlay = (): void => {
        searchOverlay?.classList.remove("open");
      };

      // Lyrics-direction heuristic: match lyric.html's auto-detect. If the
      // text contains any Japanese glyphs, treat as ja-en. Otherwise en-ja.
      const detectDirection = (text: string | null): AnalysisDirection => {
        if (!text) return "ja-en";
        return /[\u3040-\u30ff\u3400-\u9fff]/.test(text) ? "ja-en" : "en-ja";
      };

      const wireSearchCallbacks = (api: SearchBridgeApi): void => {
        api.setParseUrl((raw) => search.parseUrl(raw));
        api.setGetPlaylist(async (playlistId, options) => {
          return search.playlist(playlistId, options);
        });
        api.setGetSong(async (videoId, options) => {
          return search.song(videoId, options);
        });
        api.setGetLyrics(async (videoId, options) => {
          return search.lyrics(videoId, options);
        });
        api.setOnSelect((result, opts) => {
          // Handoff: close the search overlay and open the lyric
          // translation interface. If lyrics were fetched, they land
          // directly in the lyric pane — otherwise the user sees the
          // paste-lyrics fallback with song title/artist already filled.
          closeSearchOverlay();
          const lyrics = opts && typeof opts.lyrics === "string"
            ? opts.lyrics
            : undefined;
          openLyric({
            songTitle: result.title,
            artistName: result.artist,
            sourceTrackId: "ytmusic:" + result.videoId,
            direction: detectDirection(lyrics ?? null),
            lyrics,
          });
        });
        api.setClose(() => closeSearchOverlay());
      };

      const openSearch = (): void => {
        if (!searchOverlay || !searchFrame) return;
        if (!searchFrame.getAttribute("src")) {
          searchFrame.setAttribute("src", "search.html");
        }
        searchOverlay.classList.add("open");
        const push = () => {
          const api = getSearchApi();
          if (!api) return;
          wireSearchCallbacks(api);
          api.open();
        };
        if (getSearchApi()) {
          push();
        } else {
          searchFrame.addEventListener("load", push, { once: true });
        }
      };

      const onSearchCloseClick = (): void => closeSearchOverlay();
      const onSearchOverlayMousedown = (event: Event): void => {
        if (event.target === searchOverlay) closeSearchOverlay();
      };
      // ------------------------------------------------------------------

      // --- Quiz bridge -------------------------------------------------
      // home.html owns the overlay open/close; this bridge just installs
      // the popupQuiz facade into the nested iframe once it's loaded.
      // Mirrors the dictionary / lyric / search bridges; no new pattern.
      interface QuizBridgeApi {
        setApi: (api: {
          getState: typeof popupQuiz.getState;
          getNext: typeof popupQuiz.getNext;
          submit: typeof popupQuiz.submit;
          prefetchNext: typeof popupQuiz.prefetchNext;
          recentHistory: typeof popupQuiz.recentHistory;
        }) => void;
        open: () => void;
        close: () => void;
      }

      const getQuizApi = (): QuizBridgeApi | undefined => {
        if (!quizFrame) return undefined;
        const win = quizFrame.contentWindow as
          | (Window & { __kotobaQuiz?: QuizBridgeApi })
          | null;
        return win?.__kotobaQuiz;
      };

      const pushQuizApi = (): void => {
        const api = getQuizApi();
        if (!api) return;
        api.setApi({
          getState: popupQuiz.getState,
          getNext: popupQuiz.getNext,
          submit: popupQuiz.submit,
          prefetchNext: popupQuiz.prefetchNext,
          recentHistory: popupQuiz.recentHistory,
        });
        api.open();
      };

      const onQuizOpen = (): void => {
        if (!quizFrame) return;
        // home.html's click handler sets `src` on first open. From here
        // either the api is already present (re-open) or it'll be after
        // the iframe finishes loading.
        if (getQuizApi()) {
          pushQuizApi();
          return;
        }
        quizFrame.addEventListener(
          "load",
          () => {
            pushQuizApi();
          },
          { once: true }
        );
      };

      const onQuizCloseSignal = (): void => {
        // Parent's own handlers still remove the `.open` class — this
        // just lets the iframe reset its in-memory state so a later
        // re-open starts clean.
        getQuizApi()?.close();
      };
      // ------------------------------------------------------------------

      applyCdStateToDesign();

      incrementBtn?.addEventListener("click", onIncrement, true);
      addCardBtn?.addEventListener("click", onAddCard, true);
      disk?.addEventListener("click", onDiskClick, true);
      cdPlayer?.addEventListener("click", onCdPlayerClick, true);
      laptop?.addEventListener("click", onLaptopClick, true);
      playlistBubble?.addEventListener("click", onPlaylistClick, true);
      // Dictionary click listener uses bubble phase so home.html's own handler
      // (which sets the iframe src and toggles `.open`) runs first.
      dictionaryIcon?.addEventListener("click", onDictionaryOpen);
      notesIcon?.addEventListener("click", onNotesClick, true);
      lyricClose?.addEventListener("click", onLyricCloseClick);
      lyricOverlay?.addEventListener("mousedown", onLyricOverlayMousedown);
      searchClose?.addEventListener("click", onSearchCloseClick);
      searchOverlay?.addEventListener("mousedown", onSearchOverlayMousedown);
      // Quiz click uses bubble phase so home.html's own click handler
      // (which sets iframe src + toggles `.open`) runs first.
      quizIcon?.addEventListener("click", onQuizOpen);
      // Listening for parent-side close signals so the iframe's in-memory
      // state resets cleanly. home.html still owns removing the `.open`
      // class — these are additive observers.
      const quizCloseBtn = doc.getElementById("quizClose");
      quizCloseBtn?.addEventListener("click", onQuizCloseSignal);
      quizOverlayEl?.addEventListener("mousedown", (event: Event) => {
        if (event.target === quizOverlayEl) onQuizCloseSignal();
      });
      // Burn-CD popup: capture phase so our provider-aware submit runs
      // before home.html's legacy dev-string handler.
      urlInputEl?.addEventListener("keydown", onUrlInputKeydown, true);
      urlInputEl?.addEventListener("input", onUrlInputInput);
      manualLyricsLink?.addEventListener("click", onManualLyricsClick);
      disk?.addEventListener("dragstart", onDragStart, true);
      disk?.addEventListener("dragend", onDragEnd, true);
      doc.body.addEventListener("dragover", allowDrop, true);
      cdPlayer?.addEventListener("dragover", allowDrop, true);
      cdPlayer?.addEventListener("drop", onDropToCdPlayer, true);
      caseEl?.addEventListener("dragover", allowDrop, true);
      caseEl?.addEventListener("drop", onDropToPlaylist, true);
      playlistBubble?.addEventListener("dragover", allowDrop, true);
      playlistBubble?.addEventListener("drop", onDropToPlaylist, true);

      // Explicit demo entry point for verification: landing at
      // http://localhost/#lyric-demo (optionally #lyric-demo-en) auto-opens
      // the lyric overlay with the built-in demo lyrics. Real users reach
      // the overlay by clicking a track in the burned-playlist overlay.
      const hashRaw = window.location.hash || "";
      if (hashRaw.startsWith(LYRIC_DEMO_HASH)) {
        const wantEn = /^#lyric-demo-en/.test(hashRaw);
        // Resolve the demo lyrics out of the lyric iframe once it's loaded.
        const openDemo = () => {
          const api = getLyricApi();
          const demoLyrics = wantEn
            ? (api as unknown as { _DEMO_EN?: string } | undefined)?._DEMO_EN
            : (api as unknown as { _DEMO_JA?: string } | undefined)?._DEMO_JA;
          openLyric({
            songTitle: wantEn ? "Demo Song (EN)" : "Demo Song (JA)",
            artistName: "Kotoba",
            direction: wantEn ? "en-ja" : "ja-en",
            lyrics: demoLyrics,
            isDemo: true,
          });
        };
        if (lyricFrame && !lyricFrame.getAttribute("src")) {
          lyricFrame.setAttribute("src", "lyric.html");
          lyricFrame.addEventListener("load", openDemo, { once: true });
          lyricOverlay?.classList.add("open");
        } else if (lyricFrame) {
          openDemo();
        }
      }

      // /#search — open the YouTube Music search overlay directly. Handy
      // for demos and for links from other pages.
      if (hashRaw === SEARCH_DEMO_HASH || hashRaw.startsWith(SEARCH_DEMO_HASH + "?")) {
        openSearch();
      }

      // /#burn — jump straight to the Burn-CD popup. Auto-promotes CD
      // state so the user never has to discover the drag-and-drop path.
      if (hashRaw === "#burn") {
        const cs = readCdState();
        if (cs.status !== "inserted" && cs.status !== "burned") {
          writeCdState({ status: "inserted", lastUpdatedAt: Date.now() });
          applyCdStateToDesign();
        }
        openBurnPopup();
      }

      // /#lyric — open the lyric overlay in blank-manual mode so the
      // user can paste their own lyrics and translate without touching a
      // playlist URL. Coexists with #lyric-demo / provider flows.
      if (hashRaw === "#lyric") {
        openLyricManualMode();
      }

      return () => {
        incrementBtn?.removeEventListener("click", onIncrement, true);
        addCardBtn?.removeEventListener("click", onAddCard, true);
        disk?.removeEventListener("click", onDiskClick, true);
        cdPlayer?.removeEventListener("click", onCdPlayerClick, true);
        laptop?.removeEventListener("click", onLaptopClick, true);
        playlistBubble?.removeEventListener("click", onPlaylistClick, true);
        dictionaryIcon?.removeEventListener("click", onDictionaryOpen);
        notesIcon?.removeEventListener("click", onNotesClick, true);
        lyricClose?.removeEventListener("click", onLyricCloseClick);
        lyricOverlay?.removeEventListener("mousedown", onLyricOverlayMousedown);
        searchClose?.removeEventListener("click", onSearchCloseClick);
        searchOverlay?.removeEventListener("mousedown", onSearchOverlayMousedown);
        quizIcon?.removeEventListener("click", onQuizOpen);
        // NB: the scrim-mousedown handler was registered as an inline
        // arrow — the iframe document is torn down on navigation so no
        // explicit removeEventListener is needed there. The close-btn
        // handler is also attached to the iframe's DOM, same lifecycle.
        urlInputEl?.removeEventListener("keydown", onUrlInputKeydown, true);
        urlInputEl?.removeEventListener("input", onUrlInputInput);
        manualLyricsLink?.removeEventListener("click", onManualLyricsClick);
        if (burnPopupTimer !== undefined) clearTimeout(burnPopupTimer);
        disk?.removeEventListener("dragstart", onDragStart, true);
        disk?.removeEventListener("dragend", onDragEnd, true);
        doc.body.removeEventListener("dragover", allowDrop, true);
        cdPlayer?.removeEventListener("dragover", allowDrop, true);
        cdPlayer?.removeEventListener("drop", onDropToCdPlayer, true);
        caseEl?.removeEventListener("dragover", allowDrop, true);
        caseEl?.removeEventListener("drop", onDropToPlaylist, true);
        playlistBubble?.removeEventListener("dragover", allowDrop, true);
        playlistBubble?.removeEventListener("drop", onDropToPlaylist, true);
      };
    };

    const attachDiskboxBridge = (): (() => void) | void => {
      const frame = iframeRef.current;
      const doc = frame?.contentDocument;
      if (!doc) return;
      const pickDisk = doc.querySelector(".pick-disk") as HTMLElement | null;
      if (!pickDisk) return;

      const onPickDisk = () => {
        // Flowchart: selecting a new CD in diskbox returns home with an ejected disc.
        writeCdState({
          status: "ejected",
          lastUpdatedAt: Date.now(),
        });
      };
      pickDisk.addEventListener("click", onPickDisk, true);
      return () => pickDisk.removeEventListener("click", onPickDisk, true);
    };

    let detach: (() => void) | void;

    // Decide which bridge to attach based on what HTML page the iframe is
    // actually showing right now. This is the single source of truth for
    // "what page is visible" — the React shell does not try to mirror it
    // into its own URL.
    const detectPage = (): "home" | "diskbox" | "other" => {
      const pathname = iframeRef.current?.contentWindow?.location.pathname ?? "";
      if (pathname === "/" || pathname.endsWith("/home.html")) return "home";
      if (pathname.endsWith("/diskbox.html")) return "diskbox";
      return "other";
    };

    const onLoad = async () => {
      if (disposed) return;

      // Tear down any bridge attached to the previously-loaded page. The
      // iframe document itself is already replaced by the browser, so stale
      // listeners can't fire — we just drop our references cleanly.
      if (typeof detach === "function") detach();
      detach = undefined;

      const current = detectPage();

      if (current === "home") {
        // Prevent the legacy first-visit screen from hiding the full desk UI.
        if (ensureInitializedUiState()) {
          iframeRef.current?.contentWindow?.location.reload();
          return;
        }
        detach = await attachHomeBridge();
        return;
      }

      if (current === "diskbox") {
        detach = attachDiskboxBridge();
        return;
      }

      // "other" pages (disk-select.html, dictionary.html opened in its own
      // inner overlay) are self-contained — no bridge to attach.
    };

    const frame = iframeRef.current;
    frame?.addEventListener("load", onLoad);

    // Under React StrictMode / Fast Refresh the effect may run AFTER the
    // iframe has already fired its initial `load` event. Without this
    // guard the bridge would never attach because the `load` listener is
    // registered too late — every click (disk, laptop, dictionary, notes)
    // would silently do nothing. Kick onLoad directly when we can see
    // the iframe is already fully loaded.
    if (
      frame &&
      frame.contentWindow &&
      frame.contentDocument &&
      frame.contentDocument.readyState === "complete"
    ) {
      void onLoad();
    }

    return () => {
      disposed = true;
      frame?.removeEventListener("load", onLoad);
      if (typeof detach === "function") detach();
    };
  }, []);

  return (
    <iframe
      ref={iframeRef}
      className="legacy-frame"
      src="/home.html"
      title="kotoba"
    />
  );
}
