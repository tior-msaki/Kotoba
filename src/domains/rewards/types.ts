/**
 * Rewards domain types.
 *
 * Covers three sub-domains: quiz, currency, and gacha.
 */

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

export type QuizQuestionType = "meaning" | "reading" | "kanji";

export interface QuizOption {
  text: string;
  isCorrect: boolean;
}

export interface QuizQuestion {
  id: string;
  /** The word/kanji being tested. */
  prompt: string;
  questionType: QuizQuestionType;
  options: QuizOption[];
  /** ID of the dictionary entry this question was generated from. */
  dictionaryEntryId: string;
}

export type QuizSessionStatus = "in-progress" | "completed";

export interface QuizSession {
  id: string;
  questions: QuizQuestion[];
  /** Index of the current question (0-based). */
  currentIndex: number;
  /** Maps question ID -> selected option index. */
  answers: Record<string, number>;
  correctCount: number;
  status: QuizSessionStatus;
  startedAt: number;
  completedAt?: number;
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

export type CurrencyTransactionType = "earn" | "spend";

export interface CurrencyTransaction {
  id: string;
  type: CurrencyTransactionType;
  amount: number;
  /** Human-readable reason, e.g. "quiz_complete", "gacha_pull". */
  reason: string;
  createdAt: number;
}

export interface CurrencyBalance {
  total: number;
  earned: number;
  spent: number;
}

// ---------------------------------------------------------------------------
// Gacha
// ---------------------------------------------------------------------------

export type GachaRarity = "common" | "uncommon" | "rare" | "legendary";

export interface Photocard {
  id: string;
  name: string;
  imageUrl: string;
  rarity: GachaRarity;
  /** Artist or group this photocard belongs to. */
  artist: string;
}

export interface PhotocardInventoryItem {
  photocard: Photocard;
  /** How many copies the user owns. */
  quantity: number;
  firstObtainedAt: number;
}

export interface GachaPullResult {
  photocard: Photocard;
  isNew: boolean;
  rarity: GachaRarity;
  pulledAt: number;
}
