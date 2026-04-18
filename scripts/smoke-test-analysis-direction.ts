/**
 * Analysis direction smoke test.
 *
 * Exercises the full analysis → dictionary-export pipeline for BOTH
 *   - ja-en: Japanese line → English explanations (unchanged legacy path)
 *   - en-ja: English line → Japanese explanations (new path)
 *
 * The LLM call is stubbed at the fetch boundary so this runs offline. The
 * stub inspects the request prompt, picks a canned line-analysis response
 * matching the requested direction, and returns it in NVIDIA's
 * OpenAI-compatible chat-completions envelope. The real prompts /
 * contracts / parsers / service / cache / dictionary export all run
 * unmodified.
 *
 * Run with: npm run smoke:direction
 */

import "fake-indexeddb/auto";

import {
  analyzeLine,
  analyzeWordDetail,
  askAboutSelection,
} from "../src/domains/analysis/service";
import { setup, cd } from "../src/services/app";
import { getAllEntries } from "../src/domains/dictionary/service";
import type { LineAnalysisResponse } from "../src/domains/analysis/schemas";

// ---------------------------------------------------------------------------
// Canned LLM responses
// ---------------------------------------------------------------------------

// ja-en: a short Japanese line, words include particle + ru-verb, real kanji
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
      surface: "中",
      romaji: "naka",
      type: "noun",
      transitivity: null,
      meaningInContext: "middle; inside",
      kanjiList: [
        {
          character: "中",
          romaji: "naka",
          meanings: ["inside", "middle", "center"],
          kunYomi: ["なか"],
          onYomi: ["チュウ"],
          nanori: [],
        },
      ],
    },
    {
      surface: "で",
      romaji: "de",
      type: "particle",
      transitivity: null,
      meaningInContext: "in; at (location marker)",
      kanjiList: [],
    },
    {
      surface: "目",
      romaji: "me",
      type: "noun",
      transitivity: null,
      meaningInContext: "eye",
      kanjiList: [
        {
          character: "目",
          romaji: "me",
          meanings: ["eye"],
          kunYomi: ["め"],
          onYomi: ["モク", "ボク"],
          nanori: [],
        },
      ],
    },
    {
      surface: "を",
      romaji: "wo",
      type: "particle",
      transitivity: null,
      meaningInContext: "object marker",
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

// en-ja: an English line. Romaji is "" throughout; kanjiList is [] throughout;
// at least one word uses the neutral "verb" type with transitivity.
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
      meaningInContext: "一人称代名詞(「私」)",
      kanjiList: [],
    },
    {
      surface: "awoke",
      romaji: "",
      type: "verb",
      transitivity: "intransitive",
      meaningInContext: "目が覚めた (「awake」の過去形)",
      kanjiList: [],
    },
    {
      surface: "in",
      romaji: "",
      type: "auxiliary",
      transitivity: null,
      meaningInContext: "〜の中で (場所を示す前置詞)",
      kanjiList: [],
    },
    {
      surface: "the",
      romaji: "",
      type: "expression",
      transitivity: null,
      meaningInContext: "定冠詞(特定のものを指す)",
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

// ---------------------------------------------------------------------------
// fetch stub — the browser client POSTs { prompt, responseSchema } to the
// same-origin proxy at /api/nvidia/chat, and the proxy normally returns
// an OpenAI-compatible envelope. We stub the hop to the proxy directly
// so the test runs offline without needing the Vite dev server.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  prompt: string;
}
const fetchCalls: FetchCall[] = [];

// When true, the stub strips `japanese` from the line-analysis response
// so we can regression-test parser tolerance to a missing source line
// (the real NVIDIA bug this replaces).
let stubDropSourceField = false;

// When true, the stub corrupts kanji annotation on the ja-en response:
//   - word[0] (光) keeps its kanji but one kanji item has an empty
//     `character` (should be filtered)
//   - word[2] (中) has `kanjiList: null` (should be treated as [])
// The parser must still return a valid line with translations intact
// and bad kanji entries dropped.
let stubCorruptKanji = false;

const originalFetch = globalThis.fetch;

function installFetchStub(): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(body) as { prompt?: string };
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    fetchCalls.push({ url, prompt });

    // Direction detection on the prompt itself. The ja-en system context
    // opens with "Japanese language expert"; the en-ja one opens with
    // "bilingual English/Japanese language expert".
    const isEnJa = /bilingual English\/Japanese/.test(prompt);

    // Q&A prompts are identified by the "QA task" marker — they expect a
    // single-field `answer` response, not a structured LineAnalysis.
    const isAsk = /QA task: the user highlighted/.test(prompt);
    // Word-detail prompts carry a "WORD DETAIL task" marker and expect
    // the three-array word-detail response shape.
    const isWordDetail = /WORD DETAIL task/.test(prompt);

    let cannedText: string;
    if (isAsk) {
      cannedText = JSON.stringify({
        answer: isEnJa
          ? "これは選択された部分に関する日本語の答えです。"
          : "This is a short English answer about the highlighted text.",
      });
    } else if (isWordDetail) {
      if (isEnJa) {
        cannedText = JSON.stringify({
          conjugations: [
            { form: "base", surface: "awake", reading: "", romaji: "", description: "base form" },
            { form: "past", surface: "awoke", reading: "", romaji: "", description: "simple past" },
            { form: "present participle", surface: "awaking", reading: "", romaji: "", description: "-ing form" },
            { form: "past participle", surface: "awoken", reading: "", romaji: "", description: "perfect form" },
          ],
          alternatives: [
            { register: "formal", surface: "awaken", romaji: "", meaning: "目覚める (より書き言葉)", note: "書き言葉寄り" },
            { register: "casual", surface: "wake up", romaji: "", meaning: "目を覚ます", note: "日常的な言い方" },
          ],
          exampleSentences: [
            { source: "I awoke to the sound of rain.", translation: "雨の音で目が覚めた。" },
            { source: "She awoke early and went for a walk.", translation: "彼女は早く起きて散歩に出た。" },
          ],
        });
      } else {
        cannedText = JSON.stringify({
          conjugations: [
            { form: "plain", surface: "覚ます", reading: "さます", romaji: "samasu", description: "dictionary form" },
            { form: "polite", surface: "覚まします", reading: "さまします", romaji: "samashimasu", description: "-masu form" },
            { form: "past", surface: "覚ました", reading: "さました", romaji: "samashita", description: "plain past" },
            { form: "negative", surface: "覚まさない", reading: "さまさない", romaji: "samasanai", description: "plain negative" },
            { form: "te-form", surface: "覚まして", reading: "さまして", romaji: "samashite", description: "connective" },
          ],
          alternatives: [
            { register: "casual", surface: "起きる", romaji: "okiru", meaning: "to wake up (intr.)", note: "intransitive counterpart" },
            { register: "formal", surface: "目を覚ます", romaji: "me wo samasu", meaning: "to rouse oneself", note: "idiomatic with 目" },
          ],
          exampleSentences: [
            { source: "朝七時に目を覚ました。", translation: "I woke up at seven in the morning." },
            { source: "夢から覚ます。", translation: "To rouse someone from a dream." },
          ],
        });
      }
    } else {
      const base = isEnJa ? EN_RESPONSE : JA_RESPONSE;
      let mutated: Record<string, unknown> = { ...base };
      if (stubDropSourceField) mutated = { ...mutated, japanese: "" };
      if (stubCorruptKanji && !isEnJa) {
        const words = (base as typeof JA_RESPONSE).words.map((w, i) => {
          if (i === 0) {
            // Inject an empty-character kanji item alongside the valid one.
            return {
              ...w,
              kanjiList: [
                { character: "", romaji: "", meanings: [], kunYomi: [], onYomi: [], nanori: [] },
                ...w.kanjiList,
              ],
            };
          }
          if (i === 2) {
            // Emit a non-array kanjiList; parser must default to [].
            return { ...w, kanjiList: null as unknown as never };
          }
          return w;
        });
        mutated = { ...mutated, words };
      }
      cannedText = JSON.stringify(mutated);
    }

    const envelope = {
      choices: [
        { message: { role: "assistant", content: cannedText } },
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
// Test harness
// ---------------------------------------------------------------------------

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
  console.log("\n=== Analysis direction smoke test ===\n");

  installFetchStub();
  setup.setNvidiaApiKey("test-key-not-used");

  // -----------------------------------------------------------------------
  console.log("1. ja-en: Japanese line analysis");
  const jaLine = await analyzeLine(
    {
      line: "光の中で目を覚ます",
      songTitle: "Hikaru Nara",
      artistName: "Goose House",
      stanzaNumber: 1,
      lineNumber: 1,
      direction: "ja-en",
    },
    "smoke-song-ja"
  );
  assert(jaLine.direction === "ja-en", "result carries direction = ja-en");
  assert(jaLine.japanese === "光の中で目を覚ます", "source line preserved");
  assert(jaLine.romaji.length > 0, "line romaji is populated");
  assert(jaLine.culturalTranslation.length > 0, "cultural translation populated");
  assert(jaLine.directTranslation.length > 0, "direct translation populated");
  assert(jaLine.words.length === 7, `7 words parsed (got ${jaLine.words.length})`);
  const hikari = jaLine.words.find((w) => w.surface === "光");
  const samasu = jaLine.words.find((w) => w.surface === "覚ます");
  assert(!!hikari, "word 光 is present");
  assert(hikari?.kanjiList.length === 1, "光 has one kanji entry");
  assert(hikari?.kanjiList[0]?.meaning.includes("light") ?? false, "光 kanji meaning includes 'light'");
  assert(samasu?.type === "godan-verb", "覚ます classified as godan-verb");
  assert(samasu?.transitivity === "transitive", "覚ます transitivity is transitive");
  // Offset check: 光→0, の→1, 中→2, で→3, 目→4, を→5, 覚ます→6
  assert(hikari?.location.startOffset === 0, "光 startOffset is 0");
  assert(samasu?.location.startOffset === 6, "覚ます startOffset is 6 (character-indexed)");

  // -----------------------------------------------------------------------
  console.log("\n2. en-ja: English line analysis");
  fetchCalls.length = 0;
  const enLine = await analyzeLine(
    {
      line: "I awoke in the light",
      songTitle: "Serendipity",
      artistName: "BTS",
      stanzaNumber: 1,
      lineNumber: 1,
      direction: "en-ja",
    },
    "smoke-song-en"
  );
  assert(
    fetchCalls.length === 1 && /bilingual English\/Japanese/.test(fetchCalls[0]!.prompt),
    "en-ja request used the English/Japanese system context"
  );
  assert(enLine.direction === "en-ja", "result carries direction = en-ja");
  assert(enLine.japanese === "I awoke in the light", "source English line preserved");
  assert(enLine.romaji === "", "line.romaji is '' for en-ja (no romaji for English)");
  assert(enLine.culturalTranslation.length > 0, "cultural translation populated (target lang = JA)");
  assert(enLine.directTranslation.length > 0, "direct translation populated");
  assert(enLine.words.length === 5, `5 words parsed (got ${enLine.words.length})`);
  for (const w of enLine.words) {
    assert(w.romaji === "", `en-ja word [${w.surface}] has empty romaji`);
    assert(w.kanjiList.length === 0, `en-ja word [${w.surface}] has empty kanjiList`);
  }
  const awoke = enLine.words.find((w) => w.surface === "awoke");
  assert(awoke?.type === "verb", "awoke uses the neutral 'verb' type");
  assert(awoke?.transitivity === "intransitive", "awoke transitivity parsed (intransitive)");
  const iWord = enLine.words.find((w) => w.surface === "I");
  assert(iWord?.location.startOffset === 0, "'I' startOffset is 0");
  assert(awoke?.location.startOffset === 2, "'awoke' startOffset is 2 (accounts for spaces)");
  const lightWord = enLine.words.find((w) => w.surface === "light");
  assert(lightWord?.location.startOffset === 15, "'light' startOffset is 15 (accounts for spaces)");

  // -----------------------------------------------------------------------
  console.log("\n3. ja-en prompt inspected (first fetch)");
  const jaPrompt = fetchCalls.length >= 0 ? undefined : undefined;
  // Re-run the ja-en one with a fresh cache entry to grab the prompt text
  fetchCalls.length = 0;
  await analyzeLine(
    {
      line: "光の中で目を覚ます",
      songTitle: "Hikaru Nara",
      artistName: "Goose House",
      stanzaNumber: 1,
      lineNumber: 1,
      direction: "ja-en",
    },
    "smoke-song-ja",
    { forceRefresh: true }
  );
  const jaPromptText = fetchCalls[0]?.prompt ?? "";
  void jaPrompt;
  assert(
    /Japanese language expert/.test(jaPromptText),
    "ja-en prompt opens with 'Japanese language expert'"
  );
  assert(
    !/bilingual English\/Japanese/.test(jaPromptText),
    "ja-en prompt does NOT use the en-ja system context"
  );
  assert(
    /Source language: Japanese/.test(jaPromptText),
    "ja-en prompt declares Source language: Japanese"
  );

  // -----------------------------------------------------------------------
  console.log("\n4. en-ja prompt inspected");
  fetchCalls.length = 0;
  await analyzeLine(
    {
      line: "I awoke in the light",
      songTitle: "Serendipity",
      artistName: "BTS",
      stanzaNumber: 1,
      lineNumber: 1,
      direction: "en-ja",
    },
    "smoke-song-en",
    { forceRefresh: true }
  );
  const enPromptText = fetchCalls[0]?.prompt ?? "";
  assert(
    /Source language: English/.test(enPromptText),
    "en-ja prompt declares Source language: English"
  );
  assert(
    /must be in JAPANESE/.test(enPromptText),
    "en-ja prompt tells model to emit Japanese output"
  );
  assert(
    /kanjiList[^\n]*empty array/.test(enPromptText),
    "en-ja prompt tells model to return empty kanjiList"
  );
  assert(
    /romaji[^\n]*empty string/.test(enPromptText),
    "en-ja prompt tells model to return empty romaji"
  );

  // -----------------------------------------------------------------------
  console.log("\n5. Dictionary export works for both directions");
  await cd.saveLineToDictionary(jaLine, {
    songTitle: "Hikaru Nara",
    artistName: "Goose House",
  });
  await cd.saveLineToDictionary(enLine, {
    songTitle: "Serendipity",
    artistName: "BTS",
  });

  const entries = await getAllEntries();
  const jaEntries = entries.filter((e) => e.direction === "ja-en");
  const enEntries = entries.filter((e) => e.direction === "en-ja");

  assert(jaEntries.length >= 1, `at least 1 ja-en entry exported (got ${jaEntries.length})`);
  assert(enEntries.length >= 1, `at least 1 en-ja entry exported (got ${enEntries.length})`);
  assert(
    jaEntries.some((e) => e.surface === "光" && e.romaji === "hikari"),
    "光/hikari made it into the dictionary as ja-en"
  );
  assert(
    jaEntries.some((e) => e.surface === "覚ます" && e.kanjiList.length >= 1),
    "覚ます carries at least one kanji entry"
  );
  assert(
    enEntries.some((e) => e.surface === "awoke" && e.romaji === "" && e.kanjiList.length === 0),
    "awoke exported as en-ja with empty romaji and empty kanji"
  );
  assert(
    enEntries.some((e) => e.surface === "light" && e.direction === "en-ja"),
    "light exported as en-ja direction"
  );

  // -----------------------------------------------------------------------
  console.log("\n6. askAboutSelection: free-form Q&A round-trip");
  fetchCalls.length = 0;
  const jaAsk = await askAboutSelection({
    text: "光の中で",
    question: "why is で used here?",
    songTitle: "Hikaru Nara",
    artistName: "Goose House",
    direction: "ja-en",
  });
  assert(typeof jaAsk.answer === "string" && jaAsk.answer.length > 0, "ja-en answer is a non-empty string");
  assert(
    fetchCalls.some((c) => /QA task: the user highlighted/.test(c.prompt)),
    "ja-en ask prompt uses the QA task marker"
  );
  assert(
    fetchCalls.some((c) => /Japanese language expert/.test(c.prompt)),
    "ja-en ask prompt uses the Japanese system context (English answer)"
  );

  fetchCalls.length = 0;
  const enAsk = await askAboutSelection({
    text: "I awoke in the light",
    question: "what does 'awoke' imply here?",
    songTitle: "Serendipity",
    artistName: "BTS",
    direction: "en-ja",
  });
  assert(typeof enAsk.answer === "string" && enAsk.answer.length > 0, "en-ja answer is a non-empty string");
  assert(
    fetchCalls.some((c) => /bilingual English\/Japanese/.test(c.prompt)),
    "en-ja ask prompt uses the English/Japanese bilingual system context (Japanese answer)"
  );
  assert(
    fetchCalls.some((c) => /must be in JAPANESE/.test(c.prompt)),
    "en-ja ask prompt still instructs the model to emit Japanese output"
  );

  // Validation: empty text or empty question should throw cleanly (no
  // silent stub), since we don't want to burn API budget on empty calls.
  let emptyTextErr: unknown = null;
  try { await askAboutSelection({ text: "", question: "why?" }); }
  catch (e) { emptyTextErr = e; }
  assert(
    emptyTextErr instanceof Error && /text is empty/i.test((emptyTextErr as Error).message),
    "askAboutSelection rejects empty selection text"
  );
  let emptyQErr: unknown = null;
  try { await askAboutSelection({ text: "光の中で", question: "" }); }
  catch (e) { emptyQErr = e; }
  assert(
    emptyQErr instanceof Error && /question is empty/i.test((emptyQErr as Error).message),
    "askAboutSelection rejects empty question"
  );

  // -----------------------------------------------------------------------
  console.log("\n7. analyzeWordDetail: on-demand deeper word analysis");
  fetchCalls.length = 0;
  const jaDetail = await analyzeWordDetail({
    surface: "覚ます",
    romaji: "samasu",
    type: "godan-verb",
    songTitle: "Hikaru Nara",
    artistName: "Goose House",
    direction: "ja-en",
  });
  assert(
    fetchCalls.some((c) => /WORD DETAIL task/.test(c.prompt)),
    "ja-en word-detail prompt carries the WORD DETAIL task marker"
  );
  assert(jaDetail.surface === "覚ます", "returned surface round-trips");
  assert(jaDetail.conjugations.length >= 4, `JA conjugations populated (got ${jaDetail.conjugations.length})`);
  assert(
    jaDetail.conjugations.every((c) => typeof c.form === "string" && c.form.length > 0),
    "every JA conjugation has a form label"
  );
  assert(
    jaDetail.conjugations.some((c) => c.romaji === "samashimasu"),
    "JA polite form round-trips with romaji"
  );
  assert(jaDetail.alternatives.length >= 1, "JA alternatives populated");
  assert(
    jaDetail.alternatives.every(
      (a) => a.register === "casual" || a.register === "formal" || a.register === "same"
    ),
    "every alternative has a valid register"
  );
  assert(jaDetail.exampleSentences.length >= 1, "JA example sentences populated");
  assert(
    jaDetail.exampleSentences.every((e) => e.source.length > 0 && e.translation.length > 0),
    "every example has source + translation"
  );

  fetchCalls.length = 0;
  const enDetail = await analyzeWordDetail({
    surface: "awoke",
    type: "verb",
    songTitle: "Serendipity",
    artistName: "BTS",
    direction: "en-ja",
  });
  assert(
    fetchCalls.some((c) => /bilingual English\/Japanese/.test(c.prompt)),
    "en-ja word-detail uses the bilingual system context (answers in Japanese)"
  );
  assert(
    enDetail.conjugations.every((c) => c.romaji === "" && c.reading === ""),
    "en-ja conjugations have empty romaji + reading (English source)"
  );
  assert(enDetail.alternatives.length >= 1, "en-ja alternatives populated");
  assert(
    enDetail.alternatives.every((a) => a.romaji === ""),
    "en-ja alternatives have empty romaji"
  );

  // Validation: empty surface must throw cleanly
  let emptySurfaceErr: unknown = null;
  try { await analyzeWordDetail({ surface: "" }); }
  catch (e) { emptySurfaceErr = e; }
  assert(
    emptySurfaceErr instanceof Error && /surface is empty/i.test((emptySurfaceErr as Error).message),
    "analyzeWordDetail rejects empty surface"
  );

  // -----------------------------------------------------------------------
  console.log("\n8. skipCache option: selection analyses don't pollute the cache");
  // First, a normal line analysis writes to the cache — subsequent reads
  // with the same (songId, stanza, line) hit the cache and don't call fetch.
  fetchCalls.length = 0;
  await analyzeLine(
    {
      line: "光の中で目を覚ます",
      songTitle: "Hikaru Nara",
      artistName: "Goose House",
      stanzaNumber: 2,
      lineNumber: 3,
      direction: "ja-en",
    },
    "cache-smoke-song"
  );
  const firstCalls = fetchCalls.length;
  fetchCalls.length = 0;
  await analyzeLine(
    {
      line: "光の中で目を覚ます",
      songTitle: "Hikaru Nara",
      artistName: "Goose House",
      stanzaNumber: 2,
      lineNumber: 3,
      direction: "ja-en",
    },
    "cache-smoke-song"
  );
  assert(
    firstCalls === 1 && fetchCalls.length === 0,
    "normal analyzeLine caches: second identical call doesn't hit fetch"
  );

  // Now with skipCache: the call should re-fetch every time, and it must
  // not leave a cache entry that a later unrelated call could accidentally
  // consume under sentinel keys (stanza=0/line=0 selections).
  fetchCalls.length = 0;
  await analyzeLine(
    {
      line: "光の中で目を覚ます",
      songTitle: "Hikaru Nara",
      artistName: "Goose House",
      stanzaNumber: 0,
      lineNumber: 0,
      direction: "ja-en",
    },
    "cache-smoke-song",
    { skipCache: true }
  );
  assert(fetchCalls.length === 1, "skipCache line call hits fetch");
  fetchCalls.length = 0;
  await analyzeLine(
    {
      line: "different selection text",
      songTitle: "Hikaru Nara",
      artistName: "Goose House",
      stanzaNumber: 0,
      lineNumber: 0,
      direction: "ja-en",
    },
    "cache-smoke-song",
    { skipCache: true }
  );
  assert(
    fetchCalls.length === 1,
    "second skipCache call with same sentinel key still hits fetch (no pollution)"
  );

  // -----------------------------------------------------------------------
  // Regression: with NVIDIA the schema is embedded in the prompt rather
  // than enforced, and the model often drops `raw.japanese` (or returns
  // "") — especially for en-ja where the field name conflicts with the
  // direction. The parser must use the request's source line as the
  // authoritative override instead of throwing.
  console.log("\n9. Parser tolerance: missing raw.japanese falls back to the request's line");
  stubDropSourceField = true;
  try {
    fetchCalls.length = 0;
    const jaMissing = await analyzeLine(
      {
        line: "光の中で目を覚ます",
        songTitle: "Hikaru Nara",
        artistName: "Goose House",
        stanzaNumber: 3,
        lineNumber: 1,
        direction: "ja-en",
      },
      "missing-japanese-ja",
      { skipCache: true }
    );
    assert(
      jaMissing.japanese === "光の中で目を覚ます",
      "ja-en: missing raw.japanese → line.japanese falls back to req.line"
    );
    assert(
      jaMissing.directTranslation.length > 0 &&
        jaMissing.culturalTranslation.length > 0,
      "ja-en: translations still populated when raw.japanese is empty"
    );

    fetchCalls.length = 0;
    const enMissing = await analyzeLine(
      {
        line: "I awoke in the light",
        songTitle: "Serendipity",
        artistName: "BTS",
        stanzaNumber: 4,
        lineNumber: 1,
        direction: "en-ja",
      },
      "missing-japanese-en",
      { skipCache: true }
    );
    assert(
      enMissing.japanese === "I awoke in the light",
      "en-ja: missing raw.japanese → line.japanese falls back to req.line (English source)"
    );
    assert(
      enMissing.directTranslation.length > 0 &&
        enMissing.culturalTranslation.length > 0,
      "en-ja: translations still populated when raw.japanese is empty"
    );
  } finally {
    stubDropSourceField = false;
  }

  // -----------------------------------------------------------------------
  // Regression: one malformed kanji item (empty `character`) or a null
  // `kanjiList` used to fail the entire line via `Missing or empty
  // field: kanji.character`. Kanji annotation is enhancement data —
  // translation must survive, and bad kanji entries must be filtered.
  console.log("\n10. Parser tolerance: malformed kanji items are filtered, line still parses");
  stubCorruptKanji = true;
  try {
    fetchCalls.length = 0;
    const jaKanjiBad = await analyzeLine(
      {
        line: "光の中で目を覚ます",
        songTitle: "Hikaru Nara",
        artistName: "Goose House",
        stanzaNumber: 5,
        lineNumber: 1,
        direction: "ja-en",
      },
      "kanji-tolerance-ja",
      { skipCache: true }
    );
    assert(
      jaKanjiBad.japanese === "光の中で目を覚ます",
      "bad-kanji run: source line preserved"
    );
    assert(
      jaKanjiBad.directTranslation.length > 0 &&
        jaKanjiBad.culturalTranslation.length > 0,
      "bad-kanji run: translations still populated"
    );
    const hikariBad = jaKanjiBad.words.find((w) => w.surface === "光");
    assert(
      !!hikariBad && hikariBad.kanjiList.length === 1,
      `bad-kanji run: empty-character kanji filtered from 光 (kept ${hikariBad?.kanjiList.length ?? 0} valid)`
    );
    assert(
      hikariBad?.kanjiList.every((k) => k.character.length > 0) ?? false,
      "bad-kanji run: remaining kanji entries all have non-empty character"
    );
    const nakaBad = jaKanjiBad.words.find((w) => w.surface === "中");
    assert(
      !!nakaBad && Array.isArray(nakaBad.kanjiList) && nakaBad.kanjiList.length === 0,
      "bad-kanji run: null kanjiList defaulted to [] (no throw)"
    );
    assert(
      jaKanjiBad.words.length === 7,
      `bad-kanji run: every word still present (${jaKanjiBad.words.length}/7)`
    );

    // Extra defensive coverage: if parseKanji ever throws (exotic
    // provider shape — Proxy-like object, nested array in a reading
    // field, BigInt, etc.), the call site must catch it and drop the
    // bad item rather than failing the line.
    const { parseWord } = await import("../src/domains/analysis/parsers.js");
    const throwingKanji = {
      get character(): string {
        throw new Error("simulated throw from malformed kanji item");
      },
    };
    const wordWithThrowingKanji = {
      surface: "覚ます",
      romaji: "samasu",
      type: "godan-verb",
      transitivity: "transitive",
      meaningInContext: "to wake",
      kanjiList: [
        throwingKanji,
        { character: "覚", romaji: "kaku", meanings: ["to wake"], kunYomi: [], onYomi: [], nanori: [] },
      ],
    };
    const parsed = parseWord(
      wordWithThrowingKanji as never,
      { stanzaNumber: 1, lineNumber: 1, startOffset: 0 }
    );
    assert(
      parsed !== null && parsed.kanjiList.length === 1,
      `throwing-kanji run: throwing item dropped, valid kept (got ${parsed?.kanjiList.length ?? "null"})`
    );
    assert(
      parsed !== null && parsed.kanjiList[0]!.character === "覚",
      "throwing-kanji run: the valid 覚 entry survived"
    );
  } finally {
    stubCorruptKanji = false;
  }

  // -----------------------------------------------------------------------
  // Regression: the normalizer must be tolerant when the model returns
  // MORE lines than the source stanza contains, or when extra lines
  // have no recoverable source text. Previously this threw
  // `Missing or empty field: line.japanese` inside parseStanza's map
  // and poisoned the whole stanza; now parseLine returns null for the
  // unsalvageable extras and parseStanza filters them.
  console.log("\n11. Parser tolerance: extra unmapped lines are filtered, stanza still parses");
  {
    const stanzaSource = "光の中で目を覚ます\n夢が始まる";
    const rawStanza = {
      japanese: "",
      stanzaNumber: 1,
      directTranslation: "direct",
      culturalTranslation: "cultural",
      summary: "summary",
      lines: [
        // Real line 1 — matches stanzaSourceLines[0]
        {
          japanese: "",
          lineNumber: 1,
          directTranslation: "inside the light, waking",
          culturalTranslation: "waking inside the light",
          romaji: "hikari no naka de me wo samasu",
          words: [],
        },
        // Real line 2 — matches stanzaSourceLines[1]
        {
          japanese: "",
          lineNumber: 2,
          directTranslation: "dream begins",
          culturalTranslation: "a dream begins",
          romaji: "yume ga hajimaru",
          words: [],
        },
        // Extra unmapped line — no source override, no raw.japanese.
        // Must be filtered (previously threw).
        {
          japanese: "",
          lineNumber: 3,
          directTranslation: "",
          culturalTranslation: "",
          romaji: "",
          words: [],
        },
      ],
    };
    const { parseStanza } = await import("../src/domains/analysis/parsers.js");
    const parsed = parseStanza(rawStanza as never, "ja-en", stanzaSource);
    assert(parsed.lines.length === 2, `extra unmapped line dropped (${parsed.lines.length}/2)`);
    assert(parsed.lines[0]!.japanese === "光の中で目を覚ます", "first line carries first source");
    assert(parsed.lines[1]!.japanese === "夢が始まる", "second line carries second source");
  }

  // -----------------------------------------------------------------------
  // Regression: the line normalizer now populates direction-neutral
  // `original` / `translated` convenience fields, so downstream code
  // can read a stable shape without caring about the back-compat
  // `japanese` field name.
  console.log("\n12. Normalizer populates original/translated for both directions");
  {
    fetchCalls.length = 0;
    const jaShape = await analyzeLine(
      {
        line: "光の中で目を覚ます",
        songTitle: "Hikaru Nara",
        artistName: "Goose House",
        stanzaNumber: 6,
        lineNumber: 1,
        direction: "ja-en",
      },
      "shape-ja",
      { skipCache: true }
    );
    assert(
      jaShape.original === "光の中で目を覚ます",
      "ja-en: line.original === source Japanese line"
    );
    assert(
      jaShape.translated === jaShape.culturalTranslation && jaShape.translated.length > 0,
      "ja-en: line.translated === culturalTranslation (populated)"
    );

    fetchCalls.length = 0;
    const enShape = await analyzeLine(
      {
        line: "I awoke in the light",
        songTitle: "Serendipity",
        artistName: "BTS",
        stanzaNumber: 7,
        lineNumber: 1,
        direction: "en-ja",
      },
      "shape-en",
      { skipCache: true }
    );
    assert(
      enShape.original === "I awoke in the light",
      "en-ja: line.original === source English line"
    );
    assert(
      enShape.translated === enShape.culturalTranslation && enShape.translated.length > 0,
      "en-ja: line.translated === culturalTranslation (populated)"
    );
  }

  // -----------------------------------------------------------------------
  // Regression: blank input must fail at the service layer with a
  // user-facing message, not crash inside the parser.
  console.log("\n13. analyzeLine guards blank input cleanly");
  {
    let blankErr: unknown = null;
    try {
      await analyzeLine(
        {
          line: "   ",
          songTitle: "x",
          artistName: "x",
          stanzaNumber: 8,
          lineNumber: 1,
          direction: "ja-en",
        },
        "blank-line"
      );
    } catch (e) {
      blankErr = e;
    }
    assert(
      blankErr instanceof Error && /empty line/i.test(blankErr.message),
      "analyzeLine rejects blank req.line with an actionable message"
    );
  }

  // -----------------------------------------------------------------------
  console.log("\n14. Schema contracts are Proto-safe (no type unions, no null in enum)");
  // Historical regression guard: the Gemini-era `response_schema` field
  // rejected `type: ["string","null"]` and `enum: [..., null]` with a 400
  // "Proto field is not repeating". NVIDIA is more permissive, but the
  // contracts are still embedded in prompts and should stay portable to
  // any OpenAPI-3.0-subset consumer. Walk every contract and assert
  // neither pattern appears.
  const {
    LINE_ANALYSIS_CONTRACT,
    STANZA_ANALYSIS_CONTRACT,
    SONG_ANALYSIS_CONTRACT,
    STANZA_OVERVIEW_FROM_LINES_CONTRACT,
    SONG_OVERVIEW_FROM_STANZAS_CONTRACT,
    ASK_ABOUT_SELECTION_CONTRACT,
    WORD_DETAIL_CONTRACT,
  } = await import("../src/domains/analysis/contracts.js");

  type SchemaNode = {
    type?: unknown;
    enum?: unknown[];
    items?: SchemaNode;
    properties?: Record<string, SchemaNode>;
    nullable?: boolean;
    required?: string[];
    [k: string]: unknown;
  };

  function walkSchema(
    node: SchemaNode | null | undefined,
    path: string,
    issues: string[]
  ): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.type)) {
      issues.push(
        `${path}.type is an array (${JSON.stringify(node.type)}) — Gemini rejects this; use nullable: true instead`
      );
    }
    if (Array.isArray(node.enum) && node.enum.includes(null)) {
      issues.push(
        `${path}.enum contains null — Gemini rejects this; use nullable: true instead`
      );
    }
    if (node.items) walkSchema(node.items, `${path}.items`, issues);
    if (node.properties) {
      for (const [k, v] of Object.entries(node.properties)) {
        walkSchema(v, `${path}.properties.${k}`, issues);
      }
    }
  }

  const contractsToScan: Array<[string, unknown]> = [
    ["LINE_ANALYSIS_CONTRACT", LINE_ANALYSIS_CONTRACT],
    ["STANZA_ANALYSIS_CONTRACT", STANZA_ANALYSIS_CONTRACT],
    ["SONG_ANALYSIS_CONTRACT", SONG_ANALYSIS_CONTRACT],
    ["STANZA_OVERVIEW_FROM_LINES_CONTRACT", STANZA_OVERVIEW_FROM_LINES_CONTRACT],
    ["SONG_OVERVIEW_FROM_STANZAS_CONTRACT", SONG_OVERVIEW_FROM_STANZAS_CONTRACT],
    ["ASK_ABOUT_SELECTION_CONTRACT", ASK_ABOUT_SELECTION_CONTRACT],
    ["WORD_DETAIL_CONTRACT", WORD_DETAIL_CONTRACT],
  ];

  let totalIssues = 0;
  for (const [name, contract] of contractsToScan) {
    const issues: string[] = [];
    walkSchema(contract as SchemaNode, name, issues);
    assert(
      issues.length === 0,
      `${name} is Proto-safe (no type arrays, no null in enum)${
        issues.length > 0 ? " — issues: " + issues.join("; ") : ""
      }`
    );
    totalIssues += issues.length;
  }
  assert(totalIssues === 0, "every schema contract passes the Proto-safety walk");

  // Specifically for the field the 400 was pointing at: the fix is the
  // nullable form, not the union form.
  const lineContract = LINE_ANALYSIS_CONTRACT as SchemaNode;
  const wordItems = lineContract.properties?.words?.items as SchemaNode | undefined;
  const trans = wordItems?.properties?.transitivity as SchemaNode | undefined;
  assert(
    trans !== undefined,
    "words.items.properties.transitivity is present"
  );
  assert(
    trans?.type === "string",
    `transitivity.type === "string" (was ${JSON.stringify(trans?.type)})`
  );
  assert(
    trans?.nullable === true,
    "transitivity.nullable === true"
  );
  assert(
    Array.isArray(trans?.enum) &&
      trans!.enum!.length === 3 &&
      !trans!.enum!.includes(null),
    "transitivity.enum is [transitive, intransitive, both] with no null"
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
