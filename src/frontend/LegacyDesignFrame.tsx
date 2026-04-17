import { useEffect, useRef } from "react";
import { cd, rewards, setup } from "../services/app";

type DesignPage = "home" | "diskbox";

const ALBUM_STORAGE_KEY = "kotoba-bunny-album";
const POINTS_KEY = "kotoba-points";
const CD_STATE_KEY = "kotoba-cd-state";
const BURNED_PLAYLIST_KEY = "kotoba-burned-playlist";
const SPOTIFY_TOKEN_KEY = "kotoba-spotify-bearer-token";
const VISITED_KEY = "kotoba-visited";

type CdStatus = "none" | "ejected" | "inserted" | "burned";

interface CdState {
  status: CdStatus;
  lastUpdatedAt: number;
  playlistId?: string;
  playlistName?: string;
}

interface BurnedPlaylistState {
  provider: "spotify";
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
      raw.provider === "spotify" &&
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

function parseSpotifyPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/playlist\/([a-zA-Z0-9]+)(\?|$)/);
  if (match?.[1]) return match[1];
  if (/^[a-zA-Z0-9]+$/.test(trimmed)) return trimmed;
  return null;
}

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

function imagePathFromPull(cardId: string, rarity: string): string {
  if (rarity === "legendary") {
    const n = Number(cardId.replace("ssr-", "")) || 1;
    return `assets/special_pc/special_pc_${n}.JPG`;
  }
  const n = Number(cardId.replace("bunny-", "")) || 1;
  return `assets/bunny_photocards/bunny_${n}.JPG`;
}

export function LegacyDesignFrame({ page }: { page: DesignPage }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
      const notes = doc.querySelector(".notes") as HTMLElement | null;
      const dictionary = doc.querySelector(".dictionary") as HTMLElement | null;
      const playlistIntro = doc.querySelector(
        ".playlist-intro"
      ) as HTMLElement | null;

      const setLearningUiLocked = (locked: boolean): void => {
        const opacity = locked ? "0.55" : "1";
        for (const el of [laptop, notes, dictionary]) {
          if (!el) continue;
          el.style.opacity = opacity;
          el.style.pointerEvents = locked ? "none" : "auto";
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
        subtitle.textContent = "View songs, then close or eject the CD.";
        subtitle.style.margin = "0 0 14px";

        const list = doc.createElement("ol");
        list.style.margin = "0";
        list.style.paddingLeft = "22px";
        for (const track of playlist.tracks.slice(0, 50)) {
          const li = doc.createElement("li");
          li.textContent = `${track.title} — ${track.artist}`;
          li.style.marginBottom = "5px";
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
          writeCdState({
            status: "ejected",
            lastUpdatedAt: Date.now(),
            playlistId: playlist.playlistId,
            playlistName: playlist.playlistName,
          });
          overlay.remove();
          applyCdStateToDesign();
        };

        actions.append(closeBtn, ejectBtn);
        panel.append(title, subtitle, list, actions);
        overlay.appendChild(panel);
        doc.body.appendChild(overlay);
      };

      const burnPlaylistOnCurrentCd = async (): Promise<void> => {
        const current = readCdState();
        if (current.status !== "inserted" && current.status !== "ejected") {
          return;
        }

        const rawInput = window.prompt(
          "Paste Spotify playlist URL or playlist ID to burn onto this CD:"
        );
        if (!rawInput) return;
        const playlistId = parseSpotifyPlaylistId(rawInput);
        if (!playlistId) {
          window.alert("Invalid Spotify playlist input.");
          return;
        }

        let token = localStorage.getItem(SPOTIFY_TOKEN_KEY) ?? "";
        if (!token) {
          token =
            window.prompt(
              "Paste Spotify Bearer token (local testing). We store it in localStorage."
            ) ?? "";
          if (!token) return;
          localStorage.setItem(SPOTIFY_TOKEN_KEY, token.trim());
        }

        try {
          setup.setSpotifyToken(token.trim());
          const playlist = await cd.fetchPlaylist("spotify", playlistId, {
            forceRefresh: true,
          });
          const burned: BurnedPlaylistState = {
            provider: "spotify",
            playlistId,
            playlistName: playlist.name,
            tracks: playlist.tracks.map((t) => ({
              id: t.song.source.externalId,
              title: t.song.title,
              artist: t.song.artist,
            })),
          };
          writeBurnedPlaylistState(burned);
          writeCdState({
            status: "burned",
            lastUpdatedAt: Date.now(),
            playlistId,
            playlistName: playlist.name,
          });
          applyCdStateToDesign();
          window.alert(`Burned CD with playlist "${playlist.name}".`);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown playlist error";
          window.alert(
            `Failed to fetch playlist. Check token/playlist visibility.\n${message}`
          );
        }
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
        const cdState = readCdState();
        if (cdState.status !== "inserted" && cdState.status !== "burned") return;
        event.preventDefault();
        event.stopImmediatePropagation();

        if (cdState.status === "inserted") {
          await burnPlaylistOnCurrentCd();
          return;
        }

        const burned = readBurnedPlaylistState();
        if (burned) renderPlaylistOverlay(burned);
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

      applyCdStateToDesign();

      incrementBtn?.addEventListener("click", onIncrement, true);
      addCardBtn?.addEventListener("click", onAddCard, true);
      disk?.addEventListener("click", onDiskClick, true);
      cdPlayer?.addEventListener("click", onCdPlayerClick, true);
      laptop?.addEventListener("click", onLaptopClick, true);
      playlistBubble?.addEventListener("click", onPlaylistClick, true);
      disk?.addEventListener("dragstart", onDragStart, true);
      disk?.addEventListener("dragend", onDragEnd, true);
      doc.body.addEventListener("dragover", allowDrop, true);
      cdPlayer?.addEventListener("dragover", allowDrop, true);
      cdPlayer?.addEventListener("drop", onDropToCdPlayer, true);
      caseEl?.addEventListener("dragover", allowDrop, true);
      caseEl?.addEventListener("drop", onDropToPlaylist, true);
      playlistBubble?.addEventListener("dragover", allowDrop, true);
      playlistBubble?.addEventListener("drop", onDropToPlaylist, true);

      return () => {
        incrementBtn?.removeEventListener("click", onIncrement, true);
        addCardBtn?.removeEventListener("click", onAddCard, true);
        disk?.removeEventListener("click", onDiskClick, true);
        cdPlayer?.removeEventListener("click", onCdPlayerClick, true);
        laptop?.removeEventListener("click", onLaptopClick, true);
        playlistBubble?.removeEventListener("click", onPlaylistClick, true);
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
    const onLoad = async () => {
      if (page === "home") {
        // Prevent the legacy first-visit screen from hiding the full desk UI.
        if (ensureInitializedUiState()) {
          iframeRef.current?.contentWindow?.location.reload();
          return;
        }
        detach = await attachHomeBridge();
        return;
      }
      if (page === "diskbox") {
        detach = attachDiskboxBridge();
      }
    };

    const frame = iframeRef.current;
    frame?.addEventListener("load", onLoad);

    return () => {
      disposed = true;
      frame?.removeEventListener("load", onLoad);
      if (typeof detach === "function") detach();
    };
  }, [page]);

  return (
    <iframe
      ref={iframeRef}
      className="legacy-frame"
      src={page === "home" ? "/home.html" : "/diskbox.html"}
      title={`kotoba-${page}`}
    />
  );
}
