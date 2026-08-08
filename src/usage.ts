import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDeltaDir } from "./config";

/**
 * Delta Free Models — token-based fair-use tracker (local layer).
 *
 * The proxy enforces the real shared pool; this local counter gives instant
 * blocking and /usage visibility. Formula: 1M tokens = 10 units, daily budget
 * 500 units (= 50M tokens/day). Reset at local midnight.
 */
export const FREE_UNITS = 500;
export const TOKENS_PER_UNIT = 100_000;

interface UsageFile {
  date: string;
  tokens: number;
}

function usagePath(): string {
  return join(getDeltaDir(), "usage.json");
}

export function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function unitsFor(tokens: number): number {
  return Math.floor(tokens / TOKENS_PER_UNIT);
}

export function nextResetMs(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}

async function load(): Promise<UsageFile> {
  try {
    const raw = await readFile(usagePath(), "utf8");
    const u = JSON.parse(raw) as UsageFile;
    if (u.date !== todayKey()) return { date: todayKey(), tokens: 0 };
    return { date: u.date, tokens: Math.max(0, Number(u.tokens) || 0) };
  } catch {
    return { date: todayKey(), tokens: 0 };
  }
}

let cache: UsageFile | null = null;
let cacheDate = "";

async function current(): Promise<UsageFile> {
  const key = todayKey();
  if (!cache || cacheDate !== key) {
    cache = await load();
    cacheDate = key;
  }
  return cache;
}

export async function getUsage(): Promise<{ tokens: number; units: number; limitUnits: number; resetMs: number }> {
  const u = await current();
  return { tokens: u.tokens, units: unitsFor(u.tokens), limitUnits: FREE_UNITS, resetMs: nextResetMs() };
}

/** Pre-check: is the daily budget already spent? */
export async function tryReserve(): Promise<boolean> {
  const u = await current();
  return unitsFor(u.tokens) < FREE_UNITS;
}

/** Charge tokens used (called after each successful provider call). */
export async function addTokens(tokens: number): Promise<void> {
  if (!tokens || tokens <= 0) return;
  const u = await current();
  u.tokens += tokens;
  cache = u;
  try {
    await writeFile(usagePath(), JSON.stringify(u), "utf8");
  } catch {
    // best effort — the in-memory counter still guards this session
  }
}

/** Test helper: drop the in-memory cache so external file changes are seen. */
export function resetUsageCache(): void {
  cache = null;
  cacheDate = "";
}
