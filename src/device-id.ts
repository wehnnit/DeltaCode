import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { getDeltaDir } from "./config";

/**
 * Stable per-device identifier for the Delta Free Models fair-use pool.
 *
 * A random 32-hex ID is stored in ~/.delta/device-id (survives app reinstall,
 * resettable by deleting the file) and sent to the proxy as a SHA-256 hash —
 * no hardware data ever leaves the machine.
 */
let cached: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  const dir = getDeltaDir();
  const file = join(dir, "device-id");
  let id = "";
  try {
    id = (await readFile(file, "utf8")).trim();
  } catch {
    id = "";
  }
  if (!id || id.length !== 32) {
    id = randomBytes(16).toString("hex");
    await mkdir(dir, { recursive: true });
    await writeFile(file, id, "utf8");
  }
  cached = createHash("sha256").update(id).digest("hex");
  return cached;
}

/** Test helper. */
export function resetDeviceIdCache(): void {
  cached = null;
}
