import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getUsage, tryReserve, addTokens, FREE_UNITS, TOKENS_PER_UNIT, unitsFor, nextResetMs, resetUsageCache, todayKey } from "../src/usage";
import { loadConfig, saveConfig, isConfigured, defaultConfig, FREE_PROVIDER_ID } from "../src/config";

let home: string;
let oldHome: string | undefined;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "delta-usage-"));
  oldHome = process.env.HOME;
  process.env.HOME = home;
  await mkdir(join(home, ".delta"), { recursive: true });
});

afterAll(async () => {
  if (oldHome) process.env.HOME = oldHome;
  await rm(home, { recursive: true, force: true });
});

function usagePath() {
  return join(home, ".delta", "usage.json");
}

describe("Delta Free Models usage tracker", () => {
  test("charges tokens and reports usage in units", async () => {
    resetUsageCache();
    await rm(usagePath(), { force: true });
    expect(await tryReserve()).toBe(true);
    await addTokens(2_000_000); // 2M tokens = 20 units
    const u = await getUsage();
    expect(u.tokens).toBe(2_000_000);
    expect(u.units).toBe(20);
    expect(u.limitUnits).toBe(FREE_UNITS);
    expect(u.resetMs).toBeGreaterThan(0);
    expect(unitsFor(1_000_000)).toBe(10);
    expect(unitsFor(TOKENS_PER_UNIT * 5)).toBe(5);
  });

  test("blocks when the unit budget is spent and resets on a new day", async () => {
    resetUsageCache();
    const spent = FREE_UNITS * TOKENS_PER_UNIT; // exactly at the cap
    await writeFile(usagePath(), JSON.stringify({ date: todayKey(), tokens: spent }));
    expect(await tryReserve()).toBe(false);
    expect((await getUsage()).units).toBe(FREE_UNITS);

    // yesterday's file at the cap → new day resets
    const yesterday = new Date(Date.now() - 86400000);
    const yKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    resetUsageCache();
    await writeFile(usagePath(), JSON.stringify({ date: yKey, tokens: spent }));
    expect(await tryReserve()).toBe(true);
    expect((await getUsage()).tokens).toBe(0);
  });

  test("addTokens persists and accumulates", async () => {
    resetUsageCache();
    await rm(usagePath(), { force: true });
    await addTokens(100_000);
    await addTokens(900_000);
    expect((await getUsage()).tokens).toBe(1_000_000);
    expect((await getUsage()).units).toBe(10);
  });

  test("nextResetMs is positive and under 24h", () => {
    const ms = nextResetMs();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe("config: Delta Free Models", () => {
  test("isConfigured is true for delta-free without any API key", () => {
    const c = defaultConfig();
    c.provider = FREE_PROVIDER_ID;
    expect(isConfigured(c)).toBe(true);
  });

  test("acceptedFreeModels persists through save/load", async () => {
    const c = defaultConfig();
    c.provider = FREE_PROVIDER_ID;
    c.apiKey = "delta-free";
    c.model = "glm-4.7-flash";
    c.acceptedFreeModels = true;
    await saveConfig(c);
    const loaded = await loadConfig();
    expect(loaded.provider).toBe(FREE_PROVIDER_ID);
    expect(loaded.acceptedFreeModels).toBe(true);
  });
});
