/**
 * Gacha service.
 *
 * Handles pulls (spend currency → roll rarity → pick card → update inventory)
 * and inventory queries.
 */

import { db } from "../../../db";
import { now } from "../../../lib/utils";
import type {
  GachaPullResult,
  Photocard,
  PhotocardInventoryItem,
} from "../types";
import type { StoredPhotocardInventoryItem } from "../../../db/schema";
import { rollRarity, pickCard, getAllCards, getCardById } from "./pool";
import { spend, GACHA_PULL_COST } from "../currency/service";

// ---------------------------------------------------------------------------
// Randomness — uses Math.random by default, overridable via pool.ts
// ---------------------------------------------------------------------------

let rng = Math.random;

export function setGachaRng(fn: () => number): void {
  rng = fn;
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/**
 * Execute a single gacha pull.
 * Spends GACHA_PULL_COST currency, rolls a card, updates inventory.
 * Throws InsufficientCurrencyError if balance is too low.
 */
export async function pull(): Promise<GachaPullResult> {
  // Spend currency first — throws if insufficient
  await spend(GACHA_PULL_COST, "gacha_pull");

  // Roll
  const rarity = rollRarity(rng);
  const photocard = pickCard(rarity, rng);
  const pulledAt = now();

  // Update inventory
  const isNew = await addToInventory(photocard, pulledAt);

  return {
    photocard,
    isNew,
    rarity,
    pulledAt,
  };
}

/**
 * Execute multiple pulls in sequence.
 * Stops early if currency runs out.
 */
export async function pullMulti(count: number): Promise<GachaPullResult[]> {
  const results: GachaPullResult[] = [];
  for (let i = 0; i < count; i++) {
    const result = await pull();
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * Add a card to inventory. Returns true if this is a new card.
 */
async function addToInventory(
  card: Photocard,
  obtainedAt: number
): Promise<boolean> {
  const existing = await db.photocardInventory.get(card.id);

  if (existing) {
    await db.photocardInventory.update(card.id, {
      quantity: existing.quantity + 1,
    });
    return false;
  }

  const record: StoredPhotocardInventoryItem = {
    id: card.id,
    photocardId: card.id,
    name: card.name,
    imageUrl: card.imageUrl,
    rarity: card.rarity,
    artist: card.artist,
    quantity: 1,
    firstObtainedAt: obtainedAt,
  };
  await db.photocardInventory.add(record);
  return true;
}

/**
 * Get the full inventory with photocard details.
 */
export async function getInventory(): Promise<PhotocardInventoryItem[]> {
  const stored = await db.photocardInventory.toArray();

  return stored.map((item): PhotocardInventoryItem => {
    const photocard = getCardById(item.photocardId) ?? {
      id: item.photocardId,
      name: item.name,
      imageUrl: item.imageUrl,
      rarity: item.rarity as Photocard["rarity"],
      artist: item.artist,
    };
    return {
      photocard,
      quantity: item.quantity,
      firstObtainedAt: item.firstObtainedAt,
    };
  });
}

/**
 * Get inventory filtered by rarity.
 */
export async function getInventoryByRarity(
  rarity: string
): Promise<PhotocardInventoryItem[]> {
  const all = await getInventory();
  return all.filter((item) => item.photocard.rarity === rarity);
}

/**
 * Get collection progress: owned vs total.
 */
export async function getCollectionProgress(): Promise<{
  owned: number;
  total: number;
}> {
  const owned = await db.photocardInventory.count();
  const total = getAllCards().length;
  return { owned, total };
}
