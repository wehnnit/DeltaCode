import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Tool, ToolContext } from "./types";
import { strArg } from "./types";

const IGNORE = new Set([
  "node_modules", ".git", ".delta", "dist", "build", ".next", "coverage",
  "vendor", ".venv", "venv", "__pycache__", ".cache", "target", "out",
]);

async function walk(dir: string, base: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length && out.length < maxFiles) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      if (e.name.startsWith(".")) continue;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        out.push(relative(base, full));
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

function toRegExp(glob: string): RegExp {
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if ("\\^$.|+()[]{}".includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(re + "$");
}

function matchGlob(pattern: string, relativePath: string): boolean {
  if (pattern.includes("**")) {
    const [head, tail] = pattern.split("**");
    const headRe = head ? toRegExp(head.replace(/\/$/, "")) : null;
    const tailRe = tail ? toRegExp(tail.replace(/^\//, "")) : null;
    if (headRe && !headRe.test(relativePath) && !relativePath.startsWith(head!.replace(/\/$/, "")))
      return false;
    if (tailRe && !tailRe.test(relativePath)) return false;
    return true;
  }
  return toRegExp(pattern).test(relativePath);
}

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob pattern (e.g. **/*.tsx, src/**/*.test.ts). Returns up to 200 matches. Skips node_modules, .git, build dirs.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match" },
      base: { type: "string", description: "Directory to search from (default: project root)" },
    },
    required: ["pattern"],
  },
  handler: async (ctx: ToolContext, args) => {
    const pattern = strArg(args, "pattern");
    const baseRaw = strArg(args, "base") || ".";
    const base = resolve(ctx.cwd, baseRaw);
    if (!existsSync(base)) return { output: `Error: directory not found: ${baseRaw}` };
    const files = await walk(base, base, 100000);
    const matched = files.filter((f) => matchGlob(pattern, f));
    const limited = matched.slice(0, 200);
    return {
      output:
        limited.length === 0
          ? "No files matched."
          : `${limited.length} file${limited.length > 1 ? "s" : ""} matched${matched.length > limited.length ? ` (${matched.length - limited.length} more)` : ""}:\n` +
            limited.join("\n"),
    };
  },
};

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents by regular expression. Returns file:line matches with the matching line. Skips node_modules, .git, build dirs.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      include: { type: "string", description: "Optional file pattern filter, e.g. *.ts, *.{ts,tsx}" },
      base: { type: "string", description: "Directory to search (default: project root)" },
    },
    required: ["pattern"],
  },
  handler: async (ctx: ToolContext, args) => {
    const pattern = strArg(args, "pattern");
    const include = strArg(args, "include");
    const baseRaw = strArg(args, "base") || ".";
    const base = resolve(ctx.cwd, baseRaw);
    if (!existsSync(base)) return { output: `Error: directory not found: ${baseRaw}` };
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return { output: `Error: invalid regex: ${(e as Error).message}` };
    }
    const includeRe = include ? toRegExp(include) : null;
    const files = await walk(base, base, 5000);
    const results: string[] = [];
    let searched = 0;
    for (const rel of files) {
      if (includeRe && !includeRe.test(rel)) continue;
      if (results.length >= 300) break;
      searched++;
      const full = join(base, rel);
      try {
        const content = await Bun.file(full).text();
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (re.test(line)) {
            results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
            if (results.length >= 300) break;
          }
        }
      } catch {
        // skip unreadable files (binary etc.)
      }
    }
    return {
      output:
        results.length === 0
          ? `No matches for /${pattern}/ (${searched} files searched).`
          : `${results.length} matches:\n` + results.join("\n"),
    };
  },
};
