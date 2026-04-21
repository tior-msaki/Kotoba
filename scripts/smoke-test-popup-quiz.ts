/**
 * Manual smoke test for the popup-quiz backend.
 *
 * Run with: npx tsx scripts/smoke-test-popup-quiz.ts
 *
 * Exercises the new integration-contract surface (popupQuiz.*) end-to-end
 * via an in-process test generator — no NVIDIA / network calls. Focus is
 * on the correctness properties the audit called out:
 *   - question payload is sanitised (no answer leak)
 *   - submit is idempotent per question id (no double-award)
 *   - unknown / expired id surfaces as StorageError
 *   - ledger reason is popup-specific
 *   - state composite reflects post-answer balance + streak
 */

import "fake-indexeddb/auto";

import {
  popupQuiz,
  type PopupQuizGenerator,
  type PopupQuizQuestionView,
} from "../src/services/app";
import { createEntry } from "../src/domains/dictionary/service";
import { StorageError } from "../src/lib/errors";

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

function isStorageError(e: unknown): e is StorageError {
  return e instanceof StorageError;
}

async function run() {
  console.log("\n=== Popup Quiz Smoke Test ===\n");

  // ---------------------------------------------------------------------
  console.log("1. Empty-state contract");
  const emptyState = await popupQuiz.getState();
  assert(emptyState.balance.total === 0, "balance.total starts at 0");
  assert(emptyState.streak.current === 0, "streak.current starts at 0");
  assert(
    emptyState.hasOutstandingQuestion === false,
    "no outstanding question on boot"
  );
  assert(typeof emptyState.gachaPullCost === "number", "gachaPullCost exposed");

  // No study data → no question.
  const emptyQuestion = await popupQuiz.getNext();
  assert(emptyQuestion === null, "getNext returns null with no study data");

  // ---------------------------------------------------------------------
  console.log("\n2. Study-grounded generation");
  // Populate a handful of dictionary entries so the generator has
  // material to quiz on. We then inject a test-only generator to
  // avoid any network / LLM call.
  await createEntry({
    surface: "光",
    romaji: "hikari",
    type: "noun",
    meaning: "light",
    direction: "ja-en",
    sourceTrackName: "Demo",
    artistName: "Test",
  });
  await createEntry({
    surface: "風",
    romaji: "kaze",
    type: "noun",
    meaning: "wind",
    direction: "ja-en",
  });
  await createEntry({
    surface: "星",
    romaji: "hoshi",
    type: "noun",
    meaning: "star",
    direction: "ja-en",
  });
  await createEntry({
    surface: "月",
    romaji: "tsuki",
    type: "noun",
    meaning: "moon",
    direction: "ja-en",
  });

  const testGenerator: PopupQuizGenerator = {
    async generate(context) {
      const entry = context.recentDictionary[0]?.entry;
      if (!entry) return null;
      return popupQuiz.finalizeQuestion({
        kind: "word-meaning",
        prompt: entry.surface,
        options: [
          { text: entry.meaning, isCorrect: true },
          { text: "decoy-a", isCorrect: false },
          { text: "decoy-b", isCorrect: false },
          { text: "decoy-c", isCorrect: false },
        ],
        explanation: `test-explanation for ${entry.surface}`,
        source: {
          kind: "dictionaryEntry",
          id: entry.id,
          surface: entry.surface,
        },
      });
    },
  };
  popupQuiz.registerGenerator(testGenerator);

  const q1 = (await popupQuiz.getNext()) as PopupQuizQuestionView;
  assert(q1 !== null, "getNext returns a question when study data exists");
  assert(typeof q1.id === "string" && q1.id.length > 0, "question has id");
  assert(q1.options.length === 4, "four options returned");
  assert(
    !("isCorrect" in (q1.options[0] as object)),
    "sanitised view — no isCorrect leak on options"
  );
  assert(
    !("correctOptionIndex" in (q1 as unknown as Record<string, unknown>)),
    "sanitised view — no correctOptionIndex on the view"
  );
  assert(
    !("explanation" in (q1 as unknown as Record<string, unknown>)),
    "sanitised view — no explanation leak pre-submit"
  );

  // ---------------------------------------------------------------------
  console.log("\n3. Outstanding-question dedup");
  const q1Again = await popupQuiz.getNext();
  assert(
    q1Again?.id === q1.id,
    "repeated getNext returns the same outstanding question"
  );

  const outstandingState = await popupQuiz.getState();
  assert(
    outstandingState.hasOutstandingQuestion === true,
    "getState reports outstanding=true after delivery"
  );

  // ---------------------------------------------------------------------
  console.log("\n4. Correct submit awards exactly once");
  const submitResult = await popupQuiz.submit(q1.id, 0); // option 0 is correct
  assert(submitResult.correct === true, "correct answer evaluated as correct");
  assert(submitResult.correctOptionIndex === 0, "correctOptionIndex revealed");
  assert(submitResult.currencyAwarded === 1, "one coin awarded");
  assert(submitResult.balance.total === 1, "balance updated to 1");
  assert(submitResult.streak.current === 1, "streak advances to 1");
  assert(
    submitResult.explanation.length > 0,
    "explanation revealed post-submit"
  );

  // ---------------------------------------------------------------------
  console.log("\n5. Idempotency — re-submit does NOT double-award");
  const resubmitResult = await popupQuiz.submit(q1.id, 0);
  assert(
    resubmitResult.currencyAwarded === 1,
    "re-submit returns cached currencyAwarded (=1, not 2)"
  );
  const postBalance = await popupQuiz.getState();
  assert(postBalance.balance.total === 1, "balance still 1 after re-submit");

  // ---------------------------------------------------------------------
  console.log("\n6. Concurrent submit — only one award");
  // Deliver a new question, fire two submits in parallel.
  const q2 = (await popupQuiz.getNext()) as PopupQuizQuestionView;
  assert(q2 !== null, "second question delivered");
  const [r1, r2] = await Promise.all([
    popupQuiz.submit(q2.id, 0),
    popupQuiz.submit(q2.id, 0),
  ]);
  // Both return correct + currencyAwarded=1 (one from the real award,
  // one from the idempotency-cached replay). What must NOT happen:
  // two ledger rows. Check via the state's balance.
  const afterConcurrent = await popupQuiz.getState();
  assert(
    afterConcurrent.balance.total === 2,
    "balance.total is 2 after two questions (not 3 — no double-award)"
  );
  assert(r1.correct && r2.correct, "both concurrent submits report correct");

  // ---------------------------------------------------------------------
  console.log("\n7. Unknown id → StorageError");
  let caught: unknown = null;
  try {
    await popupQuiz.submit("does-not-exist", 0);
  } catch (err) {
    caught = err;
  }
  assert(isStorageError(caught), "unknown id throws StorageError");

  // ---------------------------------------------------------------------
  console.log("\n8. Wrong-answer path — no award, streak resets");
  const q3 = (await popupQuiz.getNext()) as PopupQuizQuestionView;
  const wrongResult = await popupQuiz.submit(q3.id, 1); // option 1 is a decoy
  assert(wrongResult.correct === false, "wrong answer evaluated as incorrect");
  assert(wrongResult.currencyAwarded === 0, "no coin awarded on wrong answer");
  const afterWrong = await popupQuiz.getState();
  assert(afterWrong.balance.total === 2, "balance unchanged after wrong answer");
  assert(afterWrong.streak.current === 0, "streak resets on wrong answer");

  // ---------------------------------------------------------------------
  console.log("\n9. Recent-rewards filter");
  const rewards = await popupQuiz.getRecentRewards(10);
  assert(
    rewards.every((r) => r.reason === popupQuiz.LEDGER_REASON),
    "recent rewards only contain the popup-specific ledger reason"
  );
  assert(
    rewards.length === 2,
    `exactly two popup-quiz reward rows recorded (got ${rewards.length})`
  );

  // ---------------------------------------------------------------------
  console.log("\n10. History is newest-first and reflects answers");
  const history = await popupQuiz.recentHistory(10);
  assert(history.length === 3, `three history rows recorded (got ${history.length})`);
  assert(
    history[0].answeredAt >= history[history.length - 1].answeredAt,
    "history ordered newest-first"
  );

  // ---------------------------------------------------------------------
  console.log(
    `\n=== ${passed} passed · ${failed} failed ===\n`
  );
  if (failed > 0) process.exit(1);
}

void run().catch((err) => {
  console.error(err);
  process.exit(1);
});
