/**
 * Currency ledger storage.
 *
 * Append-only transaction log. Balance is computed, never stored directly.
 */

import { db } from "../../../db";
import { generateId, now } from "../../../lib/utils";
import type {
  CurrencyTransaction,
  CurrencyTransactionType,
  CurrencyBalance,
} from "../types";

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

export async function appendTransaction(
  type: CurrencyTransactionType,
  amount: number,
  reason: string
): Promise<CurrencyTransaction> {
  const tx: CurrencyTransaction = {
    id: generateId(),
    type,
    amount,
    reason,
    createdAt: now(),
  };
  await db.currencyLedger.add(tx);
  return tx;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export async function computeBalance(): Promise<CurrencyBalance> {
  const transactions = await db.currencyLedger.toArray();

  let earned = 0;
  let spent = 0;

  for (const tx of transactions) {
    if (tx.type === "earn") {
      earned += tx.amount;
    } else {
      spent += tx.amount;
    }
  }

  return {
    total: earned - spent,
    earned,
    spent,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function getTransactionHistory(
  limit = 50
): Promise<CurrencyTransaction[]> {
  return db.currencyLedger
    .orderBy("createdAt")
    .reverse()
    .limit(limit)
    .toArray();
}
