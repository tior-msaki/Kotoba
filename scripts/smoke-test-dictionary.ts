/**
 * Manual smoke test for the dictionary backend.
 *
 * Run with: npx tsx scripts/smoke-test-dictionary.ts
 *
 * Exercises: create, list, update, delete, search, export,
 * dedup/merge, ja-en direction, en-ja direction.
 */

import "fake-indexeddb/auto";

import {
  createEntry,
  getEntry,
  getAllEntries,
  getEntryCount,
  updateEntry,
  deleteEntry,
  searchEntries,
  exportDictionary,
  getAvailableLetters,
  exportLine,
} from "../src/domains/dictionary/service";
import type { AnalysisLine } from "../src/domains/analysis/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

async function run() {
  console.log("\n=== Dictionary Smoke Test ===\n");

  // -----------------------------------------------------------------------
  console.log("1. Create ja-en entry");
  const jaEntry = await createEntry({
    surface: "光",
    romaji: "hikari",
    type: "noun",
    meaning: "light",
    kanjiList: [],
    direction: "ja-en",
    sourceTrackName: "Hikaru Nara",
    artistName: "Goose House",
  });
  assert(jaEntry.id.length > 0, "has id");
  assert(jaEntry.surface === "光", "surface is 光");
  assert(jaEntry.romaji === "hikari", "romaji is hikari");
  assert(jaEntry.firstLetter === "h", "firstLetter is h");
  assert(jaEntry.sourceLanguage === "ja", "sourceLanguage is ja");
  assert(jaEntry.targetLanguage === "en", "targetLanguage is en");
  assert(jaEntry.direction === "ja-en", "direction is ja-en");
  assert(jaEntry.normalizedTerm === "光", "normalizedTerm is lowercase surface");
  assert(jaEntry.encounterCount === 1, "encounterCount is 1");

  // -----------------------------------------------------------------------
  console.log("\n2. Create en-ja entry (no kanji, no romaji)");
  const enEntry = await createEntry({
    surface: "Serendipity",
    type: "noun",
    meaning: "偶然の幸運",
    direction: "en-ja",
    sourceTrackName: "Serendipity",
    artistName: "BTS",
  });
  assert(enEntry.romaji === "", "romaji is empty");
  assert(enEntry.kanjiList.length === 0, "kanjiList is empty");
  assert(enEntry.firstLetter === "s", "firstLetter derived from surface");
  assert(enEntry.sourceLanguage === "en", "sourceLanguage is en");
  assert(enEntry.targetLanguage === "ja", "targetLanguage is ja");
  assert(enEntry.direction === "en-ja", "direction is en-ja");

  // -----------------------------------------------------------------------
  console.log("\n3. List and count");
  const all = await getAllEntries();
  assert(all.length === 2, `count is 2 (got ${all.length})`);
  const count = await getEntryCount();
  assert(count === 2, `getEntryCount is 2 (got ${count})`);

  // -----------------------------------------------------------------------
  console.log("\n4. Get by id");
  const fetched = await getEntry(jaEntry.id);
  assert(fetched?.surface === "光", "fetched correct entry");

  // -----------------------------------------------------------------------
  console.log("\n5. Update entry");
  const updated = await updateEntry(jaEntry.id, {
    notes: "Common word in anime openings",
    tags: ["anime", "common"],
  });
  assert(updated.notes === "Common word in anime openings", "notes updated");
  assert(updated.tags.length === 2, "tags updated");
  assert(updated.updatedAt > jaEntry.updatedAt, "updatedAt bumped");

  // -----------------------------------------------------------------------
  console.log("\n6. Search — surface match");
  const r1 = await searchEntries("光");
  assert(r1.length === 1, `found 1 result for 光 (got ${r1.length})`);
  assert(r1[0].entry.surface === "光", "correct entry");

  console.log("   Search — romaji match");
  const r2 = await searchEntries("hikari");
  assert(r2.length === 1, `found 1 result for hikari (got ${r2.length})`);

  console.log("   Search — meaning match");
  const r3 = await searchEntries("light");
  assert(r3.length === 1, `found 1 result for light (got ${r3.length})`);

  console.log("   Search — English entry");
  const r4 = await searchEntries("serendipity");
  assert(r4.length === 1, `found 1 result for serendipity (got ${r4.length})`);

  console.log("   Search — with direction filter");
  const r5 = await searchEntries("light", 50, { direction: "en-ja" });
  assert(r5.length === 0, `no results for 'light' in en-ja direction (got ${r5.length})`);

  // -----------------------------------------------------------------------
  console.log("\n7. Export from analysis line (ja-en)");
  const mockLine: AnalysisLine = {
    japanese: "光の中で目を覚ます",
    stanzaNumber: 1,
    lineNumber: 1,
    directTranslation: "I wake up in the light",
    culturalTranslation: "I awaken in the light",
    romaji: "hikari no naka de me wo samasu",
    words: [
      {
        surface: "光",
        romaji: "hikari",
        type: "noun",
        transitivity: null,
        kanjiList: [],
        meaningInContext: "light; radiance",
        location: { stanzaNumber: 1, lineNumber: 1, startOffset: 0 },
      },
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

  const exportResult = await exportLine(mockLine, {
    songTitle: "Hikaru Nara",
    artistName: "Goose House",
    direction: "ja-en",
  });
  assert(exportResult.inserted === 1, `1 inserted (目) (got ${exportResult.inserted})`);
  assert(exportResult.updated === 1, `1 updated (光 merge) (got ${exportResult.updated})`);

  // -----------------------------------------------------------------------
  console.log("\n8. Dedup/merge verification");
  const mergedEntry = await getEntry(jaEntry.id);
  assert(mergedEntry!.encounterCount === 2, `encounterCount bumped to 2 (got ${mergedEntry!.encounterCount})`);
  assert(mergedEntry!.contextMeanings.length === 1, `1 context meaning added (got ${mergedEntry!.contextMeanings.length})`);

  // -----------------------------------------------------------------------
  console.log("\n9. Direction isolation — same surface, different direction");
  const enLight = await createEntry({
    surface: "光",
    type: "noun",
    meaning: "light (English loan context)",
    direction: "en-ja",
  });
  const allNow = await getAllEntries();
  const hikariEntries = allNow.filter((e) => e.surface === "光");
  assert(hikariEntries.length === 2, `two 光 entries in different directions (got ${hikariEntries.length})`);
  assert(
    hikariEntries[0].direction !== hikariEntries[1].direction,
    "different directions"
  );

  // -----------------------------------------------------------------------
  console.log("\n10. Delete entry");
  await deleteEntry(enLight.id);
  const afterDelete = await getEntryCount();
  assert(afterDelete === 3, `count is 3 after delete (got ${afterDelete})`);

  // -----------------------------------------------------------------------
  console.log("\n11. Export dictionary by direction");
  const jaExport = await exportDictionary("ja-en");
  assert(jaExport.direction === "ja-en", "export direction correct");
  assert(jaExport.entries.length === 2, `2 ja-en entries (got ${jaExport.entries.length})`);

  const enExport = await exportDictionary("en-ja");
  assert(enExport.entries.length === 1, `1 en-ja entry (got ${enExport.entries.length})`);

  // -----------------------------------------------------------------------
  console.log("\n12. Available letters");
  const letters = await getAvailableLetters();
  assert(letters.includes("h"), "has h (hikari)");
  assert(letters.includes("m"), "has m (me)");
  assert(letters.includes("s"), "has s (serendipity)");

  // -----------------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
