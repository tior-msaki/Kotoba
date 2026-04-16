/**
 * Currency service.
 *
 * Earn and spend with validation. All mutations go through the ledger.
 */

import { InsufficientCurrencyError } from "../../../lib/errors";
import type { CurrencyBalance, CurrencyTransaction } from "../types";
import {
  appendTransaction,
  computeBalance,
  getTransactionHistory,
} from "./storage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const QUIZ_CORRECT_REWARD = 1;
export const GACHA_PULL_COST = 100;

// ---------------------------------------------------------------------------
// Earn
// ---------------------------------------------------------------------------

export async function earnFromQuiz(): Promise<CurrencyTransaction> {
  return appendTransaction("earn", QUIZ_CORRECT_REWARD, "quiz_correct");
}

export async function earn(
  amount: number,
  reason: string
): Promise<CurrencyTransaction> {
  return appendTransaction("earn", amount, reason);
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

/**
 * Spend currency. Throws InsufficientCurrencyError if balance is too low.
 */
export async function spend(
  amount: number,
  reason: string
): Promise<CurrencyTransaction> {
  const balance = await computeBalance();
  if (balance.total < amount) {
    throw new InsufficientCurrencyError(amount, balance.total);
  }
  return appendTransaction("spend", amount, reason);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getBalance(): Promise<CurrencyBalance> {
  return computeBalance();
}

export async function getHistory(
  limit?: number
): Promise<CurrencyTransaction[]> {
  return getTransactionHistory(limit);
}
