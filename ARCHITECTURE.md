# Kotoba — Frontend Architecture

## Posture: static-HTML-first with a thin React bridge

Kotoba is **not** a component-driven React application. The UI is a set of
hand-designed static HTML pages under `public/`, each with inline CSS and
inline JavaScript, styled around a skeuomorphic desk metaphor (laptop, CD,
photocards, dictionary book). React exists only as a minimal shell that:

1. Hosts the current page in a single top-level `<iframe>`.
2. Attaches a **bridge** of DOM event listeners inside that iframe so the
   static page can call into the real backend services in `src/domains/*`
   through the `services/app.ts` facade (`cd`, `dictionary`, `notes`,
   `rewards`, `setup`).
3. Applies env-derived configuration on mount via `setup.initFromEnv()`.

All other navigation and presentation concerns live in the HTML pages.

## Files that define this posture

| File | Role |
|---|---|
| `index.html` | Vite entry. Loads `src/frontend/main.tsx`. |
| `src/frontend/main.tsx` | Mounts React into `#root` inside a `BrowserRouter`. |
| `src/frontend/App.tsx` | Declares a **single** route `/` that renders `<LegacyDesignFrame />`. All other URLs redirect to `/`. |
| `src/frontend/LegacyDesignFrame.tsx` | Renders `<iframe src="/home.html">` and attaches a bridge based on the page the iframe is currently showing. |
| `public/home.html` | Desk scene. Owns drag-and-drop CD, laptop popup, album overlay, dictionary overlay (nested iframe), points board. |
| `public/diskbox.html` | Transition scene. One clickable region → `disk-select.html`. |
| `public/disk-select.html` | CD carousel. Self-contained; no React bridge. |
| `public/dictionary.html` | Dictionary book. Opened inside an overlay iframe **nested within home.html** (not the top-level React iframe). |

## Navigation rules

- **React owns one URL**: `/`. It never mirrors the user's current page
  into its own route. Any deep link other than `/` redirects to `/`.
- **Page-to-page navigation happens inside the iframe** via the shared
  `navigateTo(url)` helper in each HTML file, which sets
  `window.location.href = url` on relative paths. Same-origin, Vite serves
  every file under `public/` from `/`.
- **`LegacyDesignFrame` detects the current page on every iframe `load`**
  by reading `iframe.contentWindow.location.pathname`, then attaches the
  matching bridge (home bridge, diskbox bridge, or none for self-contained
  pages). The previous bridge is always detached first.
- **Overlays are opened in-place**, not as new routes: album overlay,
  dictionary overlay, and laptop popup all live inside `home.html` as
  fixed-inset `<div class="…-overlay">` elements that toggle an `.open`
  class. The dictionary overlay uses a second, nested `<iframe>` to load
  `dictionary.html`.

## Styling rules (inviolable)

- Fixed design canvas: **1440 × 1024 px**. Each page scales its root
  `.home-page` / `.desktop-1` / `.disk-select` / `.album-stage` etc. with
  `transform: scale(min(vw/1440, vh/1024))`.
- White background `#FFFFFF`; no dark mode.
- Plain CSS only — **no Tailwind, no CSS-in-JS, no design tokens**. Each
  HTML page carries its own `<style>` block.
- Absolute-positioned PNG art for every interactive element.
- Fonts: `Forum`, `Gamja Flower`, `Noto Serif JP`, `Linux Libertine`,
  `Georgia`. No other fonts.
- Hover hints are **speech-bubble PNG overlays**, not generic tooltips.
- Overlay pattern: fixed inset-0 scrim + 1440×1024 centered stage + `.open`
  class + 350 ms opacity transition. Reuse this pattern for new overlays.

## What each bridge does

Both bridges run inside `useEffect` in `LegacyDesignFrame` after the iframe
fires `load`. They query the iframe's document for fixed selectors and
wire event listeners:

- **Home bridge** (`attachHomeBridge`): syncs `rewards.getBalance()` into
  the legacy points localStorage, wires the points-increment button to
  `rewards.earn`, wires the album add-card button to `rewards.gachaPull`,
  manages the CD-state FSM (`none` → `ejected` → `inserted` → `burned`),
  wires drag-and-drop to the CD player / playlist bubble, opens the
  laptop / playlist overlays on the appropriate clicks, pushes Dexie
  dictionary entries into `public/dictionary.html` every time the
  dictionary overlay opens, opens `public/lyric.html` over the desk when
  the user picks a track in the burned-playlist overlay (wires
  `cd.analyzeLine`, `cd.saveLineToDictionary`, `cd.saveWordToDictionary`
  callbacks into it), and opens a dynamic notes overlay on `.notes`
  click that reads/writes through the `notes` facade.
- **Diskbox bridge** (`attachDiskboxBridge`): wires the `.pick-disk`
  click to set the CD state to `ejected` so the next return to home.html
  shows a draggable disc.

## Posture on stubbed / partial subsystems

- **Playlist providers.** Only Spotify is registered (see
  `src/domains/playlist/service.ts`). The YouTube and Deezer adapter
  files exist as future-work placeholders but are intentionally not
  registered — callers that ask for those providers get a clean
  "Provider not registered" from the adapter registry. The UI only
  exposes the Spotify burn-CD path (`LegacyDesignFrame.burnPlaylistOnCurrentCd`).
- **Legacy drift-inducing controls are removed, not fixed in place.**
  The old `#pointsReset` and `#albumReset` buttons in `home.html` wrote
  0 to localStorage behind the rewards service's back; they have been
  removed rather than wired to an ad-hoc reset API. If a settings-style
  reset is needed later, it should land as a single backend call
  (`rewards.resetAll()` or equivalent) that clears Dexie + localStorage
  atomically.
- **Inline duplicate constants have been deleted.** The legacy
  `CARD_POOL` array in `home.html` and its inline click handler were
  dead code once the React bridge began routing gacha pulls through
  `rewards.gachaPull`; they are gone. The `home.html` album renderer
  still reads `kotoba-bunny-album` localStorage for visual ordering, and
  the bridge continues to own every write to that key.

## What this architecture deliberately omits

- No per-feature React components.
- No global state store (each domain module owns its own Dexie table).
- No router hierarchy beyond `/`.
- No component library, no design system, no theming layer.
- No build step for the HTML pages — they are served verbatim by Vite
  from `public/`.

## Adding new features

When the next step adds a lyric interface, it should:

1. Prefer a new **static HTML file** in `public/` (e.g. `public/lyric.html`)
   that matches the 1440×1024 overlay pattern and font/palette rules.
2. Open it the same way the dictionary is opened today — as a nested
   `<iframe>` inside `home.html` behind an `.open`-toggled scrim, or as a
   direct in-iframe navigation via `navigateTo('lyric.html')` if it is a
   full-screen scene.
3. If it needs backend calls, extend `LegacyDesignFrame`'s dispatcher to
   attach a **lyric bridge** when the iframe pathname is `/lyric.html`,
   mirroring the shape of `attachHomeBridge` / `attachDiskboxBridge`. Do
   not introduce a separate top-level React component for it.

Anything that violates these rules should be justified in a follow-up
section of this file before it lands.
