import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTool, writeTool, editTool } from "../src/tools/fs";
import { globTool, grepTool } from "../src/tools/search";
import type { ToolContext } from "../src/tools/types";

let dir: string;
let ctx: ToolContext;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "delta-tools-"));
  await mkdir(join(dir, "src", "components"), { recursive: true });
  await writeFile(join(dir, "src", "index.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "src", "components", "App.tsx"), "export function App() { return <div />; }\n");
  await writeFile(join(dir, "README.md"), "# Hello\n\nSome text about hello world.\n");
  ctx = {
    cwd: dir,
    allowedRoots: [dir],
    confirm: async () => true,
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fs tools", () => {
  test("read file", async () => {
    const r = await readTool.handler(ctx, { path: "src/index.ts" });
    expect(r.output).toContain("export const a = 1");
  });

  test("read directory lists entries", async () => {
    const r = await readTool.handler(ctx, { path: "src" });
    expect(r.output).toContain("components/");
    expect(r.output).toContain("index.ts");
  });

  test("read missing file errors", async () => {
    const r = await readTool.handler(ctx, { path: "nope.ts" });
    expect(r.output).toContain("not found");
  });

  test("write creates parent dirs", async () => {
    const r = await writeTool.handler(ctx, { path: "lib/util.ts", content: "export const u = 2;\n" });
    expect(r.output).toContain("Wrote");
    const back = await readTool.handler(ctx, { path: "lib/util.ts" });
    expect(back.output).toContain("export const u = 2");
  });

  test("write refuses path outside project", async () => {
    const r = await writeTool.handler(ctx, { path: "/etc/passwd", content: "x" });
    expect(r.output).toContain("outside");
  });

  test("edit replaces exact text", async () => {
    const r = await editTool.handler(ctx, { path: "lib/util.ts", oldString: "export const u = 2;", newString: "export const u = 3;" });
    expect(r.output).toContain("Edited");
    const back = await readTool.handler(ctx, { path: "lib/util.ts" });
    expect(back.output).toContain("u = 3");
  });

  test("edit errors when oldString missing", async () => {
    const r = await editTool.handler(ctx, { path: "lib/util.ts", oldString: "does not exist anywhere", newString: "x" });
    expect(r.output).toContain("not found");
  });
});

describe("search tools", () => {
  test("glob matches nested files", async () => {
    const r = await globTool.handler(ctx, { pattern: "**/*.ts*" });
    expect(r.output).toContain("src/index.ts");
    expect(r.output).toContain("src/components/App.tsx");
    expect(r.output).toContain("lib/util.ts");
  });

  test("glob with base dir", async () => {
    const r = await globTool.handler(ctx, { pattern: "**/*.tsx", base: "src" });
    expect(r.output).toContain("App.tsx");
    expect(r.output).not.toContain("index.ts");
  });

  test("grep finds matches with line numbers", async () => {
    const r = await grepTool.handler(ctx, { pattern: "hello" });
    expect(r.output).toContain("README.md:3");
    expect(r.output).toContain("Some text about hello world");
  });

  test("grep include filter", async () => {
    const r = await grepTool.handler(ctx, { pattern: "export", include: "*.ts" });
    expect(r.output).toContain("index.ts");
    expect(r.output).not.toContain("README");
  });

  test("grep no matches", async () => {
    const r = await grepTool.handler(ctx, { pattern: "zzzznothing" });
    expect(r.output).toContain("No matches");
  });
});
