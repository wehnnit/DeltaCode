import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { getSkillsDir } from "../config";
import { BUILTIN_SKILLS } from "./builtin";

export interface Skill {
  name: string;
  description: string;
  /** When the model should use this skill. */
  whenToUse: string;
  body: string;
  /** Absolute path to the skill folder (for scripts/resources). */
  dir?: string;
  /** True if shipped with Delta (immutable). */
  builtin: boolean;
}

export function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return { frontmatter: fm, body: match[2] ?? "" };
}

export async function loadSkillFromDir(dir: string, builtin = false): Promise<Skill | null> {
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  const text = await readFile(file, "utf8");
  const { frontmatter, body } = parseFrontmatter(text);
  const name = frontmatter.name ?? dir.split("/").filter(Boolean).pop() ?? "unnamed";
  if (!body.trim()) return null;
  return {
    name,
    description: frontmatter.description ?? "",
    whenToUse: frontmatter.whenToUse ?? frontmatter["when-to-use"] ?? "",
    body: body.trim(),
    dir,
    builtin,
  };
}

export async function loadSkills(projectDir: string): Promise<Skill[]> {
  const found: Skill[] = [...BUILTIN_SKILLS];

  const bases = [getSkillsDir(), join(projectDir, ".delta", "skills")];
  const seen = new Set<string>();
  for (const base of bases) {
    const key = resolve(base);
    if (seen.has(key)) continue; // e.g. running from $HOME scans the same dir twice
    seen.add(key);
    let entries: string[] = [];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const dir = join(base, entry);
      const skill = await loadSkillFromDir(dir);
      if (skill) {
        const existing = found.findIndex((s) => s.name === skill.name);
        if (existing >= 0) found[existing] = skill;
        else found.push(skill);
      }
    }
  }
  return found;
}

export function skillByName(skills: Skill[], name: string): Skill | undefined {
  return skills.find((s) => s.name === name);
}
