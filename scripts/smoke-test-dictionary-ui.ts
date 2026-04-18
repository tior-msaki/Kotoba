/**
 * UI-contract smoke test for the dictionary wiring.
 *
 * Goal: prove that an entry saved via the real backend facade (the same
 * facade the in-song "save word" flow will call) ends up in a shape the
 * rewritten public/dictionary.html renderer consumes, and that the
 * rewrite itself actually removed the hardcoded content + exposed the
 * bridge hook the React shell talks to.
 *
 * Run with: npm run smoke:ui   (or: tsx scripts/smoke-test-dictionary-ui.ts)
 */

import "fake-indexeddb/auto";

import {
  createEntry,
  getAllEntries,
  exportLine,
} from "../src/domains/dictionary/service";
import type { AnalysisLine } from "../src/domains/analysis/types";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. The UI renderer's contract
//
// dictionary.html's entryHtml() reads these fields off each entry:
//     surface, reading, romaji, type, meaning
// plus groupBySection() needs:
//     firstLetter, normalizedTerm
// Every entry the backend produces must have all of them set (empty string
// is fine for optional fields).
// ---------------------------------------------------------------------------

const RENDERER_FIELDS = [
  "surface",
  "reading",
  "romaji",
  "firstLetter",
  "type",
  "meaning",
  "normalizedTerm",
  "direction",
] as const;

// ---------------------------------------------------------------------------
// 2. The rewritten dictionary.html must expose the bridge hook and must NOT
//    ship the old hardcoded PAGES array.
// ---------------------------------------------------------------------------

const dictHtml = readFileSync(resolve(repoRoot, "public/dictionary.html"), "utf8");
const bridgeTs = readFileSync(
  resolve(repoRoot, "src/frontend/LegacyDesignFrame.tsx"),
  "utf8"
);

async function run(): Promise<void> {
  console.log("\n=== Dictionary UI-contract smoke test ===\n");

  // -----------------------------------------------------------------------
  console.log("1. dictionary.html no longer ships hardcoded entries");
  assert(
    !/const\s+PAGES\s*=\s*\[/.test(dictHtml),
    "hardcoded PAGES array removed"
  );
  assert(
    !/function\s+turn\s*\(/.test(dictHtml),
    "old turn() pagination helper removed"
  );
  assert(
    !/aru\s+—\s+oishii/.test(dictHtml),
    "hardcoded sample range header is gone"
  );

  // -----------------------------------------------------------------------
  console.log("\n2. dictionary.html exposes the bridge API");
  assert(
    /window\.__kotobaDictionary\s*=/.test(dictHtml),
    "__kotobaDictionary object is exposed on window"
  );
  assert(
    /renderEntries\s*:\s*function/.test(dictHtml),
    "renderEntries entry point is defined"
  );
  assert(
    /showEmpty\s*:\s*function/.test(dictHtml),
    "showEmpty entry point is defined"
  );
  assert(
    /class="page\s+left"/.test(dictHtml) && /class="page\s+right"/.test(dictHtml) ||
      /class=\\"page\s+left\\"/.test(dictHtml),
    "renderer still builds .page.left / .page.right (book-spread preserved)"
  );
  assert(
    /<ruby>/.test(dictHtml) && /<rt>/.test(dictHtml),
    "ruby/rt rendering is still produced for readings"
  );
  assert(
    /empty-state/.test(dictHtml),
    "empty-state CSS class is present (graceful degrade)"
  );

  // -----------------------------------------------------------------------
  console.log("\n3. React shell wires the bridge to the backend facade");
  assert(
    /\bdictionary\b.*services\/app/.test(bridgeTs),
    "LegacyDesignFrame imports `dictionary` from services/app"
  );
  assert(
    /__kotobaDictionary/.test(bridgeTs),
    "LegacyDesignFrame talks to __kotobaDictionary"
  );
  assert(
    /dictionary\.getAll\(\)/.test(bridgeTs),
    "LegacyDesignFrame calls dictionary.getAll() (real backend, not mock)"
  );
  assert(
    /dictionaryIcon\?\.addEventListener\("click", onDictionaryOpen\)/.test(
      bridgeTs
    ),
    "LegacyDesignFrame wires the .dictionary click → renderDictionaryEntries"
  );

  // -----------------------------------------------------------------------
  console.log("\n4. Backend → renderer-field contract");
  //    Create entries both ways a real user would: direct add + via analysis.
  const direct = await createEntry({
    surface: "光",
    reading: "ひかり",
    romaji: "hikari",
    type: "noun",
    meaning: "light",
    direction: "ja-en",
    sourceTrackName: "Hikaru Nara",
    artistName: "Goose House",
  });
  const enEntry = await createEntry({
    surface: "Serendipity",
    type: "noun",
    meaning: "偶然の幸運",
    direction: "en-ja",
  });
  const mockLine: AnalysisLine = {
    japanese: "光の中で目を覚ます",
    stanzaNumber: 1,
    lineNumber: 1,
    directTranslation: "I wake up in the light",
    culturalTranslation: "I awaken in the light",
    romaji: "hikari no naka de me wo samasu",
    words: [
      {
        surface: "目",
        romaji: "me",
        type: "noun",
        transitivity: null,
        kanjiList: [],
        meaningInContext: "eye",
        location: { stanzaNumber: 1, lineNumber: 1, startOffset: 5 },
      },
    ],
  };
  await exportLine(mockLine, {
    songTitle: "Hikaru Nara",
    artistName: "Goose House",
    direction: "ja-en",
  });

  const entries = await getAllEntries();
  assert(entries.length === 3, `3 entries present (got ${entries.length})`);
  assert(
    entries.some((e) => e.surface === "光"),
    "direct ja-en entry 光 is in the store"
  );
  assert(
    entries.some((e) => e.surface === "Serendipity"),
    "direct en-ja entry Serendipity is in the store"
  );
  assert(
    entries.some((e) => e.surface === "目"),
    "analysis-pipeline entry 目 is in the store"
  );

  for (const e of entries) {
    for (const field of RENDERER_FIELDS) {
      const ok =
        Object.prototype.hasOwnProperty.call(e, field) &&
        typeof (e as Record<string, unknown>)[field] !== "undefined";
      assert(
        ok,
        `entry [${e.surface}] exposes renderer field "${field}"`
      );
    }
  }

  // -----------------------------------------------------------------------
  console.log("\n5. Renderer-level end-to-end: simulate the bridge call");
  //    We don't boot jsdom. Instead, extract the pure entryHtml from
  //    dictionary.html and run it against every real entry. The markup it
  //    produces must include the surface, the POS abbreviation, the
  //    meaning text, and ruby/rt when a reading is present.
  const entryHtml = extractEntryHtml(dictHtml);

  for (const e of entries) {
    const html = entryHtml(e);
    assert(
      html.includes(escapeHtml(e.surface)),
      `rendered HTML for [${e.surface}] contains its surface`
    );
    assert(
      html.includes(escapeHtml(e.meaning)),
      `rendered HTML for [${e.surface}] contains its meaning`
    );
    if (e.reading && e.reading !== e.surface) {
      assert(
        /<ruby>/.test(html) && html.includes(`<rt>${escapeHtml(e.reading)}</rt>`),
        `rendered HTML for [${e.surface}] uses ruby/rt for reading "${e.reading}"`
      );
    }
  }
  //    And confirm direct evidence the dedicated ja-en entry renders as ruby:
  const hikariHtml = entryHtml(direct);
  assert(
    hikariHtml.includes("<ruby>光<rt>ひかり</rt></ruby>"),
    "hikari renders as <ruby>光<rt>ひかり</rt></ruby>"
  );
  //    And that an en-ja entry does NOT wrap in ruby:
  const serHtml = entryHtml(enEntry);
  assert(
    !/<ruby>/.test(serHtml),
    "Serendipity (en-ja, no reading) does NOT use ruby"
  );

  // -----------------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Extract the pure `entryHtml(e)` function from dictionary.html so we can
// exercise it in Node. This avoids pulling in jsdom for one function.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractEntryHtml(
  html: string
): (e: Record<string, unknown>) => string {
  const posMatch = html.match(/var POS_LABEL = (\{[\s\S]*?\});/);
  const fnMatch = html.match(/function entryHtml\(e\) \{([\s\S]*?)\n  \}/);
  if (!posMatch || !fnMatch) {
    throw new Error(
      "Could not extract POS_LABEL / entryHtml from dictionary.html"
    );
  }
  // Recreate the two helpers in our own scope.
  const src = `
    var POS_LABEL = ${posMatch[1]};
    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function entryHtml(e) {${fnMatch[1]}}
    return entryHtml;
  `;
  // eslint-disable-next-line no-new-func
  return new Function(src)() as (e: Record<string, unknown>) => string;
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
