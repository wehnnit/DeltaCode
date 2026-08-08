import { mkdir, readFile, writeFile, stat, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types";
import { strArg, isWithin } from "./types";

async function readText(path: string, limit?: number): Promise<string> {
  const content = await readFile(path, "utf8");
  if (limit && content.length > limit) {
    return content.slice(0, limit) + `\n... [truncated: ${content.length - limit} chars omitted]`;
  }
  return content;
}

/**
 * Read only the requested line window of a file. Small files are read whole;
 * large files are streamed line-by-line so a 1GB log only costs the bytes
 * actually returned.
 */
async function readWindow(path: string, fromLine: number, maxLines: number): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  if (size <= 1024 * 1024) {
    const lines = (await file.text()).split("\n");
    return lines.slice(fromLine - 1, fromLine - 1 + maxLines).join("\n");
  }
  const reader = (await file.stream()).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lineNo = 1;
  const out: string[] = [];
  try {
    while (out.length < maxLines) {
      const { done, value } = await reader.read();
      buf += decoder.decode(value, { stream: !done });
      if (done && !buf) break;
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (lineNo >= fromLine) out.push(line);
        lineNo++;
        if (out.length >= maxLines) break;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  return out.join("\n");
}

export const readTool: Tool = {
  name: "read",
  description:
    "Read a file from disk. Without offset: returns up to `limit` chars. With offset: reads a line window — `offset` is the 1-based start line and `limit` is the max number of lines (default 400). For large files use offset to avoid loading the whole file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read" },
      offset: { type: "number", description: "1-based line to start from" },
      limit: { type: "number", description: "Max chars (no offset) or max lines (with offset, default 400)" },
    },
    required: ["path"],
  },
  handler: async (ctx, args) => {
    const raw = strArg(args, "path");
    const path = resolve(ctx.cwd, raw);
    if (!existsSync(path)) return { output: `Error: file not found: ${raw}` };
    const st = await stat(path);
    if (st.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
      return { output: lines };
    }
    const offset = typeof args.offset === "number" ? args.offset : 0;
    if (offset > 0) {
      const maxLines = typeof args.limit === "number" ? Math.max(1, Math.floor(args.limit)) : 400;
      const window = await readWindow(path, Math.max(1, Math.floor(offset)), maxLines);
      return { output: window || "(no lines in window)" };
    }
    return { output: await readText(path, typeof args.limit === "number" ? args.limit : undefined) };
  },
};

export const writeTool: Tool = {
  name: "write",
  description: "Write a file. Creates parent directories. Overwrites existing content. Keep writes under ~1500 lines.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to write" },
      content: { type: "string", description: "Full content to write" },
    },
    required: ["path", "content"],
  },
  handler: async (ctx, args) => {
    const raw = strArg(args, "path");
    const content = strArg(args, "content");
    if (!raw) return { output: "Error: write requires a `path` argument (e.g. \"index.html\")." };
    if (!content) return { output: "Error: write requires a non-empty `content` argument." };
    const path = resolve(ctx.cwd, raw);
    if (!ctx.allowedRoots.some((r) => isWithin(path, r))) {
      return { output: `Error: path outside allowed scope: ${raw}` };
    }
    if (!isWithin(path, ctx.cwd)) {
      const ok = await ctx.confirm("write", `write to ${path}`);
      if (!ok) return { output: "Permission denied by user." };
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return { output: `Wrote ${content.length} chars to ${raw}` };
  },
};

function applyEdit(content: string, oldText: string, newText: string, all: boolean): string {
  if (!oldText) throw new Error("oldText must not be empty");
  const first = content.indexOf(oldText);
  if (first === -1) throw new Error("oldText not found in file");
  if (!all) return content.slice(0, first) + newText + content.slice(first + oldText.length);
  return content.split(oldText).join(newText);
}

export const editTool: Tool = {
  name: "edit",
  description:
    "Edit a file by replacing exact text. oldString must match exactly, with unique surrounding context. Use replaceAll for repeated occurrences.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to edit" },
      oldString: { type: "string", description: "Exact text to replace" },
      newString: { type: "string", description: "Replacement text" },
      replaceAll: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["path", "oldString", "newString"],
  },
  handler: async (ctx, args) => {
    const raw = strArg(args, "path");
    const oldText = strArg(args, "oldString");
    const newText = strArg(args, "newString");
    if (!raw) return { output: "Error: edit requires a `path` argument." };
    if (!oldText) return { output: "Error: edit requires a non-empty `oldString` argument." };
    const all = args.replaceAll === true;
    const path = resolve(ctx.cwd, raw);
    if (!existsSync(path)) return { output: `Error: file not found: ${raw}` };
    const original = await readFile(path, "utf8");
    let edited: string;
    try {
      edited = applyEdit(original, oldText, newText, all);
    } catch (e) {
      return { output: `Error: ${(e as Error).message}` };
    }
    await writeFile(path, edited, "utf8");
    const added = newText.split("\n").length;
    return {
      output: `Edited ${raw}: replaced ${oldText.split("\n").length} lines with ${added} lines.`,
    };
  },
};

export const deleteTool: Tool = {
  name: "delete",
  description: "Delete a file. Use with caution.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path of the file to delete" } },
    required: ["path"],
  },
  handler: async (ctx, args) => {
    const raw = strArg(args, "path");
    const path = resolve(ctx.cwd, raw);
    if (!ctx.allowedRoots.some((r) => isWithin(path, r))) {
      return { output: `Error: path outside allowed scope: ${raw}` };
    }
    if (!isWithin(path, ctx.cwd)) {
      const ok = await ctx.confirm("write", `delete ${path}`);
      if (!ok) return { output: "Permission denied by user." };
    }
    if (!existsSync(path)) return { output: `Error: file not found: ${raw}` };
    await unlink(path);
    return { output: `Deleted ${raw}` };
  },
};

export const fileInfoTool: Tool = {
  name: "file_info",
  description: "Get file type, size, line count, and extension info.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path to inspect" } },
    required: ["path"],
  },
  handler: async (ctx, args) => {
    const raw = strArg(args, "path");
    const path = resolve(ctx.cwd, raw);
    if (!existsSync(path)) return { output: `Error: file not found: ${raw}` };
    const st = await stat(path);
    if (st.isDirectory()) {
      const entries = await readdir(path);
      return { output: `Directory with ${entries.length} entries` };
    }
    const content = await readFile(path, "utf8");
    const lines = content.split("\n").length;
    const ext = extname(path) || "(none)";
    return {
      output: `Type: ${ext} | Size: ${st.size} bytes | Lines: ${lines}`,
    };
  },
};
