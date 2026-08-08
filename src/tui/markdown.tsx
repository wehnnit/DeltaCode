export interface InlineToken {
  t: "text" | "bold" | "italic" | "code" | "link";
  s?: string;
  url?: string;
}

export interface BlockToken {
  t: "paragraph" | "heading" | "list" | "quote" | "hr" | "code" | "raw";
  inline?: InlineToken[];
  level?: number;
  ordered?: boolean;
  items?: string[];
  lang?: string;
  text?: string;
  closed?: boolean;
}

const INLINE_RULES = [
  { open: "**", close: "**", t: "bold" as const },
  { open: "*", close: "*", t: "italic" as const },
  { open: "`", close: "`", t: "code" as const },
];

function pushText(out: InlineToken[], s: string): void {
  const last = out[out.length - 1];
  if (last && last.t === "text") {
    last.s = (last.s ?? "") + s;
  } else {
    out.push({ t: "text", s });
  }
}

export function tokenizeInline(src: string): InlineToken[] {
  const out: InlineToken[] = [];
  let rest = src;
  while (rest.length) {
    let best:
      | { at: number; open: string; close: string; t: "bold" | "italic" | "code" | "link" }
      | undefined;
    for (const rule of INLINE_RULES) {
      const at = rest.indexOf(rule.open);
      if (at !== -1 && (!best || at < best.at)) {
        best = { at, open: rule.open, close: rule.close, t: rule.t };
      }
    }
    const linkAt = rest.indexOf("[");
    if (linkAt !== -1 && (!best || linkAt < best.at)) {
      best = { at: linkAt, open: "[", close: "]", t: "link" };
    }
    if (!best) {
      pushText(out, rest);
      break;
    }
    if (best.at > 0) {
      pushText(out, rest.slice(0, best.at));
      rest = rest.slice(best.at);
    }
    if (best.t === "link") {
      const close = rest.indexOf("]", 1);
      const paren = close !== -1 ? rest.indexOf("(", close + 1) : -1;
      const end = paren !== -1 ? rest.indexOf(")", paren + 1) : -1;
      if (close !== -1 && paren !== -1 && end !== -1) {
        out.push({ t: "link", s: rest.slice(1, close), url: rest.slice(paren + 1, end) });
        rest = rest.slice(end + 1);
        continue;
      }
      pushText(out, rest.slice(0, 1));
      rest = rest.slice(1);
      continue;
    }
    const close = rest.indexOf(best.close, best.open.length);
    if (close === -1) {
      pushText(out, rest);
      break;
    }
    out.push({ t: best.t, s: rest.slice(best.open.length, close) });
    rest = rest.slice(close + best.close.length);
  }
  return out;
}

function isFence(line: string): boolean {
  return /^```/.test(line.trim());
}

function fenceLang(line: string): string {
  return line.trim().slice(3).trim();
}

export function tokenizeBlocks(src: string): BlockToken[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: BlockToken[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();

    if (isFence(line)) {
      const lang = fenceLang(line);
      i++;
      const body: string[] = [];
      while (i < lines.length && !isFence(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      if (i < lines.length) {
        i++;
        blocks.push({ t: "code", lang, text: body.join("\n"), closed: true });
      } else {
        blocks.push({ t: "code", lang, text: body.join("\n"), closed: false });
      }
      continue;
    }

    if (/^#{1,4}\s/.test(t)) {
      const level = /^#{1,4}/.exec(t)![0].length;
      blocks.push({
        t: "heading",
        level,
        inline: tokenizeInline(t.replace(/^#{1,4}\s*/, "")),
      });
      i++;
      continue;
    }

    if (/^(---+|\*\*\*+)$/.test(t)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    if (/^>\s?/.test(t)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ t: "quote", inline: tokenizeInline(quote.join(" ")) });
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d+\.$/.test(listMatch[2]!);
      const items: string[] = [];
      let j = i;
      while (j < lines.length) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[j]!);
        if (!m) break;
        items.push(m[3]!);
        j++;
        if (j < lines.length && !/^(\s*)([-*+]|\d+\.)\s/.test(lines[j]!)) break;
      }
      i = j;
      blocks.push({ t: "list", ordered, items });
      continue;
    }

    if (t === "") {
      i++;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const p = lines[i]!.trim();
      if (p === "" || isFence(lines[i]!) || /^(#{1,4}\s|>|(-|\+|\d+\.)\s|\*\s|---+$|\*\*\*+$)/.test(lines[i]!)) break;
      para.push(p);
      i++;
    }
    blocks.push({ t: "paragraph", inline: tokenizeInline(para.join(" ")) });
  }
  return blocks;
}

import { Box, Text } from "ink";
import { theme } from "./theme";

function Inline({ tokens, dim }: { tokens: InlineToken[]; dim?: boolean }) {
  const base = dim ? theme.mist : theme.foam;
  return (
    <Box flexWrap="wrap">
      {tokens.map((tok, i) => {
        switch (tok.t) {
          case "bold":
            return (
              <Text key={i} color={base} bold>
                {tok.s}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} color={base} italic>
                {tok.s}
              </Text>
            );
          case "code":
            return (
              <Text key={i} color={theme.teal} backgroundColor={theme.abyss}>
                {tok.s}
              </Text>
            );
          case "link":
            return (
              <Text key={i} color={theme.ocean} underline>
                {tok.s}
              </Text>
            );
          default:
            return (
              <Text key={i} color={base}>
                {tok.s}
              </Text>
            );
        }
      })}
    </Box>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const inner = Math.min((process.stdout.columns ?? 80) - 4, 160);
  const title = lang ? ` ${lang} ` : "";
  const dashes = Math.max(0, inner - title.length);
  const top = `┌${title}${"─".repeat(dashes)}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;
  const body = text.split("\n").map((l) => {
    const clipped = l.length > inner ? l.slice(0, Math.max(0, inner - 1)) + "…" : l;
    return `│${clipped.padEnd(inner)}│`;
  });
  return (
    <Box flexDirection="column">
      <Text color={theme.navy}>{top}</Text>
      {body.map((l, i) => (
        <Text key={i} color={theme.foam}>
          {l}
        </Text>
      ))}
      <Text color={theme.navy}>{bottom}</Text>
    </Box>
  );
}

export function Markdown({ text, dim }: { text: string; dim?: boolean }) {
  const blocks = tokenizeBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "heading":
            return (
              <Text key={i} color={theme.ocean} bold>
                {"#".repeat(b.level ?? 1)} {b.inline?.map((t) => t.s).join("")}
              </Text>
            );
          case "code":
            return b.closed ? (
              <CodeBlock key={i} lang={b.lang ?? ""} text={b.text ?? ""} />
            ) : (
              <Text key={i} color={dim ? theme.mist : theme.foam}>
                {b.text}
              </Text>
            );
          case "raw":
            return (
              <Text key={i} color={dim ? theme.mist : theme.foam}>
                {b.text}
              </Text>
            );
          case "hr":
            return (
              <Text key={i} color={theme.oceanDim}>
                {"─".repeat(24)}
              </Text>
            );
          case "quote":
            return (
              <Box key={i} flexDirection="column">
                <Box>
                  <Text color={theme.oceanDim}>│ </Text>
                  <Inline tokens={b.inline ?? []} dim={dim} />
                </Box>
              </Box>
            );
          case "list":
            return (
              <Box key={i} flexDirection="column">
                {b.items?.map((it, j) => (
                  <Box key={j}>
                    <Text color={theme.ocean}>{b.ordered ? `${j + 1}.` : "·"}</Text>
                    <Box paddingLeft={1}>
                      <Inline tokens={tokenizeInline(it)} dim={dim} />
                    </Box>
                  </Box>
                ))}
              </Box>
            );
          default:
            return <Inline key={i} tokens={b.inline ?? []} dim={dim} />;
        }
      })}
    </Box>
  );
}
