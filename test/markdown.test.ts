import { describe, expect, test } from "bun:test";
import { tokenizeInline, tokenizeBlocks } from "../src/tui/markdown";

describe("tokenizeInline", () => {
  test("bold, italic, inline code, link", () => {
    expect(tokenizeInline("a **b** c")).toEqual([
      { t: "text", s: "a " },
      { t: "bold", s: "b" },
      { t: "text", s: " c" },
    ]);
    expect(tokenizeInline("*i*")).toEqual([{ t: "italic", s: "i" }]);
    expect(tokenizeInline("`code`")).toEqual([{ t: "code", s: "code" }]);
    expect(tokenizeInline("[x](https://d.dev)")).toEqual([{ t: "link", s: "x", url: "https://d.dev" }]);
  });

  test("unclosed constructs stay raw text", () => {
    expect(tokenizeInline("**unclosed")).toEqual([{ t: "text", s: "**unclosed" }]);
    expect(tokenizeInline("`nope")).toEqual([{ t: "text", s: "`nope" }]);
    expect(tokenizeInline("[nope")).toEqual([{ t: "text", s: "[nope" }]);
  });

  test("streaming: partial bold upgrades when closed", () => {
    expect(tokenizeInline("say **hel")).toEqual([{ t: "text", s: "say **hel" }]);
    expect(tokenizeInline("say **hello**")).toEqual([
      { t: "text", s: "say " },
      { t: "bold", s: "hello" },
    ]);
  });
});

describe("tokenizeBlocks", () => {
  test("code fence with lang", () => {
    expect(tokenizeBlocks("```ts\nconst a = 1;\n```")).toEqual([
      { t: "code", lang: "ts", text: "const a = 1;", closed: true },
    ]);
  });

  test("unclosed fence becomes a plain (unframed) code block — never duplicates", () => {
    expect(tokenizeBlocks("```ts\nconst a = 1;")).toEqual([
      { t: "code", lang: "ts", text: "const a = 1;", closed: false },
    ]);
    expect(tokenizeBlocks("Here is the fix:\n```ts\nconst a = 1;")).toEqual([
      { t: "paragraph", inline: [{ t: "text", s: "Here is the fix:" }] },
      { t: "code", lang: "ts", text: "const a = 1;", closed: false },
    ]);
  });

  test("streaming: unclosed fence upgrades to a framed block once closed", () => {
    expect(tokenizeBlocks("Here is the fix:\n```ts\nconst a = 1;")).toEqual([
      { t: "paragraph", inline: [{ t: "text", s: "Here is the fix:" }] },
      { t: "code", lang: "ts", text: "const a = 1;", closed: false },
    ]);
    expect(tokenizeBlocks("Here is the fix:\n```ts\nconst a = 1;\n```\n\nDone.")).toEqual([
      { t: "paragraph", inline: [{ t: "text", s: "Here is the fix:" }] },
      { t: "code", lang: "ts", text: "const a = 1;", closed: true },
      { t: "paragraph", inline: [{ t: "text", s: "Done." }] },
    ]);
  });

  test("a trailing unclosed fence never duplicates earlier blocks", () => {
    expect(tokenizeBlocks("```\nA\n```\nmiddle\n```\nB")).toEqual([
      { t: "code", lang: "", text: "A", closed: true },
      { t: "paragraph", inline: [{ t: "text", s: "middle" }] },
      { t: "code", lang: "", text: "B", closed: false },
    ]);
  });

  test("headings, hr, quote", () => {
    expect(tokenizeBlocks("# Hi\n\n---\n\n> quoted")).toEqual([
      { t: "heading", level: 1, inline: [{ t: "text", s: "Hi" }] },
      { t: "hr" },
      { t: "quote", inline: [{ t: "text", s: "quoted" }] },
    ]);
  });

  test("lists ordered + unordered", () => {
    expect(tokenizeBlocks("- a\n- b")).toEqual([
      { t: "list", ordered: false, items: ["a", "b"] },
    ]);
    expect(tokenizeBlocks("1. a\n2. b")).toEqual([
      { t: "list", ordered: true, items: ["a", "b"] },
    ]);
  });

  test("paragraph with inline", () => {
    expect(tokenizeBlocks("hello **world**")).toEqual([
      { t: "paragraph", inline: [
        { t: "text", s: "hello " },
        { t: "bold", s: "world" },
      ] },
    ]);
  });

  test("a line starting with **bold** never loops or stalls the parser", () => {
    expect(tokenizeBlocks("**Languages I can work with:**\nnext line")).toEqual([
      { t: "paragraph", inline: [
        { t: "bold", s: "Languages I can work with:" },
        { t: "text", s: " next line" },
      ] },
    ]);
  });

  test("star/dash lines: lists need a space, bold/italic lines are paragraphs", () => {
    expect(tokenizeBlocks("- a\n\n**bold**\n\n* b\n- c")).toEqual([
      { t: "list", ordered: false, items: ["a"] },
      { t: "paragraph", inline: [{ t: "bold", s: "bold" }] },
      { t: "list", ordered: false, items: ["b", "c"] },
    ]);
    expect(tokenizeBlocks("-not-a-list\n\n*italic*")).toEqual([
      { t: "paragraph", inline: [{ t: "text", s: "-not-a-list" }] },
      { t: "paragraph", inline: [{ t: "italic", s: "italic" }] },
    ]);
  });
});
