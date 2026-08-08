import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness } from "../src/harness/loop";
import { BUILTIN_AGENTS, type AgentDef } from "../src/agents/types";
import { BUILTIN_SKILLS } from "../src/skills/builtin";
import { loadSkills } from "../src/skills/loader";
import { loadAgents } from "../src/agents/loader";
import { defaultConfig, type DeltaConfig } from "../src/config";
import { createMcpRegistry } from "../src/mcp/registry";

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textChunk(text: string) {
  return { choices: [{ delta: { content: text } }] };
}

function toolDelta(index: number, id: string, name: string, args: string) {
  return { choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] };
}

function streamOf(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(encoder.encode(p));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

let dir: string;
let home: string;
let oldHome: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "delta-agents-"));
  home = await mkdtemp(join(tmpdir(), "delta-agents-home-"));
  oldHome = process.env.HOME;
  process.env.HOME = home;
});

afterAll(async () => {
  if (oldHome) process.env.HOME = oldHome;
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("multi-agent switching + per-agent skills (THE core feature)", () => {
  test("one prompt: lead delegates to frontend, backend AND researcher — each gets only its own skills", async () => {
    const requests: Array<{ agent: string; system: string }> = [];
    // call flow: lead-0 (task frontend) → frontend → lead-1 (task backend) → backend
    //          → lead-2 (task researcher) → researcher → lead-3 (merge)
    let call = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        call++;
        const system = body.messages[0]?.content ?? "";
        const isLead = system.includes("You are the Delta lead agent");
        const isFrontend = system.includes('"frontend" specialist agent');
        const isBackend = system.includes('"backend" specialist agent');
        const isResearcher = system.includes('"researcher" specialist agent');

        if (isLead) requests.push({ agent: "lead", system });
        else if (isFrontend) requests.push({ agent: "frontend", system });
        else if (isBackend) requests.push({ agent: "backend", system });
        else if (isResearcher) requests.push({ agent: "researcher", system });

        if (isLead && call === 1)
          return streamOf([sse(toolDelta(0, "t1", "task", `{"agent":"frontend","prompt":"build the landing hero section","description":"frontend task"}`)), sse("[DONE]")]);
        if (isFrontend) return streamOf([sse(textChunk("frontend done")), sse("[DONE]")]);
        if (isLead && call === 3)
          return streamOf([sse(toolDelta(0, "t2", "task", `{"agent":"backend","prompt":"add the API routes","description":"backend task"}`)), sse("[DONE]")]);
        if (isBackend) return streamOf([sse(textChunk("backend done")), sse("[DONE]")]);
        if (isLead && call === 5)
          return streamOf([sse(toolDelta(0, "t3", "task", `{"agent":"researcher","prompt":"find the best free tier limits","description":"research task"}`)), sse("[DONE]")]);
        if (isResearcher) return streamOf([sse(textChunk("research done")), sse("[DONE]")]);
        if (isLead) return streamOf([sse(textChunk("Merged: frontend + backend + research")), sse("[DONE]")]);
        return streamOf([sse(textChunk("?")), sse("[DONE]")]);
      },
    });

    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const mcp = await createMcpRegistry({});
    const harness = new Harness({
      config,
      projectDir: dir,
      agents: BUILTIN_AGENTS,
      skills: BUILTIN_SKILLS,
      mcp,
      callbacks: {
        onText: () => {},
        onToolCall: () => {},
        onActivity: () => {},
        onAgentStart: () => {},
        onAgentEnd: () => {},
        confirm: async () => true,
      },
    });
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const res = await harness.send("build my full-stack site", []);
    expect(res.content).toBe("Merged: frontend + backend + research");

    const agents = requests.map((r) => r.agent);
    expect(agents).toEqual(["lead", "frontend", "lead", "backend", "lead", "researcher", "lead"]);

    const lead = requests[0]!.system;
    const frontend = requests[1]!.system;
    const backend = requests[3]!.system;
    const researcher = requests[5]!.system;

    // lead has its own skills + the delegation list
    expect(lead).toContain("# Loaded Skills");
    expect(lead).toContain("### Skill: syntax-check");
    expect(lead).toContain("`frontend`");
    expect(lead).toContain("`backend`");
    expect(lead).toContain("`researcher`");

    // each specialist gets ITS OWN pre-loaded skills
    expect(frontend).toContain("Frontend Patterns");
    expect(frontend).toContain("frontend-patterns");
    expect(frontend).not.toContain("backend-patterns");
    expect(frontend).not.toContain("Backend Patterns");

    expect(backend).toContain("Backend Patterns");
    expect(backend).toContain("backend-patterns");
    expect(backend).not.toContain("frontend-patterns");
    expect(backend).not.toContain("Frontend Patterns");

    expect(researcher).toContain("Web Research");
    expect(researcher).toContain("web-research");
    expect(researcher).not.toContain("backend-patterns");

    server.stop();
  });

  test("user-installed skills land inside the agent's system prompt", async () => {
    // install a custom skill into ~/.delta/skills (HOME is temp)
    const skillDir = join(home, ".delta", "skills", "custom-magic");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: custom-magic\ndescription: Makes every build delightful\nwhenToUse: whenever building\n---\n# Custom Magic\nAlways add confetti to successful builds.`,
    );

    // user agent referencing that skill
    const agentsDir = join(home, ".delta", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "specialist.md"),
      `---\nname: specialist\ndescription: Custom specialist\ntools: [read, write, edit, bash, glob, grep]\nskills: [custom-magic]\n---\nBe extra delightful.`,
    );

    const agents = await loadAgents(dir);
    const skills = await loadSkills(dir);
    expect(skills.some((s) => s.name === "custom-magic")).toBe(true);
    const specialist = agents.find((a) => a.name === "specialist");
    expect(specialist).toBeDefined();
    expect(specialist!.skills).toContain("custom-magic");

    // spawn it via task and verify the skill body is in its system prompt
    let specialistSystem = "";
    let call = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        call++;
        const system = body.messages[0]?.content ?? "";
        if (system.includes('"specialist" specialist agent')) specialistSystem = system;
        if (system.includes("You are the Delta lead agent") && call === 1) {
          return streamOf([sse(toolDelta(0, "t1", "task", `{"agent":"specialist","prompt":"build it"}`)), sse("[DONE]")]);
        }
        if (system.includes('"specialist" specialist agent')) {
          return streamOf([sse(textChunk("built with custom magic")), sse("[DONE]")]);
        }
        return streamOf([sse(textChunk("merged")), sse("[DONE]")]);
      },
    });

    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const mcp = await createMcpRegistry({});
    const harness = new Harness({
      config,
      projectDir: dir,
      agents,
      skills,
      mcp,
      callbacks: {
        onText: () => {},
        onToolCall: () => {},
        onActivity: () => {},
        onAgentStart: () => {},
        onAgentEnd: () => {},
        confirm: async () => true,
      },
    });
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const res = await harness.send("build the thing", []);
    expect(res.content).toBe("merged");
    expect(specialistSystem).toContain("custom-magic");
    expect(specialistSystem).toContain("Always add confetti to successful builds.");
    expect(specialistSystem).toContain("Be extra delightful.");
    server.stop();
  });
});
