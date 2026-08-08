import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig, isConfigured, defaultConfig, getConfigPath } from "../src/config";
import { parseAgentFile } from "../src/agents/loader";
import { parseFrontmatter, loadSkillFromDir } from "../src/skills/loader";

let home: string;
let oldHome: string | undefined;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "delta-test-"));
  oldHome = process.env.HOME;
  process.env.HOME = home;
});

afterAll(async () => {
  if (oldHome) process.env.HOME = oldHome;
  await rm(home, { recursive: true, force: true });
});

describe("config", () => {
  test("default config is not configured", () => {
    const c = defaultConfig();
    expect(isConfigured(c)).toBe(false);
  });

  test("save and load roundtrip", async () => {
    const c = defaultConfig();
    c.provider = "anthropic";
    c.apiKey = "sk-test";
    c.model = "claude-sonnet-4-5";
    await saveConfig(c);
    const loaded = await loadConfig();
    expect(loaded.provider).toBe("anthropic");
    expect(loaded.apiKey).toBe("sk-test");
    expect(loaded.model).toBe("claude-sonnet-4-5");
    expect(loaded.mcpServers.exa?.url).toBe("https://mcp.exa.ai/mcp");
  });

  test("configured detection", async () => {
    const c = defaultConfig();
    expect(isConfigured(c)).toBe(false);
    c.apiKey = "k";
    c.provider = "p";
    expect(isConfigured(c)).toBe(true);
  });

  test("loads when file missing", async () => {
    await rm(getConfigPath(), { force: true });
    const c = await loadConfig();
    expect(c.apiKey).toBe("");
  });
});

describe("agent parsing", () => {
  test("parses frontmatter agent file", () => {
    const text = `---
name: my-coder
description: Custom coder
model: glm-5.2
tools: [read, write, edit, bash]
skills: [syntax-check, custom-skill]
canDelegate: false
---

Extra instructions here.
`;
    const agent = parseAgentFile(text);
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("my-coder");
    expect(agent!.model).toBe("glm-5.2");
    expect(agent!.tools).toEqual(["read", "write", "edit", "bash"]);
    expect(agent!.skills).toEqual(["syntax-check", "custom-skill"]);
    expect(agent!.instructions).toContain("Extra instructions");
    expect(agent!.canDelegate).toBe(false);
    expect(agent!.builtin).toBe(false);
  });

  test("rejects file without name", () => {
    expect(parseAgentFile("---\ndescription: x\n---\nbody")).toBeNull();
    expect(parseAgentFile("no frontmatter")).toBeNull();
  });
});

describe("skill parsing", () => {
  test("parses frontmatter and body", () => {
    const { frontmatter, body } = parseFrontmatter(
      `---\nname: foo\ndescription: "A skill"\n---\n\n# Body\ncontent here`,
    );
    expect(frontmatter.name).toBe("foo");
    expect(frontmatter.description).toBe("A skill");
    expect(body).toContain("# Body");
  });

  test("loads skill from dir", async () => {
    const dir = join(home, "skills-test");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: test-skill\ndescription: d\nwhenToUse: always\n---\nInstructions`,
    );
    const skill = await loadSkillFromDir(dir);
    expect(skill?.name).toBe("test-skill");
    expect(skill?.whenToUse).toBe("always");
    expect(skill?.body).toBe("Instructions");
  });
});
