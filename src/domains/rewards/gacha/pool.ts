/**
 * Gacha photocard pool and rarity configuration.
 *
 * Static data defining available photocards and pull probabilities.
 * 99% common (bunny photocards), 1% SSR/legendary (full-render drawings).
 */

import type { Photocard, GachaRarity } from "../types";
import type { RngFn } from "../quiz/generator";

// ---------------------------------------------------------------------------
// Rarity weights
// ---------------------------------------------------------------------------

export interface RarityWeight {
  rarity: GachaRarity;
  weight: number;
}

export const RARITY_WEIGHTS: RarityWeight[] = [
  { rarity: "common", weight: 0.99 },
  { rarity: "legendary", weight: 0.01 },
];

// ---------------------------------------------------------------------------
// Photocard pool
// ---------------------------------------------------------------------------

const COMMON_CARDS: Photocard[] = [
  { id: "bunny-01", name: "Spring Bunny", imageUrl: "/cards/bunny-01.png", rarity: "common", artist: "Kotoba" },
  { id: "bunny-02", name: "Moon Bunny", imageUrl: "/cards/bunny-02.png", rarity: "common", artist: "Kotoba" },
  { id: "bunny-03", name: "Sakura Bunny", imageUrl: "/cards/bunny-03.png", rarity: "common", artist: "Kotoba" },
  { id: "bunny-04", name: "Snow Bunny", imageUrl: "/cards/bunny-04.png", rarity: "common", artist: "Kotoba" },
  { id: "bunny-05", name: "Star Bunny", imageUrl: "/cards/bunny-05.png", rarity: "common", artist: "Kotoba" },
];

const LEGENDARY_CARDS: Photocard[] = [
  { id: "ssr-01", name: "Celestial Guardian", imageUrl: "/cards/ssr-01.png", rarity: "legendary", artist: "Kotoba" },
  { id: "ssr-02", name: "Dragon Empress", imageUrl: "/cards/ssr-02.png", rarity: "legendary", artist: "Kotoba" },
  { id: "ssr-03", name: "Spirit of Words", imageUrl: "/cards/ssr-03.png", rarity: "legendary", artist: "Kotoba" },
];

const POOL_BY_RARITY: Record<string, Photocard[]> = {
  common: COMMON_CARDS,
  legendary: LEGENDARY_CARDS,
};

// ---------------------------------------------------------------------------
// Selection logic
// ---------------------------------------------------------------------------

/**
 * Roll a rarity based on configured weights.
 */
export function rollRarity(random: RngFn): GachaRarity {
  const roll = random();
  let cumulative = 0;
  for (const { rarity, weight } of RARITY_WEIGHTS) {
    cumulative += weight;
    if (roll < cumulative) return rarity;
  }
  // Fallback (should not reach due to weights summing to 1.0)
  return "common";
}

/**
 * Pick a random card from the pool for a given rarity.
 */
export function pickCard(rarity: GachaRarity, random: RngFn): Photocard {
  const pool = POOL_BY_RARITY[rarity] ?? COMMON_CARDS;
  const index = Math.floor(random() * pool.length);
  return pool[index];
}

/**
 * Get all cards in the pool (for display/collection tracking).
 */
export function getAllCards(): Photocard[] {
  return [...COMMON_CARDS, ...LEGENDARY_CARDS];
}

export function getCardById(id: string): Photocard | undefined {
  return getAllCards().find((c) => c.id === id);
}
