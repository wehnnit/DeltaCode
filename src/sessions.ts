import { readdir, readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDirFor } from "./config";

export interface SessionMsg {
  role: string;
  content: string;
  ts: number;
  reasoning?: string;
}

function currentFile(dir: string): string {
  return join(dir, ".current");
}

export async function startSession(cwd: string): Promise<{ dir: string; file: string; history: SessionMsg[] }> {
  const dir = sessionDirFor(cwd);
  await mkdir(dir, { recursive: true });

  let file = "";
  try {
    file = await readFile(currentFile(dir), "utf8");
    file = file.trim();
  } catch {
    file = "";
  }

  let history: SessionMsg[] = [];
  if (file) {
    const full = join(dir, file);
    if (existsSync(full)) {
      history = await readSession(full);
    } else {
      file = "";
    }
  }

  if (!file) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    file = `session-${stamp}.jsonl`;
    await writeFile(currentFile(dir), file, "utf8");
  }

  return { dir, file: join(dir, file), history };
}

export function newSession(cwd: string): string {
  const dir = sessionDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `session-${stamp}.jsonl`;
  writeFileSync(currentFile(dir), file, "utf8");
  return join(dir, file);
}

export async function readSession(file: string): Promise<SessionMsg[]> {
  const text = await readFile(file, "utf8");
  const out: SessionMsg[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionMsg);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export async function appendMsg(file: string, msg: SessionMsg): Promise<void> {
  await appendFile(file, JSON.stringify(msg) + "\n", "utf8");
}

export async function listSessions(cwd: string): Promise<string[]> {
  const dir = sessionDirFor(cwd);
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.startsWith("session-")).sort().reverse();
  } catch {
    return [];
  }
}
