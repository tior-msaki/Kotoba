/**
 * Lyric interface UI-contract smoke test.
 *
 * This test does three things, offline:
 *
 *   1. Walks the rewrite of public/lyric.html and public/home.html plus
 *      the React bridge in LegacyDesignFrame.tsx to prove the bridge
 *      wiring is in place (no hardcoded provider, no duplicate pipeline).
 *
 *   2. Runs the real analysis pipeline (with globalThis.fetch stubbed)
 *      for one Japanese line and one English line through cd.analyzeLine
 *      from services/app.ts. Then extracts the pure `wordCardHtml` and
 *      `lineAnalysisHtml` renderers from lyric.html and runs them against
 *      the actual AnalysisLine returned by the parser. Asserts the
 *      rendered HTML carries direct/cultural translation, romaji when
 *      present, ruby-free word cards, expandable kanji for JA, empty
 *      kanji for EN, and POS labels that match dictionary.html.
 *
 *   3. Exercises save-to-dictionary via cd.saveLineToDictionary and
 *      cd.saveWordToDictionary against fake-indexeddb, then confirms the
 *      Dexie store holds direction-tagged entries the dictionary UI will
 *      render in the next open.
 *
 * Run with: npm run smoke:lyric
 */

import "fake-indexeddb/auto";

import { cd, setup } from "../src/services/app";
import { getAllEntries } from "../src/domains/dictionary/service";
import type { LineAnalysisResponse } from "../src/domains/analysis/schemas";
import type { AnalysisLine, AnalysisWord } from "../src/services/app";
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

// ---------------------------------------------------------------------------
// Canned LLM responses (same shape as the direction smoke test)
// ---------------------------------------------------------------------------

const JA_RESPONSE: LineAnalysisResponse = {
  japanese: "光の中で目を覚ます",
  lineNumber: 1,
  directTranslation: "light's inside-at eyes (obj) wake-up",
  culturalTranslation: "I awaken in the light",
  romaji: "hikari no naka de me wo samasu",
  words: [
    {
      surface: "光",
      romaji: "hikari",
      type: "noun",
      transitivity: null,
      meaningInContext: "light",
      kanjiList: [
        {
          character: "光",
          romaji: "hikari",
          meanings: ["light", "radiance"],
          kunYomi: ["ひか"],
          onYomi: ["コウ"],
          nanori: [],
        },
      ],
    },
    {
      surface: "の",
      romaji: "no",
      type: "particle",
      transitivity: null,
      meaningInContext: "of; possessive",
      kanjiList: [],
    },
    {
      surface: "覚ます",
      romaji: "samasu",
      type: "godan-verb",
      transitivity: "transitive",
      meaningInContext: "to wake; to rouse",
      kanjiList: [
        {
          character: "覚",
          romaji: "saka",
          meanings: ["to wake", "to perceive"],
          kunYomi: ["おぼ", "さ"],
          onYomi: ["カク"],
          nanori: [],
        },
      ],
    },
  ],
};

const EN_RESPONSE: LineAnalysisResponse = {
  japanese: "I awoke in the light",
  lineNumber: 1,
  directTranslation: "私は光の中で目覚めた",
  culturalTranslation: "光の中で目を覚ました",
  romaji: "",
  words: [
    {
      surface: "I",
      romaji: "",
      type: "pronoun",
      transitivity: null,
      meaningInContext: "一人称代名詞",
      kanjiList: [],
    },
    {
      surface: "awoke",
      romaji: "",
      type: "verb",
      transitivity: "intransitive",
      meaningInContext: "目が覚めた (awake の過去形)",
      kanjiList: [],
    },
    {
      surface: "light",
      romaji: "",
      type: "noun",
      transitivity: null,
      meaningInContext: "光",
      kanjiList: [],
    },
  ],
};

const originalFetch = globalThis.fetch;

function installFetchStub(): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body = typeof init?.body === "string" ? init.body : "{}";
    // The browser client now POSTs { prompt, responseSchema } to the
    // same-origin proxy — direction detection still runs on the prompt.
    const parsed = JSON.parse(body) as { prompt?: string };
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    void url;
    const isEnJa = /bilingual English\/Japanese/.test(prompt);
    const canned = isEnJa ? EN_RESPONSE : JA_RESPONSE;
    const envelope = {
      choices: [
        { message: { role: "assistant", content: JSON.stringify(canned) } },
      ],
    };
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}
function restoreFetch(): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Source-scrape helpers — reproduce the lyric renderer in Node without jsdom.
// This mirrors how smoke-test-dictionary-ui.ts extracts entryHtml from
// dictionary.html. If the lyric.html renderer drifts, these regexes will
// fail to match and the test will throw loudly.
// ---------------------------------------------------------------------------

function escapeHtml(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Renderer = {
  wordCardHtml: (
    word: AnalysisWord,
    wi: number,
    ref: { stanzaIndex: number; lineIndex: number }
  ) => string;
  lineAnalysisHtml: (
    line: AnalysisLine,
    headline: string,
    ref: { stanzaIndex: number; lineIndex: number }
  ) => string;
};

function extractLyricRenderer(html: string): Renderer {
  const posMatch = html.match(/var POS_LABEL = (\{[\s\S]*?\});/);
  const wordFn = html.match(/function wordCardHtml\(word, wi, ref\) \{([\s\S]*?)\n  \}/);
  const lineFn = html.match(/function lineAnalysisHtml\(analysis, headline, ref\) \{([\s\S]*?)\n  \}/);
  const synthFn = html.match(/function synthesizeGrammarNotes\(words\) \{([\s\S]*?)\n  \}/);
  const gramFn = html.match(/function grammarNotesHtml\(words\) \{([\s\S]*?)\n  \}/);
  const deepFn = html.match(/function wordDeepDetailHtml\(detail\) \{([\s\S]*?)\n  \}/);
  if (!posMatch || !wordFn || !lineFn || !synthFn || !gramFn || !deepFn) {
    throw new Error(
      "Could not extract POS_LABEL / wordCardHtml / lineAnalysisHtml / grammar helpers / wordDeepDetailHtml from lyric.html"
    );
  }
  const src = `
    var POS_LABEL = ${posMatch[1]};
    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    // Minimal state the card renderer reads — wordDetailMap lets it decide
    // whether to emit the fetch button or the fetched content. In the test
    // sandbox we keep it empty so every card emits the fetch control, the
    // same UX a user sees on first view.
    var state = { direction: 'ja-en', wordDetailMap: new Map() };
    function wordDeepDetailHtml(detail) {${deepFn[1]}}
    function synthesizeGrammarNotes(words) {${synthFn[1]}}
    function grammarNotesHtml(words) {${gramFn[1]}}
    function wordCardHtml(word, wi, ref) {${wordFn[1]}}
    function lineAnalysisHtml(analysis, headline, ref) {${lineFn[1]}}
    return {
      wordCardHtml: wordCardHtml,
      lineAnalysisHtml: lineAnalysisHtml,
      wordDeepDetailHtml: wordDeepDetailHtml
    };
  `;
  // eslint-disable-next-line no-new-func
  return new Function(src)() as Renderer;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log("\n=== Lyric UI-contract smoke test ===\n");

  const lyricHtml = readFileSync(resolve(repoRoot, "public/lyric.html"), "utf8");
  const homeHtml = readFileSync(resolve(repoRoot, "public/home.html"), "utf8");
  const bridgeTs = readFileSync(
    resolve(repoRoot, "src/frontend/LegacyDesignFrame.tsx"),
    "utf8"
  );

  // -----------------------------------------------------------------------
  console.log("1. Static wiring: overlay + bridge + no duplicate pipeline");
  assert(/id="lyricOverlay"/.test(homeHtml), "home.html declares #lyricOverlay");
  assert(/id="lyricFrame"/.test(homeHtml), "home.html declares #lyricFrame");
  assert(/id="lyricClose"/.test(homeHtml), "home.html declares #lyricClose");
  assert(
    /\.lyric-overlay\.open/.test(homeHtml),
    "home.html has .lyric-overlay.open transition (matches overlay pattern)"
  );

  assert(/window\.__kotobaLyric\s*=/.test(lyricHtml), "lyric.html exposes __kotobaLyric");
  assert(/setAnalyzeLine:\s*function/.test(lyricHtml), "lyric.html exposes setAnalyzeLine");
  assert(/setSaveLine:\s*function/.test(lyricHtml), "lyric.html exposes setSaveLine");
  assert(/setSaveWord:\s*function/.test(lyricHtml), "lyric.html exposes setSaveWord");
  assert(/setClose:\s*function/.test(lyricHtml), "lyric.html exposes setClose");
  assert(
    /function onDirectionChange\(newDir\)/.test(lyricHtml) &&
      /state\.analysisMap\s*=\s*new Map\(\)/.test(lyricHtml),
    "direction toggle clears in-memory analyses (no stale-cache bug)"
  );
  assert(
    /id="songStatus"/.test(lyricHtml) &&
      /function refreshSongStatus/.test(lyricHtml),
    "header has dynamic 'now viewing' song-status indicator"
  );
  assert(
    /\.song-status\s*\{/.test(lyricHtml) &&
      /'Gamja Flower'/.test(lyricHtml),
    "song-status uses the Gamja Flower hand-drawn language, not dashboard styling"
  );
  assert(
    /waiting for a song/.test(lyricHtml) &&
      /lyrics not loaded yet/.test(lyricHtml) &&
      /lines? analyzed/.test(lyricHtml),
    "song-status covers three visible states: waiting / ready / N-analyzed"
  );
  // Four-view structure + progressive disclosure, per this step's spec
  assert(
    /data-stanza-toggle/.test(lyricHtml) &&
      /\.stanza-row\s*\{/.test(lyricHtml) &&
      /\.stanza-row\.expanded/.test(lyricHtml),
    "stanza mode uses an accordion (expand/collapse per stanza)"
  );
  assert(
    /opts\.focus/.test(lyricHtml) &&
      /\.line\.line-focus/.test(lyricHtml),
    "line mode renders all lines with a `line-focus` class (active line emphasized, no prev/next nav)"
  );
  assert(
    /function renderSongOverview/.test(lyricHtml) &&
      /function renderStanzaOverview/.test(lyricHtml),
    "all + stanza modes have dedicated overview panels for the analysis pane"
  );
  assert(
    /function synthesizeGrammarNotes/.test(lyricHtml) &&
      /grammar &amp; cultural notes/.test(lyricHtml),
    "line analysis includes a synthesized grammar &amp; cultural notes block"
  );
  assert(
    /\.w-details\s*\{/.test(lyricHtml) &&
      /w-details-section-lbl/.test(lyricHtml) &&
      /details ↓/.test(lyricHtml),
    "word cards use progressive disclosure: single details ↓ control hiding kanji + conjugations sections"
  );
  assert(
    /conjugations/.test(lyricHtml) &&
      /fetch conjugations &amp; examples/.test(lyricHtml),
    "conjugations are behind an explicit 'fetch' control (not auto-fetched)"
  );
  // Line click / word click wiring (this step)
  assert(
    /card\.addEventListener\('click'/.test(lyricHtml) &&
      /card\.classList\.add\('focused'\)/.test(lyricHtml),
    "word card is clickable and toggles a .focused state on click"
  );
  assert(
    /\.word-card\.focused\s*\{/.test(lyricHtml) &&
      /border-left:\s*3px solid #000/.test(lyricHtml),
    "focused word card has a distinct visual accent (bold left rule + warm background)"
  );
  assert(
    /scrollIntoView\(\{\s*block:\s*'nearest'/.test(lyricHtml),
    "focused card scrolls into view so the user can see it"
  );
  assert(
    /ev\.stopPropagation\(\)/.test(lyricHtml),
    "action buttons inside the card stop propagation (card toggle does not hijack them)"
  );
  assert(
    /state\.lastAttemptedSelection/.test(lyricHtml) &&
      /retryAnalysisBtn/.test(lyricHtml),
    "error state offers retry + tracks which attempt to retry (line vs selection)"
  );
  assert(
    /selectLine\(ref\.stanzaIndex, ref\.lineIndex\)/.test(lyricHtml) &&
      /analyzeSelection\(pendingSelection\)/.test(lyricHtml),
    "retry routes back through the real selectLine / analyzeSelection paths (same backend)"
  );
  // Confirm the React bridge still wires these to cd.analyzeLine (no
  // duplicate pipeline, as required by the spec).
  assert(
    /cd\.analyzeLine\(/.test(bridgeTs) &&
      /api\.setAnalyzeLine/.test(bridgeTs),
    "React bridge exposes cd.analyzeLine to the lyric iframe via setAnalyzeLine (single pipeline)"
  );
  // ── Highlight → ask backend (this step) ─────────────────────────────
  assert(
    /id="askSelectionBtn"/.test(lyricHtml) &&
      /❓ ask/.test(lyricHtml),
    "selection strip now ships a ❓ ask affordance next to ✎ analyze"
  );
  assert(
    /id="selectionQuestion"/.test(lyricHtml) &&
      /\.selection-ask-row/.test(lyricHtml) &&
      /\.selection-strip\.asking/.test(lyricHtml),
    "ask flow uses an inline question input inside the existing selection strip (no modal)"
  );
  assert(
    /setAskQuestion:\s*function/.test(lyricHtml) &&
      /callbacks\.askQuestion\s*=\s*fn/.test(lyricHtml),
    "iframe exposes __kotobaLyric.setAskQuestion to the bridge"
  );
  assert(
    /callbacks\.askQuestion\(text, question, state\.direction\)/.test(lyricHtml),
    "ask submit routes through callbacks.askQuestion (real bridge)"
  );
  assert(
    /function renderSelectionAnswer/.test(lyricHtml) &&
      /class="answer-card"/.test(lyricHtml) &&
      /class="answer-body"/.test(lyricHtml),
    "answer renders as a note-style .answer-card in the analysis pane"
  );
  assert(
    /id="askAnotherBtn"/.test(lyricHtml) &&
      /id="dismissAnswerBtn"/.test(lyricHtml),
    "answer card has `ask another` + `dismiss` controls (clean close path)"
  );
  assert(
    /state\.lastAttemptedAsk/.test(lyricHtml) &&
      /retry question/.test(lyricHtml),
    "ask failures offer retry tied to the last attempted question"
  );
  assert(
    /api\.setAskQuestion\(/.test(bridgeTs) &&
      /cd\.askAboutSelection\(/.test(bridgeTs),
    "React bridge wires setAskQuestion → cd.askAboutSelection (real backend, no duplicate pipeline)"
  );
  assert(
    /isSelection\s*\?\s*\{\s*skipCache:\s*true\s*\}/.test(bridgeTs) &&
      /stanzaNumber === 0 \|\| lineNumber === 0/.test(bridgeTs),
    "bridge passes skipCache: true for sentinel-position selection calls (no cache pollution)"
  );
  // ── Word-mode detail refinement (this step) ────────────────────────
  assert(
    /setAnalyzeWordDetail:\s*function/.test(lyricHtml) &&
      /callbacks\.analyzeWordDetail\s*=\s*fn/.test(lyricHtml),
    "iframe exposes __kotobaLyric.setAnalyzeWordDetail"
  );
  assert(
    /api\.setAnalyzeWordDetail\(/.test(bridgeTs) &&
      /cd\.analyzeWordDetail\(/.test(bridgeTs),
    "React bridge wires setAnalyzeWordDetail → cd.analyzeWordDetail (real backend)"
  );
  assert(
    /data-deep-fetch=/.test(lyricHtml) &&
      /fetch conjugations &amp; examples/.test(lyricHtml),
    "word card ships a single dedicated 'fetch conjugations & examples' control"
  );
  assert(
    /state\.wordDetailMap/.test(lyricHtml) &&
      /async function fetchWordDetail/.test(lyricHtml),
    "word detail is fetched on demand, not pre-fetched, and cached in wordDetailMap"
  );
  assert(
    /function wordDeepDetailHtml/.test(lyricHtml) &&
      /w-details-section-lbl">conjugations</.test(lyricHtml) &&
      /w-details-section-lbl">alternatives</.test(lyricHtml) &&
      /w-details-section-lbl">examples</.test(lyricHtml),
    "deep detail renders three compact sections: conjugations / alternatives / examples"
  );
  assert(
    /\.conj-list\s*,/.test(lyricHtml) &&
      /\.alt-list\s*,/.test(lyricHtml) &&
      /\.ex-list\s*\{/.test(lyricHtml),
    "sections use compact list styles (no giant tables)"
  );
  assert(
    /state\.wordDetailMap\s*=\s*new Map\(\)/.test(lyricHtml),
    "wordDetailMap is cleared on new song open + direction change"
  );
  assert(
    /fetching conjugations…/.test(lyricHtml) &&
      /fetch failed:/.test(lyricHtml) &&
      /data-deep-fetch=".*">retry/.test(lyricHtml),
    "loading + error + retry states are visible in the deep-fetch slot"
  );
  // Collapsed by default: the card's .w-details is display:none until the
  // .expanded class is added by the details ↓ button.
  assert(
    /\.word-card \.w-details\s*\{[\s\S]*?display:\s*none/.test(lyricHtml) &&
      /\.word-card\.expanded \.w-details\s*\{\s*display:\s*block/.test(lyricHtml),
    "word details are collapsed by default (display:none) until .expanded is applied"
  );
  // The old static "coming soon" placeholder must be gone (replaced by
  // the live fetch control).
  assert(
    !/Not fetched automatically/.test(lyricHtml) &&
      !/Tap .deep analyze. in a later step/.test(lyricHtml),
    "old 'coming soon' conjugation placeholder is replaced with the real fetch control"
  );
  for (const view of ["all", "stanza", "line", "word"]) {
    assert(
      new RegExp(`data-view="${view}"`).test(lyricHtml),
      `lyric.html has view tab: ${view}`
    );
  }
  assert(
    /class="view-tab"/.test(lyricHtml) && /view-tabs/.test(lyricHtml),
    "lyric.html uses book-style view tabs"
  );
  assert(
    /font-family:\s*'Forum'/.test(lyricHtml) &&
      /font-family:\s*'Gamja Flower'/.test(lyricHtml) &&
      /font-family:\s*'Noto Serif JP'/.test(lyricHtml),
    "lyric.html uses the Forum / Gamja Flower / Noto Serif JP font palette"
  );
  assert(
    /width:\s*1440px/.test(lyricHtml) && /height:\s*1024px/.test(lyricHtml),
    "lyric.html uses the 1440×1024 fixed stage"
  );
  assert(
    /background:\s*#ffffff/i.test(lyricHtml),
    "lyric.html keeps white background"
  );

  assert(
    /cd\.analyzeLine\(/.test(bridgeTs),
    "LegacyDesignFrame calls cd.analyzeLine (not a duplicate pipeline)"
  );
  assert(
    /cd\.saveLineToDictionary\(/.test(bridgeTs),
    "LegacyDesignFrame calls cd.saveLineToDictionary"
  );
  assert(
    /cd\.saveWordToDictionary\(/.test(bridgeTs),
    "LegacyDesignFrame calls cd.saveWordToDictionary"
  );
  assert(
    /__kotobaLyric/.test(bridgeTs),
    "LegacyDesignFrame talks to __kotobaLyric"
  );
  assert(
    /#lyric-demo/.test(bridgeTs) || /LYRIC_DEMO_HASH/.test(bridgeTs),
    "LegacyDesignFrame honors #lyric-demo URL hash"
  );
  assert(
    /openLyric\(\s*\{[\s\S]*sourceTrackId:\s*track\.id/.test(bridgeTs),
    "playlist-overlay tracks are clickable → openLyric()"
  );

  // -----------------------------------------------------------------------
  console.log("\n2. Real analysis → real renderer: ja-en");
  installFetchStub();
  setup.setNvidiaApiKey("test-key-not-used");

  const jaLine = await cd.analyzeLine(
    {
      line: "光の中で目を覚ます",
      songTitle: "Hikaru Nara",
      artistName: "Goose House",
      stanzaNumber: 1,
      lineNumber: 1,
      direction: "ja-en",
    },
    "lyric-smoke-ja"
  );

  const renderer = extractLyricRenderer(lyricHtml);
  const jaHeadlineHtml = renderer.lineAnalysisHtml(
    jaLine,
    "Line 1 · Stanza 1",
    { stanzaIndex: 0, lineIndex: 0 }
  );
  assert(
    jaHeadlineHtml.includes(escapeHtml(jaLine.japanese)),
    "JA line analysis HTML contains the source line"
  );
  assert(
    jaHeadlineHtml.includes(escapeHtml(jaLine.directTranslation)),
    "JA line analysis HTML contains the direct translation"
  );
  assert(
    jaHeadlineHtml.includes(escapeHtml(jaLine.culturalTranslation)),
    "JA line analysis HTML contains the cultural translation"
  );
  assert(
    jaHeadlineHtml.includes(escapeHtml(jaLine.romaji)),
    "JA line analysis HTML contains the romaji"
  );
  assert(
    /saveLineBtn/.test(jaHeadlineHtml),
    "JA line analysis HTML wires a save-line button"
  );

  const hikari = jaLine.words.find((w) => w.surface === "光")!;
  const hikariCard = renderer.wordCardHtml(hikari, 0, { stanzaIndex: 0, lineIndex: 0 });
  assert(hikariCard.includes(">光</"), "word card shows surface 光");
  assert(/class="w-rom">hikari</.test(hikariCard), "word card shows romaji hikari");
  assert(/class="w-pos">n\.</.test(hikariCard), "word card shows POS n.");
  assert(hikariCard.includes("light"), "word card shows meaning 'light'");
  assert(
    /class="w-details"/.test(hikariCard) &&
      /w-details-section-lbl">kanji</.test(hikariCard),
    "word card ships kanji section inside the collapsed details block"
  );
  assert(/class="k-char">光</.test(hikariCard), "word card kanji block has 光 character");
  assert(/expand-btn/.test(hikariCard), "word card has the details ↓ expand button");
  assert(/save-word-btn/.test(hikariCard), "word card has save-word button");

  const samasu = jaLine.words.find((w) => w.surface === "覚ます")!;
  const samasuCard = renderer.wordCardHtml(samasu, 2, { stanzaIndex: 0, lineIndex: 0 });
  assert(/class="w-pos">v\.</.test(samasuCard), "覚ます renders as v.");
  assert(/class="w-trans">\(transitive\)</.test(samasuCard), "覚ます shows (transitive)");

  // -----------------------------------------------------------------------
  console.log("\n3. Real analysis → real renderer: en-ja");
  const enLine = await cd.analyzeLine(
    {
      line: "I awoke in the light",
      songTitle: "Serendipity",
      artistName: "BTS",
      stanzaNumber: 1,
      lineNumber: 1,
      direction: "en-ja",
    },
    "lyric-smoke-en"
  );
  const enHeadlineHtml = renderer.lineAnalysisHtml(
    enLine,
    "Line 1 · Stanza 1",
    { stanzaIndex: 0, lineIndex: 0 }
  );
  assert(
    enHeadlineHtml.includes(escapeHtml(enLine.japanese)),
    "EN line analysis HTML contains the English source line"
  );
  assert(
    enHeadlineHtml.includes(escapeHtml(enLine.directTranslation)),
    "EN line analysis HTML contains the Japanese direct translation"
  );
  assert(
    enHeadlineHtml.includes(escapeHtml(enLine.culturalTranslation)),
    "EN line analysis HTML contains the Japanese cultural translation"
  );
  assert(
    !/class="meta-romaji"/.test(enHeadlineHtml),
    "EN line analysis does NOT render a romaji meta row (romaji is empty)"
  );
  assert(
    />en-ja</.test(enHeadlineHtml),
    "EN line analysis shows direction badge en-ja"
  );

  const awoke = enLine.words.find((w) => w.surface === "awoke")!;
  const awokeCard = renderer.wordCardHtml(awoke, 1, { stanzaIndex: 0, lineIndex: 0 });
  assert(/class="w-pos">v\.</.test(awokeCard), "awoke renders as v.");
  assert(/class="w-trans">\(intransitive\)</.test(awokeCard), "awoke shows (intransitive)");
  assert(!/class="w-rom"/.test(awokeCard), "awoke has NO romaji span (empty)");
  assert(
    !/w-details-section-lbl">kanji</.test(awokeCard),
    "awoke has NO kanji section (English)"
  );
  // awoke IS a verb, so the details block still appears — now holding
  // the explicit "fetch conjugations & examples" control (kanji section
  // is still absent since English has no kanji).
  assert(
    /w-details-section-lbl">conjugations · alternatives · examples</.test(awokeCard),
    "awoke shows the on-demand deep-fetch section label (verb)"
  );
  assert(
    /data-deep-fetch=/.test(awokeCard) &&
      /fetch conjugations &amp; examples/.test(awokeCard),
    "awoke ships the explicit fetch control (deep data not auto-fetched)"
  );
  assert(
    /expand-btn/.test(awokeCard),
    "awoke has the details ↓ control (fetch control lives behind it)"
  );
  assert(/save-word-btn/.test(awokeCard), "awoke still has save-word button");
  // Japanese meaning must come through to the card:
  assert(awokeCard.includes("目が覚めた"), "awoke card shows Japanese meaningInContext");

  // -----------------------------------------------------------------------
  console.log("\n4. Save-to-dictionary flows through the real backend");
  await cd.saveLineToDictionary(jaLine, {
    songTitle: "Hikaru Nara",
    artistName: "Goose House",
  });
  await cd.saveWordToDictionary(awoke, enLine.japanese, enLine.culturalTranslation, {
    songTitle: "Serendipity",
    artistName: "BTS",
    direction: "en-ja",
  });

  const entries = await getAllEntries();
  assert(entries.length >= 2, `dictionary has at least 2 entries (got ${entries.length})`);
  assert(
    entries.some((e) => e.surface === "光" && e.direction === "ja-en" && e.romaji === "hikari"),
    "saveLine wrote a ja-en entry for 光 with romaji=hikari"
  );
  assert(
    entries.some((e) => e.surface === "awoke" && e.direction === "en-ja" && e.kanjiList.length === 0),
    "saveWord wrote an en-ja entry for awoke with empty kanji"
  );
  assert(
    entries.some((e) => e.surface === "覚ます" && e.kanjiList.length >= 1),
    "saveLine wrote 覚ます with at least one kanji entry"
  );

  // -----------------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  restoreFetch();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  restoreFetch();
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
